# Enterprise foundation

The repository now contains an **implemented, locally validated enterprise
foundation**. It is not deployed and is not yet approved for production use.
The historical single-user VM remains independent and unchanged.

## Why APIM and LiteLLM are not equivalent

| Component | Responsibility | Required? |
|---|---|---|
| Enterprise broker | Validates Microsoft Entra identity, resolves the same user's GitHub binding, issues bounded Claude admission tokens, reserves attempts transactionally, fences dispatches and emits audit intent. | Yes |
| Isolated worker wrapper | Enforces the broker token, immutable principal binding, admission ownership, strictly increasing dispatch fences, model catalog and one in-memory conversation state per admission. | Yes |
| LiteLLM | Performs the current Copilot-specific authentication/token refresh and native Anthropic Messages transport inside one user's isolated worker. | Yes for the current proven connector; replaceable only after another connector passes the same live gates |
| API Management | Adds centralized private API publication, organization-level policy, diagnostics and API lifecycle governance. It does not authenticate to Copilot or replace the connector. | No; disabled by default |

APIM and LiteLLM therefore have no protocol parity. Removing LiteLLM without
another Copilot connector leaves no provider transport. Removing APIM still
leaves a functional private gateway because the broker validates Entra tokens
itself. Set `enableApim` only when the organization needs the additional API
governance layer and has validated its SSE behavior and cost.

## Implemented request path

1. `ccgc-enterprise login` obtains a gateway-audience Entra token through
   `DefaultAzureCredential` and verifies the immutable tenant/object binding.
2. The Claude `apiKeyHelper` creates or renews a bounded admission and stores
   only its random 256-bit token in macOS Keychain.
3. Claude sends ordinary native `/v1/messages` and `/v1/models` requests.
4. The broker hashes the admission token and request body. PostgreSQL locks the
   admission, verifies binding revision/model/limits, increments the attempt,
   assigns a monotonic fence and persists audit intent in the same transaction.
5. Key Vault resolves the worker endpoint and broker credential bound to the
   same GitHub account ID.
6. The per-user worker rejects a mismatched principal, stale/duplicate fence,
   wrong host, model drift or excess active admissions before forwarding to its
   private LiteLLM instance. Neither broker nor worker retries inference.

The broker never logs or stores prompt/response bodies. PostgreSQL stores request
digests, model IDs, dispatch outcomes and identity/binding metadata only.

## Source layout

| Path | Purpose |
|---|---|
| `src/enterprise-auth.ts` | Entra issuer/audience/tenant/scope and immutable object-ID validation |
| `src/enterprise-store.ts` | PostgreSQL schema, binding revisions, admissions, dispatch reservations/fences and audit outbox |
| `src/enterprise-server.ts` | Broker control and native Messages/model routes |
| `src/enterprise-worker-server.ts` | Isolated worker authorization, conversation guard and LiteLLM forwarding |
| `src/enterprise-client.ts` | Entra enrollment, admission renewal, Keychain and Claude settings patch |
| `src/enterprise-admin.ts` | Explicit operator same-user link/revoke operations |
| `infra/enterprise/` | Private, zone-redundant Bicep foundation and optional internal APIM |
| `server/Dockerfile.enterprise*` | Non-root locked broker and worker images |

## Infrastructure

`infra/enterprise/main.bicep` creates a new resource group and does not reference,
modify or adopt `rg-ccgc-dev-87b7`. The default topology includes:

- Internal zone-redundant Container Apps workload-profile environment.
- Separate Container Apps, PostgreSQL, private-endpoint and optional APIM subnets.
- NAT Gateway for stable connector egress.
- Entra-only, zone-redundant PostgreSQL Flexible Server.
- Private Key Vault with RBAC, soft delete and purge protection.
- Private Premium ACR with admin/anonymous access disabled, quarantine and
  retention policies, and zone redundancy.
- User-assigned broker identity with scoped Key Vault Secrets User and AcrPull.
- Log Analytics and workspace-based Application Insights. Application payload
  logging remains prohibited.
- Optional internal Premium v2 APIM with private DNS and unbuffered forwarding.

The generated infrastructure contains no GitHub, Copilot, worker or database
credential. `brokerImage` must be an approved immutable digest. Worker instances
and their long-lived Copilot authorization are deliberately separate onboarding
operations so one template/state cannot pool user seats.

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
checkov -f enterprise.json --framework arm --skip-download --compact
```

The PostgreSQL integration test runs when `CCGC_TEST_POSTGRES_URL` is set. CI
provides PostgreSQL 16 and executes it with the normal test suite.

## Deployment gate

No enterprise Azure resources were deployed by this implementation task.
Before deployment:

1. Create the Entra API registration and delegated/application permission
   `CCGC.Access`; approve Conditional Access and client sign-in policy.
2. Create a separate PostgreSQL administrator identity. After deployment, use a
   private runner to create the broker identity as a least-privilege database
   principal and grant only schema/table/sequence access required by the broker.
3. Build, scan, sign and push immutable broker and worker image digests through
   a private runner that can reach ACR.
4. Run subscription `what-if` with a private parameter file, review APIM and
   PostgreSQL costs, and confirm that changes are create-only.
5. Deploy only after explicit risk/cost approval.

Example preview:

```bash
az deployment sub what-if \
  --location swedencentral \
  --template-file infra/enterprise/main.bicep \
  --parameters @/private/path/enterprise.parameters.json
```

## User onboarding

The operator must independently verify that the Entra principal and GitHub
account belong to the same employee and that the organization permits the
unofficial Copilot connector. Private input is sent on stdin:

```bash
export CCGC_POSTGRES_URL='postgresql://BROKER_ID@PRIVATE_HOST:5432/postgres?sslmode=require'
export CCGC_KEY_VAULT_URL='https://PRIVATE_VAULT.vault.azure.net/'

npm run enterprise:admin -- link --confirm-same-user < /private/path/link.json
```

`link.json` contains the tenant/object IDs, immutable GitHub account ID/login,
approved model IDs, worker secret name, private worker URL/token and a concise
operator evidence statement. The evidence statement is stored only as SHA-256.
Changing a binding increments its revision and revokes every existing admission.

The developer then runs:

```bash
npm run enterprise:client -- login \
  --gateway https://PRIVATE_GATEWAY \
  --audience api://ENTRA-APPLICATION-ID
npm run enterprise:client -- configure --apply
npm run enterprise:client -- models
claude
```

`DefaultAzureCredential` must resolve to the intended employee. In production,
the organization must standardize the accepted credential source and protected
token cache rather than relying on arbitrary developer credentials.

## Remaining release gates

- Vendor/organization approval for the unofficial Copilot route.
- Automated GitHub browser linking and anti-replay proof instead of operator
  evidence alone.
- Automated creation/deletion of one private LiteLLM runtime and credential
  cache per user; the repository currently implements the wrapper and contract,
  not that lifecycle controller.
- Durable conversation lineage across worker restarts. Broker dispatch fencing
  is durable, but a restarted worker intentionally requires admission retirement
  before continuing a prior conversation.
- Real private deployment, Entra/Key Vault/PostgreSQL validation, two-user
  isolation tests, revoked-seat/model tests, SSE load/soak/failure tests,
  restore drills, signed release/rollback and cost approval.
- Azure Monitor Private Link Scope if the organization requires fully private
  monitoring ingestion and query.

These gates prevent this foundation from being described as production-ready.
