# Enterprise Claude Code with GitHub Copilot

This repository implements an enterprise architecture that lets employees use
the **official Claude Code CLI** with Anthropic models provided through **each
employee's own GitHub Copilot seat**.

```text
Employee Claude Code
        |
        | Microsoft Entra identity
        v
Enterprise admission broker
        |
        v
Multi-user worker Container App (2-30 shared replicas)
        |
        v
LiteLLM Gateway Container App (2-10 shared replicas)
        |
        v
        Employee's GitHub Copilot seat -> Anthropic Models
```

Each employee has a separate identity binding, LiteLLM user key, GitHub OAuth
connection, Copilot authorization, model catalog, admission, limits, and
encrypted conversation checkpoints. The broker and worker retain enterprise
control and state safety; LiteLLM owns per-user GitHub OAuth, Copilot token
exchange, Anthropic Messages transport, streaming conversion, and provider
session caches.

> [!IMPORTANT]
> The enterprise foundation is implemented and locally validated, but it is not
> deployed or approved for production use. The remaining release gates are
> documented in [docs/ENTERPRISE.md](docs/ENTERPRISE.md).

> [!WARNING]
> The Copilot connector is unofficial and is not endorsed by GitHub or
> Anthropic. The organization must approve this use before onboarding employees.

## Why the enterprise path uses LiteLLM and a broker

The enterprise path has two required project components:

| Component | What it is | Why it is required |
|---|---|---|
| Enterprise admission broker | Project-developed TypeScript/Node.js service. | Validates Entra identity, resolves the employee binding, issues bounded admissions, reserves attempts, fences dispatches, and records audit metadata. |
| Shared multi-user worker | Project-developed TypeScript/Node.js service. | Verifies short-lived broker-signed dispatches, enforces per-user fairness, restores encrypted branch checkpoints on any replica, and forwards each call with the bound LiteLLM user key. |
| LiteLLM Gateway | Separate private Container App. | Implements per-user GitHub OAuth, encrypted user connections, Copilot token exchange, Anthropic Messages transport, streaming, token counting, and provider session caching. |

Current LiteLLM Gateway supports **Per-user GitHub OAuth**: each request is
authenticated as the same LiteLLM user who connected GitHub, and each user's
encrypted GitHub connection is stored separately in LiteLLM PostgreSQL. This
removes the custom enterprise device flow, GitHub-token custody, Copilot token
exchange, endpoint validation, and provider transport.

LiteLLM does not replace the broker or worker because it does not implement this
project's Entra-to-GitHub immutable binding, bounded admissions, signed dispatch
fences, per-user branch quotas, encrypted checkpoints, or no-replay state
machine. API Management remains omitted because the broker already owns those
controls.

## Enterprise Azure components

| Component | Purpose |
|---|---|
| Azure Container Apps | Independently scales broker (2-10), worker (2-30), and LiteLLM Gateway (2-10) replicas. |
| Microsoft Entra ID | Authenticates employees and supplies immutable tenant/object identity. |
| Azure Database for PostgreSQL | Uses an Entra-only server for enterprise control state and a dedicated private server for LiteLLM's encrypted OAuth connections and gateway state. |
| Azure Key Vault | Stores account-scoped LiteLLM user keys, LiteLLM master/salt keys, dispatch signing, database connection material, and checkpoint encryption. |
| Azure Blob Storage | Stores client-side-encrypted branch checkpoints with ETag conditional writes. |
| Azure Container Registry | Stores approved immutable broker, worker, and LiteLLM images. |
| NAT Gateway | Gives the private workers controlled, stable outbound connectivity. |
| Azure Monitor and Application Insights | Records operational metadata without prompt or response bodies. |

The broker is the Claude Code ingress. LiteLLM exposes its private dashboard and
per-user GitHub connection endpoints through approved corporate connectivity;
the worker and both PostgreSQL servers remain private.

## On the Mac

Each employee needs:

- Official Claude Code `2.1.296`
- The project-developed enterprise `ccgc` command-line helper
- A bounded opaque admission credential stored in macOS Keychain
- `~/.claude/settings.json` pointing Claude Code to the enterprise broker
- A private, non-secret profile containing Entra, GitHub, model, and binding
  metadata

The Mac uses Microsoft Entra to request an admission. GitHub OAuth tokens remain
encrypted in LiteLLM PostgreSQL. The worker loads only the matching LiteLLM user
key from Key Vault.

See [Mac enterprise setup and operation](docs/mac/README.md) for installation,
Entra sign-in, configuration, Keychain behavior, verification, and daily use.

## Claude Code feature compatibility

### Validated features

- Core chat and streaming
- Read, Edit, and Bash
- Model discovery and model switching
- Bounded admission renewal
- Image input and PDF document input
- Adaptive thinking, effort metadata, and thinking-block handling
- Low-effort between-tools thinking
- Exact token counting
- Resume of completed turns across admission renewal and gateway restart
- Resume of an exact pending tool batch after an enterprise worker restart
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

## Developer validation

Requirements:

- macOS for the enterprise client and Keychain integration
- Node.js 24
- npm
- Docker
- Azure CLI and Bicep for infrastructure validation

```bash
npm ci
npm run check
npm test
npm run test:bootstrap
npm run test:client

docker build -f server/Dockerfile.enterprise -t ccgc-enterprise-broker:test .
docker build -f server/Dockerfile.enterprise-worker -t ccgc-enterprise-worker:test .
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

## LiteLLM bootstrap and employee onboarding

After deployment, an operator creates the database-backed per-user OAuth
credential and approved public model mappings. The LiteLLM image intentionally
does not define them in `config.yaml`; doing so would select the direct,
single-account SDK device flow during gateway startup.

```bash
export CCGC_LITELLM_URL='https://PRIVATE_LITELLM_GATEWAY/'
export CCGC_LITELLM_MASTER_KEY='sk-PRIVATE-LITELLM-MASTER-KEY'

npm run enterprise:admin -- bootstrap --confirm-bootstrap \
  < /private/path/litellm-bootstrap.json
```

`litellm-bootstrap.json` contains `litellmCredentialName` and the approved
Claude `models` array. The command idempotently creates the Per-user GitHub
OAuth credential and missing `github_copilot/<model>` mappings through
LiteLLM's management API.

Employee onboarding then has two approvals. The employee key must belong to a
LiteLLM `internal_user`; an unowned raw virtual key cannot use the per-user
connection endpoints.

### 1. Operator links the employee

The operator verifies that the Entra principal and GitHub account belong to the
same employee, then writes the approved private binding:

```bash
export CCGC_POSTGRES_URL='postgresql://BROKER_ID@PRIVATE_HOST:5432/postgres?sslmode=require'
export CCGC_KEY_VAULT_URL='https://PRIVATE_VAULT.vault.azure.net/'
export CCGC_LITELLM_URL='https://PRIVATE_LITELLM_GATEWAY/'

npm run enterprise:admin -- link --confirm-same-user \
  < /private/path/link.json
```

`link.json` supplies the immutable Entra and GitHub IDs, approved models,
`litellmCredentialName`, and the employee's LiteLLM user key. The admin command
first verifies `/credentials/user_connections` reports that the key is connected
to the confirmed GitHub login, then stores the key in Key Vault. Updating a
binding increments its revision and revokes existing admissions.

### 2. Employee configures the Mac

```bash
npm run enterprise:client -- login \
  --gateway https://PRIVATE_GATEWAY \
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

- One immutable Entra principal maps to one immutable GitHub account.
- Every employee uses their own Copilot seat.
- Admission tokens are random, bounded, hashed server-side, and stored locally
  only in macOS Keychain.
- PostgreSQL atomically reserves attempts and creates monotonic dispatch fences.
- Broker-signed, 60-second dispatch assertions bind tenant, principal, account,
  credential reference, binding revision, admission, branch, model, fence, and
  dispatch ID.
- Shared workers reject invalid assertions, duplicate dispatch IDs, stale
  branch fences, cross-account state, model drift, and per-user saturation.
- Each dispatch uses only the bound LiteLLM user key; LiteLLM resolves the
  corresponding encrypted GitHub connection and keeps Copilot sessions
  user-scoped.
- Conversation checkpoints are encrypted before private Blob Storage and use
  ETag compare-and-swap to detect concurrent writers.
- Broker and worker do not retry inference.
- Prompt and response bodies are not logged or stored by the broker.
- No provider fallback or cross-user response cache is used.

## Deployment status and remaining gates

No enterprise Azure resources have been deployed from this repository.
Production deployment still requires:

1. Entra API registration, permissions, and Conditional Access approval
2. Private PostgreSQL administrator/bootstrap flow
3. Built, scanned, signed, and immutable broker, worker, and LiteLLM images
4. Approved LiteLLM license/edition and user-key lifecycle
5. Live two-user, revocation, load, replica-failure, restore, and noisy-neighbor testing
6. Monitoring privacy review
7. Azure cost and change-plan approval
8. Vendor and organization approval for the unofficial Copilot route

The foundation must not be described as production-ready until these gates pass.

## Architecture poster

![Enterprise multi-user architecture](docs/diagrams/ccgc-enterprise-runtime-multiuser-litellm-professional-v6.png)

The current poster shows an independently scaled broker and one shared inference
plane containing separate multi-user worker and LiteLLM Gateway Container Apps.
The worker and LiteLLM retain independent replica ranges and responsibilities.
The poster also includes the separate control and LiteLLM databases, private Key
Vault, and encrypted checkpoint store. The reviewed Archify JSON and interactive
HTML remain the authoritative technical architecture; the GPT-image poster is
its presentation companion. Diagram sources, model provenance, and validation receipts are in
[docs/diagrams](docs/diagrams/README.md).

## Documentation

| Document | Purpose |
|---|---|
| [docs/ENTERPRISE.md](docs/ENTERPRISE.md) | Enterprise architecture, implementation, onboarding, and release gates |
| [docs/mac/README.md](docs/mac/README.md) | Employee Mac setup and daily operation |
| [docs/PRD.md](docs/PRD.md) | Product and security contract |
| [docs/diagrams/README.md](docs/diagrams/README.md) | Diagram sources and provenance |
