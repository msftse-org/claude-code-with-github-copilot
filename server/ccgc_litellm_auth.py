"""Single-tenant CCGC authentication extension for LiteLLM Proxy."""

from __future__ import annotations

import asyncio
from hashlib import sha256
import json
import os
import re
from typing import Any, NamedTuple, Protocol
from urllib.parse import parse_qs, unquote, urlparse


ADMISSION = re.compile(r"^[a-f0-9]{64}$")
API_KEY = re.compile(r"^ccgc_sk_[A-Za-z0-9_-]{43}$")
UUID = re.compile(r"^[0-9a-f-]{36}$", re.IGNORECASE)
LITELLM_KEY = re.compile(r"^sk-[A-Za-z0-9._-]{16,}$")


class AuthenticationRejected(Exception):
    """Reject a CCGC credential without exposing binding details."""

    def __init__(self, message: str, status_code: int = 401):
        super().__init__(message)
        self.status_code = status_code


class Principal(NamedTuple):
    tenant_id: str
    object_id: str
    subject: str


class Binding(NamedTuple):
    tenant_id: str
    object_id: str
    github_account_id: int
    github_login: str
    credential_secret_name: str
    revision: int


class IdentityStore(Protocol):
    async def admission_binding(self, token_hash: str, consume: bool) -> Binding: ...

    async def api_key_binding(self, key_hash: str) -> Binding: ...

    async def principal_binding(self, principal: Principal) -> Binding: ...


class SecretResolver(Protocol):
    async def get(self, name: str) -> str: ...


class TokenValidator(Protocol):
    async def validate(self, token: str) -> Principal: ...


class CCGCAuthenticator:
    def __init__(
        self,
        tenant_id: str,
        store: IdentityStore,
        secrets: SecretResolver,
        tokens: TokenValidator,
        native_jwt_auth: bool = False,
    ):
        if not UUID.fullmatch(tenant_id):
            raise ValueError("CCGC tenant ID is invalid")
        self.tenant_id = tenant_id.lower()
        self.store = store
        self.secrets = secrets
        self.tokens = tokens
        self.native_jwt_auth = native_jwt_auth

    async def authenticate(self, token: str, path: str) -> str:
        if ADMISSION.fullmatch(token):
            binding = await self.store.admission_binding(
                sha256(token.encode()).hexdigest(),
                path.rstrip("/") in {"/v1/messages", "/messages"},
            )
        elif API_KEY.fullmatch(token):
            binding = await self.store.api_key_binding(sha256(token.encode()).hexdigest())
        elif token.count(".") == 2 and self.native_jwt_auth:
            raise AuthenticationRejected(
                "JWT authentication is delegated to LiteLLM native authentication."
            )
        elif token.count(".") == 2:
            principal = await self.tokens.validate(token)
            binding = await self.store.principal_binding(principal)
        else:
            raise AuthenticationRejected("Credential is not handled by CCGC custom authentication.")
        if binding.tenant_id.lower() != self.tenant_id:
            raise AuthenticationRejected("The identity belongs to another tenant.", 403)
        return await self._virtual_key(binding)

    async def _virtual_key(self, binding: Binding) -> str:
        try:
            payload = json.loads(await self.secrets.get(binding.credential_secret_name))
        except (json.JSONDecodeError, TypeError) as error:
            raise AuthenticationRejected("The employee credential is unavailable.", 503) from error
        if not isinstance(payload, dict):
            raise AuthenticationRejected("The employee credential is unavailable.", 503)
        api_key = payload.get("apiKey")
        login = payload.get("login")
        account_id = payload.get("githubAccountId")
        credential_name = payload.get("credentialName")
        if (
            not isinstance(api_key, str)
            or not LITELLM_KEY.fullmatch(api_key)
            or not isinstance(login, str)
            or login.lower() != binding.github_login.lower()
            or account_id != binding.github_account_id
            or not isinstance(credential_name, str)
            or not credential_name
        ):
            raise AuthenticationRejected(
                "The LiteLLM user credential does not match the Entra-to-GitHub binding.",
                403,
            )
        return api_key


class EntraTokenValidator:
    def __init__(self, tenant_id: str, audience: str, role: str):
        if not UUID.fullmatch(tenant_id) or not audience or not role:
            raise ValueError("Entra validation settings are invalid")
        self.tenant_id = tenant_id.lower()
        self.audience = audience
        self.role = role
        self.issuer = f"https://login.microsoftonline.com/{self.tenant_id}/v2.0"
        self.jwks_url = f"https://login.microsoftonline.com/{self.tenant_id}/discovery/v2.0/keys"

    async def validate(self, token: str) -> Principal:
        try:
            import jwt

            def decode() -> dict[str, Any]:
                signing_key = jwt.PyJWKClient(self.jwks_url).get_signing_key_from_jwt(token)
                return jwt.decode(
                    token,
                    signing_key.key,
                    algorithms=["RS256"],
                    audience=self.audience,
                    issuer=self.issuer,
                    leeway=5,
                )

            payload = await asyncio.to_thread(decode)
        except Exception as error:
            raise AuthenticationRejected("Microsoft Entra token validation failed.") from error
        tenant_id = str(payload.get("tid", "")).lower()
        object_id = str(payload.get("oid", "")).lower()
        subject = str(payload.get("sub", ""))
        roles = payload.get("roles")
        if (
            tenant_id != self.tenant_id
            or not UUID.fullmatch(object_id)
            or not subject
            or not isinstance(roles, list)
            or self.role not in roles
        ):
            raise AuthenticationRejected("The Entra principal or required app role is not approved.", 403)
        return Principal(tenant_id, object_id, subject)


class AzureSecretResolver:
    def __init__(self, vault_url: str):
        parsed = urlparse(vault_url)
        if parsed.scheme != "https" or not parsed.hostname or not parsed.hostname.endswith(".vault.azure.net"):
            raise ValueError("CCGC Key Vault URL is invalid")
        self.vault_url = vault_url
        self._credential: Any = None
        self._client: Any = None

    async def get(self, name: str) -> str:
        if self._client is None:
            from azure.identity.aio import DefaultAzureCredential
            from azure.keyvault.secrets.aio import SecretClient

            self._credential = DefaultAzureCredential()
            self._client = SecretClient(self.vault_url, self._credential)
        secret = await self._client.get_secret(name)
        if not secret.value:
            raise AuthenticationRejected("The employee credential is unavailable.", 503)
        return secret.value


class PostgresIdentityStore:
    def __init__(self, connection_url: str, entra: bool):
        parsed = urlparse(connection_url)
        if parsed.scheme not in {"postgres", "postgresql"} or not parsed.hostname or not parsed.path.strip("/"):
            raise ValueError("CCGC PostgreSQL URL is invalid")
        self.host = parsed.hostname
        self.port = parsed.port or 5432
        self.user = unquote(parsed.username or "")
        self.password = unquote(parsed.password or "")
        self.database = unquote(parsed.path.strip("/"))
        self.schema = parse_qs(parsed.query).get("schema", ["public"])[0]
        self.entra = entra
        if (
            not self.user
            or (entra and self.password)
            or not re.fullmatch(r"[a-z][a-z0-9_]{0,62}", self.schema)
        ):
            raise ValueError("CCGC PostgreSQL identity settings are invalid")

    async def _connection(self):
        import asyncpg

        password = self.password
        if self.entra:
            from azure.identity.aio import DefaultAzureCredential

            credential = DefaultAzureCredential()
            try:
                access = await credential.get_token("https://ossrdbms-aad.database.windows.net/.default")
                password = access.token
            finally:
                await credential.close()
        return await asyncpg.connect(
            host=self.host,
            port=self.port,
            user=self.user,
            password=password,
            database=self.database,
            ssl="require",
            server_settings={"search_path": self.schema},
            timeout=10,
        )

    @staticmethod
    def _binding(row: Any) -> Binding:
        if row is None:
            raise AuthenticationRejected("The employee identity is not enrolled.", 403)
        return Binding(
            tenant_id=str(row["tenant_id"]),
            object_id=str(row["object_id"]),
            github_account_id=int(row["github_account_id"]),
            github_login=str(row["github_login"]),
            credential_secret_name=str(row["credential_secret_name"]),
            revision=int(row["revision"]),
        )

    async def admission_binding(self, token_hash: str, consume: bool) -> Binding:
        connection = await self._connection()
        try:
            async with connection.transaction():
                row = await connection.fetchrow(
                    """
                    SELECT a.id, a.binding_revision, a.max_attempts, a.attempts,
                           b.tenant_id, b.object_id, b.github_account_id, b.github_login,
                           b.credential_secret_name, b.revision
                    FROM enterprise_admissions a
                    JOIN enterprise_account_bindings b
                      ON b.tenant_id = a.tenant_id AND b.object_id = a.object_id
                    WHERE a.token_hash = $1
                      AND a.revoked_at IS NULL AND a.expires_at > now()
                      AND b.revoked_at IS NULL
                    FOR UPDATE OF a
                    """,
                    token_hash,
                )
                binding = self._binding(row)
                if int(row["binding_revision"]) != binding.revision:
                    raise AuthenticationRejected("The account binding changed after admission.", 409)
                if consume:
                    if int(row["attempts"]) >= int(row["max_attempts"]):
                        raise AuthenticationRejected("Admission attempt budget is exhausted.", 429)
                    await connection.execute(
                        "UPDATE enterprise_admissions SET attempts = attempts + 1 WHERE id = $1",
                        row["id"],
                    )
                return binding
        finally:
            await connection.close()

    async def api_key_binding(self, key_hash: str) -> Binding:
        connection = await self._connection()
        try:
            row = await connection.fetchrow(
                """
                WITH principal AS (
                  UPDATE enterprise_api_keys
                  SET last_used_at = now()
                  WHERE key_hash = $1 AND revoked_at IS NULL AND expires_at > now()
                  RETURNING tenant_id, object_id
                )
                SELECT b.tenant_id, b.object_id, b.github_account_id, b.github_login,
                       b.credential_secret_name, b.revision
                FROM principal p
                JOIN enterprise_account_bindings b
                  ON b.tenant_id = p.tenant_id AND b.object_id = p.object_id
                WHERE b.revoked_at IS NULL
                """,
                key_hash,
            )
            return self._binding(row)
        finally:
            await connection.close()

    async def principal_binding(self, principal: Principal) -> Binding:
        connection = await self._connection()
        try:
            row = await connection.fetchrow(
                """
                SELECT tenant_id, object_id, github_account_id, github_login,
                       credential_secret_name, revision
                FROM enterprise_account_bindings
                WHERE tenant_id = $1 AND object_id = $2 AND revoked_at IS NULL
                """,
                principal.tenant_id,
                principal.object_id,
            )
            return self._binding(row)
        finally:
            await connection.close()


_authenticator: CCGCAuthenticator | None = None


def _required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable {name}")
    return value


def _runtime_authenticator() -> CCGCAuthenticator:
    global _authenticator
    if _authenticator is None:
        tenant_id = _required("CCGC_ENTRA_TENANT_ID")
        _authenticator = CCGCAuthenticator(
            tenant_id,
            PostgresIdentityStore(
                _required("CCGC_POSTGRES_URL"),
                os.environ.get("CCGC_POSTGRES_ENTRA") == "true",
            ),
            AzureSecretResolver(_required("CCGC_KEY_VAULT_URL")),
            EntraTokenValidator(
                tenant_id,
                _required("CCGC_ENTRA_AUDIENCE"),
                os.environ.get("CCGC_ENTRA_ROLE", "CCGC.Access"),
            ),
            os.environ.get("CCGC_NATIVE_JWT_AUTH") == "true",
        )
    return _authenticator


async def user_api_key_auth(request: Any, api_key: str) -> str:
    """Resolve CCGC policy credentials while native JWT and virtual keys fall through."""
    try:
        return await _runtime_authenticator().authenticate(api_key, request.url.path)
    except AuthenticationRejected:
        if api_key.count(".") == 2 and os.environ.get("CCGC_NATIVE_JWT_AUTH") != "true":
            # JWT auth is configured in LiteLLM so it can be activated without
            # replacing the image. While disabled, never let a CCGC validation
            # failure fall through to a pre-provisioned native mapping.
            return "sk-ccgc-native-jwt-disabled"
        # In custom-auth auto mode, LiteLLM falls back to its normal virtual-key
        # authentication. This preserves every pre-existing customer workload.
        raise
