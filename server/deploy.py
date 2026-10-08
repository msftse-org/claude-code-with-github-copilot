"""Resumable, approval-gated deployment of the reviewed single-user Azure profile."""

import argparse
import base64
from datetime import datetime, timedelta, timezone
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, build_opener
import uuid

ROOT = Path(__file__).resolve().parent.parent
CLIENT_VERSION = "2.1.284"
STAGES = ("infra", "host", "gateway", "client", "verified")


class DeployError(Exception):
    pass


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def private_directory(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise DeployError("Deployment state must be a private directory owned by the operator.")
    if any(parent.is_symlink() for parent in (path, *path.parents)):
        raise DeployError("Deployment state cannot have symlink ancestors.")


def read_json(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > 16 * 1024 * 1024 or info.st_uid != os.getuid():
            raise DeployError("JSON input must be a bounded regular file owned by the operator.")
        value = json.load(handle)
    if not isinstance(value, dict):
        raise DeployError(f"Expected a JSON object: {path.name}")
    return value


def write_json(path, value):
    if path.is_symlink():
        raise DeployError("Refusing to replace a symlink.")
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".ccgc-")
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(value, handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def operator_ip(value):
    if not isinstance(value, str):
        raise DeployError("operatorIpv4Cidr must be a string containing one public IPv4 /32.")
    try:
        network = ipaddress.IPv4Network(value, strict=True)
        address = network.network_address
        if str(network) != value or network.prefixlen != 32 or not address.is_global or address.is_multicast:
            raise ValueError()
        return str(address)
    except ValueError:
        raise DeployError("operatorIpv4Cidr must be one globally routable IPv4 /32.") from None


def config_file(path):
    config = read_json(path)
    required = {"engine", "subscriptionId", "tenantId", "deploymentName", "operatorIpv4Cidr",
                "sshPrivateKeyFile", "sshPublicKeyFile", "githubLogin", "githubAccountId", "model"}
    if set(config) != required:
        raise DeployError("Config must contain exactly: " + ", ".join(sorted(required)))
    if config["engine"] not in ("bicep", "terraform"):
        raise DeployError("engine must be bicep or terraform.")
    for key in ("subscriptionId", "tenantId"):
        try:
            config[key] = str(uuid.UUID(config[key]))
        except (ValueError, TypeError, AttributeError):
            raise DeployError(f"{key} must be a UUID.") from None
    for key, pattern in {
        "deploymentName": r"[a-z][a-z0-9-]{1,30}[a-z0-9]",
        "githubLogin": r"[A-Za-z0-9][A-Za-z0-9-]{0,38}",
        "model": r"claude-[a-z0-9.-]+",
    }.items():
        if not isinstance(config[key], str) or not re.fullmatch(pattern, config[key]):
            raise DeployError(f"Invalid {key}; use exact identifiers, not display names.")
    if type(config["githubAccountId"]) is not int or config["githubAccountId"] <= 0:
        raise DeployError("githubAccountId must be the intended account's positive immutable numeric ID.")
    operator_ip(config["operatorIpv4Cidr"])
    for key in ("sshPrivateKeyFile", "sshPublicKeyFile"):
        value = Path(config[key]).expanduser()
        if not value.is_absolute() or value.is_symlink() or not value.is_file():
            raise DeployError(f"{key} must name an existing absolute regular key file.")
        config[key] = str(value)
    info = Path(config["sshPrivateKeyFile"]).stat()
    if info.st_mode & 0o077 or info.st_uid != os.getuid():
        raise DeployError("SSH private key must be owned by you with mode 0600 or stricter.")
    return config


def run(args, *, cwd=ROOT, input=None, interactive=False, timeout=600):
    result = subprocess.run([str(arg) for arg in args], cwd=cwd, input=input,
                            stdout=None if interactive else subprocess.PIPE,
                            stderr=None if interactive else subprocess.PIPE,
                            text=True, timeout=timeout, check=False)
    if result.returncode:
        # Raw provider errors may include secrets. Interactive operator commands have no credential output.
        raise DeployError(f"{Path(str(args[0])).name} failed (exit {result.returncode}); "
                          "no later stage ran. Inspect the failed stage privately; no automatic fallback.")
    return result.stdout or ""


def checked_plan(engine, value):
    if engine == "terraform":
        if value.get("errored") or not isinstance(value.get("resource_changes"), list):
            raise DeployError("Terraform did not produce an applicable resource plan.")
        changes = [row["change"]["actions"] for row in value.get("resource_changes", [])]
        if any(actions not in (["create"], ["read"], ["no-op"]) for actions in changes):
            raise DeployError("Plan would change/delete existing resources. This automation is create/resume-only.")
    else:
        if value.get("status") != "Succeeded" or not isinstance(value.get("changes"), list):
            raise DeployError("Azure what-if did not return a successful complete change list.")
        if any(row.get("changeType") not in ("Create", "NoChange", "Ignore") for row in value["changes"]):
            raise DeployError("What-if contains modifications, deletions or ambiguous changes; operator review required.")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise DeployError("Gateway redirect rejected.")


def health(url, seconds=180):
    deadline = time.monotonic() + seconds
    opener = build_opener(NoRedirect)
    while True:
        try:
            with opener.open(url + "/healthz", timeout=10) as response:
                if response.status == 200 and json.load(response).get("status") == "listening":
                    break
        except (URLError, TimeoutError):
            if time.monotonic() >= deadline:
                raise DeployError("Gateway HTTPS readiness timed out; inference was not attempted.") from None
        if time.monotonic() >= deadline:
            raise DeployError("Gateway did not become ready.")
        time.sleep(3)
    try:
        opener.open(url + "/ccgc/info", timeout=10).close()
    except HTTPError as error:
        if error.code == 401:
            return
        raise DeployError("Protected endpoint did not return the expected 401.") from None
    raise DeployError("Gateway control endpoint unexpectedly allowed unauthenticated access.")


class Deployment:
    def __init__(self, config, directory, options):
        self.config, self.directory, self.options = config, directory, options
        self.path = directory / "state.json"
        self.state = read_json(self.path) if self.path.exists() else {
            "version": 1, "createdAt": now(), "config": config, "stages": {},
        }
        if self.state["config"] != config:
            raise DeployError("Deployment config/engine differs from saved state. Never switch engines or adopt a host implicitly.")
        self.save()

    def save(self):
        self.state["updatedAt"] = now()
        write_json(self.path, self.state)

    def mark(self, stage):
        self.state["stages"][stage] = {"completedAt": now()}
        self.save()

    def require(self, flag):
        if not getattr(self.options, flag, False):
            raise DeployError("Explicit approval required: --" + flag.replace("_", "-"))

    def az(self, *args, timeout=600):
        return json.loads(run(["az", *args, "--subscription", self.config["subscriptionId"],
                               "--only-show-errors", "--output", "json"], timeout=timeout))

    @property
    def group(self):
        return "rg-" + self.config["deploymentName"]

    @property
    def fqdn(self):
        return self.config["deploymentName"] + ".swedencentral.cloudapp.azure.com"

    def preflight(self, client=False):
        for tool in ("az", "ssh", "ssh-keygen", "scp", "tar"):
            if not shutil.which(tool):
                raise DeployError(f"Missing prerequisite: {tool}. No automatic tool installation.")
        account = self.az("account", "show")
        if account["tenantId"] != self.config["tenantId"] or account["id"] != self.config["subscriptionId"]:
            raise DeployError("Azure CLI tenant/subscription does not match the explicit deployment config.")
        subscription = "/subscriptions/" + self.config["subscriptionId"]
        feature = self.az("feature", "show", "--namespace", "Microsoft.Compute", "--name", "EncryptionAtHost")
        if feature.get("properties", {}).get("state") != "Registered":
            raise DeployError("EncryptionAtHost must already be registered in this subscription; obtain administrator approval.")
        pricing = self.az("rest", "--method", "get", "--url",
                          f"https://management.azure.com{subscription}/providers/Microsoft.Security/pricings/VirtualMachines?api-version=2024-01-01")
        if pricing["properties"].get("pricingTier") != "Standard" or pricing["properties"].get("subPlan") != "P2":
            raise DeployError("Existing Defender for Servers P2 is required for JIT. Automation will not change subscription governance/billing.")
        public = Path(self.config["sshPublicKeyFile"]).read_text().strip()
        derived = run(["ssh-keygen", "-y", "-P", "", "-f", self.config["sshPrivateKeyFile"]]).strip()
        if len(public.split()) < 2 or public.split()[:2] != derived.split()[:2]:
            raise DeployError("SSH public/private keys do not match.")
        if not re.fullmatch(r"ssh-(?:ed25519|rsa) [A-Za-z0-9+/=]+(?: [^\r\n]*)?", public):
            raise DeployError("Expected one RSA or Ed25519 public key.")
        self.public_key = public
        if client:
            if sys.platform != "darwin":
                raise DeployError("The current client/Keychain profile supports macOS only. Use --until gateway on other hosts.")
            if not shutil.which("node") or not run(["node", "--version"]).startswith("v24."):
                raise DeployError("Node.js 24 is required for client configuration and probes.")
            profile = Path.home() / ".local/share/ccgc/remote/profile.json"
            if profile.exists():
                saved = read_json(profile)
                if saved.get("gateway") != "https://" + self.fqdn:
                    raise DeployError("Mac is enrolled in a different gateway. Use --until gateway; automation will not replace that enrollment.")
                info = saved.get("info", {})
                if (info.get("login") != self.config["githubLogin"] or info.get("accountId") != self.config["githubAccountId"]
                        or info.get("model", {}).get("id") != self.config["model"]):
                    raise DeployError("Existing client account/default-model binding differs from the deployment configuration.")
            if shutil.which("claude"):
                installed = run(["claude", "--version"]).split()[0]
                if installed != CLIENT_VERSION and not self.options.install_client:
                    raise DeployError(f"Claude {CLIENT_VERSION} required; approve --install-client or install it explicitly.")
            elif not self.options.install_client:
                raise DeployError(f"Claude {CLIENT_VERSION} is missing; approve --install-client or install it explicitly.")

    def workspace(self):
        target = self.directory / "iac"
        if target.exists():
            return target
        target.mkdir(mode=0o700)
        for path in (ROOT / "infra").rglob("*"):
            if path.is_file() and (path.suffix in (".tf", ".bicep", ".yaml", ".hcl") or path.name == "bicepconfig.json"):
                if ".terraform" in path.parts:
                    continue
                destination = target / path.relative_to(ROOT / "infra")
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, destination)
        return target

    def inputs(self):
        config = self.config
        return {
            "deploymentName": config["deploymentName"], "location": "swedencentral",
            "operatorIpv4Address": operator_ip(config["operatorIpv4Cidr"]),
            "sshPublicKey": self.public_key, "createdAt": self.state["createdAt"],
        }

    def terraform(self, *args):
        return run(["terraform", *args], cwd=self.workspace() / "terraform", timeout=1800)

    def prepare_iac(self):
        values = self.inputs()
        if self.config["engine"] == "bicep":
            path = self.directory / "parameters.json"
            write_json(path, {"$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
                             "contentVersion": "1.0.0.0", "parameters": {key: {"value": value} for key, value in values.items()}})
            return ["--location", "swedencentral", "--name", self.config["deploymentName"],
                    "--template-file", str(self.workspace() / "bicep/main.bicep"), "--parameters", "@" + str(path)]
        if not shutil.which("terraform"):
            raise DeployError("Terraform >=1.9, <2 is required.")
        if any(value and key.startswith(("ARM_", "TF_CLI_ARGS", "TF_VAR_")) for key, value in os.environ.items()):
            raise DeployError("This profile uses the verified Azure CLI login and saved inputs; remove ARM_/TF_CLI_ARGS/TF_VAR_ overrides.")
        write_json(self.workspace() / "terraform/deployment.auto.tfvars.json", {
            "deployment_name": values["deploymentName"], "location": values["location"],
            "operator_ipv4_address": values["operatorIpv4Address"], "ssh_public_key": values["sshPublicKey"],
            "created_at": values["createdAt"], "subscription_id": self.config["subscriptionId"],
            "tenant_id": self.config["tenantId"],
        })
        self.terraform("init", "-input=false", "-no-color", "-lockfile=readonly")
        self.terraform("validate", "-no-color")
        return []

    def plan(self):
        self.preflight()
        if "infra" in self.state["stages"]:
            raise DeployError("Infrastructure is already provisioned. Use access/recover; do not reapply an NSG over Defender-managed rules.")
        exists = self.az("group", "exists", "--name", self.group)
        if exists and not self.state.get("provisionStarted"):
            raise DeployError("Target resource group already exists. Use a new deployment name; adoption/import is not automatic.")
        if exists:
            group = self.az("group", "show", "--name", self.group)
            if group.get("tags", {}).get("ccgc-deployment") != self.config["deploymentName"]:
                raise DeployError("Existing group is not owned by this deployment.")
        skus = self.az("vm", "list-skus", "--location", "swedencentral", "--size", "Standard_D2as_v5", "--all")
        sku = next((row for row in skus if row["name"] == "Standard_D2as_v5"), None)
        if not sku or any(row["type"] == "Location" for row in sku.get("restrictions", [])):
            raise DeployError("Reviewed D-series SKU unavailable for this subscription/region. No SKU/region fallback.")
        usage = self.az("vm", "list-usage", "--location", "swedencentral")
        for name in ("cores", sku["family"]):
            row = next((item for item in usage if item["name"]["value"].lower() == name.lower()), None)
            if not row or row["limit"] - row["currentValue"] < 2:
                raise DeployError("Insufficient regional or D-series vCPU quota; request quota explicitly.")
        args = self.prepare_iac()
        if self.config["engine"] == "bicep":
            value = self.az("deployment", "sub", "what-if", *args, "--no-pretty-print")
        else:
            self.terraform("plan", "-input=false", "-no-color", "-out=deployment.tfplan")
            value = json.loads(self.terraform("show", "-json", "deployment.tfplan"))
        checked_plan(self.config["engine"], value)
        write_json(self.directory / "plan.json", value)
        self.state["plan"] = {"sha256": digest(value), "createdAt": now(), "inputsSha256": digest(self.inputs())}
        self.save()
        print(json.dumps({"status": "plan-ready", "engine": self.config["engine"], "subscription": self.config["subscriptionId"],
                          "resourceGroup": self.group, "region": "swedencentral", "vmSize": "Standard_D2as_v5",
                          "planFile": str(self.directory / "plan.json"), "approvePlan": self.state["plan"]["sha256"],
                          "costApprovalRequired": "Review current VM, disk, public IPv4, bandwidth and Defender costs; no price is inferred."}, indent=2))

    def provision(self):
        if "infra" in self.state["stages"]:
            self.verify_outputs(self.state["outputs"])
            return
        plan = self.state.get("plan")
        if not plan or self.options.approve_plan != plan["sha256"]:
            raise DeployError("Run plan, review changes/costs, then pass its exact --approve-plan SHA256.")
        if now()[:10] != plan["createdAt"][:10] or plan["inputsSha256"] != digest(self.inputs()):
            raise DeployError("Plan expired or inputs changed. Generate and review a new plan.")
        if digest(read_json(self.directory / "plan.json")) != plan["sha256"]:
            raise DeployError("Saved plan was modified.")
        args = self.prepare_iac()
        if not self.state.get("provisionStarted") and self.az("group", "exists", "--name", self.group):
            raise DeployError("Target appeared after planning. Refusing to adopt existing infrastructure.")
        self.state["provisionStarted"] = now()
        self.save()
        if self.config["engine"] == "bicep":
            current = self.az("deployment", "sub", "what-if", *args, "--no-pretty-print")
            checked_plan("bicep", current)
            if digest(current) != plan["sha256"]:
                raise DeployError("Azure what-if changed since approval. Run plan again.")
            result = self.az("deployment", "sub", "create", *args, timeout=1800)
            outputs = {key: row["value"] for key, row in result["properties"]["outputs"].items()}
        else:
            current = json.loads(self.terraform("show", "-json", "deployment.tfplan"))
            if digest(current) != plan["sha256"]:
                raise DeployError("Terraform saved plan no longer matches approval.")
            self.terraform("apply", "-input=false", "-no-color", "deployment.tfplan")
            outputs = json.loads(self.terraform("output", "-json"))["deployment"]["value"]
        self.verify_outputs(outputs)
        self.state["outputs"] = outputs
        self.mark("infra")

    def verify_outputs(self, outputs):
        config = self.config
        vm_id = f"/subscriptions/{config['subscriptionId']}/resourceGroups/{self.group}/providers/Microsoft.Compute/virtualMachines/vm-{config['deploymentName']}"
        expected = {"vmId": vm_id, "resourceGroupName": self.group, "vmName": "vm-" + config["deploymentName"],
                    "publicFqdn": self.fqdn, "gatewayUrl": "https://" + self.fqdn, "adminUsername": "ccgcadmin",
                    "sshAccessPolicyId": f"/subscriptions/{config['subscriptionId']}/resourceGroups/{self.group}/providers/Microsoft.Security/locations/swedencentral/jitNetworkAccessPolicies/ccgc-ssh"}
        if any(outputs.get(key) != value for key, value in expected.items()):
            raise DeployError("Infrastructure outputs do not match the approved deployment contract.")
        if not ipaddress.IPv4Address(outputs["publicIpAddress"]).is_global:
            raise DeployError("Infrastructure did not return a public IPv4 address.")

    def ssh(self, command, **kwargs):
        args = ["ssh", "-T", "-i", self.config["sshPrivateKeyFile"], "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
                "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=" + str(self.directory / "known_hosts"),
                "-o", "HostKeyAlgorithms=ssh-ed25519", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=30",
                "-o", "ServerAliveCountMax=3", "ccgcadmin@" + self.fqdn, command]
        return run(args, **kwargs)

    def access(self):
        self.require("approve_access")
        outputs = self.state.get("outputs")
        if not outputs:
            raise DeployError("Provision infrastructure first.")
        self.verify_outputs(outputs)
        source = operator_ip(self.options.operator_ipv4_cidr or self.config["operatorIpv4Cidr"])
        vm_id = outputs["vmId"]
        policy = {"kind": "Basic", "properties": {"virtualMachines": [{
            "id": vm_id, "ports": [{"number": 22, "protocol": "TCP", "allowedSourceAddressPrefix": source + "/32",
                                   "maxRequestAccessDuration": "PT1H"}],
        }]}}
        policy_url = "https://management.azure.com" + outputs["sshAccessPolicyId"]
        self.az("rest", "--method", "put", "--url", policy_url + "?api-version=2020-01-01", "--body", json.dumps(policy))
        end = (datetime.now(timezone.utc) + timedelta(minutes=55)).isoformat()
        request = {"virtualMachines": [{"id": vm_id, "ports": [{
            "number": 22, "allowedSourceAddressPrefix": source + "/32", "endTimeUtc": end,
        }]}], "justification": "CCGC explicit operator deployment access"}
        self.az("rest", "--method", "post", "--url", policy_url + "/initiate?api-version=2020-01-01", "--body", json.dumps(request))
        result = self.az("vm", "run-command", "invoke", "--resource-group", self.group, "--name", outputs["vmName"],
                         "--command-id", "RunShellScript", "--scripts",
                         "set -eu; cloud-init status --wait >/dev/null; cat /etc/ssh/ssh_host_ed25519_key.pub", timeout=900)
        public_keys = []
        for row in result.get("value", []):
            public_keys += re.findall(r"(?m)^ssh-ed25519 ([A-Za-z0-9+/=]+)(?: [^\n]*)?$", row.get("message", ""))
        if len(set(public_keys)) != 1:
            raise DeployError("Azure Run Command did not return one unambiguous SSH host key.")
        key = public_keys[0]
        base64.b64decode(key, validate=True)
        content = f"{self.fqdn},{outputs['publicIpAddress']} ssh-ed25519 {key}\n"
        known = self.directory / "known_hosts"
        if known.exists() and known.read_text() != content:
            raise DeployError("SSH host identity changed. Review it explicitly; known_hosts was not replaced.")
        if not known.exists():
            with open(known, "x", opener=lambda path, flags: os.open(path, flags | os.O_NOFOLLOW, 0o600)) as handle:
                handle.write(content)
        for attempt in range(12):
            try:
                self.ssh("true", timeout=25)
                return
            except DeployError:
                if attempt == 11:
                    raise DeployError("JIT SSH unavailable after bounded propagation wait; governance was not bypassed.") from None
                time.sleep(5)

    def recover(self):
        self.require("accept_unofficial")
        self.require("approve_access")
        outputs = self.state.get("outputs")
        if not outputs or "host" not in self.state["stages"]:
            raise DeployError("Complete host installation with up before requesting recovery.")
        view = self.az("vm", "get-instance-view", "--resource-group", self.group, "--name", outputs["vmName"])
        running = any(row.get("code") == "PowerState/running" for row in view.get("instanceView", {}).get("statuses", []))
        if not running:
            self.require("approve_start")
            run(["az", "vm", "start", "--subscription", self.config["subscriptionId"],
                 "--resource-group", self.group, "--name", outputs["vmName"], "--only-show-errors"])
        self.access()
        self.gateway()

    def host(self, action, *args, **kwargs):
        return self.ssh(shlex.join(["sudo", "-n", "bash", "/opt/ccgc/server/deploy-host.sh", action, self.fqdn, *args]), **kwargs)

    def install(self):
        archive = self.directory / "source.tar.gz"
        if not archive.exists():
            run(["bash", ROOT / "server/azure-deploy.sh", "package", archive])
        sha = hashlib.sha256(archive.read_bytes()).hexdigest()
        if self.state.get("sourceSha256", sha) != sha:
            raise DeployError("Source archive changed during deployment; refusing an implicit upgrade.")
        self.state["sourceSha256"] = sha
        self.save()
        remote_archive = f"/home/ccgcadmin/ccgc-{sha}.tar.gz"
        # Stream the allowlisted non-secret archive over the already verified SSH connection.
        with archive.open("rb") as handle:
            command = shlex.join(["sh", "-c", 'umask 077; cat > "$1"', "sh", remote_archive])
            result = subprocess.run(["ssh", "-T", "-i", self.config["sshPrivateKeyFile"], "-o", "IdentitiesOnly=yes",
                                     "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
                                     "-o", "UserKnownHostsFile=" + str(self.directory / "known_hosts"),
                                     "-o", "HostKeyAlgorithms=ssh-ed25519", "-o", "ConnectTimeout=15",
                                     "ccgcadmin@" + self.fqdn, command], stdin=handle, timeout=120, check=False)
            if result.returncode:
                raise DeployError("Source upload failed.")
        script = r"""
import hashlib, os, pathlib, shutil, tarfile, tempfile
os.umask(0o022)
archive = pathlib.Path(ARCHIVE)
target = pathlib.Path('/opt/ccgc')
marker = target / '.ccgc-source-sha256'
if hashlib.sha256(archive.read_bytes()).hexdigest() != SHA:
    raise SystemExit('Source checksum mismatch')
if target.is_symlink():
    raise SystemExit('Source destination is a symlink')
if target.exists():
    if not marker.is_file() or marker.read_text().strip() != SHA:
        raise SystemExit('Existing source is not this release; refusing overwrite/implicit upgrade')
else:
    stage = pathlib.Path(tempfile.mkdtemp(prefix='ccgc-stage-', dir='/opt'))
    try:
        with tarfile.open(archive) as bundle:
            for member in bundle.getmembers():
                path = pathlib.PurePosixPath(member.name)
                if not member.isfile() or path.is_absolute() or '..' in path.parts:
                    raise SystemExit('Unsafe archive member')
            bundle.extractall(stage, filter='data')
        (stage / '.ccgc-source-sha256').write_text(SHA + '\n')
        stage.chmod(0o755)
        os.rename(stage, target)
    finally:
        if stage.exists():
            shutil.rmtree(stage)
archive.unlink()
"""
        script = script.replace("ARCHIVE", repr(remote_archive)).replace("SHA", repr(sha))
        self.ssh("sudo -n python3 -", input=script)
        if "host" not in self.state["stages"]:
            self.host("prepare", interactive=True, timeout=1800)
            self.mark("host")

    def gateway(self):
        self.require("accept_unofficial")
        status = json.loads(self.host("status"))
        if status["status"] != "initialized":
            # Device codes are terminal-only: do not capture or persist authorization output.
            self.host("authorize", interactive=True, timeout=600)
            self.host("init", self.config["githubLogin"], str(self.config["githubAccountId"]), self.config["model"])
            status = json.loads(self.host("status"))
        if (status["login"] != self.config["githubLogin"] or status["accountId"] != self.config["githubAccountId"]
                or status["model"] != self.config["model"] or status["publicUrl"] != "https://" + self.fqdn):
            raise DeployError("Existing protected account/model/URL differs from configuration. Nothing was replaced.")
        info = json.loads(self.host("verify"))
        if "models" not in info:
            raise DeployError("Legacy single-model metadata requires a separately approved catalog migration.")
        self.host("activate", interactive=True)
        health("https://" + self.fqdn)
        runtime = json.loads(self.host("inspect"))
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", str(runtime.get("imageId", ""))):
            raise DeployError("Running gateway/LiteLLM image identity could not be recorded.")
        if self.state.get("runtime") != runtime:
            self.state["stages"].pop("verified", None)
        self.state["runtime"] = runtime
        self.mark("gateway")

    def client(self):
        self.require("approve_client")
        if self.options.install_client and (not shutil.which("claude") or run(["claude", "--version"]).split()[0] != CLIENT_VERSION):
            if shutil.which("claude"):
                run(["claude", "install", CLIENT_VERSION], interactive=True)
            else:
                # Download the official installer to a private file; do not pipe a network response into a shell.
                installer = self.directory / "claude-install.sh"
                run(["curl", "--fail", "--silent", "--show-error", "--location", "--proto", "=https",
                     "--proto-redir", "=https", "https://claude.ai/install.sh", "--output", installer])
                run(["bash", installer, CLIENT_VERSION], interactive=True)
                installer.unlink()
                os.environ["PATH"] = str(Path.home() / ".local/bin") + os.pathsep + os.environ.get("PATH", "")
        if run(["claude", "--version"]).split()[0] != CLIENT_VERSION:
            raise DeployError("Official Claude installation does not match the reviewed version.")
        cli = ["node", ROOT / "src/cli.ts"]
        profile_path = Path.home() / ".local/share/ccgc/remote/profile.json"
        if profile_path.exists():
            profile = read_json(profile_path)
            if profile.get("gateway") != "https://" + self.fqdn:
                raise DeployError("Mac is already enrolled in another gateway. Existing settings and Keychain were preserved.")
        else:
            # Credential goes only through process pipes, never argv, logs, files or Terraform state.
            secret = self.host("owner-key").strip()
            try:
                if not re.fullmatch(r"[a-f0-9]{64}", secret):
                    raise DeployError("Owner-key transfer returned an invalid credential.")
                run([*cli, "login", "--gateway", "https://" + self.fqdn, "--accept-unofficial"], input=secret)
            finally:
                secret = None
        for name, path in (("claude-settings", Path.home() / ".claude/settings.json"), ("client-profile", profile_path)):
            backup = self.directory / (name + ".before.json")
            if path.exists() and not backup.exists():
                if path.is_symlink():
                    raise DeployError("Client settings/profile is a symlink; refusing backup or mutation.")
                write_json(backup, read_json(path))
        run([*cli, "configure", "--apply"])
        self.mark("client")

    def verify(self):
        self.require("approve_live")
        self.require("accept_unofficial")
        health("https://" + self.fqdn)
        # The smoke command refuses an existing admission and never closes someone else's session.
        report = json.loads(run(["node", ROOT / "src/deployment-smoke.ts", "--accept-unofficial"], timeout=900))
        write_json(self.directory / "live-verification.json", report)
        self.mark("verified")

    def admit(self):
        self.require("approve_live")
        self.require("accept_unofficial")
        report = json.loads(run(["node", ROOT / "src/deployment-smoke.ts", "--accept-unofficial", "--admit-only"], timeout=120))
        write_json(self.directory / "admission.json", report)

    def up(self):
        until = STAGES.index(self.options.until)
        if until >= 1:
            self.require("approve_access")
        if until >= 2:
            self.require("accept_unofficial")
        if until >= 3:
            self.require("approve_client")
        if until >= 4:
            self.require("approve_live")
        self.preflight(client=until >= 3)
        self.provision()
        if until == 0:
            return
        self.access()
        self.install()
        if until == 1:
            return
        self.gateway()
        if until == 2:
            return
        self.client()
        if until >= 4:
            if "verified" not in self.state["stages"]:
                self.verify()
            else:
                self.admit()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("plan", "up", "status", "access", "recover", "verify", "admit"))
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--state-dir", type=Path, help="Private local deployment state directory; never put this in Git or cloud sync.")
    parser.add_argument("--until", choices=STAGES, default="verified")
    parser.add_argument("--approve-plan", help="SHA256 emitted by plan; confirms reviewed changes and hosting costs.")
    parser.add_argument("--approve-access", action="store_true")
    parser.add_argument("--accept-unofficial", action="store_true")
    parser.add_argument("--approve-client", action="store_true")
    parser.add_argument("--approve-live", action="store_true")
    parser.add_argument("--approve-start", action="store_true", help="Allow recover to start a stopped VM and resume hosting charges.")
    parser.add_argument("--install-client", action="store_true")
    parser.add_argument("--operator-ipv4-cidr", help="Explicit current /32 for access-only policy updates.")
    options = parser.parse_args(argv)
    os.umask(0o077)
    config = config_file(options.config)
    directory = (options.state_dir or Path.home() / ".local/state/ccgc/deployments" / config["deploymentName"]).expanduser().absolute()
    if ROOT == directory or ROOT in directory.parents:
        raise DeployError("Keep deployment state outside the repository and cloud-synced checkout.")
    private_directory(directory)
    with open(directory / "lock", "a", opener=lambda path, flags: os.open(path, flags | os.O_NOFOLLOW, 0o600)) as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise DeployError("Another coordinator owns this deployment.") from None
        deployment = Deployment(config, directory, options)
        if options.command == "status":
            print(json.dumps({"stateDirectory": str(directory), "stages": deployment.state["stages"],
                              "createdAt": deployment.state["createdAt"], "liveProof": deployment.state.get("stages", {}).get("verified", "not-run")}, indent=2))
        elif options.command in ("plan", "up"):
            getattr(deployment, options.command)()
        elif options.command in ("access", "recover"):
            deployment.preflight()
            getattr(deployment, options.command)()
        else:
            deployment.preflight(client=True)
            getattr(deployment, options.command)()
        if options.command not in ("plan", "status"):
            print(json.dumps({"status": "completed", "command": options.command,
                              "stages": list(deployment.state["stages"]), "gateway": "https://" + deployment.fqdn}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (DeployError, OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(f"DEPLOY_BLOCKED: {error}", file=sys.stderr)
        sys.exit(1)
