# Configuration after Azure provisioning

For **new deployments**, use [end-to-end Bicep/Terraform automation](AUTOMATION.md)
instead of repeating these steps manually. This document remains the detailed
operator runbook for the existing proof host and troubleshooting.

The enterprise target has separate [runtime](diagrams/ccgc-enterprise-runtime.html)
and [provisioning](diagrams/ccgc-enterprise-provisioning.html) diagrams, with
[presentation posters and source notes](diagrams/README.md). Those designs are
not deployed. This runbook still operates the existing single-user proof host,
shown in the [current-state diagram](diagrams/ccgc-automated-solution.html).

Follow these sections in order:

1. Link the intended GitHub Copilot account and bind a default Claude model.
2. Activate LiteLLM, the admission gateway and HTTPS ingress.
3. Configure the actual Claude Code CLI on the Mac and perform an authorized
   live tool workflow.

This is the **post-provisioning operator runbook**. Account linking,
gateway activation and actual-client live proof are separate milestones.
See [Azure provisioning and custody](AZURE.md), the [project README](../README.md)
and the [PRD](PRD.md) for current evidence and limitations.

**Upgrade completed:** [section 4](#4-gateway-owned-model-catalog-and-one-time-migration)
describes the active 2.1.284 multi-model profile. After explicit upgrade approval,
the gateway and Mac were migrated without changing account credentials.
All six models completed live tool workflows and in-conversation switching.

**Execution status, 2026-10-07: all three setup stages completed.**

| Stage | Observed result |
|---|---|
| Account/model | Existing `ShironB` authorization preserved; default `claude-sonnet-5.5` plus all six enabled Claude models explicitly bound. |
| Gateway | LiteLLM, Node and Caddy are running; public HTTPS works and anonymous control access returns 401. Internal service/Docker ports are not published. |
| Mac client | Gateway key saved directly to macOS Keychain; user Claude settings backed up and configured. |
| Live proof | Actual Claude Code 2.1.284 switched through all six models and back to Sonnet 5.5 in one conversation; seven Read/Edit/Bash workflows changed synthetic files from `alpha` to `beta`. All 33 native requests succeeded. |
| Admissions | Upgrade approval permitted closing the previous admission. Diagnostic admissions were closed after use; routine launches need a valid fresh admission. |

The effective live provider was `https://api.enterprise.githubcopilot.com`,
using the exact six `github_copilot/claude-*` routes in section 4.1. The earlier
2.1.220 single-model proof is retained as historical evidence. Neither proof
establishes Desktop support or production readiness.

Administrative access uses Defender JIT after governance removed the original
permanent SSH rule. The policy permits TCP 22 only from the currently reviewed
operator `/32`, for at most one hour; expired windows need renewal. Governance
and Defender P2 remain enabled. On 2026-10-07 the operator IP changed and the
access-only Bicep policy was updated before requesting another window.

**Do not rerun the old account-link Terminal launcher, `authorize`, or `init`
for this existing binding.** The private state volume now contains live
credentials. Use `setup verify` for a metadata-only check, and preserve the
existing authorization rather than deleting state to retry.

## Deployment reference

| Item | Value |
|---|---|
| Subscription | `ME-MngEnvMCAP994670-shironbabi-1` / `b8242aba-c397-4474-82e4-c96cbfd7fa7b` |
| Resource group | `rg-ccgc-dev-87b7` |
| Region / host | Sweden Central / `vm-ccgc-dev-87b7` |
| VM | `Standard_D2as_v5`, 2 vCPU / 8 GiB |
| Hostname | `ccgc-dev-87b7.swedencentral.cloudapp.azure.com` |
| Server source | `/opt/ccgc` |
| Operator | `ccgcadmin` |
| Mac SSH key | `$HOME/.ssh/ccgc-dev-87b7` |
| Verified host-key file | `$HOME/.ssh/ccgc-dev-87b7.known_hosts` |
| SSH access | Defender JIT `ccgc-ssh`, TCP 22, operator `/32`, maximum one hour |
| Mac project | `/Users/shironbabi/Desktop/OneDrive - Microsoft/Desktop/microsoft/claude-code-with-github-copilot` |
| Client profile | Claude Code 2.1.284, `remote-litellm-cli-2.1.284-v2`. Node.js 24; CLI only. |

Hosting charges continue even while inference is inactive. The approved estimate
is $90.21/month at 730 hours, excluding variable charges and Copilot seat/usage.

## 1. Link your GitHub Copilot account

### 1.1 Review authorization and credential custody

Confirm that the intended account has a Copilot seat and that applicable
organization policy permits this unofficial integration. The
`--accept-unofficial` flag acknowledges risk; it does not grant permission or
bypass a model/access restriction.

Account credentials stay on the Azure VM in the `ccgc_state` Docker volume.
The volume is on the persistent Azure-encrypted OS disk, with runtime UID/GID
10001 and private directory/file modes. Host administrators can access it.
**There is no automatic backup or managed secret-store integration.** Approve
credential retention, deletion and any backup requirements before linking.
Never copy credentials from another client's cache.

Section 1 performs authorization and account/model metadata checks, not model
inference. It does not authorize sections 2 or 3 automatically.

### 1.2 Connect from your Mac

Open Terminal on the Mac where the dedicated SSH key was created. Sign in to
Azure CLI with an identity authorized to request JIT access. Request a new
window before connecting when there is no active one:

```bash
cd "/Users/shironbabi/Desktop/OneDrive - Microsoft/Desktop/microsoft/claude-code-with-github-copilot"
export CCGC_OPERATOR_IPV4_CIDR="<your-current-public-ipv4>/32"
CCGC_APPROVE_ACCESS=yes bash server/azure-deploy.sh access-open

export CCGC_HOST=ccgc-dev-87b7.swedencentral.cloudapp.azure.com

ssh -i "$HOME/.ssh/ccgc-dev-87b7" \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$HOME/.ssh/ccgc-dev-87b7.known_hosts" \
  "ccgcadmin@$CCGC_HOST"
```

The host-key file was established through authenticated Azure Run Command.
Do not disable strict host checking or replace it with an unverified network
scan. The request initially reports `Initiating`; allow brief rule propagation
before SSH. Each request lasts 55 minutes, with a policy maximum of one hour.
Expired windows deny new connections; NSGs are stateful, so expiry does not
necessarily disconnect an already established SSH session.

SSH is restricted to the operator's public IPv4 `/32`. If your IP changes,
review and update only the JIT policy before requesting another window:

```bash
bash server/azure-deploy.sh access-what-if
CCGC_APPROVE_ACCESS=yes bash server/azure-deploy.sh access-configure
CCGC_APPROVE_ACCESS=yes bash server/azure-deploy.sh access-open
```

These access commands need no SSH public-key input, do not redeploy the VM,
and never open SSH to the internet. They use the subscription's existing
Defender P2 plan. Do not manually recreate a permanent SSH rule or disable
governance. If governance later rejects/removes JIT access, stop and contact
the subscription administrator; the helper does not repeatedly recreate rules.

### 1.3 Initialize the account on the VM

If you do not already know the exact model ID, authorize the account and list
its eligible Claude models first. Run this interactively in your own terminal:

```bash
cd /opt/ccgc
export CCGC_HOST=ccgc-dev-87b7.swedencentral.cloudapp.azure.com
sudo env CCGC_HOST="$CCGC_HOST" \
  docker compose --profile operator -f server/compose.yaml run --rm setup authorize \
  --accept-unofficial
```

Complete GitHub's device flow below and review the returned login and `models`.
The output status is `authorized-model-selection-required`, not completed setup.
This creates only the legitimate private authorization state, not gateway keys
or a deployment binding. No inference is performed. The operator service uses
Docker's `none` logging driver so device codes are displayed in the attached
terminal but not retained in container logs.

Choose one **exact Copilot Claude model ID** from that eligible list, not a
display name or generic alias. `claude-sonnet-4.5` appears in synthetic checks but
is not a promise of account availability. `init` reuses the authorized token and
independently rechecks the selected model; it never silently chooses another.
If the exact ID is already known, direct `init` still performs the device flow.
For this deployment, the selected ID is **`claude-sonnet-5.5`**, not the display
name `Claude Sonnet 5.5`. The initial display-name rejection did not invalidate
browser authorization; initialization reused that authorization successfully.

The selected model must pass the implemented policy, Anthropic vendor, tool-call,
context-window and output-limit checks. Do not change providers or silently
substitute a model after rejection.

On the VM:

```bash
cd /opt/ccgc
export CCGC_HOST=ccgc-dev-87b7.swedencentral.cloudapp.azure.com

# Replace this with the exact enabled Claude ID before continuing.
MODEL='REPLACE_WITH_EXACT_ENABLED_CLAUDE_ID'

sudo env CCGC_HOST="$CCGC_HOST" \
  docker compose -f server/compose.yaml run --rm setup init \
  --public-url "https://$CCGC_HOST" \
  --model "$MODEL" \
  --accept-unofficial
```

Complete the displayed GitHub device flow yourself:

1. Open the displayed GitHub verification URL in your Mac's browser.
2. Enter the displayed device code.
3. Sign in with the account that owns the intended Copilot seat and review the
   access request before authorizing.
4. Leave Terminal open while setup completes.

Do not share device codes, access tokens or gateway keys in chat, screenshots,
logs or source files. Do not enable shell tracing (`set -x`).

Expected initialization success: `metadata-verified`, with the intended GitHub login and exact
model ID, and `liveInference: not-tested`.

If setup reports unavailable/disabled models, access denial, unsafe state or an
existing deployment, stop and review the error. Do not delete credential or
revocation files to force a retry. A failed metadata check may leave an authorized
GitHub token in private state even though deployment initialization is incomplete.
The same applies after `authorize`: keep the account and state under operator
control, and revoke the OAuth grant in GitHub if authorization is abandoned.

### 1.4 Confirm the binding without inference

On the VM:

```bash
sudo env CCGC_HOST="$CCGC_HOST" \
  docker compose -f server/compose.yaml run --rm -T setup verify
```

Check the returned login and model. This independently checks the current
account/model metadata against the stored deployment binding.

**Section 1 is complete only after both initialization and verification succeed.**
If only section 1 was authorized, leave production services stopped and do not
continue to section 2. GitHub account authorization alone is not live inference
proof.

## 2. Activate LiteLLM and the HTTPS gateway

Proceed only after section 1 and authorization to activate the gateway. Stay on
the VM in `/opt/ccgc` with `CCGC_HOST` set as above. The image is already built;
no provider upgrade or new infrastructure is required.

```bash
sudo env CCGC_HOST="$CCGC_HOST" \
  docker compose -f server/compose.yaml up -d litellm gateway ingress

sudo env CCGC_HOST="$CCGC_HOST" \
  docker compose -f server/compose.yaml ps
```

LiteLLM should become healthy. Gateway and ingress should remain running. Caddy
obtains the HTTPS certificate automatically; initial issuance may take time.
Only Caddy publishes 80/443. Never publish Node/LiteLLM ports 8080/4000 or Docker.

Return to your Mac:

```bash
exit
```

From the same Mac terminal:

```bash
curl --fail --silent --show-error "https://$CCGC_HOST/healthz"
```

Expected body:

```json
{"status":"listening","inference":"not-verified"}
```

Confirm a protected control endpoint rejects unauthenticated access:

```bash
curl --silent --show-error --output /dev/null \
  --write-out '%{http_code}\n' \
  "https://$CCGC_HOST/ccgc/info"
```

Expected status: **401**. These requests do not perform inference. A successful
health check proves a responding gateway, not Copilot model access.

If HTTPS or startup fails, stop and inspect bounded operational logs privately.
Do not use `curl -k`, disable authentication, enable payload/debug logging, or
share unreviewed logs that could contain account data.

### 2.1 Recover after a VM stop or gateway rebuild

The VM was found deallocated on 2026-10-07. The shutdown actor was not identified;
no governance or shutdown controls were changed. Compose uses `restart: "no"`,
so starting the VM does not automatically start the gateway services.

If the VM is deallocated, start the existing approved resource from your Mac:

```bash
az vm start \
  --subscription b8242aba-c397-4474-82e4-c96cbfd7fa7b \
  --resource-group rg-ccgc-dev-87b7 --name vm-ccgc-dev-87b7
```

Renew JIT access using section 1.2, connect with verified SSH, then run on the VM:

```bash
cd /opt/ccgc
sudo env CCGC_HOST=ccgc-dev-87b7.swedencentral.cloudapp.azure.com \
  docker compose -f server/compose.yaml up -d --wait --wait-timeout 120 \
  litellm gateway ingress
```

Verify HTTPS from the Mac as above; startup may need brief propagation even
after Compose reports success. A gateway restart invalidates all admissions
and changes its instance identifier. Refresh the client binding explicitly:

```bash
node "$CCGC_PROJECT/src/cli.ts" close
node "$CCGC_PROJECT/src/cli.ts" doctor --remote
node "$CCGC_PROJECT/src/cli.ts" doctor --live --accept-unofficial
claude
```

Use section 3.1 to set `CCGC_PROJECT` first. Do not use `logout`, reauthorize
GitHub or recreate credentials to resolve a routine instance change.

## 3. Configure and exercise Claude Code on your Mac

### 3.1 Check the supported versions

On your Mac:

```bash
export CCGC_PROJECT='/Users/shironbabi/Desktop/OneDrive - Microsoft/Desktop/microsoft/claude-code-with-github-copilot'
export CCGC_HOST=ccgc-dev-87b7.swedencentral.cloudapp.azure.com

node --version
claude --version
```

The active profile uses Node.js 24 and exactly Claude Code 2.1.284.
The earlier 2.1.220 profile is historical. Coordinate subsequent client changes
with gateway compatibility review; do not bypass a version guard.

### 3.2 Transfer the gateway credential directly into Keychain

Run this on the Mac. It transfers the separate gateway owner/renewal key over
verified SSH directly into the local login command. It does not print the key
or create a temporary plaintext key file:

```bash
set -o pipefail

ssh -T -i "$HOME/.ssh/ccgc-dev-87b7" \
  -o IdentitiesOnly=yes \
  -o BatchMode=yes \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$HOME/.ssh/ccgc-dev-87b7.known_hosts" \
  "ccgcadmin@$CCGC_HOST" \
  'cd /opt/ccgc && sudo -n env CCGC_HOST=ccgc-dev-87b7.swedencentral.cloudapp.azure.com docker compose -f server/compose.yaml run --rm -T setup owner-key' \
| node "$CCGC_PROJECT/src/cli.ts" login \
    --gateway "https://$CCGC_HOST" --accept-unofficial
```

Expected status: `gateway-authenticated`, showing the intended account/model.
macOS may request Keychain permission. The GitHub credential and LiteLLM master
key remain server-side; only the separate gateway credential enters Keychain.

### 3.3 Preview and apply Claude settings

Start in a disposable directory with no confidential code:

```bash
WORKDIR="$(mktemp -d "$HOME/ccgc-smoke.XXXXXX")"
cd "$WORKDIR"
printf 'alpha\n' > sample.txt

node "$CCGC_PROJECT/src/cli.ts" configure
```

Review the non-secret patch. Before applying, retain a private backup of any
existing Claude settings if you need to restore your previous setup.

```bash
node "$CCGC_PROJECT/src/cli.ts" configure --apply
node "$CCGC_PROJECT/src/cli.ts" doctor --remote
```

**`--apply` modifies user-level `~/.claude/settings.json`, not just the test
directory.** It routes Claude through this gateway, enables catalog discovery
and a default model (the legacy profile instead pinned all aliases),
installs the credential helper, disables hooks and selected background features,
and sets the supported output/thinking limits. It preserves unrelated settings
and tool permission rules.

For the completed setup, the original settings were retained privately at
`~/.local/share/ccgc/remote/claude-settings.before-azure-20261006.json`.
Do not overwrite that backup or restore it blindly over later unrelated edits.

Conflicting environment, provider, credential-helper or managed settings block
configuration. Resolve them explicitly with the appropriate owner; do not
bypass organizational policy. The helper references this checkout and the Node
executable, so keep both at their configured paths.

### 3.4 Perform an explicitly authorized live probe

This step **can consume Copilot allowance**:

```bash
node "$CCGC_PROJECT/src/cli.ts" doctor --live --accept-unofficial
```

The actual Claude CLI runs a fixed synthetic prompt with no tools and a bounded
output. Expected status: `actual-client-route-verified`. Stop if it fails.
Only a successful probe creates an admission for a foreground Claude session.

The verified Sonnet 5.5 path required three gateway compatibility repairs:
reviewed `output_config.effort`, persistent text-only `system` messages inside
the conversation, and a transport `[DONE]` marker only after a complete native
`message_stop`. No fields were converted to user text and no model was changed.
Malformed or incomplete streams still fail closed. Thinking blocks and other
unreviewed semantic extensions remain outside this alpha's supported profile.

### 3.5 Verify a real Claude tool workflow

After a successful probe, in the same disposable directory:

```bash
claude
```

Give Claude this task:

> Read `sample.txt`, replace `alpha` with `beta`, then use Bash to run
> `cat sample.txt`. Do not access other files or the network.

Review and approve tool requests normally. Do not bypass permissions. The
expected outcome is a real Read/Edit/Bash workflow ending with `beta`, through
the configured Copilot-backed route. Keep real repository content out of the
initial test; later coding sessions send source context off the developer Mac.

The legacy deployment supports one exact Claude model; the new profile supports
all explicitly bound Claude models with one foreground session per admission.
The admission lasts at most eight hours, has a 15-minute idle lease, and a
shared 50-attempt budget including probes, model checks and tool continuations. These are
application safeguards, not a monetary cap or GitHub billing report.

### 3.6 End the session

Exit Claude, then:

```bash
node "$CCGC_PROJECT/src/cli.ts" close
```

Use `close` for an ordinary session ending. **Do not use `logout` as a routine
close:** it persistently revokes the deployment owner's access, and this alpha
does not have an owner-key re-enrollment command. A later session requires
another explicitly authorized live probe.

For full unlink/revocation or Azure shutdown, follow the
[project lifecycle procedure](../README.md#lifetime-limits-and-recovery) and
[Azure stop/remove procedure](AZURE.md#stop-and-remove). Stopping inference
containers does not stop VM billing.

### 3.7 If Claude reports an apiKeyHelper failure

Claude's generic suggestion to reauthenticate does not necessarily mean the
GitHub authorization expired. Inspect the helper's error from Terminal, keeping
any successful credential output out of the terminal and logs:

```bash
node "$CCGC_PROJECT/src/cli.ts" token >/dev/null
```

On 2026-10-07, the reported failure was reproduced as `ADMISSION_REQUIRED`:
HTTPS and authenticated account/model metadata were healthy, the configured
helper matched, but no admission existed after the completed test was closed.
No GitHub reauthorization or Keychain replacement was needed.
`doctor --remote` checks metadata only; it does not create an admission.

Exit the already-open Claude session first, then choose the reviewed project
directory in Terminal. Do not launch from your whole home directory accidentally.
Run the live probe and launch only if it succeeds:

```bash
node "$CCGC_PROJECT/src/cli.ts" doctor --live --accept-unofficial && claude
```

Wait for `actual-client-route-verified`. A failed probe must be investigated
instead of starting Claude anyway. Do not run `logout`, delete credentials or
repeat device authorization to solve a missing admission. A stale instance
after a gateway restart instead needs the explicit `close` and reconnect
procedure in section 2.1.

## 4. Gateway-owned model catalog and one-time migration

**Status: active and live-verified.** Initial staging preserved the running
session; the owner's subsequent "do the upgrade" approval authorized activation.
The native client, protected catalog and user settings have been migrated.
The final source archive is
`/opt/ccgc-staged/model-catalog-v2/tool-history-source.tar.gz`, and the runtime
is also tagged `ccgc-runtime:catalog-tool-history`. Do not run the staged Compose
file directly: activation retains the existing deployment and `ccgc_state`.

Active image:
`sha256:958ec9635e50d510fef2e2865e3ea820379822412c03e8f203119ec55c88df0b`.
Source archive SHA256:
`2e71642df5b6238e3e4e0e4481ca7dc6f5706cc1a180f413d440954853b842c8`.
The retained pre-upgrade image is
`sha256:88e85468fb7baf82b36710edbf5c439a388eb2dababafb1276c9c7e19fc56ee5`.

### 4.1 Exact mappings and the incorrect Sonnet label

The actual 2.1.220 client generates this system instruction:

> You are powered by the model named Sonnet 5. The exact model ID is claude-sonnet-5.5.

It was therefore asking the correctly routed model to use an outdated label.
The gateway was not secretly routing Sonnet 5.5 requests to Sonnet 5.
Claude Code 2.1.284 recognizes the correct version and uses its native IDs;
the gateway maps those IDs to the seat's exact Copilot IDs:

| Display name | Claude/discovery ID | Exact Copilot route |
|---|---|---|
| Claude Sonnet 5.5 | `claude-sonnet-5-5` | `github_copilot/claude-sonnet-5.5` |
| Claude Sonnet 5 | `claude-sonnet-5` | `github_copilot/claude-sonnet-5` |
| Claude Opus 5.5 | `claude-opus-5-5` | `github_copilot/claude-opus-5.5` |
| Claude Opus 5 | `claude-opus-5` | `github_copilot/claude-opus-5` |
| Claude Opus 4.8 | `claude-opus-4-8` | `github_copilot/claude-opus-4.8` |
| Claude Haiku 4.5 | `claude-haiku-4-5-20251001` | `github_copilot/claude-haiku-4.5` |

A read-only metadata check confirmed these six enabled models on 2026-10-07.
The gateway also accepts their exact Copilot IDs and undated hyphen spellings.
It does not map Fable, GPT, unknown versions or disabled models to another model.
It validates the upstream response against the selected model, without editing
assistant answers or rewriting model identity text in prompts.

An authenticated `GET /v1/models?limit=1000` serves the approved catalog without
an upstream metadata round trip. Client discovery remains opt-in through one
setting, `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`; no client-side mapping
table is required. Nonessential traffic remains disabled. Before 2.1.257 that
traffic setting prevents discovery refresh, which is another reason not to
retain 2.1.220 for the new profile.

References:
[model support and aliases](https://code.claude.com/docs/en/model-config),
[gateway discovery](https://code.claude.com/docs/en/llm-gateway-protocol#model-discovery).

### 4.2 Activate only after the foreground session has ended

The following migration has already been completed on this deployment.
Do not repeat it or reauthorize merely to switch models.

First exit Claude on the Mac, then close its admission:

```bash
node "$CCGC_PROJECT/src/cli.ts" close
```

Renew JIT and connect using section 1.2. On the VM, review the new catalog
without writing to the state volume or running inference:

```bash
sudo docker run --rm --read-only \
  --tmpfs /tmp:mode=1777,size=128m \
  --mount type=volume,source=ccgc_state,target=/state,readonly \
  ccgc-runtime:catalog-tool-history catalog --accept-unofficial
```

Confirm the linked account, unchanged default Sonnet 5.5 and enabled model set.
Then stop the existing services before applying the state migration:

```bash
cd /opt/ccgc
export CCGC_HOST=ccgc-dev-87b7.swedencentral.cloudapp.azure.com
sudo env CCGC_HOST="$CCGC_HOST" docker compose -f server/compose.yaml \
  stop ingress gateway litellm

sudo docker run --rm --read-only \
  --tmpfs /tmp:mode=1777,size=128m \
  --mount type=volume,source=ccgc_state,target=/state \
  ccgc-runtime:catalog-tool-history catalog --accept-unofficial --apply
```

`catalog --apply` atomically replaces only the deployment metadata. It preserves
the default model, immutable account identity, public URL, existing timestamps,
owner key, LiteLLM key and Copilot authorization. Revocation, changed identity
or changed default-model metadata block migration. Do not run `init`,
`authorize`, `unlink`, or delete a revocation marker.

Promote the reviewed source and image, then start the existing Compose project:

```bash
sudo tar -xzf /opt/ccgc-staged/model-catalog-v2/tool-history-source.tar.gz -C /opt/ccgc
sudo docker tag ccgc-runtime:catalog-tool-history ccgc-runtime:0.2.0-alpha.1
sudo env CCGC_HOST="$CCGC_HOST" docker compose -f server/compose.yaml \
  run --rm -T setup verify </dev/null
sudo env CCGC_HOST="$CCGC_HOST" docker compose -f server/compose.yaml \
  up -d --wait --wait-timeout 120 litellm gateway ingress
```

Retain the previous image and source for operator recovery. The new LiteLLM
configuration is regenerated from the validated binding at startup, with one
exact route per model and no retries/fallback lists. Verify HTTPS as in section 2.

### 4.3 One-time Mac update

This step is complete on the owner's Mac. The additional private backups are
`~/.local/share/ccgc/remote/claude-settings.before-catalog-20261007.json` and
`profile.before-catalog-20261007.json` in the same directory. The original
pre-Azure backup was not overwritten. Do not restore a stale admission from
the profile backup.

Keep the original pre-Azure settings backup. Save a separate private copy of
the current settings before migration; never overwrite an earlier backup.
Then use the official client installer and explicit same-account refresh:

```bash
claude install 2.1.284
claude --version
node "$CCGC_PROJECT/src/cli.ts" refresh --accept-unofficial
node "$CCGC_PROJECT/src/cli.ts" configure
node "$CCGC_PROJECT/src/cli.ts" configure --apply
node "$CCGC_PROJECT/src/cli.ts" doctor --remote
node "$CCGC_PROJECT/src/cli.ts" doctor --live --accept-unofficial
```

Refresh approves the new catalog only for the previously linked identity and
default model; it does not replace the Keychain credential. Configuration
removes only old pins owned by this project's helper and equal to the previous
default model. Other routing overrides block migration, while unrelated settings
and permissions remain intact. A saved, valid model selection is preserved.
The default remains Sonnet 5.5, now using its native Claude spelling.

After a successful live probe, launch ordinary `claude` and use `/model`.
For an exact selection, for example:

```text
/model claude-opus-5-5
/model claude-sonnet-5-5
/model claude-haiku-4-5-20251001
```

The native `sonnet`, `opus` and `haiku` aliases also resolve inside the pinned
client. Built-in picker entries outside the approved catalog are not guaranteed
to disappear; selecting one is rejected, never silently remapped.

### 4.4 Switching safeguards and evidence

Switch after the current response/tool batch completes. The gateway keeps one
conversation, shared attempt accounting, pending tool results, expiry and
fail-closed state across models. A switch requires a new user turn; changing
the model cannot resubmit the previous turn or recover a failed branch.
Claude's fixed one-token "Hi" selection checks use the real provider and count
toward the same admission budget, without replacing conversation history.

Claude 2.1.284 represents the same historical context differently for Haiku.
The gateway normalizes that representation only for history comparison,
preserving every context value; it forwards the client's original message
roles and text. For tool results, Haiku embeds the token-budget reminder and
trims trailing whitespace first; comparison normalizes that exact pattern
without discarding the reminder's value, tool ID, error flag or result text.
Top-level system/tool semantics remain fixed.

Executed evidence for this candidate includes all six real-client synthetic
Read/Edit/Bash workflows, exact identity-line checks, authenticated HTTPS
discovery, switching through all six models and back within one actual CLI
process, protected migration regressions and installed LiteLLM offline checks.
The final direct-HTTPS live run completed seven workflows (the six models
followed by Sonnet 5.5 again), with all three tools succeeding each time,
seven files containing `beta`, correct model self-identification and 33 HTTP
200 native Messages requests through `api.enterprise.githubcopilot.com`.
Its admission was closed afterward.

An earlier Opus 5.5 completion left the branch retired; its original cause was
not captured and it did not recur in the next two workflows. Bounded error
codes and server-error messages are now logged without request bodies,
credentials or client-input error text. The reproducible Haiku tool-history
conflict was diagnosed with isolated synthetic traffic and fixed with regression
coverage. Historical failed runs remain separate from the successful final run.

Thinking blocks, compaction, agents, Desktop and exact input-token enforcement
remain outside the verified scope.
