# Enterprise foundation

The repository contains an **implemented, locally validated multi-user
enterprise foundation** based on Azure Container Apps. It is not deployed and
is not yet approved for production use. The historical single-user VM and its
LiteLLM connector remain independent and unchanged as rollback evidence.

## Required runtime components

| Component | Responsibility |
|---|---|
| Enterprise broker | Validates Microsoft Entra identity, resolves the immutable GitHub binding, issues bounded admissions, reserves attempts transactionally, fences each branch dispatch, signs a 60-second worker assertion, and emits audit intent. |
| Shared multi-user worker fleet | Runs as one Container App scaled across 2-30 replicas. Each replica verifies broker assertions, enforces per-user and global capacity, hosts the in-process connector pool, restores durable branch state, and streams native Messages responses. |
| Account-scoped native Copilot connector | An in-process object inside a worker replica, not a separate Container App. It validates the effective GitHub login, maintains one OAuth credential, Copilot token cache, endpoint, and refresh lock per binding revision, then sends the exact Anthropic Messages request. |
| PostgreSQL | Stores account bindings, admission budgets, active branch reservations, monotonic fences, outcomes, and the audit outbox. |
| Encrypted Blob checkpoints | Stores pending tool lineage and other branch state encrypted by the worker. Blob ETags reject concurrent or stale writes. |

The broker is the only employee-facing ingress. The worker service is private
inside the Container Apps environment. API Management is omitted because it
would duplicate broker controls and add another streaming hop.

LiteLLM is intentionally absent from the enterprise request path. Its reviewed
GitHub Copilot integration uses one process-wide credential directory, which is
safe for the retained single-user proof but not for many accounts in one worker
process. The enterprise worker instead reuses the repository's native Copilot
transport through account-keyed connector objects.

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
   credential, validates the effective GitHub login, and selects or creates that
   account's native connector context.
7. The worker loads the branch checkpoint from private Blob Storage, decrypts
   and validates its full identity envelope, and performs the Messages request.
   Checkpoint updates use ETag compare-and-swap; neither broker nor worker
   transparently retries inference.

The broker stores no prompt or response body. The checkpoint can contain
pending assistant tool blocks and arguments, so it is encrypted before leaving
the worker and must never be logged.

## Multi-user isolation and scaling

- Worker replicas are interchangeable; sticky sessions are not required.
- Connector cache keys include tenant, principal, binding revision, GitHub
  account ID, and credential secret name.
- Each connector owns independent OAuth and Copilot token state and an
  independent refresh promise.
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
| `src/enterprise-connector.ts` | Key Vault credential resolution and account-scoped connector pool |
| `src/enterprise-checkpoint.ts` | Client-side encrypted Azure Blob checkpoints with ETag conditional writes |
| `src/enterprise-worker-server.ts` | Shared multi-user worker authorization, fairness, branch state, and native connector routing |
| `src/enterprise-client.ts` | Entra enrollment, admission renewal, Keychain, and Claude settings patch |
| `src/enterprise-admin.ts` | Explicit same-user credential link and binding revocation |
| `infra/enterprise/` | Private, zone-redundant Container Apps foundation |

## Infrastructure

`infra/enterprise/main.bicep` creates a new enterprise resource group and does
not reference, modify, or adopt `rg-ccgc-dev-87b7`. The topology includes:

- Internal, zone-redundant Container Apps workload-profile environment.
- Broker Container App with 2-10 replicas.
- Shared worker Container App with 2-30 replicas.
- Separate Container Apps, PostgreSQL, and private-endpoint subnets.
- NAT Gateway for deterministic connector egress.
- Entra-only, zone-redundant PostgreSQL Flexible Server.
- Private Key Vault with RBAC, soft delete, and purge protection.
- Private GZRS StorageV2 account with shared-key access disabled and a private
  `checkpoints` Blob container.
- Private Premium ACR with admin and anonymous access disabled.
- Separate user-assigned broker and worker identities. The worker receives only
  Key Vault Secrets User, Storage Blob Data Contributor, and ACR pull roles.
- Log Analytics and workspace-based Application Insights. Application payload
  logging remains prohibited.

The Bicep accepts secure deployment parameters for the broker/worker HMAC secret
and the base64 32-byte checkpoint encryption key. Employee GitHub credentials
are never IaC parameters and are linked after deployment.

## Build and validate

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
The one skipped naming check is a scanner limitation: the generated
`take(...uniqueString...)` expression is lowercase alphanumeric and never
exceeds Azure's 24-character storage-account limit.

## Deployment gate

No enterprise Azure resources were deployed by this implementation task. Before
deployment:

1. Create the Entra API registration, permission, and Conditional Access policy.
2. Bootstrap a least-privilege PostgreSQL principal for the broker.
3. Build, scan, sign, and push immutable broker and worker image digests through
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

The operator independently verifies that the Entra principal and GitHub account
belong to the same employee and that the organization permits the unofficial
Copilot connector.

```bash
export CCGC_POSTGRES_URL='postgresql://BROKER_ID@PRIVATE_HOST:5432/postgres?sslmode=require'
export CCGC_KEY_VAULT_URL='https://PRIVATE_VAULT.vault.azure.net/'

npm run enterprise:admin -- link --confirm-same-user < /private/path/link.json
```

`link.json` contains tenant/object IDs, immutable GitHub account ID/login,
approved model IDs, `credentialSecretName`, a `credential` object with the same
login and GitHub OAuth credential, and concise operator evidence. The credential
is written only to Key Vault. The evidence is stored only as SHA-256. Changing a
binding increments its revision and revokes every existing admission.

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
- Supported browser linking, anti-replay proof, token rotation, and unlinking
  instead of operator-supplied credential JSON.
- Real private Azure deployment and managed-identity/PostgreSQL bootstrap.
- A real 10-15 minute Container Apps SSE proof, including first-token stalls,
  cancellation, scale-out, revision draining, and replica termination.
- Live two-account credential isolation, revoked-seat/model, noisy-neighbor,
  NAT/SNAT saturation, checkpoint conflict, and disaster-recovery tests.
- Signed release/rollback, monitoring privacy review, and cost approval.
- Azure Monitor Private Link Scope if fully private monitoring ingestion/query
  is required.

These gates prevent the foundation from being described as production-ready.
