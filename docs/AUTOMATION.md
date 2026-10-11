# End-to-end deployment automation

`server/deploy.py` coordinates **either Bicep or Terraform** and the same
post-provisioning lifecycle. This automates the reviewed **single-user alpha**,
not the proposed multi-user enterprise service.

The [enterprise provisioning diagram](diagrams/ccgc-enterprise-provisioning.html)
is a **separate proposed workflow**, not a claim that this coordinator provisions
the enterprise target. Its [runtime architecture](diagrams/ccgc-enterprise-runtime.html)
contains no provisioning flow. The earlier
[single-user diagram](diagrams/ccgc-automated-solution.html) remains current-state evidence.

This single-user coordinator is for a **new, uniquely named deployment**. It never imports,
recreates or upgrades the historical proof VM, replaces an existing Mac
enrollment, changes subscriptions implicitly, or deletes infrastructure.
The original `server/azure-deploy.sh` remains the proof host's access-only helper.

## What runs

| Phase | Automated behavior |
|---|---|
| Preflight | Explicit Azure subscription/tenant, matching SSH keys, existing Defender P2 and EncryptionAtHost registration, D-series availability and quota, supported Mac/Node/Claude versions. |
| Plan | Bicep what-if or saved Terraform plan; rejects existing unowned groups, replacements, deletes and updates. Produces a SHA256 for explicit cost/change approval. |
| Infrastructure | New RG, Standard static IPv4/DNS, VNet/subnet/NSG/NIC, Ubuntu 24.04 `Standard_D2as_v5`, retained 64-GiB Standard SSD, Trusted Launch, host encryption, source-restricted JIT policy. |
| Access | JIT TCP 22 for one public IPv4 `/32`, 55 minutes. Waits for cloud-init and retrieves the Ed25519 host key through authenticated Azure Run Command, then uses strict SSH. |
| Host | Allowlisted source archive, checksum verification, atomic initial installation, pinned container build, offline bootstrap/provider checks. Internal service ports remain unpublished. |
| Linking | Displays legitimate device authorization in the attached terminal, checks the expected GitHub login **and immutable account ID**, and selects the exact configured Claude model. Existing authorization is reused; credentials/revocation markers are never deleted to force progress. |
| Gateway | Independently verifies the frozen model catalog, starts Compose, waits for HTTPS readiness and checks anonymous control access returns 401. Liveness is not labeled inference proof. |
| Mac | Optionally installs the reviewed official Claude version, pipes the separate gateway renewal credential through SSH into Keychain, backs up settings/profile privately, and merges the ordinary gateway configuration. |
| Live proof | With separate consent, uses empty temporary HOME/project directories and synthetic files. Exercises Read/Edit/Bash through every approved model and back in one conversation. Checks successful tool results and files, closes only its diagnostic admission, and creates a fresh foreground admission. |

The developer still runs ordinary `claude`; there is no persistent local proxy.
Model mappings stay on the gateway. Current reviewed client: **2.1.284**.

## Prerequisites and boundaries

- Permission for the unofficial Copilot route and the intended account's enabled
  models. This automation is not a vendor-support or licensing approval.
- Azure CLI already signed in to the explicit tenant/subscription with permission
  to create the resource group/resources, manage JIT, and execute VM Run Command.
  Required resource providers and quota must be available.
- Defender for Servers **P2 already enabled** and the
  `Microsoft.Compute/EncryptionAtHost` feature registered. The coordinator does
  not enable billable subscription plans or weaken governance automatically.
- Python 3.11+, OpenSSH, `tar`, Azure CLI/Bicep; Terraform 1.9+ and <2 for
  Terraform deployments. AzAPI **2.13.0** is pinned and its lock file is included.
- For local client stages: macOS with Keychain, Node.js 24, and official Claude
  2.1.284. `--install-client` explicitly permits installation/update from the
  official distribution; `curl` is needed for a first installation.
- A dedicated SSH key pair, with an unencrypted private key protected by mode
  0600. This operator profile uses non-interactive SSH; it does not collect key
  passphrases. Keep the key outside the checkout.
- Internet egress for Azure management, package/container downloads, certificate
  issuance, GitHub authorization and the entitled Copilot endpoint.

Public 80/443 and a single public IP remain intentional alpha choices.
There are no public Node, LiteLLM or Docker ports and no permanent SSH allow rule.
Hosting location does not establish provider inference residency.
The new host-encryption requirement strengthens future deployments; this task
does not retrofit or redeploy the existing proof host.

## 1. Create a configuration

Keep the operator configuration and deployment state outside Git and cloud sync:

```bash
mkdir -p "$HOME/.config/ccgc"
chmod 700 "$HOME/.config/ccgc"
cp infra/deployment.example.json "$HOME/.config/ccgc/deployment.json"

ssh-keygen -t ed25519 -f "$HOME/.ssh/ccgc-your-unique-name"
chmod 600 "$HOME/.ssh/ccgc-your-unique-name"
```

Edit the copied JSON. Replace **all** placeholders:

- `engine`: `bicep` or `terraform`. The rest of the workflow is identical.
- `subscriptionId`, `tenantId`: explicit UUIDs; `az account show` displays them.
- `deploymentName`: globally unique Azure regional DNS label, 3-32 lowercase
  letters/digits/hyphens, beginning with a letter and ending with a letter/digit.
  Use a new name, not `ccgc-dev-87b7`.
- `operatorIpv4Cidr`: your public IPv4 with `/32`, not a local address or network.
- `sshPrivateKeyFile`, `sshPublicKeyFile`: the dedicated matching key pair.
- `githubLogin`, `githubAccountId`: the intended GitHub account. If GitHub CLI
  is already authenticated as that account, `gh api user --jq '{login,id}'`
  shows both without exposing a token.
- `model`: an **exact enabled Copilot ID**, for example `claude-sonnet-5.5`,
  not `Claude Sonnet 5.5`. The example does not guarantee entitlement.

The config contains no tokens, passwords or private-key contents. Unknown fields
are rejected rather than silently ignored. To try both IaC engines, use two
distinct configurations and deployment names; never switch engines on one host.

## 2. Preview and approve infrastructure

From the repository:

```bash
python3 server/deploy.py plan --config "$HOME/.config/ccgc/deployment.json"
```

This performs read-only Azure checks and generates the engine's plan. Terraform
downloads its pinned provider locally but creates no Azure resources.
Review the printed `planFile`, exact subscription, resource changes and **current
hosting costs** before continuing. Budget for VM, OS disk, static public IPv4,
bandwidth and applicable Defender costs. The old proof-host estimate is not a
current quote for another subscription or environment.

Plans expire at the next UTC date boundary. The coordinator saves stable creation
timestamps, the engine/config binding and a snapshot of the IaC. Terraform applies
the reviewed saved plan; Bicep reruns what-if and requires the same result.
Any changed or destructive plan blocks execution.

## 3. Run the approved lifecycle

```bash
python3 server/deploy.py up \
  --config "$HOME/.config/ccgc/deployment.json" \
  --approve-plan REPLACE_WITH_PLAN_SHA256 \
  --approve-access \
  --accept-unofficial \
  --approve-client \
  --approve-live
```

Add `--install-client` only when you approve installing/updating official Claude.
This is not required if the reviewed version is already installed.

**Human checkpoints cannot be removed safely:**

1. Approve the exact infrastructure plan and costs.
2. Personally complete GitHub's browser device authorization when shown.
3. Explicitly approve client settings changes and allowance-consuming inference.
4. If Copilot changes the entitled model catalog, review the exact generated
   `catalog-preview.json` and approve its SHA256 before protected state changes.

Do not record/share the device code or run this process with shell tracing.
Authorization output is terminal-only, not captured in deployment evidence or
container logs. If the wrong GitHub account is authorized, initialization stops
before creating gateway credentials. Resolve authorization deliberately rather
than deleting protected state or silently trying another identity.

If the configured model is unavailable, setup stops with the existing
authorization preserved. Review the displayed catalog; do not choose another
model as an automatic fallback. Deployment configuration is immutable after
state creation, so a deliberate model change requires operator review rather
than editing the config and rerunning blindly.

You can stop at an approval boundary:

```bash
# Provision and install containers, but do not authorize GitHub or start inference.
python3 server/deploy.py up \
  --config "$HOME/.config/ccgc/deployment.json" \
  --approve-plan REPLACE_WITH_PLAN_SHA256 --approve-access --until host

# Complete the remote gateway without changing this Mac's existing enrollment.
python3 server/deploy.py up \
  --config "$HOME/.config/ccgc/deployment.json" \
  --approve-access --accept-unofficial --until gateway
```

Available boundaries: `infra`, `host`, `gateway`, `client`, `verified`.
After successful infrastructure provisioning, resumption does not need the old
plan hash and **does not reapply infrastructure over Defender's dynamic rules**.
The account, credential files, original backup and completed proof are reused.
Source changes are not deployed implicitly: the release archive is frozen per
deployment, and a different remote release is rejected.

## 4. Status, access and recovery

```bash
python3 server/deploy.py status --config "$HOME/.config/ccgc/deployment.json"

# Renew JIT access; update only the JIT policy if your public address changed.
python3 server/deploy.py access \
  --config "$HOME/.config/ccgc/deployment.json" \
  --operator-ipv4-cidr YOUR_CURRENT_PUBLIC_IPV4/32 --approve-access

# Recover the complete managed path: start if approved, renew JIT, reconcile the
# reviewed catalog, restart services, refresh/configure this Mac, and admit it.
python3 server/deploy.py recover \
  --config "$HOME/.config/ccgc/deployment.json" \
  --approve-access --approve-start --accept-unofficial \
  --approve-client --approve-live

# Renew an expired admission without repeating the all-model workflow.
python3 server/deploy.py admit \
  --config "$HOME/.config/ccgc/deployment.json" \
  --approve-live --accept-unofficial
```

`admit` preserves an already-valid admission without inference or cancellation.
A fresh admission lasts eight hours at most and expires after fifteen idle minutes.
After a gateway restart, an expired/lost grant is reconciled with the same
account/catalog before a new isolated probe.

If recovery reports catalog drift, inspect
`~/.local/state/ccgc/deployments/<deploymentName>/catalog-preview.json`, then
rerun the same command with `--approve-catalog REPLACE_WITH_CATALOG_SHA256`.
Only that exact same-account catalog is applied. The client profile is refreshed,
an unavailable gateway-owned user model selection is reset to the configured
approved default, Claude settings are re-applied, and a fresh admission is
created. Project or managed settings conflicts still fail closed.

To explicitly repeat the full all-model proof:

```bash
# Only after finishing your foreground Claude session:
node src/cli.ts close
python3 server/deploy.py verify \
  --config "$HOME/.config/ccgc/deployment.json" \
  --approve-live --accept-unofficial
```

Verification refuses a live admission rather than terminating someone else's
conversation. Interrupted inference is not retried automatically.

## State and evidence

Default directory:
`~/.local/state/ccgc/deployments/<deploymentName>/` (0700).
Individual state/evidence/backup files are private. `--state-dir` permits another
private **non-symlinked local** directory outside the checkout; do not use OneDrive
or another shared/synchronized folder.

This directory contains:

- `state.json`: engine/config binding, original creation time, progress, outputs.
- `catalog-preview.json`: exact same-account catalog and SHA256 requiring review
  before entitlement changes are written to protected host state.
- Running gateway/LiteLLM image identity is recorded in state; an image change
  invalidates the old verification stage instead of reusing its success.
- `plan.json`, `iac/`: reviewed plan and frozen templates. Terraform's local state,
  provider cache, lock and saved plan live in `iac/terraform/`.
- `known_hosts`: public SSH host identity obtained through Azure management.
- `source.tar.gz`: allowlisted runtime source, not credentials or local settings.
- `claude-settings.before.json`, `client-profile.before.json`: first private
  pre-change backups; never overwritten. Do not restore stale admission IDs.
- `live-verification.json`: successful synthetic tool/model workflow evidence.
- `admission.json`: last explicit admission refresh result, without tokens.

Only one coordinator can own a deployment at a time. Failed stages stop with
`DEPLOY_BLOCKED`; later stages are not marked successful. Resume the same command
after resolving the cause. A changed host key, partial protected initialization,
foreign resource group, account drift or revoked credential needs deliberate
operator recovery, not a reset flag.

GitHub tokens remain inside the protected server volume. Gateway renewal
credentials are transferred through process pipes into Keychain, never into
Terraform/Bicep parameters, plan output, arguments or evidence. Settings backups
can contain unrelated private user settings: protect them accordingly.

## Validation and remaining enterprise work

```bash
npm run check
npm test
npm run test:bootstrap
npm run test:client
terraform -chdir=infra/terraform init -backend=false
terraform -chdir=infra/terraform validate
terraform -chdir=infra/terraform test
az bicep build --file infra/bicep/main.bicep --stdout >/dev/null
checkov -d infra --framework bicep terraform --skip-download --compact
```

Terraform tests use a mocked AzAPI provider: they perform **no cloud deployment**.
The same automation smoke routine is exercised against the real pinned Claude
client and a synthetic HTTPS provider. That proves the harness, not new live
Copilot entitlement.

AzAPI is used to preserve ARM parity, including JIT and OS-disk `Detach`.
Its reviewed VM schema uses API `2026-03-01`; the existing Bicep module uses
`2026-04-01` with the same configured properties. Checkov covers Bicep; its
generic Terraform checks do not fully understand AzAPI bodies, so Terraform's
mocked security/retention assertions are required too. The one scoped
`CKV_AZURE_50` exception retains the VM agent/extension channel for Defender
governance and authenticated Azure Run Command. No subscription policy is disabled.

The new coordinator has not been used to create another billable deployment as
part of implementation. Neither engine's fresh apply is claimed as live-verified.
The historical gateway/tool proof is separate evidence.

Before enterprise production: supported provider authorization, Entra/per-user
seat isolation, managed secret storage, redundant compute/session ownership,
auditing, centralized encrypted Terraform state with locking and access controls,
CI/CD identity and upgrade/rollback orchestration remain separate deliverables.
This operator workflow deliberately has no automatic destroy, engine migration,
account replacement, runtime upgrade or provider/model fallback.
