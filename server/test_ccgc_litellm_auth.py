import json
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from ccgc_litellm_auth import (
    AuthenticationRejected,
    Binding,
    CCGCAuthenticator,
    PostgresIdentityStore,
    Principal,
)


TENANT = "2e1ff9b6-0978-4e17-84c5-b55ad1f6041d"
OBJECT = "5e2cca69-2897-4dda-867b-09181b21ac45"


class Store:
    def __init__(self):
        self.consumed = []
        self.binding = Binding(TENANT, OBJECT, 97739755, "marina-marenkov", "ccgc-user", 4)

    async def admission_binding(self, token_hash, consume):
        self.consumed.append((token_hash, consume))
        return self.binding

    async def api_key_binding(self, key_hash):
        return self.binding

    async def principal_binding(self, principal):
        self.principal = principal
        return self.binding


class Secrets:
    def __init__(self, value=None):
        self.value = value or json.dumps({
            "apiKey": "sk-1234567890abcdefghijklmnop",
            "login": "marina-marenkov",
            "githubAccountId": 97739755,
            "credentialName": "github-copilot-user",
        })

    async def get(self, name):
        self.name = name
        return self.value


class Tokens:
    async def validate(self, token):
        self.token = token
        return Principal(TENANT, OBJECT, "entra-subject")


class CCGCLiteLLMAuthTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.store = Store()
        self.secrets = Secrets()
        self.tokens = Tokens()
        self.auth = CCGCAuthenticator(TENANT, self.store, self.secrets, self.tokens)

    async def test_admission_maps_to_employee_virtual_key_and_only_consumes_messages(self):
        token = "a" * 64
        key = await self.auth.authenticate(token, "/v1/models")
        self.assertEqual(key, "sk-1234567890abcdefghijklmnop")
        self.assertFalse(self.store.consumed[-1][1])
        await self.auth.authenticate(token, "/v1/messages")
        self.assertTrue(self.store.consumed[-1][1])
        self.assertEqual(self.secrets.name, "ccgc-user")

    async def test_entra_identity_uses_the_same_immutable_binding(self):
        token = "header.payload.signature"
        self.assertEqual(
            await self.auth.authenticate(token, "/v1/messages"),
            "sk-1234567890abcdefghijklmnop",
        )
        self.assertEqual(self.store.principal.object_id, OBJECT)

    async def test_existing_litellm_keys_are_left_for_normal_authentication(self):
        with self.assertRaises(AuthenticationRejected):
            await self.auth.authenticate("sk-existing-customer-key", "/v1/messages")

    async def test_github_identity_mismatch_fails_closed(self):
        self.secrets.value = json.dumps({
            "apiKey": "sk-1234567890abcdefghijklmnop",
            "login": "another-user",
            "githubAccountId": 97739755,
            "credentialName": "github-copilot-user",
        })
        with self.assertRaisesRegex(AuthenticationRejected, "does not match"):
            await self.auth.authenticate("a" * 64, "/v1/messages")

    async def test_cross_tenant_binding_is_rejected(self):
        self.store.binding = Binding(
            "72f988bf-86f1-41af-91ab-2d7cd011db47",
            OBJECT,
            97739755,
            "marina-marenkov",
            "ccgc-user",
            4,
        )
        with self.assertRaisesRegex(AuthenticationRejected, "another tenant"):
            await self.auth.authenticate("a" * 64, "/v1/messages")

    def test_postgres_identity_store_routes_queries_to_ccgc_schema(self):
        store = PostgresIdentityStore(
            "postgresql://identity@postgres.example/postgres?schema=ccgc&sslmode=require",
            True,
        )
        self.assertEqual(store.schema, "ccgc")

    def test_postgres_identity_store_rejects_unsafe_schema(self):
        with self.assertRaisesRegex(ValueError, "identity settings"):
            PostgresIdentityStore(
                "postgresql://identity@postgres.example/postgres?schema=ccgc%3Bdrop",
                True,
            )

    async def test_postgres_identity_store_sets_connection_search_path(self):
        connect = AsyncMock(return_value=object())
        store = PostgresIdentityStore(
            "postgresql://identity:password@postgres.example/postgres?schema=ccgc&sslmode=require",
            False,
        )
        with patch.dict(sys.modules, {"asyncpg": SimpleNamespace(connect=connect)}):
            await store._connection()
        connect.assert_awaited_once_with(
            host="postgres.example",
            port=5432,
            user="identity",
            password="password",
            database="postgres",
            ssl="require",
            server_settings={"search_path": "ccgc"},
            timeout=10,
        )


if __name__ == "__main__":
    unittest.main()
