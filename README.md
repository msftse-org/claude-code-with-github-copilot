<img src="https://img.icons8.com/fluency/96/microsoft.png" width="36"/> &nbsp; <img src="https://img.icons8.com/fluency/96/azure-1.png" width="36"/> &nbsp; <img src="https://github.githubassets.com/assets/GitHub-Mark-ea2971cee799.png" width="36"/>

![Node.js 24](https://img.shields.io/badge/Node.js-24-339933?logo=node.js&logoColor=white)
![Azure Container Apps](https://img.shields.io/badge/Azure-Container%20Apps-0078D4?logo=microsoftazure&logoColor=white)
![Claude Code](https://img.shields.io/badge/Claude%20Code-2.1.308-D97757)
![Status](https://img.shields.io/badge/status-enterprise%20pilot-blue)

# Enterprise Claude Code with GitHub Copilot

This repository implements an enterprise architecture that lets employees use
the **official Claude Code CLI** with Anthropic models provided through **each
employee's own GitHub Copilot seat**.

---

## Table of Contents

- [Architecture](#architecture)
- [Why central LiteLLM](#why-the-enterprise-path-uses-central-litellm)
- [Enterprise Azure components](#enterprise-azure-components)
- [Employee setup](#on-the-mac)
- [Claude Code feature compatibility](#claude-code-feature-compatibility)
- [Prerequisites](#prerequisites)
- [Getting started](#getting-started)
- [Developer validation](#developer-validation)
- [Project structure](#project-structure)
- [Enterprise pilot automation](#enterprise-pilot-automation)
- [Employee onboarding](#litellm-bootstrap-and-employee-onboarding)
- [Security properties](#security-properties)
- [Known limitations](#known-limitations)
- [Deployment status and remaining gates](#deployment-status-and-remaining-gates)
- [Resources](#resources)

---

## Architecture

![Enterprise Claude Code: SSO onboarding and per-user GitHub Copilot request flow](docs/diagrams/ccgc-enterprise-overview.jpeg)

> The SSO/PKCE session-login flow shown above is illustrative. The deployed
> configuration currently uses per-user LiteLLM virtual keys, not the
> session/refresh-token login shown in this diagram.

[Open the interactive layered architecture dashboard](docs/diagrams/ccgc-layered-architecture.html)
to switch between the employee flow, the combined user/admin view, and the
administration-only view.

### Employee request flow

[Open the interactive employee runtime diagram](docs/diagrams/ccgc-employee-runtime.html).

![Claude Code employee request flow](docs/diagrams/ccgc-employee-runtime.visual-check.2048x1320.light.png)

Each installation serves one customer. Every person receives a distinct
LiteLLM virtual key and connects their own GitHub account through LiteLLM's
per-user GitHub Copilot OAuth capability. Claude Code sends the native
Anthropic Messages API directly to LiteLLM; LiteLLM authenticates the virtual
key, applies user/team/model/budget policy, and uses that same user's encrypted
GitHub connection.

This is an HTTPS API integration, not a GitHub SDK and not direct access to the
Anthropic API. GitHub Copilot supplies the employee-specific model entitlement;
the solution uses neither a shared Copilot seat nor a separate Anthropic API
key.

### Administration and enrollment

[Open the interactive administration diagram](docs/diagrams/ccgc-admin-control-plane.html).

![CCGC administration and employee enrollment](docs/diagrams/ccgc-admin-control-plane.visual-check.2048x1320.light.png)

LiteLLM UI is the target user and administrator control panel for users,
virtual keys, teams, models, budgets, rates, spend, rotation, revocation, and
per-user GitHub connections. The CCGC broker issues one-time enrollment codes
and personal LiteLLM keys through the administrator GitHub Actions workflow,
and retains the legacy admission path for rollback; it does not proxy
inference.

> [!IMPORTANT]
> The zero-delete direct-key migration is deployed. Direct virtual-key model
> discovery, Anthropic Messages, Chat Completions, Responses, Claude Code CLI,
> key lifecycle controls, and user isolation have passed. The compatibility
> broker remains deployed temporarily for rollback.

> [!WARNING]
> The Copilot connector is unofficial and is not endorsed by GitHub or
> Anthropic. The organization must approve this use before onboarding employees.

### Provisioning and rollout

![Enterprise provisioning and rollout](docs/diagrams/ccgc-enterprise-provisioning.png)

The provisioning workflow separates scope and cost approval, private foundation
deployment, service rollout, employee enrollment, acceptance gates, staged
promotion, and approved recovery. Open the
[interactive provisioning diagram](docs/diagrams/ccgc-enterprise-provisioning.html)
for inspection and export.

## Why the enterprise path uses central LiteLLM

LiteLLM is both the inference gateway and the target control plane. It already
owns the controls required on this path: virtual-key authentication, users,
teams, model access, budgets, rate limits, spend, key rotation/revocation, and
per-user GitHub OAuth. API Management is not required because it would
duplicate gateway policy without replacing LiteLLM's user-to-GitHub credential
resolution.

[Open the interactive authentication comparison](docs/diagrams/ccgc-auth-options-comparison.html).

| Area | LiteLLM direct key — target | CCGC admission — migration only |
|---|---|---|
| Request identity | User-owned LiteLLM virtual key | Entra/CCGC key exchanged for an admission |
| Control panel | LiteLLM UI only | CCGC administration plus LiteLLM |
| GitHub account | Same LiteLLM user owns key and OAuth connection | CCGC binding resolves to that user's LiteLLM key |
| Models, budgets, rates, spend | Native LiteLLM | Native LiteLLM after custom-auth resolution |
| Rotation and revocation | Native LiteLLM key lifecycle | CCGC and LiteLLM lifecycles |
| Extra services | None on the request path | Broker, CCGC database state, Key Vault records, custom auth |
| Main advantage | Simplest path; no enterprise JWT license dependency | Safe rollback for existing managed clients |
| Main disadvantage | Secure user-key distribution and storage | More components, failure modes, and operations |

Both options use the same LiteLLM per-user GitHub OAuth provider and Copilot
entitlement. The difference is request authentication and user selection.

## Enterprise Azure components

| Component | Purpose |
|---|---|
| Azure Container Apps | Runs LiteLLM and the CCGC broker, which issues enrollment codes and personal keys and retains the admission path for rollback. |
| Microsoft Entra ID | Protects CCGC administration (`CCGC.Admin`, including the GitHub Actions workload identity); employees do not sign in to it and it is not used for inference. |
| Azure Database for PostgreSQL | Stores LiteLLM users, virtual keys, policy, spend, and encrypted per-user GitHub connections; the `ccgc` schema remains temporarily for rollback. |
| Azure Key Vault | Retains migration-only CCGC records and managed LiteLLM administration secrets until reviewed cleanup. |
| Azure Container Registry | Stores approved immutable control-plane and managed LiteLLM images. |
| Azure Monitor and Application Insights | Records operational metadata without prompt or response bodies. |

Target clients use LiteLLM directly for `/v1/messages`, `/v1/models`, Chat
Completions, Responses, and embeddings where configured. The credential helper
returns the user's virtual key from OS credential storage. Existing admissions
remain accepted temporarily for migration rollback.

## On the Mac

Each employee needs:

- Official Claude Code `2.1.296` or newer
- The project-developed enterprise `ccgc` command-line helper
- A user-owned LiteLLM virtual key stored in macOS Keychain
- `~/.claude/settings.json` pointing Claude Code to the central LiteLLM gateway
- A private, non-secret profile containing the gateway and discovered models

Each employee also needs their own Copilot-entitled GitHub account and a
one-time `CCGC-…` enrollment code from Enterprise IT (see
[Employee enrollment with GitHub Actions](#employee-enrollment-with-github-actions)).
No Entra sign-in, LiteLLM account, password, or invitation is required.

With Node.js 24 and the repository dependencies installed (`npm ci`), run:

```bash
npm run enterprise:client -- setup \
  --gateway https://BROKER_FQDN \
  --apply
```

1. Paste the enrollment code when prompted. Input is hidden.
2. Setup prints the GitHub account that must approve and opens
   `https://github.com/login/device` with a short device code.
3. Approve as that GitHub account. If another account approves, the broker
   disconnects it and setup fails.
4. Setup stores a personal 90-day LiteLLM virtual key in macOS Keychain,
   writes the profile and `~/.claude/settings.json`, and writes a secret-free
   Desktop import file.

The relocatable [`ccgc-enterprise` launcher](scripts/ccgc-enterprise-launcher.sh)
can also be installed in Downloads and run with the same `setup` arguments.
It requires the repository and Node.js 24; it is not a standalone binary.

The broker creates a non-invited LiteLLM internal user keyed by the GitHub
account ID because LiteLLM's per-user GitHub OAuth connection belongs to a
LiteLLM user. The employee never signs in to it. The key is restricted to the
approved Claude models and inference/model-info routes. Completing setup
deletes every older key for that user, so each employee has exactly one active
key. Rerunning setup with the same code within its hour returns the same key.

**Renewal and new machines.** Keys expire after 90 days. Ask Enterprise IT for
a new code and rerun setup; the existing GitHub connection is reused, so no
second device approval is normally needed, and the old key is revoked.
Restart existing Claude sessions afterwards.

`--no-browser` leaves GitHub approval to a browser opened manually. Multiple
configured GitHub credentials require explicit `--credential NAME`; no
account is selected arbitrarily. A failed setup leaves the previous local
profile unchanged.

**LiteLLM dashboard access is not part of employee setup.** The internal
service identity has no employee password or dashboard session, so it will not
appear under an employee's browser **Your connections** view. Setup verifies
the GitHub identity returned by LiteLLM's OAuth flow directly; it does not
read or replace browser cookies.

Advanced `login-litellm-key` remains available for an explicitly supplied
personal key; it validates ownership and discovery but does not initiate
GitHub OAuth. The native client's `login-key` remains a manual-key path, not
the guided setup. GitHub tokens stay in LiteLLM PostgreSQL.
See [enterprise setup](docs/ENTERPRISE.md) for the current flow.
[Mac managed enrollment](docs/mac/README.md) and
[`scripts/ccgc-enterprise-macos.sh`](scripts/ccgc-enterprise-macos.sh) describe
the older CCGC admission path, retained for migration only; their `enroll`
command is rejected by the current enrollment routes.

### Claude Desktop uses separate gateway settings

`~/.claude/settings.json` configures the CLI, not Desktop's third-party
inference mode. After direct-key login, export a secret-free Desktop
configuration from the repository with Node.js 24:

```bash
umask 077
node src/enterprise-cli.ts desktop-config > "$HOME/Downloads/ccgc-desktop-gateway.json"
```

Guided `setup` already writes the same configuration to
`~/.local/share/ccgc/enterprise/desktop-gateway.json`. If Desktop already uses
this helper in Gateway mode, relaunch it to pick up the newly verified key.

In Desktop, enable **Help > Troubleshooting > Enable Developer Mode**, open
**Developer > Configure Third-Party Inference**, and use the configuration
selector's **Import configuration** action. Import the generated JSON, then
choose **Apply Changes > Relaunch now**.

The export selects **Gateway**, **Helper script**, Bearer authentication, and
gateway model discovery. It calls the same Keychain-backed `token` command;
it contains no API key and does not fall back to an Anthropic credential.
Re-export after moving the repository or changing the Node executable path.
This is the macOS TypeScript-client path, not a portable Windows profile.

Desktop now identifies the provider as **Gateway**. Third-party mode uses
separate local conversation history; existing subscription history is not
deleted. A provider label alone is not proof: verify a real Code session in
LiteLLM's request logs under the intended user and `github_copilot` route.
CLI `doctor` does not verify Desktop.

See Anthropic's [gateway configuration](https://claude.com/docs/third-party/claude-desktop/gateway)
and [credential-helper contract](https://claude.com/docs/third-party/claude-desktop/credential-helper).

### Configured Claude model catalog

The scoped bootstrap now reconciles both user and existing virtual-key model
allowlists, including explicitly selected direct LiteLLM users. The client
refreshes `/v1/models` before configuration and model listing. Canonical IDs
are preserved, including dots in version numbers.

Live results for the tested employee connection on 2026-11-08:

| Client model ID | LiteLLM provider model | Result |
|---|---|---|
| `claude-sonnet-5.5` | `github_copilot/claude-sonnet-5.5` | API, CLI Read workflow, and Desktop Code Read workflow passed |
| `claude-sonnet-5` | `github_copilot/claude-sonnet-5` | Messages API and CLI Read workflow passed |
| `claude-haiku-5.5` | `github_copilot/claude-haiku-5.5` | Messages API and CLI Read workflow passed; Desktop auxiliary request also passed |
| `claude-haiku-4.5` | `github_copilot/claude-haiku-4.5` | Messages API and CLI Read workflow passed |
| `claude-opus-5.5` | `github_copilot/claude-opus-5.5` | **Blocked upstream:** GitHub returned `model_not_supported`; no fallback |

Discovery currently advertises all five configured routes; it is not an
upstream entitlement check. Opus 5.5 is therefore **not verified working** for
this connection. This reviewed catalog is not a claim that every model
available to every Copilot account has been exhaustively discovered.
These requests proved the configured employee's route, **not the identity of
the person currently operating the Mac**. That Mac was later found to contain
another employee's key. Correct-user sign-in and new live client proof remain
required; the new setup's synthetic coverage is not a substitute.

## Claude Code feature compatibility

### Authentication-path parity

| Capability | Direct LiteLLM key | CCGC admission compatibility |
|---|---|---|
| `/v1/models` | **Live pass** | Deployed and previously validated |
| Anthropic `/v1/messages` | **Live pass** | Deployed and previously validated |
| Chat Completions | **Live pass** | Same LiteLLM backend |
| Responses | **Live pass** | Same LiteLLM backend |
| Embeddings | Endpoint available; no approved embedding model is configured in the pilot | Same LiteLLM backend |
| Claude Code CLI | **Live Read workflow pass with Claude Code 2.1.319** | Deployed and previously validated |
| Claude Desktop Code tab | **Live Read workflow pass with Desktop 4.23118.0**, using its separate Gateway mode and Keychain helper | Current third-party-mode retest not performed |
| Desktop Chat / Cowork | Same documented third-party configuration; full interactive workflows not tested in this rollout | Not tested in this rollout |
| Per-user GitHub OAuth | Same LiteLLM user must own key and connection | Same downstream connection after CCGC resolution |
| Models, teams, budgets, rates, spend | Model restriction returned 403; TPM limit returned 429; spend was recorded; budget enforcement returned 422 after the accounting window | Native LiteLLM |
| Rotation and revocation | Replacement key passed; revoked key returned 401 | CCGC credential/admission plus LiteLLM key controls |
| User isolation | Unconnected second user returned 401 and could not use another user's OAuth connection | Previously validated on compatibility architecture |
| Rollback path | Not applicable | Temporary CCGC API key, admission issuance, and LiteLLM discovery **live pass** |

### Validated features

- Core chat and streaming
- Read, Edit, and Bash
- Model discovery and model switching
- Bounded admission renewal on the temporary compatibility path
- Image input and PDF document input
- Adaptive thinking, effort metadata, and thinking-block handling
- Low-effort between-tools thinking
- Exact token counting
- Resume of completed turns across admission renewal and gateway restart
- Resume of an exact pending tool batch after an enterprise worker restart
  (validated on the legacy revision; central-LiteLLM revalidation is pending)
- Coordinated agents/subagents with isolated branches
- Background Bash tasks and result collection
- Hooks
- Automatic compaction through a real context-limit continuation cycle
- Cron create/list/delete, durable restart, and timed one-shot firing
- Automatic-memory write, persistence, and fresh-session reload
- Auto permission mode through Claude Code's local classifier

| Feature | Status | Why |
|---|---|---|
| Explicit fixed-budget thinking | **Not supported by the current model** | The current Sonnet model requires adaptive thinking and rejects `thinking.type: enabled` with an explicit token budget. |
| Advisor tool | **Anthropic API only** | Claude Code `2.1.296` supports Advisor, but deliberately omits the `advisor_20260301` server tool when `ANTHROPIC_BASE_URL` points to this custom Copilot gateway. |

Validated features have automated coverage and, where applicable, a live
gateway proof. The table contains only behavior that remains unavailable,
model-limited, or short of its complete stateful release scenario.

Auto mode remains opt-in: the generated profile sets
`CLAUDE_CODE_AUTO_MODE_SERVER=0` so Claude Code uses its reviewed local
classifier instead of requesting Anthropic-only server safeguard verdicts.
Normal allow/deny rules and explicit approvals remain authoritative.

## Prerequisites

- Node.js 24
- npm
- Docker for local image validation
- Azure CLI with Bicep for infrastructure validation and deployment
- Go 1.25 or later only when building the optional cross-platform enrollment binary
- macOS for Keychain integration or Windows for DPAPI integration
- An Azure subscription and Microsoft Entra permissions for enterprise deployment
- A GitHub Copilot seat for every employee who uses the gateway

## Getting started

```bash
git clone https://github.com/msftse-org/claude-code-with-github-copilot.git
cd claude-code-with-github-copilot
npm ci
npm run check
npm test
```

See [Mac enterprise setup](docs/mac/README.md) or
[Windows enterprise setup](docs/windows/README.md) for employee installation.
Infrastructure operators should start with
[the enterprise deployment guide](docs/ENTERPRISE.md).

## Developer validation

```bash
npm run check
npm test
npm run test:bootstrap
npm run test:client

docker build -f server/Dockerfile.enterprise -t ccgc-enterprise-broker:test .
docker build -f server/Dockerfile.enterprise-litellm -t ccgc-enterprise-litellm:test .

az bicep build --file infra/enterprise/main.bicep --stdout > enterprise.json
checkov -d infra/enterprise --framework bicep --skip-download --compact \
  --skip-check CKV_AZURE_43
```

The PostgreSQL integration test runs when `CCGC_TEST_POSTGRES_URL` is set.
`CKV_AZURE_43` is skipped because Checkov cannot evaluate the Bicep
`take(...uniqueString...)` storage name expression; the expression is lowercase
alphanumeric and capped at Azure's 24-character limit.

The LiteLLM image pins both its base digest and an upstream source commit/archive
hash. The source overlay supplies the per-user GitHub OAuth routes and database
migration that are not yet in the pinned published image. A non-secret invalid
Copilot token sentinel permits router initialization only; disconnected users
still fail closed before any upstream request, and real per-user sessions
replace the sentinel on connected requests.

## Project structure

| Path | Purpose |
|---|---|
| [`src/`](src) | Enterprise control plane, administration, operator API, client, and legacy rollback implementation |
| [`cmd/ccgc-enterprise/`](cmd/ccgc-enterprise) | Cross-platform enrollment and credential-helper binary |
| [`web/admin/`](web/admin) | Dependency-free Entra-authenticated administration panel |
| [`infra/enterprise/`](infra/enterprise) | Enterprise Azure Bicep deployment and generated ARM template |
| [`server/`](server) | LiteLLM overlay, bootstrap, image definitions, and supporting tests |
| [`deploy/existing-litellm/`](deploy/existing-litellm) | Additive CCGC overlay for a customer-owned LiteLLM |
| [`scripts/`](scripts) | Entra, deployment, packaging, and managed-device automation |
| [`test/`](test) | Unit, integration, lifecycle, infrastructure, and regression tests |
| [`docs/`](docs) | Architecture, operations, platform setup, examples, and diagram provenance |

## Enterprise pilot automation

The central architecture exposes the employee-authenticated control plane and
the CCGC-enabled LiteLLM inference gateway. Every data service remains private.
The assignment-required
Enterprise Application gives the employee group only `CCGC.Access` and the IT
administrator group only `CCGC.Admin`; the control plane validates the required
role for lifecycle operations, while LiteLLM custom auth validates inference
credentials and the fixed tenant.

```bash
npm run enterprise:entra -- \
  --display-name 'CCGC Enterprise API' \
  --pilot-group-object-id 00000000-0000-0000-0000-000000000000 \
  --admin-group-object-id 11111111-1111-1111-1111-111111111111 \
  --admin-portal-redirect-uri https://PUBLIC_CONTROL_PLANE_FQDN/ccgc/admin \
  --confirm-entra-changes

npm run enterprise:pilot -- foundation \
  --parameters /private/path/enterprise.parameters.json
npm run enterprise:pilot -- foundation \
  --parameters /private/path/enterprise.parameters.json \
  --confirm-deploy

npm run enterprise:pilot -- images \
  --parameters /private/path/enterprise.parameters.json

npm run enterprise:pilot -- runtime \
  --parameters /private/path/enterprise.parameters.json \
  --images .azure/enterprise-images.GIT_SHA.json
npm run enterprise:pilot -- runtime \
  --parameters /private/path/enterprise.parameters.json \
  --images .azure/enterprise-images.GIT_SHA.json \
  --confirm-deploy
```

The no-confirm variants run Azure `what-if`. Foundation deployment creates the
private Premium ACR and scale-to-zero VNet build pool first; image publication
then produces digest-only references consumed by runtime deployment.
Image publication creates the private `.azure/` manifest directory when needed.
The Docker build context remains an explicit allowlist, including the LiteLLM
configuration, authentication extension, and non-secret bootstrap sentinel;
local credentials and deployment parameter files are not included.

## LiteLLM bootstrap and employee onboarding

The confirmed runtime deployment starts the private Bicep-defined bootstrap job
after the Container Apps revision is created. The job initializes the
Entra-only control database, grants the control plane and LiteLLM their required database rights,
and idempotently creates the LiteLLM per-user OAuth credential and approved
`github_copilot/<model>` mappings. It also reconciles every active binding,
pending enrollment, and LiteLLM internal user to the deployment-approved Claude
catalog, revoking stale admissions when a binding changes. No public bootstrap
endpoint or manual database command exists.

### Employee enrollment with GitHub Actions

Enterprise IT enrolls and offboards employees with the
[**CCGC employee access**](.github/workflows/ccgc-employee-access.yml)
workflow. It runs only from the Actions tab in the protected `ccgc-admin`
environment, signs in to Entra through GitHub OIDC (no stored secret), and
calls the broker with an app-only token carrying `CCGC.Admin`.

**One-time setup** (after `scripts/enterprise-entra.mjs` created the broker API):

```bash
npm run enterprise:actions-identity -- \
  --repository msftse-org/claude-code-with-github-copilot \
  --broker-url https://PUBLIC_CONTROL_PLANE_FQDN \
  --configure-github \
  --confirm-entra-changes
```

The idempotent script creates the **CCGC Employee Access Automation** app
registration with a federated credential for
`repo:OWNER/REPO:environment:ccgc-admin`, assigns it `CCGC.Admin` (no client
secret and no Azure RBAC), creates the `ccgc-admin` environment restricted to
`main`, and sets the `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
`CCGC_ADMIN_AUDIENCE`, and `CCGC_BROKER_URL` environment variables. Granting an
application role requires an Entra administrator for the broker API.

**Enroll or renew an employee:**

1. Open **Actions → CCGC employee access → Run workflow**.
2. Choose `enroll`, enter the employee's GitHub username, and optionally their
   work email (stored only as LiteLLM metadata).
3. Open the finished run's summary, copy the `CCGC-…` code and the employee
   instructions, and send them privately.

The broker resolves the GitHub username to its immutable account ID and
creates or reuses that employee's LiteLLM internal user. The code expires
after one hour, is consumed by the employee's setup, and works only when that
GitHub account approves the device flow. It appears only in the run summary,
never in the job log. Repository readers can see run summaries; delete the run
if that exposure is not acceptable.

**Offboard an employee:** run the workflow with `revoke` and the GitHub
username. The broker revokes all enrollments for the account, disconnects its
Copilot connection from LiteLLM, and deletes the LiteLLM user with all of its
keys. Claude stops working on the employee's next request.

Anyone with write access to the repository can dispatch the workflow on
`main`. Keep the repository private and write access limited to Enterprise IT,
or add required reviewers to the `ccgc-admin` environment.

Existing employees do **not** rerun setup for routine control-plane,
LiteLLM, model-catalog, image, or Claude Code updates. Rerun setup with a new
code only for key renewal, a new workstation or user profile, or after an
offboarding and re-enrollment.

The equivalent administrator CLI, for break-glass use with a signed-in
`CCGC.Admin` user, is:

```bash
cp docs/examples/enterprise-create-enrollment.example.json \
  /private/path/create-enrollment.json
chmod 600 /private/path/create-enrollment.json

npm run enterprise:manage -- create-enrollment \
  --url https://PUBLIC_CONTROL_PLANE_FQDN \
  --audience api://ENTRA-APPLICATION-ID \
  --input /private/path/create-enrollment.json \
  --output /private/path/enrollment.json
```

### Legacy managed macOS script

Employees enrolled before this flow used the managed bash script and a 30-day
broker key. Its `enroll` command is no longer accepted for new enrollments;
use guided setup instead. Existing installations keep working until migrated,
and the script's `doctor` command remains available:

```bash
/bin/bash "$HOME/.local/share/ccgc/enterprise/ccgc-enterprise-macos.sh" doctor
```

### Client validation history

Earlier checks of shared CLI settings did not establish Desktop's provider
routing. On 2026-11-08, Desktop `4.23118.0` was explicitly switched to Gateway
mode. A real Code session read an isolated synthetic file and returned its
sentinel; LiteLLM recorded successful `github_copilot/claude-sonnet-5.5`
requests under the same user who owns the virtual key and GitHub connection.
CLI `2.1.319` independently passed the same kind of Read workflow. Neither the
Pro account label nor a successful CLI check establishes Desktop routing.
Later inspection established that this was another employee's stored key,
not a verified identity of the current Mac operator. These historical passes
must not be described as proof that the operator's own Copilot account works.

The Go implementation under [`cmd/ccgc-enterprise/`](cmd/ccgc-enterprise)
remains an optional manual-key binary path; it does not implement guided
enrollment. Distribute any binary through an approved organization channel;
do not bypass Gatekeeper or MDM policy.

### Administrator panel

The broker also serves a dependency-free administrator panel at
`/ccgc/admin`. It provides readiness checks, enrollment creation with
copyable employee instructions, legacy employee-binding revocation, and API-key
revocation. Offboard current employees with the workflow's `revoke` action.
It also lists bindings, API-key metadata, and recent enrollments through the
paginated access-query contract. The panel never requests or
displays LiteLLM keys and retains Entra tokens and one-time enrollment codes
only in page memory. Browser sign-in uses the dependency-free Entra
authorization-code-with-PKCE adapter documented in
[`web/admin/README.md`](web/admin/README.md). The broker still validates
`CCGC.Admin` for every administration API request.

The older administrator-driven create/connect/link flow remains available for
legacy Entra employees and recovery operations:

### Manual administrator connection

Create the employee's LiteLLM `internal_user` and its private output file, then
start the device flow through the broker's `CCGC.Admin` lifecycle routes while
the employee is present:

```bash
npm run enterprise:manage -- create-user \
  --url https://PUBLIC_CONTROL_PLANE_FQDN \
  --audience api://ENTRA-APPLICATION-ID \
  --input /private/path/create-user.json \
  --output /private/path/created-user.json
npm run enterprise:manage -- connect \
  --url https://PUBLIC_CONTROL_PLANE_FQDN \
  --audience api://ENTRA-APPLICATION-ID \
  --input /private/path/connect-user.json
```

The command displays GitHub's public verification URL and one-time code, polls
until completion, verifies the active Copilot seat, and fails if the connected
GitHub login differs from `connect-user.json`. Input files must be user-owned
mode-0600 regular files; `create-user` creates its output exclusively with mode
0600.

### Manual administrator binding

The administrator verifies that the Entra principal and GitHub account belong to the
same employee, then writes the approved private binding:

```bash
npm run enterprise:manage -- link \
  --url https://PUBLIC_CONTROL_PLANE_FQDN \
  --audience api://ENTRA-APPLICATION-ID \
  --input /private/path/link.json
```

`link.json` supplies the immutable Entra and GitHub IDs, approved models,
`litellmCredentialName`, and the employee's LiteLLM user key. The admin command
first verifies `/credentials/user_connections` reports that the key is connected
to the confirmed GitHub login, then stores the key in Key Vault. Updating a
binding increments its revision and revokes existing admissions.

### Entra employee configuration

```bash
npm run enterprise:client -- login \
  --gateway https://PUBLIC_CONTROL_PLANE_FQDN \
  --audience api://ENTRA-APPLICATION-ID

npm run enterprise:client -- configure
npm run enterprise:client -- configure --apply
npm run enterprise:client -- models
claude
```

`DefaultAzureCredential` must resolve to the intended employee. Production
deployment must define the approved Entra credential source and local token
cache policy.

## Security properties

- One immutable GitHub account ID maps to one LiteLLM internal user, one
  per-user Copilot connection, and one active 90-day virtual key.
- Enrollment codes are random, single-use, hashed server-side, valid for one
  hour, and accepted only when the named GitHub account approves the device
  flow; a different approver is disconnected.
- Employee keys are restricted to approved models and inference/model-info
  routes, and stored locally only in macOS Keychain.
- The enrollment workflow uses GitHub OIDC federation without stored secrets
  and an app-only `CCGC.Admin` token scoped to the broker API.

For the legacy admission path:

- One immutable Entra principal maps to one immutable GitHub account.
- Every employee uses their own Copilot seat.
- Admission tokens are random, bounded, hashed server-side, and stored locally
  only in macOS Keychain.
- LiteLLM custom auth accepts only the configured tenant and resolves opaque
  credentials from their server-side hashes.
- Admission attempts are consumed transactionally for Messages requests, not
  model discovery.
- The active database binding and Key Vault secret must agree on the immutable
  GitHub numeric account ID and login.
- Each request uses only the bound LiteLLM virtual key; LiteLLM resolves the
  corresponding encrypted GitHub connection and keeps Copilot sessions
  user-scoped.
- Ordinary existing LiteLLM keys fall through to native LiteLLM authentication.
- The control plane does not proxy, retry, log, or store inference bodies.
- No provider fallback or cross-user response cache is used.

## Known limitations

- The GitHub Copilot connector is unofficial and requires explicit organization
  and vendor-policy approval.
- Claude Code `2.1.296` is the minimum validated client; newer semantic
  versions are accepted by the managed enrollment script.
- Fixed-budget thinking is model-limited, and the Advisor tool remains available
  only through the direct Anthropic API.
- Initial enrollment binaries are not yet Apple-notarized or
  Authenticode-signed.
- The deployed environment is an enterprise pilot, not a general production
  service.

## Deployment status and remaining gates

The Sweden Central pilot runs LiteLLM `1.108.0` with direct per-user virtual
keys and the CCGC admission path retained temporarily for rollback. PostgreSQL
is healthy and LiteLLM reports its database connected.

- [LiteLLM UI](https://ca-ccgc-pilot-litellm.bluefield-2d967d14.swedencentral.azurecontainerapps.io/ui)
- [LiteLLM gateway](https://ca-ccgc-pilot-litellm.bluefield-2d967d14.swedencentral.azurecontainerapps.io)
- [Temporary compatibility broker](https://ca-ccgc-pilot-broker.bluefield-2d967d14.swedencentral.azurecontainerapps.io)

The latest scoped-catalog deployment uses broker/bootstrap code from
`4b715f9`, with broker revision `0000024` and the retained LiteLLM revision
`0000010`. Its runtime preview created and deleted no resources, and automatic
bootstrap succeeded. Four configured models passed live inference; Opus 5.5
remains blocked upstream as listed above. Desktop Code's direct-key GUI
workflow passed. Broker retirement still requires broader two-user testing,
traffic observation, and a separate destructive what-if.

### Remaining production gates

Production rollout still requires:

1. Organization and vendor approval for the unofficial Copilot route
2. Apple Developer ID notarization and Windows Authenticode signing
3. Two-user central-LiteLLM isolation, existing-LiteLLM compatibility, load,
   replica-failure, restore, and noisy-neighbor testing
4. Monitoring privacy, cost, capacity, and operational-readiness approval
5. Production release, rollback, backup, disaster-recovery, and support runbooks

The foundation must not be described as production-ready until these gates pass.

## Diagram provenance

The current authentication comparison shows the recommended direct LiteLLM
virtual-key path and the temporary CCGC admission rollback path, including
their shared per-user GitHub OAuth behavior and different operational costs.
Diagram sources, provenance, and validation receipts are in
[docs/diagrams](docs/diagrams/README.md).

## Resources

| Document | Purpose |
|---|---|
| [docs/ENTERPRISE.md](docs/ENTERPRISE.md) | Enterprise architecture, implementation, onboarding, and release gates |
| [docs/mac/README.md](docs/mac/README.md) | Employee Mac setup and daily operation |
| [docs/windows/README.md](docs/windows/README.md) | Employee Windows setup and credential storage |
| [docs/PRD.md](docs/PRD.md) | Product and security contract |
| [docs/diagrams/README.md](docs/diagrams/README.md) | Diagram sources and provenance |
