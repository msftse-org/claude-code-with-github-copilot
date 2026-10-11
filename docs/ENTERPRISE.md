# Enterprise foundation

The repository contains an **implemented, locally validated multi-user
enterprise foundation** based on Azure Container Apps. It is not deployed and
is not yet approved for production use. The enterprise path now uses a private,
shared LiteLLM Gateway with per-user GitHub OAuth. The historical single-user VM
remains independent as rollback evidence.

## Required runtime components

| Component | Responsibility |
|---|---|
| Enterprise broker | Validates Microsoft Entra identity, resolves the immutable GitHub binding, issues bounded admissions, reserves attempts transactionally, fences each branch dispatch, signs a 60-second worker assertion, and emits audit intent. |
| Shared multi-user worker fleet | Runs as one Container App scaled across 2-30 replicas. Each replica verifies broker assertions, enforces per-user and global capacity, restores durable branch state, and forwards native Messages calls with the bound LiteLLM user key. |
| LiteLLM Gateway | Runs as a separate private Container App scaled across 2-10 replicas. It owns per-user GitHub OAuth, encrypted user connections, Copilot token exchange/session caching, Anthropic Messages transport, streaming, and token counting. |
| PostgreSQL | Stores account bindings, admission budgets, active branch reservations, monotonic fences, outcomes, and the audit outbox. |
| LiteLLM PostgreSQL | Dedicated private database for encrypted per-user GitHub connections, virtual keys, and gateway state. |
| Encrypted Blob checkpoints | Stores pending tool lineage and other branch state encrypted by the worker. Blob ETags reject concurrent or stale writes. |

The broker is the Claude Code ingress. LiteLLM's private ingress is used for
approved dashboard/onboarding and worker traffic. API Management is omitted
because it would duplicate broker controls and add another streaming hop.

The broker and worker are TypeScript modules running on Node.js 24. The worker
keeps only account-keyed `LiteLLMBackend` clients; GitHub tokens and Copilot
sessions are owned by LiteLLM and are never loaded into Node.js worker memory.

## Implemented request path

1. `ccgc-enterprise login` obtains a gateway-audience Entra token through
   `DefaultAzureCredential` and verifies the tenant/object binding.
2. Claude's `apiKeyHelper` creates or renews a bounded admission and stores only
   its random 256-bit token in macOS Keychain.
3. Claude sends native `/v1/messages` and `/v1/models` requests to the broker.
4. PostgreSQL locks the admission, verifies binding revision, model and limits,
   rejects an already-active branch, increments the attempt and fence, and
   writes audit intent in the same transaction.
5. The broker signs a short-lived assertion containing the tenant, principal,
   immutable binding revision, GitHub account, Key Vault credential reference,
   admission, branch, model, fence, and dispatch ID.
6. Any shared worker replica verifies the assertion, loads only the matching
   LiteLLM user key, and selects or creates that account's LiteLLM client.
7. The worker loads the branch checkpoint from private Blob Storage, decrypts
   and validates its full identity envelope, then forwards the Messages request.
   LiteLLM resolves the same authenticated user's encrypted GitHub connection
   and performs the Copilot request.
   Checkpoint updates use ETag compare-and-swap; neither broker nor worker
   transparently retries inference.

The broker stores no prompt or response body. The checkpoint can contain
pending assistant tool blocks and arguments, so it is encrypted before leaving
the worker and must never be logged.

## Multi-user isolation and scaling

- Worker replicas are interchangeable; sticky sessions are not required.
- LiteLLM client cache keys include tenant, principal, binding revision, GitHub
  account ID, and credential secret name.
- Each cached client contains only one LiteLLM user key. LiteLLM isolates
  encrypted GitHub connections and short-lived Copilot sessions by user.
- PostgreSQL permits one active dispatch per admission branch and at most four
  active dispatches per principal by default.
- Each worker also enforces per-user and global active-branch limits before
  allocating connector/session state.
- Branch checkpoints include tenant, principal, binding revision, admission,
  branch, and GitHub account ID as authenticated encryption context.
- Container Apps runs 2-30 worker replicas and scales on concurrent HTTP
  requests. Dedicated workload-profile capacity, NAT/SNAT use, memory per
  connector, and long stream duration remain live sizing gates.

Multi-user workers provide logical rather than per-container isolation. This is
an explicit density tradeoff. The compensating controls are immutable bindings,
signed dispatches, account-keyed objects, encrypted state, conditional writes,
strict input validation, no dynamic user code, and adversarial two-user tests.

## Source layout

| Path | Purpose |
|---|---|
| `src/enterprise-auth.ts` | Entra issuer/audience/tenant/scope and immutable object-ID validation |
| `src/enterprise-store.ts` | PostgreSQL bindings, admissions, per-branch reservations/fences, per-user concurrency, and audit outbox |
| `src/enterprise-dispatch.ts` | Short-lived broker dispatch signing and worker verification |
| `src/enterprise-server.ts` | Broker control, native Messages/model routes, and signed worker dispatch |
| `src/enterprise-connector.ts` | Key Vault LiteLLM user-key resolution and account-scoped LiteLLM client pool |
| `src/litellm.ts` | Fixed-origin Anthropic Messages and token-count forwarding to LiteLLM |
| `src/enterprise-checkpoint.ts` | Client-side encrypted Azure Blob checkpoints with ETag conditional writes |
| `src/enterprise-worker-server.ts` | Shared multi-user worker authorization, fairness, branch state, and LiteLLM routing |
| `src/enterprise-client.ts` | Entra enrollment, admission renewal, Keychain, and Claude settings patch |
| `src/enterprise-admin.ts` | Explicit same-user credential link and binding revocation |
| `infra/enterprise/` | Private, zone-redundant Container Apps foundation |

## Infrastructure

`infra/enterprise/main.bicep` creates a new enterprise resource group and does
not reference, modify, or adopt `rg-ccgc-dev-87b7`. The topology includes:

- Internal, zone-redundant Container Apps workload-profile environment.
- Broker Container App with 2-10 replicas.
- Shared worker Container App with 2-30 replicas.
- LiteLLM Gateway Container App with 2-10 replicas and private dashboard/API.
- Entra-only PostgreSQL for enterprise control state.
- Dedicated private password-authenticated PostgreSQL for LiteLLM's Prisma state.
- NAT Gateway for deterministic connector egress.
- Private Key Vault with RBAC, soft delete, and purge protection.
- Private GZRS StorageV2 account with shared-key access disabled and a private
  `checkpoints` Blob container.
- Private Premium ACR with admin and anonymous access disabled.
- Separate user-assigned broker, worker, and LiteLLM identities. The worker receives only
  Key Vault Secrets User, Storage Blob Data Contributor, and ACR pull roles.
- Log Analytics and workspace-based Application Insights. Application payload
  logging remains prohibited.

The Bicep accepts secure deployment parameters for the broker/worker HMAC
secret, checkpoint key, LiteLLM master/salt keys, and dedicated LiteLLM database
password. Employee GitHub tokens are never IaC parameters; LiteLLM obtains them
through each user's device flow after deployment.

## Build and validate

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
The one skipped naming check is a scanner limitation: the generated
`take(...uniqueString...)` expression is lowercase alphanumeric and never
exceeds Azure's 24-character storage-account limit.

The LiteLLM image is reproducible rather than floating: its base image is pinned
by digest and the gateway/proxy source overlay is pinned by commit plus archive
SHA-256. That source revision contains the per-user GitHub OAuth endpoints and
Prisma migration that are not present in the corresponding published
`main-latest` image. The build regenerates the Prisma client from the pinned
schema.

LiteLLM currently initializes the GitHub Copilot adapter before request-time
per-user credentials are attached. The image therefore includes a deliberately
invalid, non-secret Copilot token sentinel solely to let the router load the
model mapping. A connected user's encrypted OAuth session always replaces it;
an unconnected user fails with `401 Connect GitHub Copilot` before an upstream
request. The sentinel must never be replaced with a real shared token and can
be removed when a verified upstream release no longer requires it.

## Deployment gate

No enterprise Azure resources were deployed by this implementation task. Before
deployment:

1. Create the Entra API registration, permission, and Conditional Access policy.
2. Bootstrap a least-privilege PostgreSQL principal for the broker.
3. Build, scan, sign, and push immutable broker, worker, and LiteLLM image digests through
   a private runner.
4. Generate secure random dispatch and checkpoint-encryption values in an
   approved secret-handling workflow.
5. Run subscription `what-if`, verify create-only changes, review Container Apps
   and PostgreSQL cost, and obtain explicit deployment approval.

```bash
az deployment sub what-if \
  --location swedencentral \
  --template-file infra/enterprise/main.bicep \
  --parameters @/private/path/enterprise.parameters.json
```

## User onboarding

First bootstrap the database-backed LiteLLM credential and model mappings:

```bash
export CCGC_LITELLM_URL='https://PRIVATE_LITELLM_GATEWAY/'
export CCGC_LITELLM_MASTER_KEY='sk-PRIVATE-LITELLM-MASTER-KEY'

npm run enterprise:admin -- bootstrap --confirm-bootstrap \
  < /private/path/litellm-bootstrap.json
```

The bootstrap JSON contains `litellmCredentialName` and `models`. The command is
idempotent: it creates the Per-user GitHub OAuth credential when absent and adds
only missing `github_copilot/<model>` mappings. The runtime image keeps these
objects out of `config.yaml` so gateway startup never falls into LiteLLM's
single-account SDK device flow.

An administrator then creates the employee's LiteLLM `internal_user` identity
and user key through the approved LiteLLM identity workflow. Raw keys without
an owning LiteLLM user role cannot access the per-user connection endpoints.
The employee uses that identity to connect GitHub under **Models + Endpoints ->
LLM Credentials -> Your connections**.

The operator independently verifies that the Entra principal and GitHub account
belong to the same employee and that the organization permits the unofficial
Copilot connector.

```bash
export CCGC_POSTGRES_URL='postgresql://BROKER_ID@PRIVATE_HOST:5432/postgres?sslmode=require'
export CCGC_KEY_VAULT_URL='https://PRIVATE_VAULT.vault.azure.net/'
export CCGC_LITELLM_URL='https://PRIVATE_LITELLM_GATEWAY/'

npm run enterprise:admin -- link --confirm-same-user < /private/path/link.json
```

`link.json` contains tenant/object IDs, immutable GitHub account ID/login,
approved model IDs, `credentialSecretName`, `litellmCredentialName`,
`litellmApiKey`, and concise operator evidence. The admin command verifies that
the LiteLLM key's user connection is currently connected to the confirmed
GitHub login before storing only the LiteLLM key in Key Vault. The GitHub token
remains encrypted in LiteLLM PostgreSQL. Evidence is stored only as SHA-256.

The employee then runs:

```bash
npm run enterprise:client -- login \
  --gateway https://PRIVATE_GATEWAY \
  --audience api://ENTRA-APPLICATION-ID
npm run enterprise:client -- configure --apply
npm run enterprise:client -- models
claude
```

## Remaining release gates

- Vendor and organization approval for the unofficial Copilot route.
- Approved LiteLLM dashboard/SSO access, virtual-key rotation, disconnect, and
  license/edition review.
- Real private Azure deployment and managed-identity/PostgreSQL bootstrap.
- A real 10-15 minute Container Apps SSE proof, including first-token stalls,
  cancellation, scale-out, revision draining, and replica termination.
- Live two-account credential isolation, revoked-seat/model, noisy-neighbor,
  NAT/SNAT saturation, checkpoint conflict, and disaster-recovery tests.
- Signed release/rollback, monitoring privacy review, and cost approval.
- Azure Monitor Private Link Scope if fully private monitoring ingestion/query
  is required.

These gates prevent the foundation from being described as production-ready.
