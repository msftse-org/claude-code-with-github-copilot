"""Operator-only Copilot authorization and metadata checks; never runs inference."""

import argparse
import json
import logging
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import tempfile
from urllib.parse import urlparse
from urllib.request import Request

HOSTS = {
    "api.githubcopilot.com",
    "api.individual.githubcopilot.com",
    "api.business.githubcopilot.com",
    "api.enterprise.githubcopilot.com",
}


class SetupError(Exception):
    pass


def secure_directory(path: Path, create: bool = False):
    if create:
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
        raise SetupError("State directory must be private, owned by the runtime user, and not a symlink.")


def read_secret(path: Path) -> str:
    secure_directory(path.parent)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid() or info.st_size > 65536:
            raise SetupError("Credential/state file has unsafe permissions, owner, or size.")
        return handle.read().strip()


def write_private(path: Path, value: str):
    secure_directory(path.parent, True)
    fd, temporary = tempfile.mkstemp(prefix=".ccgc-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def json_request(url: str, token: str):
    from urllib.error import HTTPError, URLError
    from urllib.request import HTTPRedirectHandler, build_opener

    class NoRedirect(HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            raise SetupError("Authentication/metadata redirect rejected.")

    request = Request(url, headers={
        "Authorization": f"token {token}" if url.startswith("https://api.github.com/") else f"Bearer {token}",
        "Accept": "application/json", "User-Agent": "GithubCopilot/1.155.0",
        "Editor-Version": "vscode/1.85.1", "Editor-Plugin-Version": "copilot/1.155.0",
    })
    try:
        with build_opener(NoRedirect).open(request, timeout=20) as response:
            raw = response.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise SetupError("Metadata response exceeded its limit.")
            return json.loads(raw)
    except HTTPError as error:
        raise SetupError(f"Metadata authentication/access failed with HTTP {error.code}; no fallback.") from None
    except (URLError, TimeoutError, ValueError):
        raise SetupError("Metadata request failed or returned invalid JSON.") from None


def authenticator(state: Path):
    os.environ["GITHUB_COPILOT_TOKEN_DIR"] = str(state)
    os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
    os.environ["DO_NOT_TRACK"] = "True"
    for name in ("GITHUB_COPILOT_API_BASE", "GITHUB_COPILOT_DEVICE_CODE_URL", "GITHUB_COPILOT_ACCESS_TOKEN_URL",
                 "GITHUB_COPILOT_API_KEY_URL", "GITHUB_COPILOT_CLIENT_ID", "GITHUB_COPILOT_ACCESS_TOKEN_FILE", "GITHUB_COPILOT_API_KEY_FILE"):
        if name in os.environ:
            raise SetupError("Ambient Copilot authentication/endpoint overrides are not supported.")
    from litellm.llms.github_copilot.authenticator import Authenticator
    logging.getLogger("LiteLLM").disabled = True
    for name in logging.root.manager.loggerDict:
        if "litellm" in name.lower():
            logging.getLogger(name).disabled = True
    return Authenticator()


def model_catalog(state: Path):
    access = read_secret(state / "access-token")
    if not access:
        raise SetupError("Authorize Copilot with the operator authorize or init command before starting the proxy.")
    # Read-only control checks must not race LiteLLM's mutable session cache.
    session = json_request("https://api.github.com/copilot_internal/v2/token", access)
    api_key = session.get("token")
    endpoint = session.get("endpoints", {}).get("api")
    if not isinstance(api_key, str) or not api_key or not isinstance(endpoint, str):
        raise SetupError("Copilot session metadata is incomplete.")
    parsed = urlparse(endpoint or "")
    if parsed.scheme != "https" or parsed.hostname not in HOSTS or parsed.port or parsed.username or parsed.password or parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        raise SetupError("Copilot returned an unreviewed endpoint.")
    user = json_request("https://api.github.com/user", access)
    catalog = json_request(endpoint.rstrip("/") + "/models", api_key)
    if type(user.get("id")) is not int or user["id"] <= 0 or not isinstance(user.get("login"), str) or not user["login"]:
        raise SetupError("Invalid GitHub account metadata.")
    models = {}
    for entry in catalog.get("data", []):
        model_id = entry.get("id")
        if not isinstance(model_id, str) or not re.fullmatch(r"claude-[a-z0-9.-]+", model_id) or str(entry.get("vendor", "")).lower() != "anthropic":
            continue
        if "policy" in entry and entry["policy"].get("state") != "enabled":
            continue
        caps = entry.get("capabilities", {})
        limits = caps.get("limits", {})
        context, output = limits.get("max_context_window_tokens"), limits.get("max_output_tokens")
        if not caps.get("supports", {}).get("tool_calls") or type(context) is not int or context < 200000 or type(output) is not int or output < 128:
            continue
        ids = [model_id]
        version = entry.get("version")
        if isinstance(version, str) and version.startswith("claude-"):
            ids.append(version)
        if model_id in models:
            raise SetupError("Copilot returned duplicate eligible model IDs; operator review required.")
        models[model_id] = {
            "id": model_id, "name": entry.get("name", model_id), "context": context, "output": min(output, 16384), "responseIds": ids,
        }
    return {"accountId": user["id"], "login": user["login"], "models": list(models.values()), "maxTurns": 50}


def metadata(state: Path, model_id: str):
    catalog = model_catalog(state)
    for model in catalog["models"]:
        if model["id"] == model_id:
            return {"accountId": catalog["accountId"], "login": catalog["login"], "model": model, "maxTurns": catalog["maxTurns"]}
    raise SetupError("Selected Claude model is unavailable, disabled, or lacks the verified context/tool profile.")


def catalog_binding(state: Path, previous):
    catalog = model_catalog(state)
    default = next((model for model in catalog["models"] if model == previous["model"]), None)
    if catalog["accountId"] != previous["accountId"] or catalog["login"] != previous["login"] or default is None or catalog["maxTurns"] != previous["maxTurns"]:
        raise SetupError("Linked identity or default model changed; catalog migration cannot change the existing binding.")
    return {**previous, "models": sorted(catalog["models"], key=lambda model: model["id"])}


def litellm_config(model_ids):
    if isinstance(model_ids, str):
        model_ids = [model_ids]
    return {
        "model_list": [{"model_name": model_id, "litellm_params": {"model": "github_copilot/" + model_id}} for model_id in model_ids],
        "general_settings": {"master_key": "os.environ/LITELLM_MASTER_KEY", "disable_spend_logs": True},
        "litellm_settings": {"drop_params": False, "num_retries": 0, "set_verbose": False, "turn_off_message_logging": True,
                             "success_callback": [], "failure_callback": [], "callbacks": [], "cache": False},
        "router_settings": {"num_retries": 0, "fallbacks": [], "context_window_fallbacks": [], "content_policy_fallbacks": []},
    }


def state_status(state: Path):
    secure_directory(state)
    names = ("access-token", "api-key.json", "owner.key", "litellm.key", "deployment.json", "owner.revoked")
    present = {}
    for name in names:
        path = state / name
        present[name] = path.exists() or path.is_symlink()
        if present[name]:
            read_secret(path)
    if present["owner.revoked"]:
        raise SetupError("Deployment is revoked; automation cannot reuse it.")
    if present["deployment.json"]:
        if not all(present[name] for name in names[:4]):
            raise SetupError("Initialized deployment has incomplete credentials; operator recovery required.")
        deployment = json.loads(read_secret(state / "deployment.json"))
        info = deployment["info"]
        return {"status": "initialized", "publicUrl": deployment["publicUrl"], "login": info["login"],
                "accountId": info["accountId"], "model": info["model"]["id"]}
    if present["owner.key"] or present["litellm.key"]:
        raise SetupError("Partial initialization; do not overwrite credentials. Operator recovery required.")
    return {"status": "authorized" if present["access-token"] else "empty"}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["status", "authorize", "init", "catalog", "verify", "serve", "owner-key", "unlink"])
    parser.add_argument("--state", type=Path, default=Path("/state"))
    parser.add_argument("--model")
    parser.add_argument("--public-url")
    parser.add_argument("--accept-unofficial", action="store_true")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--expected-account-id", type=int)
    parser.add_argument("--expected-login")
    args = parser.parse_args()
    state = args.state.absolute()
    secure_directory(state, args.command in ("authorize", "init"))
    if args.command == "status":
        print(json.dumps(state_status(state)))
        return
    if args.command in ("authorize", "init"):
        if not args.accept_unofficial:
            raise SetupError("Account authorization requires --accept-unofficial after reviewing authorized use.")
        if args.command == "init":
            if not args.model or not re.fullmatch(r"claude-[a-z0-9.-]+", args.model) or not args.public_url:
                raise SetupError("init requires --model, --public-url and --accept-unofficial after reviewing authorized use.")
            endpoint = urlparse(args.public_url)
            if endpoint.scheme != "https" or not endpoint.hostname or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment or re.search(r"[\\%\s]|\.\.", args.public_url) or "//" in endpoint.path:
                raise SetupError("Public gateway URL must use HTTPS and contain no credentials/query/fragment.")
        if (state / "deployment.json").exists() or (state / "deployment.json").is_symlink():
            raise SetupError("Deployment already exists; do not overwrite its identity or credentials.")
        if (state / "owner.revoked").exists() or (state / "owner.revoked").is_symlink():
            raise SetupError("Gateway owner access is revoked; this deployment cannot be reused silently.")
        state_status(state)
        for filename in ("access-token", "api-key.json"):
            if (state / filename).exists() or (state / filename).is_symlink():
                read_secret(state / filename)
        auth = authenticator(state)
        auth.get_access_token()
        if args.command == "authorize":
            catalog = model_catalog(state)
            if not catalog["models"]:
                raise SetupError("No enabled Claude models meet the verified context/tool profile; no fallback.")
            print(json.dumps({"status": "authorized-model-selection-required", "login": catalog["login"],
                              "models": catalog["models"], "liveInference": "not-tested"}))
            return
        info = catalog_binding(state, metadata(state, args.model))
        if (args.expected_account_id is not None and info["accountId"] != args.expected_account_id
                or args.expected_login is not None and info["login"] != args.expected_login):
            raise SetupError("Authorized GitHub account does not match the expected identity; no deployment credentials were created.")
        auth.get_api_key()
        read_secret(state / "api-key.json")
        write_private(state / "owner.key", secrets.token_hex(32))
        write_private(state / "litellm.key", "sk-ccgc-" + secrets.token_hex(32))
        write_private(state / "litellm.json", json.dumps(litellm_config([model["id"] for model in info["models"]])))
        write_private(state / "deployment.json", json.dumps({"publicUrl": args.public_url.rstrip("/"), "info": info}))
        print(json.dumps({"status": "metadata-verified", "login": info["login"], "model": args.model, "liveInference": "not-tested"}))
        return
    deployment = json.loads(read_secret(state / "deployment.json"))
    if args.command == "unlink":
        write_private(state / "owner.revoked", json.dumps({"revoked": True}))
        for filename in ("access-token", "api-key.json"):
            path = state / filename
            if path.exists():
                read_secret(path)
                path.unlink()
        print("Gateway access revoked and stored Copilot tokens removed. Revoke the OAuth grant in GitHub settings separately.")
        return
    if (state / "owner.revoked").exists() or (state / "owner.revoked").is_symlink():
        raise SetupError("Gateway owner access is revoked; this deployment cannot be reused silently.")
    if args.command == "owner-key":
        print(read_secret(state / "owner.key"))
        return
    if args.command == "catalog":
        if not args.accept_unofficial:
            raise SetupError("Review all enabled Claude models and supply --accept-unofficial; --apply changes the protected catalog after stopping services.")
        current = catalog_binding(state, deployment["info"])
        if args.apply:
            read_secret(state / "owner.key")
            read_secret(state / "litellm.key")
            write_private(state / "deployment.json", json.dumps({**deployment, "info": current}))
        print(json.dumps({"status": "catalog-applied" if args.apply else "catalog-preview", "info": current, "liveInference": "not-tested"}))
        return
    current = catalog_binding(state, deployment["info"]) if "models" in deployment["info"] else metadata(state, deployment["info"]["model"]["id"])
    if current != deployment["info"]:
        raise SetupError("Linked identity/model profile changed; operator review and a new deployment profile are required.")
    if args.command == "verify":
        print(json.dumps(current))
        return
    auth = authenticator(state)
    if (state / "api-key.json").exists() or (state / "api-key.json").is_symlink():
        read_secret(state / "api-key.json")
    auth.get_api_key()
    read_secret(state / "api-key.json")
    os.environ["LITELLM_MASTER_KEY"] = read_secret(state / "litellm.key")
    os.environ["GITHUB_COPILOT_TOKEN_DIR"] = str(state)
    os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
    os.environ["DO_NOT_TRACK"] = "True"
    write_private(state / "litellm.json", json.dumps(litellm_config([model["id"] for model in current.get("models", [current["model"]])])))
    os.execv(str(Path(sys.executable).parent / "litellm"), [
        "litellm", "--config", str(state / "litellm.json"), "--host", "0.0.0.0", "--port", "4000", "--num_workers", "1",
    ])


if __name__ == "__main__":
    try:
        main()
    except SetupError as error:
        print(f"SETUP_BLOCKED: {error}", file=sys.stderr)
        sys.exit(1)
    except Exception:
        print("SETUP_FAILED: operator authorization, protected state, or metadata verification failed; no inference was attempted.", file=sys.stderr)
        sys.exit(1)
