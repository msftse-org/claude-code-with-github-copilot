import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import bootstrap


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="ccgc-bootstrap-")
        self.state = Path(self.directory.name)
        bootstrap.write_private(self.state / "access-token", "synthetic-oauth")
        self.catalog = {"data": [{
            "id": "claude-fixture", "vendor": "Anthropic", "policy": {"state": "enabled"},
            "capabilities": {"supports": {"tool_calls": True}, "limits": {
                "max_context_window_tokens": 200000, "max_output_tokens": 32000,
            }},
        }]}

    def tearDown(self):
        self.directory.cleanup()

    def reply(self, url, token):
        if url.endswith("/copilot_internal/v2/token"):
            self.assertEqual(token, "synthetic-oauth")
            return {"token": "synthetic-session", "endpoints": {"api": "https://api.business.githubcopilot.com"}}
        if url.endswith("/user"):
            return {"id": 42, "login": "synthetic-user"}
        self.assertEqual(url, "https://api.business.githubcopilot.com/models")
        self.assertEqual(token, "synthetic-session")
        return self.catalog

    def test_metadata_binds_immutable_identity_model_policy_and_limits_without_mutating_cache(self):
        bootstrap.write_private(self.state / "api-key.json", '{"cache":"unchanged"}')
        with patch.object(bootstrap, "json_request", self.reply):
            result = bootstrap.metadata(self.state, "claude-fixture")
        self.assertEqual(result["accountId"], 42)
        self.assertEqual(result["model"]["output"], 16384)
        self.assertEqual(result["maxTurns"], 50)
        self.assertEqual(bootstrap.read_secret(self.state / "api-key.json"), '{"cache":"unchanged"}')

    def test_metadata_rejects_unreviewed_upstreams_before_forwarding_tokens(self):
        for endpoint in ["http://api.githubcopilot.com", "https://other.example", "https://api.githubcopilot.com/path",
                         "https://api.githubcopilot.com:443", "https://name:pass@api.githubcopilot.com"]:
            with self.subTest(endpoint=endpoint), patch.object(bootstrap, "json_request", return_value={
                "token": "synthetic-session", "endpoints": {"api": endpoint},
            }) as call:
                with self.assertRaises(bootstrap.SetupError):
                    bootstrap.metadata(self.state, "claude-fixture")
                self.assertEqual(call.call_count, 1)

    def test_metadata_rejects_disabled_missing_and_unqualified_models(self):
        for change in [
            {"policy": {"state": "disabled"}}, {"vendor": "Other"}, {"id": "gpt-fixture"},
            {"capabilities": {"supports": {"tool_calls": False}, "limits": {}}},
        ]:
            entry = self.catalog["data"][0].copy()
            entry.update(change)
            with patch.object(bootstrap, "json_request", self.reply):
                original = self.catalog
                self.catalog = {"data": [entry]}
                with self.assertRaises(bootstrap.SetupError):
                    bootstrap.metadata(self.state, "claude-fixture")
                self.catalog = original

    def test_catalog_lists_only_eligible_claude_models_without_selecting_or_mutating_state(self):
        eligible = self.catalog["data"][0]
        self.catalog["data"] += [
            {**eligible, "id": "claude-disabled", "policy": {"state": "disabled"}},
            {**eligible, "id": "gpt-fixture", "vendor": "Other"},
            {**eligible, "id": "claude-short", "capabilities": {"supports": {"tool_calls": True}, "limits": {
                "max_context_window_tokens": 8192, "max_output_tokens": 32000,
            }}},
            {**eligible, "id": "claude-notools", "capabilities": {"supports": {"tool_calls": False}, "limits": {
                "max_context_window_tokens": 200000, "max_output_tokens": 32000,
            }}},
        ]
        with patch.object(bootstrap, "json_request", self.reply):
            result = bootstrap.model_catalog(self.state)
        self.assertEqual([model["id"] for model in result["models"]], ["claude-fixture"])
        self.assertNotIn("model", result)
        self.assertEqual({p.name for p in self.state.iterdir()}, {"access-token"})

    def test_authorize_requires_consent_and_never_creates_deployment_credentials(self):
        args = ["bootstrap.py", "authorize", "--state", str(self.state)]
        with patch("sys.argv", args), patch.object(bootstrap, "authenticator") as auth:
            with self.assertRaises(bootstrap.SetupError):
                bootstrap.main()
            auth.assert_not_called()
        output = io.StringIO()
        with patch("sys.argv", [*args, "--accept-unofficial"]), patch.object(bootstrap, "authenticator") as auth, \
                patch.object(bootstrap, "json_request", self.reply), contextlib.redirect_stdout(output):
            bootstrap.main()
        auth.return_value.get_access_token.assert_called_once_with()
        auth.return_value.get_api_key.assert_not_called()
        result = json.loads(output.getvalue())
        self.assertEqual(result["status"], "authorized-model-selection-required")
        self.assertEqual(result["liveInference"], "not-tested")
        self.assertEqual(result["models"][0]["id"], "claude-fixture")
        self.assertNotIn("synthetic-oauth", output.getvalue())
        self.assertEqual({p.name for p in self.state.iterdir()}, {"access-token"})

    def test_authorize_rejects_no_eligible_models_but_retains_the_legitimate_token(self):
        self.catalog = {"data": []}
        with patch("sys.argv", ["bootstrap.py", "authorize", "--state", str(self.state), "--accept-unofficial"]), \
                patch.object(bootstrap, "authenticator"), patch.object(bootstrap, "json_request", self.reply):
            with self.assertRaisesRegex(bootstrap.SetupError, "No enabled Claude"):
                bootstrap.main()
        self.assertEqual(bootstrap.read_secret(self.state / "access-token"), "synthetic-oauth")
        self.assertFalse((self.state / "deployment.json").exists())

    def test_authorization_refuses_existing_revoked_or_symlinked_deployments(self):
        for name in ("deployment.json", "owner.revoked"):
            for symlink in (False, True):
                path = self.state / name
                if symlink:
                    path.symlink_to(self.state / "missing")
                else:
                    bootstrap.write_private(path, "{}")
                for command in ("authorize", "init"):
                    args = ["bootstrap.py", command, "--state", str(self.state), "--accept-unofficial",
                            "--model", "claude-fixture", "--public-url", "https://gateway.example"]
                    with patch("sys.argv", args), patch.object(bootstrap, "authenticator") as auth:
                        with self.assertRaises(bootstrap.SetupError):
                            bootstrap.main()
                        auth.assert_not_called()
                path.unlink()

    def test_init_reuses_authorization_and_binds_only_the_explicit_model(self):
        auth = Mock()
        auth.get_api_key.side_effect = lambda: bootstrap.write_private(self.state / "api-key.json", '{"cache":"synthetic"}')
        args = ["bootstrap.py", "init", "--state", str(self.state), "--accept-unofficial",
                "--model", "claude-fixture", "--public-url", "https://gateway.example"]
        with patch("sys.argv", args), patch.object(bootstrap, "authenticator", return_value=auth), \
                patch.object(bootstrap, "json_request", self.reply), contextlib.redirect_stdout(io.StringIO()):
            bootstrap.main()
        deployment = json.loads(bootstrap.read_secret(self.state / "deployment.json"))
        self.assertEqual(deployment["info"]["model"]["id"], "claude-fixture")
        self.assertEqual(bootstrap.read_secret(self.state / "access-token"), "synthetic-oauth")
        self.assertEqual((self.state / "owner.key").stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.state / "litellm.key").stat().st_mode & 0o777, 0o600)

    def test_init_expected_account_mismatch_does_not_create_keys(self):
        args = ["bootstrap.py", "init", "--state", str(self.state), "--accept-unofficial",
                "--model", "claude-fixture", "--public-url", "https://gateway.example", "--expected-account-id", "43"]
        with patch("sys.argv", args), patch.object(bootstrap, "authenticator"), \
                patch.object(bootstrap, "json_request", self.reply), self.assertRaises(bootstrap.SetupError):
            bootstrap.main()
        self.assertFalse((self.state / "owner.key").exists())
        self.assertFalse((self.state / "deployment.json").exists())

    def test_status_is_read_only_and_never_returns_credentials(self):
        before = {path.name: path.read_bytes() for path in self.state.iterdir()}
        self.assertEqual(bootstrap.state_status(self.state), {"status": "authorized"})
        self.assertEqual({path.name: path.read_bytes() for path in self.state.iterdir()}, before)
        bootstrap.write_private(self.state / "owner.key", "synthetic-owner")
        with self.assertRaisesRegex(bootstrap.SetupError, "Partial initialization"):
            bootstrap.state_status(self.state)

    def test_status_revocation_cannot_be_bypassed(self):
        bootstrap.write_private(self.state / "owner.revoked", "{}")
        with self.assertRaisesRegex(bootstrap.SetupError, "revoked"):
            bootstrap.state_status(self.state)

    def test_catalog_rejects_duplicate_eligible_ids(self):
        self.catalog["data"].append(self.catalog["data"][0].copy())
        with patch.object(bootstrap, "json_request", self.reply):
            with self.assertRaisesRegex(bootstrap.SetupError, "duplicate"):
                bootstrap.model_catalog(self.state)

    def test_protected_state_rejects_permissions_and_symlinks(self):
        path = self.state / "access-token"
        os.chmod(path, 0o644)
        with self.assertRaises(bootstrap.SetupError):
            bootstrap.read_secret(path)
        path.unlink()
        path.symlink_to(self.state / "missing")
        with self.assertRaises(OSError):
            bootstrap.read_secret(path)

    def test_configuration_is_claude_only_without_caching_retries_or_fallbacks(self):
        config = bootstrap.litellm_config("claude-fixture")
        self.assertEqual(config["model_list"], [{"model_name": "claude-fixture", "litellm_params": {"model": "github_copilot/claude-fixture"}}])
        self.assertEqual(config["router_settings"]["num_retries"], 0)
        self.assertEqual(config["router_settings"]["fallbacks"], [])
        self.assertFalse(config["litellm_settings"]["cache"])
        self.assertTrue(config["litellm_settings"]["turn_off_message_logging"])
        self.assertEqual(config["general_settings"]["master_key"], "os.environ/LITELLM_MASTER_KEY")

    def test_unlink_persists_revocation_and_removes_only_owned_copilot_tokens(self):
        bootstrap.write_private(self.state / "deployment.json", json.dumps({"info": {}}))
        bootstrap.write_private(self.state / "api-key.json", "{}")
        bootstrap.write_private(self.state / "owner.key", "synthetic-owner")
        with patch("sys.argv", ["bootstrap.py", "unlink", "--state", str(self.state)]), contextlib.redirect_stdout(io.StringIO()):
            bootstrap.main()
        self.assertTrue(json.loads(bootstrap.read_secret(self.state / "owner.revoked"))["revoked"])
        self.assertFalse((self.state / "access-token").exists())
        self.assertFalse((self.state / "api-key.json").exists())
        self.assertEqual(bootstrap.read_secret(self.state / "owner.key"), "synthetic-owner")

    def test_revoked_deployments_cannot_print_keys_or_verify(self):
        bootstrap.write_private(self.state / "deployment.json", "{}")
        bootstrap.write_private(self.state / "owner.revoked", '{"revoked":true}')
        for command in ["owner-key", "verify", "serve"]:
            with patch("sys.argv", ["bootstrap.py", command, "--state", str(self.state)]), self.assertRaises(bootstrap.SetupError):
                bootstrap.main()

    def test_catalog_migration_previews_then_atomically_preserves_keys_identity_and_creation_time(self):
        with patch.object(bootstrap, "json_request", self.reply):
            info = bootstrap.metadata(self.state, "claude-fixture")
        original = {"info": info, "publicUrl": "https://gateway.example", "createdAt": "original-timestamp"}
        bootstrap.write_private(self.state / "deployment.json", json.dumps(original))
        bootstrap.write_private(self.state / "owner.key", "original-owner")
        bootstrap.write_private(self.state / "litellm.key", "original-master")
        bootstrap.write_private(self.state / "litellm.json", "unchanged-until-serve")
        self.catalog["data"].append({**self.catalog["data"][0], "id": "claude-opus-5.5"})
        args = ["bootstrap.py", "catalog", "--state", str(self.state), "--accept-unofficial"]
        with patch.object(bootstrap, "json_request", self.reply), patch.object(bootstrap, "authenticator") as auth:
            with patch("sys.argv", args), contextlib.redirect_stdout(io.StringIO()):
                bootstrap.main()
            self.assertEqual(json.loads(bootstrap.read_secret(self.state / "deployment.json")), original)
            with patch("sys.argv", [*args, "--apply"]), contextlib.redirect_stdout(io.StringIO()):
                bootstrap.main()
            auth.assert_not_called()
        deployed = json.loads(bootstrap.read_secret(self.state / "deployment.json"))
        self.assertEqual(deployed["createdAt"], original["createdAt"])
        self.assertEqual(deployed["info"]["model"], info["model"])
        self.assertEqual(len(deployed["info"]["models"]), 2)
        for name, expected in [("owner.key", "original-owner"), ("litellm.key", "original-master"),
                               ("access-token", "synthetic-oauth"), ("litellm.json", "unchanged-until-serve")]:
            self.assertEqual(bootstrap.read_secret(self.state / name), expected)
        config = bootstrap.litellm_config([model["id"] for model in deployed["info"]["models"]])
        self.assertEqual(len(config["model_list"]), 2)
        self.assertEqual(config["router_settings"]["fallbacks"], [])

    def test_catalog_migration_rejects_identity_changes_disabled_default_and_revocation(self):
        with patch.object(bootstrap, "json_request", self.reply):
            info = bootstrap.metadata(self.state, "claude-fixture")
        for change in [{"accountId": 99}, {"login": "another"}, {"model": {**info["model"], "output": 1}}]:
            with patch.object(bootstrap, "json_request", self.reply), self.assertRaises(bootstrap.SetupError):
                bootstrap.catalog_binding(self.state, {**info, **change})
        bootstrap.write_private(self.state / "deployment.json", json.dumps({"info": info}))
        (self.state / "owner.revoked").symlink_to(self.state / "missing")
        with patch("sys.argv", ["bootstrap.py", "catalog", "--state", str(self.state), "--accept-unofficial", "--apply"]), \
                patch.object(bootstrap, "json_request") as request, self.assertRaises(bootstrap.SetupError):
            bootstrap.main()
        request.assert_not_called()


if __name__ == "__main__":
    unittest.main()
