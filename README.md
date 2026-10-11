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
Shared multi-user worker fleet
        |
        v
Account-scoped native connector -> Employee's GitHub Copilot seat -> Anthropic Models
```

Each employee has a separate identity binding, Copilot authorization, connector
context, model catalog, admission, limits, and encrypted conversation
checkpoints. Worker replicas are shared for scale, but seats, credentials,
token refresh state, checkpoints, and quotas remain account scoped.

> [!IMPORTANT]
> The enterprise foundation is implemented and locally validated, but it is not
> deployed or approved for production use. The remaining release gates are
> documented in [docs/ENTERPRISE.md](docs/ENTERPRISE.md).

> [!WARNING]
> The Copilot connector is unofficial and is not endorsed by GitHub or
> Anthropic. The organization must approve this use before onboarding employees.

## Why the enterprise path does not use LiteLLM

The enterprise path has two required project components:

| Component | What it is | Why it is required |
|---|---|---|
| Enterprise admission broker | Project-developed TypeScript/Node.js service. | Validates Entra identity, resolves the employee binding, issues bounded admissions, reserves attempts, fences dispatches, and records audit metadata. |
| Shared multi-user worker | Project-developed TypeScript/Node.js service. | Verifies short-lived broker-signed dispatches, selects an account-scoped Copilot connector, enforces per-user fairness, and restores encrypted branch checkpoints on any replica. |

The native connector in `src/copilot.ts` performs GitHub identity validation,
Copilot token refresh, model discovery, token counting, and Anthropic Messages
transport independently for each account context. Unmodified LiteLLM is not used
because its GitHub Copilot credential directory is process global and therefore
cannot safely select many employee seats inside one shared worker process.

LiteLLM remains only in the retained single-user proof deployment. API
Management is not included because the broker already owns enterprise identity,
policy, admission, routing, and audit controls.

## Enterprise Azure components

| Component | Purpose |
|---|---|
| Azure Container Apps | Runs two or more broker replicas and a shared worker fleet that scales from 2 to 30 replicas. |
| Microsoft Entra ID | Authenticates employees and supplies immutable tenant/object identity. |
| Azure Database for PostgreSQL | Stores user bindings, admission state, attempt reservations, dispatch fences, and audit intent. |
| Azure Key Vault | Stores account-scoped GitHub credentials, the dispatch-signing secret, and checkpoint-encryption material. |
| Azure Blob Storage | Stores client-side-encrypted branch checkpoints with ETag conditional writes. |
| Azure Container Registry | Stores approved immutable broker and worker images. |
| NAT Gateway | Gives the private workers controlled, stable outbound connectivity. |
| Azure Monitor and Application Insights | Records operational metadata without prompt or response bodies. |

The broker is the only employee-facing enterprise ingress. The worker service,
PostgreSQL, Key Vault, Blob Storage, and the registry remain private.

## On the Mac

Each employee needs:

- Official Claude Code `2.1.296`
- The project-developed enterprise `ccgc` command-line helper
- A bounded opaque admission credential stored in macOS Keychain
- `~/.claude/settings.json` pointing Claude Code to the enterprise broker
- A private, non-secret profile containing Entra, GitHub, model, and binding
  metadata

The Mac uses Microsoft Entra to request an admission. GitHub and Copilot
credentials remain in private Key Vault and are loaded only into the matching
account-scoped worker connector.

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

az bicep build --file infra/enterprise/main.bicep --stdout > enterprise.json
checkov -d infra/enterprise --framework bicep --skip-download --compact \
  --skip-check CKV_AZURE_43
```

The PostgreSQL integration test runs when `CCGC_TEST_POSTGRES_URL` is set.
`CKV_AZURE_43` is skipped because Checkov cannot evaluate the Bicep
`take(...uniqueString...)` storage name expression; the expression is lowercase
alphanumeric and capped at Azure's 24-character limit.

## Employee onboarding

Onboarding has two separate approvals.

### 1. Operator links the employee

The operator verifies that the Entra principal and GitHub account belong to the
same employee, then writes the approved private binding:

```bash
export CCGC_POSTGRES_URL='postgresql://BROKER_ID@PRIVATE_HOST:5432/postgres?sslmode=require'
export CCGC_KEY_VAULT_URL='https://PRIVATE_VAULT.vault.azure.net/'

npm run enterprise:admin -- link --confirm-same-user \
  < /private/path/link.json
```

The binding contains the immutable Entra and GitHub IDs, approved models, and
that employee's Key Vault credential reference. Updating a binding increments
its revision and revokes existing admissions.

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
- Account-scoped connectors never share GitHub OAuth credentials, Copilot token
  caches, or refresh locks.
- Conversation checkpoints are encrypted before private Blob Storage and use
  ETag compare-and-swap to detect concurrent writers.
- Broker and worker do not retry inference.
- Prompt and response bodies are not logged or stored by the broker.
- No provider fallback, response cache, or shared credential pool is used.

## Deployment status and remaining gates

No enterprise Azure resources have been deployed from this repository.
Production deployment still requires:

1. Entra API registration, permissions, and Conditional Access approval
2. Private PostgreSQL administrator/bootstrap flow
3. Built, scanned, signed, and immutable broker/worker images
4. Supported employee GitHub linking/token revocation automation
5. Live two-user, revocation, load, replica-failure, restore, and noisy-neighbor testing
6. Monitoring privacy review
7. Azure cost and change-plan approval
8. Vendor and organization approval for the unofficial Copilot route

The foundation must not be described as production-ready until these gates pass.

## Architecture poster

![Enterprise architecture](docs/diagrams/ccgc-enterprise-runtime.png)

The current diagram shows the enterprise broker, horizontally scaled multi-user
worker fleet, account-scoped native connectors, private credential store, and
encrypted checkpoint store. It also records the verified rich-input,
adaptive-thinking, token-counting, agent-branch, background-task, and
completed-turn resume state.
Diagram sources and validation receipts are in
[docs/diagrams](docs/diagrams/README.md).

## Documentation

| Document | Purpose |
|---|---|
| [docs/ENTERPRISE.md](docs/ENTERPRISE.md) | Enterprise architecture, implementation, onboarding, and release gates |
| [docs/mac/README.md](docs/mac/README.md) | Employee Mac setup and daily operation |
| [docs/PRD.md](docs/PRD.md) | Product and security contract |
| [docs/diagrams/README.md](docs/diagrams/README.md) | Diagram sources and provenance |
