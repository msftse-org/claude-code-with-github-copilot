import argparse
import contextlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import deploy


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ccgc-deploy-test-")
        self.directory = Path(self.temp.name).resolve()
        self.private = self.directory / "ssh"
        self.private.write_text("synthetic private key, never an inference credential")
        self.private.chmod(0o600)
        self.public = self.directory / "ssh.pub"
        self.public.write_text("ssh-ed25519 AAAA synthetic")
        self.config = {
            "engine": "bicep", "subscriptionId": "00000000-0000-0000-0000-000000000001",
            "tenantId": "00000000-0000-0000-0000-000000000002", "deploymentName": "ccgc-synthetic",
            "operatorIpv4Cidr": "8.8.8.8/32", "sshPrivateKeyFile": str(self.private),
            "sshPublicKeyFile": str(self.public), "githubLogin": "synthetic-user",
            "githubAccountId": 42, "model": "claude-sonnet-5.5",
        }
        self.options = argparse.Namespace(approve_plan=None, approve_access=False, accept_unofficial=False,
                                          approve_client=False, approve_live=False, install_client=False,
                                          until="verified", operator_ipv4_cidr=None)
        self.state = self.directory / "deployment"
        self.state.mkdir(mode=0o700)
        self.deployment = deploy.Deployment(self.config, self.state, self.options)
        self.deployment.public_key = self.public.read_text()

    def tearDown(self):
        self.temp.cleanup()

    def test_config_strict_schema_ids_key_permissions_and_exact_model(self):
        path = self.directory / "config.json"
        deploy.write_json(path, self.config)
        self.assertEqual(deploy.config_file(path), self.config)
        for change in ({"engine": "other"}, {"secret": "not-accepted"}, {"model": "Claude Sonnet 5.5"},
                       {"githubAccountId": 0}, {"subscriptionId": "default"}, {"deploymentName": "../existing"}):
            deploy.write_json(path, {**self.config, **change})
            with self.subTest(change=change), self.assertRaises(deploy.DeployError):
                deploy.config_file(path)
        deploy.write_json(path, self.config)
        self.private.chmod(0o644)
        with self.assertRaises(deploy.DeployError):
            deploy.config_file(path)

    def test_only_public_single_host_jit_sources(self):
        self.assertEqual(deploy.operator_ip("8.8.8.8/32"), "8.8.8.8")
        for value in ("0.0.0.0/0", "10.0.0.1/32", "127.0.0.1/32", "8.8.8.0/24", "8.8.8.8", "::1/128", "224.0.0.1/32"):
            with self.subTest(value=value), self.assertRaises(deploy.DeployError):
                deploy.operator_ip(value)

    def test_no_implicit_engine_account_or_configuration_change(self):
        for field, value in (("engine", "terraform"), ("githubAccountId", 43), ("model", "claude-opus-5.5")):
            with self.subTest(field=field), self.assertRaises(deploy.DeployError):
                deploy.Deployment({**self.config, field: value}, self.state, self.options)

    def test_creation_time_is_immutable_and_state_is_private(self):
        created = self.deployment.state["createdAt"]
        again = deploy.Deployment(self.config, self.state, self.options)
        again.mark("infra")
        self.assertEqual(again.state["createdAt"], created)
        self.assertEqual((self.state / "state.json").stat().st_mode & 0o777, 0o600)

    def test_symlink_state_or_config_is_rejected(self):
        alias = self.directory / "alias"
        alias.symlink_to(self.state, target_is_directory=True)
        with self.assertRaises(deploy.DeployError):
            deploy.private_directory(alias)
        path = self.directory / "config.json"
        path.symlink_to(self.state / "state.json")
        with self.assertRaises(OSError):
            deploy.read_json(path)

    def test_destructive_or_uncertain_plans_are_blocked_for_both_engines(self):
        for engine, value in (
            ("terraform", {"resource_changes": [{"change": {"actions": ["create"]}}]}),
            ("bicep", {"status": "Succeeded", "changes": [{"changeType": "Create"}]}),
        ):
            deploy.checked_plan(engine, value)
        for actions in (["delete"], ["delete", "create"], ["update"]):
            with self.assertRaises(deploy.DeployError):
                deploy.checked_plan("terraform", {"resource_changes": [{"change": {"actions": actions}}]})
        for change in ("Delete", "Modify", "Unsupported", "Deploy"):
            with self.assertRaises(deploy.DeployError):
                deploy.checked_plan("bicep", {"status": "Succeeded", "changes": [{"changeType": change}]})
        with self.assertRaises(deploy.DeployError):
            deploy.checked_plan("bicep", {"status": "Failed"})

    def test_all_up_approvals_are_checked_before_cloud_mutation(self):
        with patch.object(self.deployment, "preflight") as preflight, self.assertRaises(deploy.DeployError):
            self.deployment.up()
        preflight.assert_not_called()

    def test_stages_execute_in_order_and_stop_at_requested_boundary(self):
        self.options.until = "gateway"
        self.options.approve_access = self.options.accept_unofficial = True
        calls = []
        with contextlib.ExitStack() as stack:
            for name in ("preflight", "provision", "access", "install", "gateway", "client", "verify"):
                stack.enter_context(patch.object(self.deployment, name, side_effect=lambda *a, n=name, **k: calls.append(n)))
            self.deployment.up()
        self.assertEqual(calls, ["preflight", "provision", "access", "install", "gateway"])

    def test_failed_phase_does_not_run_later_phases(self):
        self.options.approve_access = self.options.accept_unofficial = self.options.approve_client = self.options.approve_live = True
        with patch.object(self.deployment, "preflight"), patch.object(self.deployment, "provision"), \
                patch.object(self.deployment, "access", side_effect=deploy.DeployError("blocked by policy")), \
                patch.object(self.deployment, "install") as install, self.assertRaises(deploy.DeployError):
            self.deployment.up()
        install.assert_not_called()
        self.assertNotIn("verified", self.deployment.state["stages"])

    def test_provision_requires_exact_saved_plan_approval(self):
        self.deployment.state["plan"] = {"sha256": "reviewed"}
        self.options.approve_plan = "something-else"
        with patch.object(self.deployment, "az") as az, self.assertRaises(deploy.DeployError):
            self.deployment.provision()
        az.assert_not_called()

    def test_completed_infra_is_not_reapplied(self):
        self.deployment.state["stages"]["infra"] = {}
        self.deployment.state["outputs"] = {"synthetic": True}
        with patch.object(self.deployment, "verify_outputs") as verify, patch.object(self.deployment, "az") as az:
            self.deployment.provision()
        verify.assert_called_once()
        az.assert_not_called()

    def test_jit_and_host_key_are_azure_authenticated_never_network_scanned(self):
        self.options.approve_access = True
        outputs = {"vmId": "/synthetic/vm", "vmName": "vm-ccgc-synthetic", "publicIpAddress": "8.8.4.4", "sshAccessPolicyId": "/synthetic/jit"}
        self.deployment.state["outputs"] = outputs
        calls = []

        def azure(*args, **kwargs):
            calls.append(args)
            return {"value": [{"message": "ssh-ed25519 AAAA root@host\n"}]} if args[:2] == ("vm", "run-command") else {}

        with patch.object(self.deployment, "verify_outputs"), patch.object(self.deployment, "az", side_effect=azure), \
                patch.object(self.deployment, "ssh") as ssh:
            self.deployment.access()
        self.assertEqual(len(calls), 3)
        policy = json.loads(calls[0][-1])
        port = policy["properties"]["virtualMachines"][0]["ports"][0]
        self.assertEqual(port["allowedSourceAddressPrefix"], "8.8.8.8/32")
        self.assertEqual(port["maxRequestAccessDuration"], "PT1H")
        self.assertIn("ssh-ed25519 AAAA", (self.state / "known_hosts").read_text())
        ssh.assert_called_once_with("true", timeout=25)
        (self.state / "known_hosts").write_text("different existing host key\n")
        with patch.object(self.deployment, "verify_outputs"), patch.object(self.deployment, "az", side_effect=azure), \
                patch.object(self.deployment, "ssh") as ssh, self.assertRaises(deploy.DeployError):
            self.deployment.access()
        ssh.assert_not_called()

    def test_gateway_reuses_existing_binding_without_authorization(self):
        self.options.accept_unofficial = True
        status = {"status": "initialized", "login": "synthetic-user", "accountId": 42,
                  "model": self.config["model"], "publicUrl": "https://" + self.deployment.fqdn}
        with patch.object(self.deployment, "host", side_effect=[json.dumps(status), '{"models":[]}', "", json.dumps({"imageId": "sha256:" + "a" * 64})]) as host, \
                patch.object(deploy, "health"):
            self.deployment.gateway()
        self.assertEqual([call.args[0] for call in host.call_args_list], ["status", "verify", "activate", "inspect"])
        self.assertIn("gateway", self.deployment.state["stages"])

    def test_runtime_change_invalidates_old_live_proof(self):
        self.options.accept_unofficial = True
        self.deployment.state["stages"]["verified"] = {"completedAt": "old-proof"}
        self.deployment.state["runtime"] = {"imageId": "sha256:" + "b" * 64}
        status = {"status": "initialized", "login": "synthetic-user", "accountId": 42,
                  "model": self.config["model"], "publicUrl": "https://" + self.deployment.fqdn}
        with patch.object(self.deployment, "host", side_effect=[json.dumps(status), '{"models":[]}', "", json.dumps({"imageId": "sha256:" + "a" * 64})]), \
                patch.object(deploy, "health"):
            self.deployment.gateway()
        self.assertNotIn("verified", self.deployment.state["stages"])

    def test_gateway_refuses_account_mismatch_without_starting_service(self):
        self.options.accept_unofficial = True
        status = {"status": "initialized", "login": "someone-else", "accountId": 43,
                  "model": self.config["model"], "publicUrl": "https://" + self.deployment.fqdn}
        with patch.object(self.deployment, "host", return_value=json.dumps(status)) as host, self.assertRaises(deploy.DeployError):
            self.deployment.gateway()
        self.assertEqual(host.call_count, 1)

    def test_source_archive_allowlist_never_contains_keys_or_operational_state(self):
        import tarfile
        archive = self.directory / "release.tar.gz"
        deploy.run(["bash", deploy.ROOT / "server/azure-deploy.sh", "package", archive])
        with tarfile.open(archive) as handle:
            names = handle.getnames()
            self.assertIn("server/deploy-host.sh", names)
            self.assertIn("src/deployment-smoke.ts", names)
            self.assertFalse(any("state.json" in name or ".copilot-azure" in name or name.endswith(".key") for name in names))
            self.assertTrue(all(member.isfile() for member in handle))

    def test_run_does_not_report_secret_process_output(self):
        result = Mock(returncode=1, stdout="synthetic-secret", stderr="synthetic-secret")
        with patch("subprocess.run", return_value=result), self.assertRaises(deploy.DeployError) as error:
            deploy.run(["synthetic-program"])
        self.assertNotIn("synthetic-secret", str(error.exception))

    def test_bootstrap_integration_has_no_inference_retry_or_secret_logging(self):
        script = (deploy.ROOT / "server/deploy-host.sh").read_text()
        self.assertNotIn("set -x", script)
        self.assertIn("run --rm -T setup", script)
        self.assertIn("</dev/null", script)

    def test_recovery_does_not_start_host_without_explicit_approval(self):
        self.options.accept_unofficial = self.options.approve_access = True
        self.options.approve_start = False
        self.deployment.state["outputs"] = {"vmName": "vm-ccgc-synthetic"}
        self.deployment.state["stages"]["host"] = {}
        with patch.object(self.deployment, "az", return_value={"instanceView": {"statuses": [{"code": "PowerState/deallocated"}]}}), \
                patch.object(deploy, "run") as run, self.assertRaises(deploy.DeployError):
            self.deployment.recover()
        run.assert_not_called()

    def test_bicep_provision_uses_approved_plan_and_normalized_outputs(self):
        value = {"status": "Succeeded", "changes": [{"changeType": "Create"}]}
        deploy.write_json(self.state / "plan.json", value)
        self.deployment.state["plan"] = {"sha256": deploy.digest(value), "createdAt": deploy.now(),
                                          "inputsSha256": deploy.digest(self.deployment.inputs())}
        self.options.approve_plan = deploy.digest(value)
        outputs = {"vmName": {"value": "vm-ccgc-synthetic"}}
        with patch.object(self.deployment, "prepare_iac", return_value=["--template-file", "snapshot.bicep"]), \
                patch.object(self.deployment, "az", side_effect=[False, value, {"properties": {"outputs": outputs}}]) as az, \
                patch.object(self.deployment, "verify_outputs"):
            self.deployment.provision()
        self.assertEqual(az.call_args_list[-1].args[:3], ("deployment", "sub", "create"))
        self.assertEqual(self.deployment.state["outputs"], {"vmName": "vm-ccgc-synthetic"})
        self.assertIn("infra", self.deployment.state["stages"])

    def test_changed_bicep_preview_is_never_applied(self):
        value = {"status": "Succeeded", "changes": [{"changeType": "Create", "resourceId": "/reviewed"}]}
        deploy.write_json(self.state / "plan.json", value)
        self.deployment.state["plan"] = {"sha256": deploy.digest(value), "createdAt": deploy.now(),
                                          "inputsSha256": deploy.digest(self.deployment.inputs())}
        self.options.approve_plan = deploy.digest(value)
        changed = {"status": "Succeeded", "changes": [{"changeType": "Create", "resourceId": "/different"}]}
        with patch.object(self.deployment, "prepare_iac", return_value=[]), \
                patch.object(self.deployment, "az", side_effect=[False, changed]) as az, self.assertRaises(deploy.DeployError):
            self.deployment.provision()
        self.assertEqual(az.call_count, 2)
        self.assertNotIn("infra", self.deployment.state["stages"])

    def test_terraform_applies_only_saved_plan_and_never_auto_approves_generated_changes(self):
        self.deployment.config = {**self.config, "engine": "terraform"}
        value = {"resource_changes": [{"change": {"actions": ["create"]}}]}
        deploy.write_json(self.state / "plan.json", value)
        self.deployment.state["plan"] = {"sha256": deploy.digest(value), "createdAt": deploy.now(),
                                          "inputsSha256": deploy.digest(self.deployment.inputs())}
        self.options.approve_plan = deploy.digest(value)
        outputs = {"deployment": {"value": {"vmName": "vm-ccgc-synthetic"}}}
        with patch.object(self.deployment, "prepare_iac", return_value=[]), \
                patch.object(self.deployment, "az", return_value=False), \
                patch.object(self.deployment, "terraform", side_effect=[json.dumps(value), "", json.dumps(outputs)]) as terraform, \
                patch.object(self.deployment, "verify_outputs"):
            self.deployment.provision()
        self.assertEqual(terraform.call_args_list[1].args, ("apply", "-input=false", "-no-color", "deployment.tfplan"))
        self.assertIn("infra", self.deployment.state["stages"])

    def test_approval_timestamp_is_not_renewed_when_resuming(self):
        value = {"status": "Succeeded", "changes": []}
        self.deployment.state["plan"] = {"sha256": deploy.digest(value), "createdAt": "2020-01-01T00:00:00Z",
                                          "inputsSha256": deploy.digest(self.deployment.inputs())}
        self.options.approve_plan = deploy.digest(value)
        with patch.object(self.deployment, "az") as az, self.assertRaises(deploy.DeployError):
            self.deployment.provision()
        az.assert_not_called()


if __name__ == "__main__":
    unittest.main()
