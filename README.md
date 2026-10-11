# Claude Code with GitHub Copilot

Use the **actual Claude Code CLI**, configured for a remote HTTPS gateway, with
Anthropic models supplied through **your own GitHub Copilot seat**. No separate
Anthropic inference credential, replacement coding client, or local inference
proxy is part of the target workflow.

**Enterprise foundation implemented, not deployed.** The repository now includes
an Entra-authenticated multi-user broker, PostgreSQL admission/dispatch fencing
and audit outbox, Key Vault worker resolution, an isolated per-user worker
wrapper, an Entra/admission-based Claude credential helper, private Container
Apps/PostgreSQL/Key Vault/ACR Bicep, and metadata-only monitoring. The enterprise
broker is the private ingress, while LiteLLM remains the required current
Copilot/Anthropic connector inside each isolated user worker.
See [the enterprise implementation and deployment gates](docs/ENTERPRISE.md).

**Deployment automation:** [the end-to-end runbook](docs/AUTOMATION.md) supports
both **Bicep and Terraform** through `python3 server/deploy.py`. It covers a new
host, verified JIT/SSH, account binding, HTTPS activation, Mac configuration,
all-model tool verification, admission renewal and complete restart recovery.
Recovery starts a stopped VM only with approval, renews JIT access, requires an
exact catalog-preview hash before applying entitlement changes, restarts the
containers, refreshes and configures the Mac client, resets only an unavailable
gateway-owned user model to the approved default, and creates a fresh admission.
Browser
authorization and cost/client/inference approvals remain explicit. The
coordinator is locally tested; no fresh billable deployment is claimed.

**Model-catalog update: active on 2026-10-07.** The gateway supports Claude model
discovery, exact Anthropic-to-Copilot ID mappings and in-conversation switching
with the unmodified **Claude Code 2.1.284**. All six catalog models completed
live Copilot-backed Read/Edit/Bash workflows in one conversation, followed by
a switch back to Sonnet 5.5: seven successful workflows and 33 native Messages
requests, sharing one admission and its attempt budget. Each model reported
its correct family/version. The account and credentials were preserved. See
[catalog migration](docs/README.md#4-gateway-owned-model-catalog-and-one-time-migration).

**Still an experimental single-user alpha, not a production-ready service.**
The earlier unmodified Claude Code
2.1.220 completed both its isolated route probe and an ordinary configured
Read/Edit/Bash workflow through Azure HTTPS, LiteLLM 1.104.0 and the linked
Copilot seat's **`claude-sonnet-5.5`**. Claude changed a synthetic file from
`alpha` to `beta`, verified it with Bash, and returned `CCGC_WORKFLOW_OK`.
No real repository content was used. The effective provider origin was
`https://api.enterprise.githubcopilot.com`; five native Messages requests
succeeded across the probe and four-turn workflow, without a model fallback.

The [Sweden Central proof host](docs/AZURE.md), `Standard_D2as_v5`
(2 vCPU / 8 GiB), is running LiteLLM, the admission gateway and Caddy at
`https://ccgc-dev-87b7.swedencentral.cloudapp.azure.com`.
Account credentials are in protected server state, the gateway renewal key is
in macOS Keychain, and user-level Claude settings have been applied with a
private pre-change backup. Diagnostic admissions are closed after use; each
new foreground session requires an explicit live probe. Hosting charges
continue while the VM runs.

Follow the [post-provisioning configuration runbook](docs/README.md) for account
linking, gateway activation and configuring Claude Code on the Mac.
VM administration now uses source-restricted Defender JIT SSH, not a permanent
port-22 allow rule; the runbook includes the bounded access-window commands.
The deployed operator's `setup authorize --accept-unofficial` command now lists
eligible Claude models after browser authorization, before explicit model binding.

## Architecture and access

The **enterprise target and implemented foundation** are documented in
[the enterprise runbook](docs/ENTERPRISE.md) and two separate diagrams:
[runtime architecture](docs/diagrams/ccgc-enterprise-runtime-v2.png) and
[provisioning/rollout](docs/diagrams/ccgc-enterprise-provisioning.png).
Interactive [runtime](docs/diagrams/ccgc-enterprise-runtime.html) and
[workflow](docs/diagrams/ccgc-enterprise-provisioning.html) versions are included.
The broker, client, worker wrapper and secure Bicep foundation now exist and are
locally validated, but they are **not deployed enterprise functionality**; see the
[enterprise target contract](docs/PRD.md#enterprise-target-revision-017) and
[diagram sources/provenance](docs/diagrams/README.md).

The [single-user implementation diagram](docs/diagrams/ccgc-automated-solution.html)
is retained separately as current-state evidence. The running service and the
existing Bicep/Terraform coordinator remain the single-user alpha described below.

## Internal components deployed for the current test environment

The working test environment is the **single-user Azure alpha**, not the
enterprise Container Apps foundation. It has two halves: a remote Azure host
that owns the Copilot connection and a local Mac configuration that keeps the
unmodified Claude Code CLI as the user interface.

### Azure host

| Component | What it does | Why it is required |
|---|---|---|
| Azure VM | Runs the three Docker services and their protected state on one approved host. | Provides a stable remote Linux environment for the connector and HTTPS gateway. |
| Azure networking and DNS | Gives the VM a static public address and the `ccgc-dev-87b7.swedencentral.cloudapp.azure.com` hostname. Port 443 is public; SSH is opened only through source-restricted Defender JIT access. | Claude Code needs a stable HTTPS origin, while administration must remain restricted. |
| Caddy ingress | Terminates public TLS and forwards requests to the internal Node gateway. It is the only container that publishes ports 80/443. | The Claude API endpoint must be HTTPS; neither the gateway nor LiteLLM should be exposed directly. |
| Node admission gateway | Validates the host and gateway credentials, runs the fixed live probe, issues bounded admissions, enforces the selected model and attempt limit, protects conversation continuity, and forwards native Anthropic Messages traffic. | A Copilot credential alone does not provide session admission, replay protection, limits, or safe client-facing authentication. |
| LiteLLM connector | Performs GitHub device authorization, refreshes the user's Copilot token, discovers the Copilot endpoint and enabled Claude catalog, and transports native Anthropic Messages requests to Copilot. | This is the current proven adapter between the Anthropic-compatible Claude Code protocol and the employee's Copilot seat. |
| Private Docker state volume | Stores the authorized GitHub account binding, Copilot token cache, gateway keys, approved model catalog, and deployment metadata with restricted filesystem permissions. | The containers need durable authentication and binding state across process restarts without placing secrets in the repository or container image. |

The containers communicate only on private Docker networks:

```text
Internet
  -> Caddy HTTPS ingress
  -> Node admission gateway
  -> LiteLLM connector
  -> GitHub Copilot
  -> entitled Claude model
```

There is intentionally no API Management instance, shared Copilot service
account, provider fallback, response cache, inference retry layer, or prompt
body logging in this deployed path.

### Developer Mac

| Component | What it does |
|---|---|
| Claude Code 2.1.284 | Remains the unmodified coding client. Read, Edit, Bash, permissions, and the interactive conversation run locally. |
| `ccgc` CLI and `apiKeyHelper` | Performs login/configuration, remote checks, the isolated live probe, admission renewal, model discovery, and on-demand gateway-token retrieval. It is not a persistent local proxy. |
| macOS Keychain | Stores the gateway renewal credential. GitHub and Copilot tokens remain on the Azure host. |
| `~/.claude/settings.json` | Points Claude Code to the Azure HTTPS origin, installs the credential helper, enables gateway model discovery, and disables conflicting background/provider behavior. |
| Local CCGC profile | Stores non-secret gateway metadata, the reviewed account/model binding, and the current bounded admission identifier. |

The configured default is **Claude Sonnet 5.5**. Claude Code discovers the
current approved catalog from the gateway rather than maintaining a separate
hard-coded client mapping. To inspect it before starting Claude:

```bash
node src/cli.ts models
```

The currently verified Copilot-seat catalog is Claude Haiku 4.5, Claude Haiku
5.5, Claude Sonnet 5, and Claude Sonnet 5.5. Inside Claude Code, use `/model` to
select one of the discovered models. A live synthetic client check switches
through every catalog model and back to the default over the same
Claude Code -> HTTPS gateway -> LiteLLM -> GitHub Copilot route. If Copilot
changes the entitled catalog, startup fails closed until the operator reviews
and explicitly refreshes the same-account binding.

For an ordinary request, Claude Code asks the helper for a short-lived gateway
token and sends `/v1/messages` over HTTPS. The gateway validates the admission,
then LiteLLM uses the already-authorized Copilot seat to reach the selected
Claude model. The response streams back through the same path. Repository files
and tool execution stay on the Mac; the remote services handle only model
transport and the control metadata needed to secure it.

### Enterprise components not deployed yet

The Entra-authenticated enterprise broker, Azure Container Apps environment,
PostgreSQL admission/fencing store, Key Vault worker records, private ACR,
per-user workers, and Azure Monitor/Application Insights configuration exist as
an implemented and locally validated foundation only. They are not part of the
current live test deployment and must not be inferred from the enterprise
poster. Their remaining deployment and release gates are documented in
[the enterprise runbook](docs/ENTERPRISE.md).

The **implemented alpha** path is **Claude -> remote TLS ingress -> admission gateway ->
internal LiteLLM -> Copilot native `/v1/messages`**. Claude owns all file/shell
tools and permission decisions. LiteLLM handles the Copilot inference transport
and its own token cache. A small Node service owns client credentials, admission,
model restrictions, conversation guards, and attempt accounting.

The included alpha deployment uses Caddy for HTTPS. The enterprise foundation
uses the internal Container Apps broker directly and does not add a second API
gateway. Any ingress change requires separately validating native Messages,
immediate SSE, Host preservation, and no inference retries, cache, or body
logging. A gateway credential never grants a Copilot seat.

**Unofficial access warning:** LiteLLM uses GitHub device authorization with the
community-default OAuth client ID `Iv1.b507a08c87ecfe98`, the internal
`copilot_internal/v2/token` endpoint, and compatibility headers identifying
VS Code/Copilot. This is not a GitHub- or Anthropic-endorsed integration.
Confirm applicable account/organization permission before authorizing it.
`--accept-unofficial` acknowledges that risk; it does not grant permission or
circumvent an access denial. Model policies, quotas, and additional usage charges
still apply.

## Developer installation

The new source profile requires macOS, Node.js 24, npm, and the official
Claude Code **2.1.284**. The credential helper remains compatible with the
existing 2.1.220 profile until explicit migration.
The client is not redistributed, modified, or automatically upgraded.

```bash
npm ci
node src/cli.ts version
node src/cli.ts --help
```

`node src/cli.ts` is shown so no global npm link is required. It is also available
as `npm run ccgc -- ...`; the generated helper invokes Node directly, never npm,
so its stdout contains only the gateway access token.

## Operator setup: one developer, one linked seat

The default sequence is live feasibility proof before remote hosting. On
2026-10-06, the project owner explicitly requested Azure hosting first to resolve
the local package-download/Docker blockers, selected **Sweden Central**, and
approved scaffolding and then the **$90.21/month D-series deployment**. The
[Azure runbook](docs/AZURE.md) records the executed host build and preserves the
separate Copilot-linking approval. This ordering exception does not waive access
policy, bootstrap, or any live proof/release gate.
The existing deployment is already linked and active. The following commands
are for a **new deployment**, not a reason to reauthorize or reinitialize this
one. If the exact model ID is unknown, use the runbook's `setup authorize` step
first; it does not initialize the gateway or run inference.

On that approved remote host, with Docker/Compose, a public DNS name and ports
80/443 available:

```bash
export CCGC_HOST=gateway.example.com
docker compose -f server/compose.yaml build

docker compose -f server/compose.yaml run --rm setup init \
  --public-url "https://$CCGC_HOST" \
  --model <exact-enabled-copilot-claude-id> --accept-unofficial

docker compose -f server/compose.yaml up -d litellm gateway ingress
```

Complete the printed GitHub device flow yourself using the intended account.
Setup checks the immutable GitHub account ID, login, model policy, tools and
context/output limits, and warms LiteLLM's own token cache before startup.
It does not copy another application's credentials or perform model inference.
The model must have at least 200K context; output is capped at 16,384 tokens.
One deployment binds one default model plus a reviewed, frozen catalog of
enabled Claude models from the same account, with one shared 50-attempt
admission budget. Metadata changes require explicit operator catalog refresh;
new or disabled models never silently change the approved routing.

`state` is a private Docker volume, not a source-tree or synchronized folder.
Both runtime containers use UID 10001. Protect the host/volume with disk
encryption, restricted operator access and an approved backup/deletion policy.
Mode 0700/0600 is **not encryption or Key Vault integration**. Keep one gateway
replica and one LiteLLM worker; scaling and shared-seat use are unsupported.

Only ingress publishes ports. Never publish the Node or LiteLLM ports, expose
LiteLLM's master key to Claude, enable payload/debug logging, or add provider
fallbacks. LiteLLM and its required Prisma error-handling dependency are pinned.
Executed image digests and a dependency snapshot are recorded in the Azure
deployment evidence; a reproducible, hash-locked transitive build remains a
release gate.

The operator obtains the separate gateway renewal key with:

```bash
docker compose -f server/compose.yaml run --rm -T setup owner-key
```

Transfer that key only to the same developer over an approved secure channel.
Do not put it in command arguments, source files, shell history, or chat. An SSH
pipe into the developer's login command avoids a plaintext local key file.
The operator-to-developer binding is manual in this single-user alpha; there is
no Entra/OIDC, self-service account-linking flow, or multi-user seat routing.

For a non-container operator environment:

```bash
cd server
uv sync
uv run python bootstrap.py --help
```

Use `--state /private/non-synchronized/path` on every bootstrap command. State
must be owned by the runtime user and private. `serve` starts internal LiteLLM;
the Node service separately uses `CCGC_STATE_DIR`, `CCGC_PYTHON`,
`CCGC_LITELLM_URL`, and optionally `CCGC_BIND_HOST` (default `127.0.0.1`).
It listens on port 8080 and requires TLS ingress preserving the configured Host
and optional URL path prefix. Do not expose its plaintext listener remotely.

## Configure the developer's Claude CLI

From the repository root where you intend to use Claude:

```bash
# Feed the operator-issued renewal key through stdin, not a literal argument.
node /path/to/this-project/src/cli.ts login \
  --gateway https://gateway.example.com --accept-unofficial < /protected/owner-key

node /path/to/this-project/src/cli.ts configure
node /path/to/this-project/src/cli.ts configure --apply
node /path/to/this-project/src/cli.ts doctor --remote
node /path/to/this-project/src/cli.ts doctor --live --accept-unofficial
claude
```

The key-file example assumes a user-owned mode-0600 file outside source control
and synchronized storage; prefer secure stdin piping and remove temporary
transfer files through your approved process.

`login` validates gateway metadata and stores only its renewal key in the macOS
Keychain under `ccgc.remote.<URL hash>`. The local profile at
`~/.local/share/ccgc/remote/profile.json` contains metadata and an admission ID,
not an inference or GitHub token.

`configure` previews only the project's non-secret patch. `--apply` explicitly
merges it into `~/.claude/settings.json`, preserving unrelated settings and tool
permission rules. It pins the endpoint, sets a default model, enables gateway
model discovery without maintaining client-side mapping tables, installs the
`apiKeyHelper`, disables hooks and selected background/experimental features,
and sets output/thinking limits. Conflicting inspected settings or ambient
credentials block rather than being overwritten. The helper points to this
checkout and Node executable: keep both at their configured paths.

`doctor` is offline; `--remote` checks metadata without inference. `models`
reports the deployment's default and approved model catalog, not an unrestricted
provider catalog.
`doctor --live` runs the actual CLI with a fixed synthetic prompt, no tools,
safe mode, a disposable empty HOME/working directory and a 128-token cap.
It can consume Copilot allowance.
Only an exact successful probe permits an admission; no repository session is
started by the probe.

After setup, ordinary `claude` uses HTTPS and an on-demand credential helper.
**There is no local inference listener and no persistent `ccgc start` parent.**
Start only one foreground Claude session per admission. Normal configured use
is not the local harness's `--safe-mode` launcher: repository instructions and
client permission decisions remain Claude's responsibility.

## Lifetime, limits and recovery

| Control | Current remote behavior |
|---|---|
| Probe | 2-minute expiry, at most 3 attempts; attempts count toward the admission limit. |
| Admission | 8-hour maximum, 15-minute idle lease, one foreground conversation. In-progress responses maintain the idle lease, not the hard deadline. |
| Access token | 1 hour or remaining admission lifetime; renews within 5 minutes of expiry. Helper cache TTL is 1 minute. Renewal cannot reset attempts or extend admission. |
| Attempt accounting | Server-owned cumulative count across all selected models; tool continuations and Claude's fixed one-token model-selection checks count. Not a monetary cap or authoritative Copilot billing report. |
| Failure/replay | No Node-side inference retry. Duplicate/divergent history, concurrent generations and uncertain upstream state fail closed. LiteLLM's actual retry behavior still needs package-level verification. |
| Restart | In-memory grants, replay state and access tokens are lost and invalidated. There is no automatic resume or fresh probe. |
| Cancellation | Client disconnect aborts its upstream request; explicit close retires the admission. Closing Claude alone is not an immediate remote logout signal. |

Compose deliberately uses `restart: "no"`. After a VM stop/start, the operator
must explicitly start the three services and verify HTTPS; see the
[restart procedure](docs/README.md#21-recover-after-a-vm-stop-or-gateway-rebuild).
The VM was found deallocated on 2026-10-07; its shutdown actor was not identified,
and no governance or shutdown policy was disabled.

For another session or stale admission after a gateway restart:

```bash
node /path/to/this-project/src/cli.ts close
node /path/to/this-project/src/cli.ts doctor --live --accept-unofficial
claude
```

Do not use `close` to approve an unexpected account/model change. Review that
change with the operator before issuing another live probe.

`logout` revokes the deployment's owner access, clears its active grants and
removes this project's local Keychain item/profile. Revocation persists across
server restarts. It does **not** silently restore a different Claude route or
revoke the GitHub OAuth grant. Claude settings remain and the helper fails closed.
This alpha has no owner-key re-enrollment command; a revoked deployment requires
reviewed reprovisioning, not deletion of the revocation marker.

For operator unlink, stop services before removing cached Copilot credentials:

```bash
docker compose -f server/compose.yaml stop gateway litellm
docker compose -f server/compose.yaml run --rm -T setup unlink
```

Unlink marks owner access revoked and removes the two owned Copilot token files.
Separately revoke the OAuth grant in GitHub settings. External revocation files
are checked on new requests; stopping the service also terminates work already
in progress.

## Supported scope and outstanding gates

Live-verified legacy profile: one exact Sonnet 5.5 mapping. Live-verified
2.1.284 profile: gateway discovery, six exact Claude mappings, model switching,
text, native Messages/SSE, client-owned tools, ordered conversation/tool results
and one foreground session with shared accounting. No OpenAI-format conversion,
model-response relabeling or separate inference provider is used.
History comparison accounts for Claude's model-dependent system-reminder
placement, including token-budget reminders appended to tool results on Haiku.
Only the comparison representation tolerates the client's accompanying trailing
whitespace trim; actual upstream messages remain unchanged.
Sonnet 5.5 request compatibility preserves `output_config.effort` and persistent
text-only mid-conversation `system` messages. A transport-only `[DONE]` suffix
is consumed only after a fully validated native `message_stop`; premature,
duplicate or followed-by-data sentinels fail closed. Synthetic regressions also
exercise earlier model fixtures, but those are not additional live evidence.
Images/documents, thinking, compaction, cross-admission resume, agents/teams,
background sessions, turn-scoped system instructions, inline tool changes and
arbitrary semantic extensions are rejected or unverified.
Token counting returns an explicit unsupported response; exact input-token
enforcement is not implemented.

The configuration checks do not prove every enterprise/MDM source, plugin/MCP
combination, nested-repository setting, interactive startup branch, or later
manual routing override. Use a reviewed repository-root configuration with no
unverified customizations. Source context intentionally leaves the developer
machine during coding; client/provider retention is separate from gateway
logging. Desktop, Entra/OIDC, Key Vault, performance targets, and
production hardening are not implemented or certified.

**Still required for broader release:** verify cold/refresh endpoint behavior,
fault-path retries, complete per-hop logging/SSE guarantees, longer live
conversations and the remaining
[PRD](docs/PRD.md) release gates. The inspected `v1.104.0` authenticator lacks the
worker-login guard found in the earlier reviewed commit; bootstrap is therefore
mandatory and credentials must not be deleted while serving.

## Development and retained local proof harness

```bash
npm run check
npm test
npm run test:bootstrap
npm run test:client

# Requires successful installation of server/pyproject.toml dependencies:
npm run test:litellm
```

Tests use synthetic credentials, disposable files and no live Copilot inference.
`test:client` requires the pinned real Claude CLI; its remote-config test also
requires OpenSSL and temporarily creates/removes one uniquely named synthetic
Keychain item. It trusts a generated test CA without disabling TLS verification,
and changes only disposable Claude settings. `test:litellm` is an installed
provider-contract check, not a live entitlement or full proxy integration test.
Its synthetic capability/authentication fixtures explicitly reject any network
or authentication attempt; they do not stand in for real account metadata.

The original native adapter is retained only under **`ccgc local`**:

```bash
node src/cli.ts local login --accept-unofficial
node src/cli.ts local models --accept-unofficial
node src/cli.ts local doctor --live --model <exact-id> --accept-unofficial
node src/cli.ts local start --model <exact-id> --accept-unofficial
node src/cli.ts local logout
```

That harness has its own protected local Copilot store, loopback gateway and
safe/manual-mode launcher; it is not remote mode. Use `local --help` for options.
The [interactive architecture diagram](docs/architecture.html) and
[Archify source](docs/architecture.archify.json) still document this **local
alpha**, not the new remote topology.

Sources: [LiteLLM provider documentation](https://docs.litellm.ai/docs/providers/github_copilot),
[v1.104.0 native Messages source](https://github.com/BerriAI/litellm/blob/v1.104.0/litellm/llms/github_copilot/messages/transformation.py),
[v1.104.0 authenticator](https://github.com/BerriAI/litellm/blob/v1.104.0/litellm/llms/github_copilot/authenticator.py),
[Claude gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol).
