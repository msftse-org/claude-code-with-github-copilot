#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
subscription=b8242aba-c397-4474-82e4-c96cbfd7fa7b
location=swedencentral
deployment=ccgc-dev-87b7
resource_group=rg-ccgc-dev-87b7
vm=vm-ccgc-dev-87b7

fail() { printf 'AZURE_DEPLOY_BLOCKED: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'HELP'
Usage: bash server/azure-deploy.sh validate|what-if|provision
       bash server/azure-deploy.sh access-what-if|access-configure|access-open
       bash server/azure-deploy.sh package /absolute/new/archive.tar.gz

Target: Sweden Central, rg-ccgc-dev-87b7, Standard_D2as_v5 (general purpose).
All Azure actions require CCGC_OPERATOR_IPV4_CIDR.
Full-host ARM commands also require CCGC_SSH_PUBLIC_KEY_FILE.
The CIDR must be one globally routable IPv4 /32, never an entire network.
provision additionally requires CCGC_APPROVE_PROVISIONING=yes after cost approval.
access-configure deploys only the JIT policy; Defender manages its SSH NSG rules.
access-open requests TCP 22 from the operator /32 for 55 minutes (policy max 1 hour).
Both access mutations require CCGC_APPROVE_ACCESS=yes. They do not disable governance.
package creates an allowlisted source archive; it neither connects nor deploys.
No command authorizes Copilot, starts inference, or changes Claude settings.
HELP
}

action=${1:-help}
case "$action" in
  help|--help|-h) usage; exit 0 ;;
  package)
    [[ $# == 2 ]] || fail 'package requires one new absolute archive path.'
    command -v python3 >/dev/null || fail 'python3 is required.'
    python3 - "$root" "$2" <<'PY'
import hashlib
import os
from pathlib import Path
import stat
import sys
import tarfile

root = Path(sys.argv[1])
target = Path(sys.argv[2])
if not target.is_absolute() or root == target.resolve() or root in target.resolve().parents:
    sys.exit("AZURE_DEPLOY_BLOCKED: Archive must be outside the checkout at an absolute path.")
names = [
    ".dockerignore", "package.json", "server/Dockerfile", "server/pyproject.toml",
    "server/bootstrap.py", "server/compose.yaml", "server/Caddyfile",
    "server/integration_litellm.py", "server/test_bootstrap.py",
    "server/deploy-host.sh",
] + [str(p.relative_to(root)) for p in sorted((root / "src").glob("*.ts"))]
if not any(name.startswith("src/") for name in names):
    sys.exit("AZURE_DEPLOY_BLOCKED: No runtime source found.")
for name in names:
    path = root / name
    if not stat.S_ISREG(path.lstat().st_mode) or any(p.is_symlink() for p in [path, *path.parents] if p != root):
        sys.exit("AZURE_DEPLOY_BLOCKED: Archive input must be a regular file without symlink ancestors.")
try:
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
except FileExistsError:
    sys.exit("AZURE_DEPLOY_BLOCKED: Refusing to overwrite an existing archive.")
try:
    with os.fdopen(fd, "wb") as output, tarfile.open(fileobj=output, mode="w:gz") as archive:
        for name in names:
            info = archive.gettarinfo(root / name, arcname=name)
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            info.mode = 0o644
            with (root / name).open("rb") as source:
                archive.addfile(info, source)
except BaseException:
    target.unlink()
    raise
print("Source archive SHA256:", hashlib.sha256(target.read_bytes()).hexdigest())
print("Archive:", target)
PY
    exit 0
    ;;
  validate|what-if|provision|access-what-if|access-configure|access-open) [[ $# == 1 ]] || fail 'Unexpected command arguments.' ;;
  *) fail "Unknown command: $action" ;;
esac

if [[ "$action" == provision && "${CCGC_APPROVE_PROVISIONING:-}" != yes ]]; then
  fail 'Explicit deployment approval is required: CCGC_APPROVE_PROVISIONING=yes.'
fi
if [[ "$action" == access-configure || "$action" == access-open ]]; then
  [[ "${CCGC_APPROVE_ACCESS:-}" == yes ]] || fail 'Explicit access approval is required: CCGC_APPROVE_ACCESS=yes.'
fi
if [[ "$action" != access-* ]]; then
  [[ -n "${CCGC_SSH_PUBLIC_KEY_FILE:-}" ]] || fail 'Set CCGC_SSH_PUBLIC_KEY_FILE to the public key, never the private key.'
fi
[[ -n "${CCGC_OPERATOR_IPV4_CIDR:-}" ]] || fail 'Set CCGC_OPERATOR_IPV4_CIDR to your public IPv4 /32.'
command -v python3 >/dev/null || fail 'python3 is required.'
command -v az >/dev/null || fail 'Azure CLI is required.'

public_key=$(python3 - "${CCGC_SSH_PUBLIC_KEY_FILE:-}" "$CCGC_OPERATOR_IPV4_CIDR" "$action" <<'PY'
import base64
import ipaddress
import os
import stat
import sys

try:
    network = ipaddress.IPv4Network(sys.argv[2], strict=True)
    address = network.network_address
    if str(network) != sys.argv[2] or network.prefixlen != 32 or not address.is_global or address.is_multicast or address.is_reserved:
        raise ValueError("SSH source must be one public IPv4 /32.")
    if sys.argv[3].startswith("access-"):
        sys.exit(0)
    fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > 65536:
            raise ValueError("Public-key input must be a bounded regular file.")
        value = handle.read().strip()
    fields = value.split()
    if "\n" in value or "\r" in value or len(fields) < 2 or fields[0] not in ("ssh-rsa", "ssh-ed25519"):
        raise ValueError("Expected one RSA or Ed25519 SSH public key.")
    base64.b64decode(fields[1], validate=True)
except (OSError, ValueError) as error:
    sys.exit(f"AZURE_DEPLOY_BLOCKED: {error}")
print(value)
PY
)

if [[ "$action" == access-open ]]; then
  request=$(python3 - "$subscription" "$resource_group" "$vm" "$CCGC_OPERATOR_IPV4_CIDR" <<'PY'
from datetime import datetime, timedelta, timezone
import json
import sys

subscription, group, vm, source = sys.argv[1:]
end = datetime.now(timezone.utc) + timedelta(minutes=55)
print(json.dumps({
    "virtualMachines": [{
        "id": f"/subscriptions/{subscription}/resourceGroups/{group}/providers/Microsoft.Compute/virtualMachines/{vm}",
        "ports": [{"number": 22, "allowedSourceAddressPrefix": source,
                   "endTimeUtc": end.isoformat(timespec="seconds").replace("+00:00", "Z")}],
    }],
    "justification": "CCGC operator-only SSH administration",
}))
PY
)
  exec az rest --method post --subscription "$subscription" \
    --url "https://management.azure.com/subscriptions/$subscription/resourceGroups/$resource_group/providers/Microsoft.Security/locations/$location/jitNetworkAccessPolicies/ccgc-ssh/initiate?api-version=2020-01-01" \
    --headers Content-Type=application/json --body "$request"
fi

if [[ "$action" == access-* ]]; then
  operation=what-if
  [[ "$action" != access-configure ]] || operation=create
  exec az deployment group "$operation" \
    --subscription "$subscription" --resource-group "$resource_group" \
    --name "$deployment-access" --mode Incremental \
    --template-file "$root/infra/access.bicep" \
    --parameters "location=$location" "vmName=$vm" \
      "operatorIpv4Address=${CCGC_OPERATOR_IPV4_CIDR%/32}"
fi

operation=$action
[[ "$action" != provision ]] || operation=create
exec az deployment sub "$operation" \
  --subscription "$subscription" \
  --location "$location" \
  --name "$deployment" \
  --template-file "$root/infra/main.bicep" \
  --parameters "@$root/infra/main.parameters.json" \
    "operatorIpv4Address=${CCGC_OPERATOR_IPV4_CIDR%/32}" "sshPublicKey=$public_key"
