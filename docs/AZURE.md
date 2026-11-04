# Azure proof host: Sweden Central

**Status, 2026-10-07: active multi-model HTTPS gateway and live CLI proof.**

For a new named deployment, use [the Bicep/Terraform automation](AUTOMATION.md).
It reuses the proven host topology and post-provisioning sequence without
adopting or changing the proof host described below.
The owner separately approved the $90.21/month D-series deployment, then
authorized account linking, activation and client setup. The linked account is
bound to default `claude-sonnet-5.5` and all six enabled Claude models;
LiteLLM, Node and Caddy are running, and private server credentials were
preserved through the catalog upgrade.

Bicep/ARM provisioning, cloud-init, Docker/Compose and verified-SSH source upload
succeeded. The catalog runtime passed fifteen bootstrap and four installed-package
checks. LiteLLM 1.108.0's authentication-error path uses pinned `prisma==0.11.0`,
returning HTTP 401 without adding a database. Caddy has a valid public TLS
certificate. Actual Claude Code 2.1.284 passed its live route probe, then seven
Read/Edit/Bash workflows while switching through all six models and back to
Sonnet 5.5 through the Copilot enterprise endpoint. All 33 native requests in
that run returned HTTP 200; the admission retained one cumulative attempt budget.
This is single-user feasibility evidence, not production certification.

## Approved architecture

One general-purpose D-series Ubuntu 24.04 VM runs the existing Caddy, Node admission gateway and LiteLLM
containers. The client and macOS Keychain helper remain on the developer's Mac.
This avoids changing LiteLLM's private POSIX token store to fit a shared PaaS
mount. No APIM, ACR, database, managed identity, Key Vault or payload telemetry
service is added.

| Item | Deployed value |
|---|---|
| Subscription | `ME-MngEnvMCAP994670-shironbabi-1` / `b8242aba-c397-4474-82e4-c96cbfd7fa7b` |
| Resource group | `rg-ccgc-dev-87b7` |
| Region | `swedencentral`, no automatic regional fallback |
| VM | `vm-ccgc-dev-87b7`, `Standard_D2as_v5`, 2 vCPU / 8 GiB, AMD x64, non-burstable |
| Image | `Canonical:ubuntu-24_04-lts:server:24.04.202609040`, x64 / Gen2 |
| Boot security | Trusted Launch, Secure Boot and vTPM |
| OS/state disk | `osdisk-ccgc-dev-87b7`, 64 GiB Standard SSD LRS, Azure encryption at rest |
| Networking | `vnet-ccgc-dev-87b7`, `nsg-ccgc-dev-87b7`, `nic-ccgc-dev-87b7` |
| Public IP | `pip-ccgc-dev-87b7`, Standard static IPv4 |
| Hostname | `ccgc-dev-87b7.swedencentral.cloudapp.azure.com`, resolves to `135.225.75.22` |
| Operator | `ccgcadmin`, dedicated SSH key; Defender JIT TCP 22 from operator `/32`, maximum one hour |
| Public service ports | 80/443 for Caddy; never 4000/8080 or Docker |
| Runtime | Node 24.18.1, Python 3.14.6, LiteLLM 1.108.0, Caddy 2.11.2 |

At provisioning handoff, only operator-restricted SSH responded. At 13:25 UTC
on 2026-10-06, `MCAPSGovernance-AutomationApp` removed `allow-ssh-operator`;
the healthy VM became unreachable by SSH. With the owner's access-repair
authorization, an access-only Bicep deployment created Defender JIT policy
`ccgc-ssh` at 14:23 UTC. A 55-minute request from `167.220.205.20/32` succeeded,
and strict SSH login was verified at 14:24 UTC. That window expired at
15:18:28 UTC; future connections require a current JIT request.
No governance automation or inherited Defender protection was disabled.
Defender manages its temporary allow and deny rules and may reprioritize
existing NSG rules. Acceptance of this window does not guarantee a permanent
governance exemption. See the [post-provisioning runbook](README.md#12-connect-from-your-mac).
Ports 80/443 now serve Caddy; internal ports 4000/8080 and Docker remain denied.
At provisioning, both production entrypoints were
confirmed to fail closed with empty account state. The `ccgc_state` volume has
UID/GID 10001 and mode 0700 on the persistent OS disk.

Live regional quota checks found 100 available regional and DASv5-family vCPUs
and 997 available Standard IPv4 addresses. The selected VM has no reported SKU
restriction and the pinned image exists in Sweden Central. These observations
do not reserve capacity or prove that deployment will succeed.

## Cost and custody

The 2026-10-06 [Azure Retail Prices API](https://prices.azure.com/api/retail/prices)
estimate is **$90.21/month** at 730 hours: VM $67.16, disk $4.80, IPv4 $3.65, and
the subscription's existing Defender for Servers P2 $14.60. The P2 setting is
unchanged and its trial has expired. Tax, disk transactions, traffic, other
policy add-ons and GitHub Copilot seat/usage are excluded. This is not a spending
cap; deallocating the VM does not eliminate disk, IP or all security charges.

The owner requested this general-purpose D-series replacement after the initial
B-series scaffold. It doubles memory to 8 GiB and removes the B-series CPU-credit
model. The owner subsequently approved the revised hosting estimate; the earlier
B-series price is not the price of this running VM. Hosting charges now accrue.

## Executed artifact evidence

The current multi-model release is image
`sha256:958ec9635e50d510fef2e2865e3ea820379822412c03e8f203119ec55c88df0b`,
tagged `ccgc-runtime:0.2.0-alpha.1` and `ccgc-runtime:catalog-tool-history`.
Its allowlisted source archive SHA256 is
`2e71642df5b6238e3e4e0e4481ca7dc6f5706cc1a180f413d440954853b842c8`.
The catalog migration retained the GitHub identity, default model, owner key,
LiteLLM key and Copilot authorization. The pre-upgrade metadata backup remains
inside protected state as `deployment.before-catalog-20261007.json`; the previous
image/source were retained for operator recovery. See
[the completed migration](README.md#4-gateway-owned-model-catalog-and-one-time-migration)
for Mac backups, exact mappings, compatibility repairs and historical failed runs.

Source lives at `/opt/ccgc` on the VM. The initial runtime preparation archive had
SHA256 `73538da9340f57cabd5c0bebb9f6e6386ec7aa78d230f970997077a125d755e0`.
That initial runtime image was `ccgc-runtime:0.2.0-alpha.1`, image ID
`sha256:2763f5ed3df3b5e83c3850fd76c358827f69f015ce1ef17b7d490646490a61ca`.
The executed Node and Python base digests and full installed dependency snapshot
are retained in the ignored onboarding session's deployment evidence. That
snapshot records this build; it is not a hash-locked reproducible dependency
specification.

The account-setup follow-up rebuilt the same tag with eligible-model discovery
and disabled operator-container logging. Its source archive SHA256 is
`0324fcd1e8301f7c0a04c7d8a6b99553d0d6d54b7dd8535cd50595d5ad3559f2`;
the image ID at that stage was
`sha256:e14131f0949792f38708b00efe6f8f10d0335d8adbc3b8d68fc77f279c080e65`.
The Node/Python base digests and dependency layer were reused unchanged.
Thirteen bootstrap checks and two installed-package checks passed on the rebuilt
image. The `operator` profile's `setup` service uses logging driver `none`;
production services stayed stopped and the private volume was rechecked empty
at that pre-authorization stage.

The 2026-10-07 compatibility continuation preserves Sonnet 5.5 effort and native
text system messages, and validates stream termination before accepting an
optional transport-only `[DONE]` suffix. Its source archive SHA256 is
`60529eb646e4c3cd5824c285833f7e432a083d46564e4df73ff5e5bc47f5e4ac`;
the current runtime image ID is
`sha256:88e85468fb7baf82b36710edbf5c439a388eb2dababafb1276c9c7e19fc56ee5`.
All thirteen bootstrap and three installed-package checks passed, with the
latter rejecting attempted network/authentication calls rather than merely
relying on Docker's disconnected network.

The actual-client live proof completed at 08:08 UTC. The effective native model
was `github_copilot/claude-sonnet-5.5` at
`https://api.enterprise.githubcopilot.com`; five internal `/v1/messages`
requests returned HTTP 200 across the probe and four-turn Read/Edit/Bash workflow.
The model response ID was checked by the gateway on each response.
The fixture changed from `alpha` to `beta`, a Bash sentinel confirmed the
check, and the admission was explicitly closed. Sanitized records are in the
ignored onboarding session's `evidence/sonnet55-live-probe-v3.log`,
`evidence/sonnet55-live-workflow-v3.json` and
`evidence/sonnet55-live-route-v3.json`; build/runtime evidence uses the matching
`sonnet55-*-v3.log` names. These observations do not prove fault-path retry,
refresh or all release requirements.

The isolated HTTP smoke test had no network, published port, persistent volume
or configured model. Its temporary credential and container were removed. Its
success proves package startup/error handling, not Copilot access, TLS, native
streaming or the full production gateway path.

SSH uses `$HOME/.ssh/ccgc-dev-87b7` and the dedicated
`$HOME/.ssh/ccgc-dev-87b7.known_hosts`, whose host key was obtained through Azure
Run Command. Preserve both files; never replace them with the deleted disposable
validation keypair or disable strict host checking.

## Persistent state and lifecycle

The Docker `ccgc_state` volume resides on the persistent OS disk, outside the
checkout. Runtime UID 10001 and mode 0700/0600 checks remain mandatory. Azure
disk encryption is not application-level credential encryption or Key Vault.
Host administrators can access state. Do not export the volume, enable payload
logging or treat disk encryption as an automatic backup. The owner authorized
the existing private-volume credential custody; no managed backup was added.
Stop serving before unlinking or changing protected account state.

The VM was found deallocated on 2026-10-07 and restarted without disabling
governance or shutdown controls; the shutdown actor remains unidentified.
Compose deliberately does not auto-restart containers. Follow the
[restart runbook](README.md#21-recover-after-a-vm-stop-or-gateway-rebuild)
to start services, verify HTTPS and refresh stale client admission state.
There is no automatic backup in this proof environment.

One VM/worker/gateway is intentional: restarts invalidate in-memory admissions,
and there is no high availability or automatic service restart. The OS disk is
retained when only the VM is deleted; deleting the whole resource group removes
the disk and its credentials too.

## Validate and provision

Requires Azure CLI, Bicep, Bash, Python 3, OpenSSH and the approved subscription.
Use a dedicated SSH key outside the repository and synchronized storage. Never
put its private key in a parameter file, shell argument, source archive or chat.

```bash
# Create this key once; do not overwrite an existing deployment's key.
install -d -m 700 "$HOME/.ssh"
ssh-keygen -t rsa -b 4096 -f "$HOME/.ssh/ccgc-dev-87b7"

export CCGC_SSH_PUBLIC_KEY_FILE="$HOME/.ssh/ccgc-dev-87b7.pub"
export CCGC_OPERATOR_IPV4_CIDR="<your-current-public-ipv4>/32"

bash server/azure-deploy.sh validate
bash server/azure-deploy.sh what-if

# Only after reviewing costs, scope and the separate deployment approval:
CCGC_APPROVE_PROVISIONING=yes bash server/azure-deploy.sh provision
```

The helper pins the subscription, region, deployment name and parameter file.
It rejects broad/nonpublic SSH sources, unexpected arguments and private-key
input. The Bicep parameters contain only nonsecret deployment values. Direct
Bicep callers pass `operatorIpv4Address` without a suffix; the JIT policy appends
`/32` itself so no caller-selected subnet width can open SSH broadly. The helper
also checks public routability. `infra/vm.bicep` no longer declares a permanent
SSH allow rule; it includes the same `infra/access.bicep` policy module used by
the access-only repair. A policy declaration does not open an access window.

The subscription already has Defender for Servers P2. JIT uses that existing
plan; this repair adds no Bastion or other paid hosting service and does not
change the approved hosting estimate.

For initial JIT configuration or a reviewed operator IP change, run these
commands from the local checkout:

```bash
export CCGC_OPERATOR_IPV4_CIDR="<your-current-public-ipv4>/32"
bash server/azure-deploy.sh access-what-if
CCGC_APPROVE_ACCESS=yes bash server/azure-deploy.sh access-configure
CCGC_APPROVE_ACCESS=yes bash server/azure-deploy.sh access-open
```

`access-configure` deploys only the policy in incremental mode. The existing
VM, disk and network resources are not redeployed; Defender applies the JIT NSG
rules. The policy fixes TCP 22, one operator `/32`, and maximum duration `PT1H`.
`access-open` requests 55 minutes and prints the request/expiry. When the IP and
policy are unchanged, only `access-open` is needed. These commands do not need
the SSH public key, initiate GitHub login or start inference.
Policy what-if may show removal of server-populated `requests` history and
`appendMode`; never copy live access requests into declarative Bicep to suppress
that difference. Treat policy reconfiguration as potentially ending current
windows and request a new one afterward.

Use the access-only path for administrative access changes. Full-host
`provision` redeploys the inline NSG rule set and can remove current
Defender-managed rules or interrupt access. Do not use it just to renew SSH;
review full-host what-if separately and request a fresh JIT window afterward.
Never keep recreating rules that governance removes; seek subscription
administrator guidance if JIT is rejected. The helper has no recovery loop.
See Microsoft's [JIT guidance](https://learn.microsoft.com/en-us/azure/defender-for-cloud/enable-just-in-time-access)
and [policy schema](https://learn.microsoft.com/en-us/azure/templates/microsoft.security/locations/jitnetworkaccesspolicies).

The deployment creates the VM and installs Docker/Compose using cloud-init.
It does **not** upload source, start inference services, initiate GitHub device
authorization, create fake deployment credentials or change Claude settings.
ARM success is followed by host and runtime checks, not reported as app health.

## Stage the source and verify the runtime

Get the actual deployment outputs, then record them in the ignored onboarding
session. The output URL is planned connectivity, not a health assertion.

```bash
az deployment sub show \
  --subscription b8242aba-c397-4474-82e4-c96cbfd7fa7b \
  --name ccgc-dev-87b7 --query properties.outputs -o json
```

Before SSH/SCP, open a current JIT window as described above. Before the first
connection, obtain the host's Ed25519 fingerprint through
the authenticated Azure control plane:

```bash
az vm run-command invoke \
  --subscription b8242aba-c397-4474-82e4-c96cbfd7fa7b \
  --resource-group rg-ccgc-dev-87b7 --name vm-ccgc-dev-87b7 \
  --command-id RunShellScript \
  --scripts 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub' \
  --query 'value[].message' -o tsv
```

Compare it with SSH's presented Ed25519 fingerprint before accepting the host
key. Thereafter use `StrictHostKeyChecking=yes` and the saved known-host entry.
Never trust `ssh-keyscan` alone or disable host-key verification.

Create a new archive at an absolute path outside the checkout:

```bash
bash server/azure-deploy.sh package /private/tmp/ccgc-source-unique.tar.gz
```

Only runtime TypeScript, package metadata, Docker/Compose/Caddy files and the
synthetic Python checks are included. Local settings, onboarding state, keys,
`.env`, dependencies and Git history are excluded; symlink inputs and archive
overwrites are rejected. Record its SHA256, transfer it with verified SSH/SCP,
and compare the remote checksum before extracting. Extract into `/opt/ccgc`
with `--no-same-owner --no-same-permissions`; never extract into the Docker
volume or overwrite a running source revision without first stopping services.
Delete the specific transferred archive after verification.

On the host, confirm `cloud-init status --wait` succeeded and Docker/Compose are
responsive. From the extracted checkout:

```bash
export CCGC_HOST="<actual-publicFqdn-output>"
sudo env CCGC_HOST="$CCGC_HOST" docker compose -f server/compose.yaml build

sudo docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --tmpfs /tmp:mode=1777,size=128m \
  --mount "type=bind,src=$PWD/server,dst=/checks,readonly" \
  --entrypoint /opt/venv/bin/python ccgc-runtime:0.2.0-alpha.1 \
  -m unittest discover -s /checks -p 'test_*.py'

sudo docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --tmpfs /tmp:mode=1777,size=128m \
  --mount "type=bind,src=$PWD/server,dst=/checks,readonly" \
  --entrypoint /opt/venv/bin/python ccgc-runtime:0.2.0-alpha.1 \
  -m unittest discover -s /checks -p 'integration_*.py'
```

Repeat these checks and capture fresh image/base digests and dependency versions
after each rebuild. The initial deployment passed them; do not reuse that result
for a changed artifact or call a failed provider check a pass. The installed
provider test mocks its authenticator and cannot establish live entitlement.
Before account linking, leave the real services stopped and report
**host/runtime prepared, inference inactive**. A separate isolated, model-less
proxy smoke test may check liveness, but it must never become the production
configuration or be presented as the Copilot service.

## Activate only after approved account linking

Follow the [post-provisioning configuration runbook](README.md) for the complete
Mac/VM procedure and separate authorization boundaries.

Review the [README access warning and operator procedure](../README.md#operator-setup-one-developer-one-linked-seat).
With the intended account and an exact enabled Claude model, complete the
interactive `setup authorize` device flow to discover eligible models, then
bind one with `setup init`; direct `init` remains available for a known exact ID.
Do not copy credentials from
another application. Then start the real containers with the actual HTTPS
hostname and verify TLS, health, unauthenticated rejection and inaccessible
internal ports before giving the developer a gateway key.

Transfer the gateway owner key through a verified SSH pipe into `ccgc login`,
never through logs or chat. The LiteLLM master key and GitHub credentials stay
on the host. Live CLI probes consume Copilot allowance and require explicit
authorization; only a successful actual-client tool workflow proves the goal.
Keeping the gateway in Sweden does not guarantee GitHub/provider inference
processing or retention is confined to Sweden.

## Stop and remove

Stop inference containers before unlinking. Follow the README's `setup unlink`
procedure and separately revoke the GitHub OAuth grant. Do not remove a
revocation marker to resurrect an old deployment.

```bash
# Stop VM compute billing; other resource charges can continue.
az vm deallocate \
  --subscription b8242aba-c397-4474-82e4-c96cbfd7fa7b \
  --resource-group rg-ccgc-dev-87b7 --name vm-ccgc-dev-87b7

# Destructive: only after explicit cleanup approval and credential-retention review.
az group delete \
  --subscription b8242aba-c397-4474-82e4-c96cbfd7fa7b \
  --name rg-ccgc-dev-87b7
```

Do not execute deletion as automatic deployment-error recovery. Confirm the
resource group contains only this deployment before deleting it. Keep source
hashes and sanitized deployment evidence, not live tokens or prompt transcripts.
