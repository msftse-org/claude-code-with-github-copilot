# Enterprise single-tenant foundation

Each deployment serves exactly one customer and one Microsoft Entra tenant.
LiteLLM is the central inference gateway. The CCGC control plane manages
enrollment, revocation, bounded admissions, administration, and reconciliation,
but it does not proxy inference.

Two deployment modes share the same identity and enrollment contract:

- **Managed LiteLLM:** deploy the full solution, including CCGC-enabled LiteLLM
  and one PostgreSQL Flexible Server with separate `ccgc` and `litellm`
  schemas.
- **Existing LiteLLM:** install the CCGC authentication overlay on the
  customer's approved LiteLLM image and point the control plane and bootstrap
  job at that existing gateway.

The central-LiteLLM migration is implemented and locally validated. The
previous deployed pilot remains on the legacy broker/worker revision until an
approved zero-delete what-if and controlled runtime rollout are completed.

## Required runtime components

| Component | Responsibility |
|---|---|
| CCGC-enabled LiteLLM | Public Anthropic Messages gateway. Its custom-auth extension accepts normal customer LiteLLM keys unchanged and resolves CCGC Entra, API-key, or bounded admission credentials to the enrolled employee's LiteLLM virtual key. |
| CCGC control plane | Public administration and enrollment service. `CCGC.Access` or employee API keys create bounded admissions; `CCGC.Admin` manages employees, GitHub device authorization, bindings, model reconciliation, status, and revocation. |
| Bootstrap job | Initializes the enterprise schema, grants both control-plane and LiteLLM database principals, and idempotently creates the per-user OAuth credential, approved model groups, and user catalogs. |
| PostgreSQL | Managed mode uses one server: the `ccgc` schema stores immutable bindings, employee API keys, enrollment state, admission budgets, revisions, and audit intent; the `litellm` schema stores virtual keys, encrypted per-user GitHub connections, policies, and gateway state. Existing mode keeps the dedicated CCGC server and the customer's existing LiteLLM database. |
| Azure Key Vault | Stores employee LiteLLM virtual-key references and the administration secrets required by the selected deployment mode. |

API Management remains omitted. LiteLLM is already the policy and inference
gateway, while the control plane owns only lifecycle operations.

## Implemented request path

1. `ccgc-enterprise login` obtains a gateway-audience Entra token through
   `DefaultAzureCredential`, or `login-api-key` loads an administrator-issued
   30-day employee API key from a private file into macOS Keychain.
2. Claude's `apiKeyHelper` creates or renews a bounded admission and stores only
   its random 256-bit token in macOS Keychain. API keys are stored only as
   SHA-256 digests by the broker and never authorize administration routes.
3. Claude sends `/v1/messages` and `/v1/models` directly to central LiteLLM.
4. `ccgc_litellm_auth` hashes opaque CCGC credentials or validates an Entra JWT,
   reads only the fixed tenant's binding, enforces the admission attempt budget,
   and loads the bound Key Vault secret.
5. The extension verifies that the secret's GitHub login and immutable numeric
   account ID match the database binding, then returns the employee's existing
   LiteLLM virtual key.
6. Normal LiteLLM authorization applies model/team/budget policy and selects the
   same user's encrypted GitHub connection for Copilot inference.

Existing LiteLLM keys that do not match a CCGC credential format fall through
to normal LiteLLM authentication in `custom_auth_settings.mode: auto`.

## Employee isolation and scaling

- The configured Entra tenant is fixed for the deployment; cross-tenant
  bindings fail closed.
- Each binding contains one Entra object ID, immutable GitHub numeric account
  ID, GitHub login, revision, approved model catalog, and Key Vault reference.
- The Key Vault secret must contain the same GitHub identity and exactly one
  LiteLLM virtual key.
- LiteLLM isolates encrypted GitHub connections and Copilot sessions by user.
- Managed mode scales LiteLLM independently from the control plane.
- Existing mode preserves customer scaling, keys, teams, budgets, callbacks,
  databases, and unrelated models.

## Source layout

| Path | Purpose |
|---|---|
| `src/enterprise-auth.ts` | Entra issuer/audience/tenant/scope and immutable object-ID validation |
| `src/enterprise-store.ts` | PostgreSQL bindings, admissions, per-branch reservations/fences, per-user concurrency, and audit outbox |
| `server/ccgc_litellm_auth.py` | LiteLLM custom auth for Entra, employee API keys, bounded admissions, immutable GitHub binding verification, and virtual-key resolution |
| `src/enterprise-server.ts` | Role-separated control-plane administration, enrollment, profile, admission, and central-LiteLLM discovery routes |
| `src/enterprise-client.ts` | Separate control-plane and inference-gateway profile, admission renewal, Keychain, and Claude settings patch |
| `src/enterprise-admin.ts` | Explicit same-user credential link, binding revocation, and reusable LiteLLM bootstrap logic |
| `src/enterprise-management*.ts` | `CCGC.Admin` lifecycle actions for status, internal users, GitHub connection, binding, and revocation |
| `src/enterprise-bootstrap.ts` | One-shot database and LiteLLM initialization run by the private bootstrap job |
| `infra/enterprise/` | Dual-mode Azure deployment for managed or existing LiteLLM |
| `deploy/existing-litellm/` | Additive image and configuration overlay for a customer-owned LiteLLM |
| `scripts/enterprise-entra.mjs` | Idempotent Entra API, access/admin roles, assignment-required service principal, and separate employee/admin group assignments |
| `scripts/enterprise-pilot.mjs` | Mode-aware foundation, image publication, runtime what-if/deploy, and bootstrap |

## Infrastructure

`infra/enterprise/main.bicep` creates a new enterprise resource group and does
not reference, modify, or adopt `rg-ccgc-dev-87b7`. The topology includes:

- Internet-reachable, zone-redundant Container Apps workload-profile
  environment.
- Public HTTPS control-plane Container App with 2-10 replicas and application-level
  Entra tenant/audience/permission validation for separate `CCGC.Access` and
  `CCGC.Admin` route groups.
- Private one-shot Container Apps bootstrap job with a dedicated managed
  identity that is PostgreSQL Entra administrator only for initialization.
- Public CCGC-enabled LiteLLM Container App with 2-10 replicas in managed mode,
  or a fixed existing customer LiteLLM HTTPS origin in existing mode.
- One private PostgreSQL Flexible Server in managed mode, with Entra
  authentication for the `ccgc` schema and password authentication for
  LiteLLM's Prisma-managed `litellm` schema.
- A separate Entra-only CCGC PostgreSQL server in existing-LiteLLM mode; the
  customer's existing LiteLLM database remains unchanged.
- Private Key Vault with RBAC, soft delete, and purge protection.
- Private Premium ACR with admin and anonymous access disabled, plus a
  scale-to-zero VNet-attached ACR task agent pool for image publication.
- Separate user-assigned control-plane, bootstrap, and managed LiteLLM
  identities. An existing LiteLLM workload identity receives only Key Vault
  secret-read and CCGC PostgreSQL permissions. The control plane receives Key
  Vault Secrets Officer because its
  `CCGC.Admin` routes create and rotate account-scoped LiteLLM user-key secrets.
- Log Analytics and workspace-based Application Insights. Application payload
  logging remains prohibited.

The Bicep accepts `litellmMode: managed|existing`. Managed mode creates only one
PostgreSQL Flexible Server and routes each workload through an explicit schema
in its connection string. Existing mode additionally
requires the customer LiteLLM URL, workload identity object ID, database
principal name, and a scoped administration key. Employee GitHub tokens are
never IaC parameters; LiteLLM obtains them through each user's device flow.

Managed LiteLLM currently uses the shared server administrator credential from
Key Vault because its Prisma startup owns `litellm` schema creation and
migrations. The schemas separate object namespaces and CCGC runtime grants, but
they are not a security boundary against that database administrator. CCGC
runtime identities remain restricted to the `ccgc` schema.

## Build and validate

```bash
npm ci
npm run check
npm test
npm run test:bootstrap
npm run test:client

docker build -f server/Dockerfile.enterprise -t ccgc-enterprise-broker:test .
docker build -f server/Dockerfile.enterprise-litellm -t ccgc-enterprise-litellm:test .

docker build \
  --build-arg LITELLM_IMAGE=customer-registry/litellm@sha256:APPROVED_DIGEST \
  -f deploy/existing-litellm/Dockerfile \
  -t customer-registry/litellm-ccgc:test .

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

## Automated pilot deployment

Create or update the Entra API first. The script defines both the delegated
permission and app role `CCGC.Access`, adds the separate `CCGC.Admin` app role,
preauthorizes Azure CLI, marks the Enterprise Application assignment-required,
and assigns the employee and administrator groups independently. Run it as a tenant
administrator permitted to create app registrations/service principals, read the
group, and create app-role assignments:

```bash
npm run enterprise:entra -- \
  --display-name 'CCGC Enterprise API' \
  --pilot-group-object-id 00000000-0000-0000-0000-000000000000 \
  --admin-group-object-id 11111111-1111-1111-1111-111111111111 \
  --confirm-entra-changes
```

Copy `infra/enterprise/main.parameters.example.json` to a private path and
replace every identity and secret placeholder, then run `chmod 600` on it. Do
not commit that file. The deployment is deliberately two-stage:

```bash
# What-if only; review before applying.
npm run enterprise:pilot -- foundation \
  --parameters /private/path/enterprise.parameters.json

# Explicitly create the foundation: VNet, private services, ACR, build pool,
# identities, databases, secrets, and the public Container Apps environment.
npm run enterprise:pilot -- foundation \
  --parameters /private/path/enterprise.parameters.json \
  --confirm-deploy

# Scale the private ACR task pool to one, build all three images, resolve their
# immutable digests, write a mode-0600 image manifest, and scale the pool to zero.
npm run enterprise:pilot -- images \
  --parameters /private/path/enterprise.parameters.json

# Review the runtime deployment with the generated manifest.
npm run enterprise:pilot -- runtime \
  --parameters /private/path/enterprise.parameters.json \
  --images .azure/enterprise-images.GIT_SHA.json

# Apply only after reviewing runtime what-if and cost.
npm run enterprise:pilot -- runtime \
  --parameters /private/path/enterprise.parameters.json \
  --images .azure/enterprise-images.GIT_SHA.json \
  --confirm-deploy
```

The public outputs are `brokerPublicFqdn` for control-plane operations and
`litellmGatewayUrl` for Claude Code inference. `bootstrapJobName` is not a
public endpoint.

## Deployment gate

No enterprise Azure resources were deployed by this implementation task. Before
deployment:

1. Run the Entra automation, verify assignment-required is enabled, and apply
   the approved Conditional Access policy to the pilot group.
2. Verify that the confirmed runtime deployment completed the private bootstrap
   job and granted the broker only its required table and sequence privileges.
3. Scan/sign the immutable images produced by the private ACR build pool.
4. Generate secure random dispatch and checkpoint-encryption values in an
   approved secret-handling workflow.
5. Run subscription `what-if`, verify create-only changes, review Container Apps
   and PostgreSQL cost, and obtain explicit deployment approval.

```bash
npm run enterprise:pilot -- foundation \
  --parameters /private/path/enterprise.parameters.json
```

## User onboarding

The confirmed runtime deployment starts the Bicep-defined bootstrap job after
creating the Container Apps revision. The job initializes the Entra-only
enterprise database and idempotently creates the database-backed LiteLLM
credential and approved model mappings. The same job reconciles every active
binding, unconsumed pending enrollment, and existing LiteLLM internal user to
the complete deployment-approved catalog. Binding changes increment the
revision, revoke active admissions, and emit audit events. Deployment fails if
the job does not reach `Succeeded` within 15 minutes.

API-key employees use a single-use, 30-minute self-service enrollment. The
administrator provides only the employee email and GitHub username, then
creates an enrollment code. The broker supplies the deployment tenant and
approved model catalog and resolves the canonical GitHub login and immutable
numeric account ID from GitHub:

```bash
cp docs/examples/enterprise-create-enrollment.example.json \
  /private/path/create-enrollment.json
chmod 600 /private/path/create-enrollment.json

npm run enterprise:manage -- create-enrollment \
  --url https://PUBLIC_BROKER_FQDN \
  --audience api://ENTRA-APPLICATION-ID \
  --input /private/path/create-enrollment.json \
  --output /private/path/enrollment.json
```

Only the control-plane URL and `CCGC-...` code are sent to the employee. The employee
runs the native executable:

```bash
./ccgc-enterprise enroll \
  --gateway https://PUBLIC_BROKER_FQDN \
  --code CCGC-ONE-TIME-CODE
```

The executable opens GitHub device authorization and the broker rejects any
GitHub login other than the server-resolved identity. The broker creates and
binds the LiteLLM internal user with every deployment-approved Claude model,
then issues a 30-day API key directly to the employee process. The key is
stored only in macOS Keychain or Windows DPAPI storage. The executable writes
the non-secret profile, configures Claude Code, and acknowledges the
enrollment; acknowledgment deletes the temporary Key Vault values and consumes
the code. Completed output is held temporarily in Key Vault until
acknowledgment so a lost HTTP response can be retried without losing the only
copy of the key.

The executable remains installed as Claude's `apiKeyHelper` and supports
`token`, `models`, and `configure`. Build targets are macOS ARM64 and Windows
x64:

```bash
GOOS=darwin GOARCH=arm64 go build -trimpath -o dist/ccgc-enterprise-darwin-arm64 ./cmd/ccgc-enterprise
GOOS=windows GOARCH=amd64 go build -trimpath -o dist/ccgc-enterprise-windows-amd64.exe ./cmd/ccgc-enterprise
```

### Enrollment preservation during updates

Routine deployments and reconciliation preserve active employee bindings,
employee credentials, GitHub connections, and workstation profiles. Updating
the control plane, LiteLLM image, approved model catalog, or Claude Code client
does not by itself require an employee to run `enroll` again.

For an existing employee:

- use `doctor` or the platform health checks after a client or service update;
- use `models` after catalog reconciliation;
- use `configure` when the helper path or Claude settings need to be reapplied;
- create a new enrollment only for a new workstation/user profile, an expired
  or revoked employee credential, an intentional identity rebind, unrecoverable
  local credential loss, or an explicitly announced migration.

Enterprise IT must not create or send a new one-time code merely because a
runtime revision was deployed. If a migration truly requires re-enrollment,
the rollout plan must state why existing credentials cannot be preserved,
revoke them deliberately, and provide a new code through the approved channel.

The manual administrator-driven device flow remains available for Entra
employees and recovery:

```bash
npm run enterprise:manage -- create-user \
  --url https://PUBLIC_BROKER_FQDN \
  --audience api://ENTRA-APPLICATION-ID \
  --input /private/path/create-user.json \
  --output /private/path/created-user.json
npm run enterprise:manage -- connect \
  --url https://PUBLIC_BROKER_FQDN \
  --audience api://ENTRA-APPLICATION-ID \
  --input /private/path/connect-user.json
```

`connect-user.json` contains `litellmApiKey`, `litellmCredentialName`, and the
expected `githubLogin`. The command is idempotent, prints only the public GitHub
verification URL/code, polls within the server-supplied expiry, verifies the
active Copilot seat, and rejects a different GitHub account.

The administrator independently verifies that the Entra principal and GitHub account
belong to the same employee and that the organization permits the unofficial
Copilot connector.

```bash
npm run enterprise:manage -- link \
  --url https://PUBLIC_BROKER_FQDN \
  --audience api://ENTRA-APPLICATION-ID \
  --input /private/path/link.json
```

`link.json` contains tenant/object IDs, immutable GitHub account ID/login,
approved model IDs, `credentialSecretName`, `litellmCredentialName`,
`litellmApiKey`, and concise administrator evidence. The admin command verifies that
the LiteLLM key's user connection is currently connected to the confirmed
GitHub login before storing only the LiteLLM key in Key Vault. The GitHub token remains encrypted in LiteLLM's PostgreSQL schema. Evidence is
stored only as SHA-256.

The employee then runs:

```bash
npm run enterprise:client -- login \
  --gateway https://PUBLIC_BROKER_FQDN \
  --audience api://ENTRA-APPLICATION-ID
npm run enterprise:client -- configure --apply
npm run enterprise:client -- models
claude
```

## Two-person enterprise simulation

Use two separate Entra security groups even when the same person acts as both
enterprise IT and an employee:

- `CCGC-Pilot-Employees`: add both testers. This group receives
  `CCGC.Access`.
- `CCGC-Pilot-Admins`: add only the person acting as enterprise IT. This group
  receives `CCGC.Admin`.

The groups must remain distinct, but an IT tester may be a member of both. Each
tester must use their own Entra identity, GitHub identity, GitHub Copilot seat,
macOS user profile, Keychain, and Claude Code installation. Never exchange
admission tokens, LiteLLM user keys, GitHub device codes after use, Claude
settings, or local conversation directories.

### 1. Create groups and add the two testers

Run as the tenant administrator:

```bash
SELF_ID="$(az ad user show --id it-admin@example.com --query id -o tsv)"
COLLEAGUE_ID="$(az ad user show --id colleague@example.com --query id -o tsv)"

EMPLOYEE_GROUP_ID="$(az ad group create \
  --display-name CCGC-Pilot-Employees \
  --mail-nickname ccgc-pilot-employees \
  --query id -o tsv)"
ADMIN_GROUP_ID="$(az ad group create \
  --display-name CCGC-Pilot-Admins \
  --mail-nickname ccgc-pilot-admins \
  --query id -o tsv)"

az ad group member add --group "$EMPLOYEE_GROUP_ID" --member-id "$SELF_ID"
az ad group member add --group "$EMPLOYEE_GROUP_ID" --member-id "$COLLEAGUE_ID"
az ad group member add --group "$ADMIN_GROUP_ID" --member-id "$SELF_ID"
```

If the groups already exist, retrieve their object IDs instead of recreating
them. Run the Entra automation with those two IDs and save its `tenantId`,
`audience`, and application client ID:

```bash
npm run enterprise:entra -- \
  --display-name 'CCGC Enterprise API' \
  --pilot-group-object-id "$EMPLOYEE_GROUP_ID" \
  --admin-group-object-id "$ADMIN_GROUP_ID" \
  --confirm-entra-changes
```

Allow Entra assignment propagation, then force both testers to sign out and
sign back in before requesting broker tokens. Do not reuse an Azure CLI token
issued before the group-role assignments.

### 2. Deploy once as enterprise IT

Create the mode-0600 parameter file from
`infra/enterprise/main.parameters.example.json`, use the Entra automation's
tenant and audience values, and replace every secret placeholder with an
independently generated random value. Run foundation and runtime `what-if`
before either confirmed deployment. The confirmed runtime deployment starts
and waits for the private bootstrap job.

After deployment:

```bash
PREFIX=ccgc-pilot
RESOURCE_GROUP="rg-${PREFIX}-enterprise"
BROKER_FQDN="$(az deployment sub show \
  --name "${PREFIX}-enterprise-runtime" \
  --query properties.outputs.brokerPublicFqdn.value -o tsv)"
BROKER_URL="https://${BROKER_FQDN}"
```

Require successful administrator status before onboarding either employee:

```bash
npm run enterprise:manage -- status \
  --url "$BROKER_URL" \
  --audience "$ENTRA_AUDIENCE"
```

### 3. Onboard each employee independently

Repeat the following process once for the IT tester and once for the
colleague. Start from the templates under `docs/examples/`, copy them outside
the repository, and protect every working file:

```bash
umask 077
mkdir -p "$HOME/.config/ccgc/pilot/employee-one"
cp docs/examples/enterprise-create-user.example.json \
  "$HOME/.config/ccgc/pilot/employee-one/create-user.json"
chmod 600 "$HOME/.config/ccgc/pilot/employee-one/create-user.json"
```

For an Entra employee, set `userId` to their Entra object ID. For an API-key
employee, generate a dedicated UUID and use it consistently as `userId` and the
binding `objectId`:

```bash
API_USER_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
```

Use the employee email, choose the approved Claude model list, then create the
LiteLLM internal user:

```bash
npm run enterprise:manage -- create-user \
  --url "$BROKER_URL" \
  --audience "$ENTRA_AUDIENCE" \
  --input "$HOME/.config/ccgc/pilot/employee-one/create-user.json" \
  --output "$HOME/.config/ccgc/pilot/employee-one/created-user.json"
```

Copy the returned `litellmApiKey` into a private copy of
`enterprise-connect-user.example.json`, set the employee's expected GitHub
login, and run the connection command. Enterprise IT may start and poll the
flow, but the named employee must personally open GitHub's verification URL,
enter the one-time code, and authorize their own account:

```bash
npm run enterprise:manage -- connect \
  --url "$BROKER_URL" \
  --audience "$ENTRA_AUDIENCE" \
  --input "$HOME/.config/ccgc/pilot/employee-one/connect-user.json"
```

Retrieve the immutable numeric GitHub account ID from the public GitHub API,
then complete a private copy of `enterprise-link-user.example.json`:

```bash
GITHUB_ACCOUNT_ID="$(curl -fsSL \
  "https://api.github.com/users/employee-github-login" | jq -r '.id')"
test "$GITHUB_ACCOUNT_ID" -gt 0
```

Use the deployment tenant ID and the employee's Entra object ID or dedicated
API-user UUID, verified GitHub login/account ID, same LiteLLM user key,
approved models, and a unique secret name such as
`ccgc-user-<object-id-without-hyphens>`. Link only after the administrator has
verified that the enterprise and GitHub identities belong to the same employee:

```bash
npm run enterprise:manage -- link \
  --url "$BROKER_URL" \
  --audience "$ENTRA_AUDIENCE" \
  --input "$HOME/.config/ccgc/pilot/employee-one/link-user.json"
```

Do not reuse any of these three files for the second employee.

### 4. Each employee configures their own workstation

An Entra-authenticated tester signs into Azure CLI as themselves, from their
own macOS account and machine:

```bash
az logout
az login --tenant "$ENTRA_TENANT_ID"
npm ci
npm run enterprise:client -- login \
  --gateway "$BROKER_URL" \
  --audience "$ENTRA_AUDIENCE"
npm run enterprise:client -- configure --apply
npm run enterprise:client -- models
claude
```

For an API-key employee, Enterprise IT creates a single-use enrollment instead
of receiving and transferring the employee key:

```bash
cp docs/examples/enterprise-create-enrollment.example.json \
  "$HOME/.config/ccgc/pilot/employee-one/create-enrollment.json"
chmod 600 "$HOME/.config/ccgc/pilot/employee-one/create-enrollment.json"

npm run enterprise:manage -- create-enrollment \
  --url "$BROKER_URL" \
  --audience "$ENTRA_AUDIENCE" \
  --input "$HOME/.config/ccgc/pilot/employee-one/create-enrollment.json" \
  --output "$HOME/.config/ccgc/pilot/employee-one/enrollment.json"
```

Transfer only the control-plane URL and one-time code through an approved channel. The
employee runs:

```bash
./ccgc-enterprise enroll \
  --gateway "$BROKER_URL" \
  --code CCGC-ONE-TIME-CODE
./ccgc-enterprise models
claude
```

An already enrolled employee must not repeat this flow for routine service,
catalog, or client updates. They should run `models`, `configure`, or the
platform doctor/health command as appropriate. Re-enrollment requires a new
one-time code and one of the lifecycle conditions in
[Enrollment preservation during updates](#enrollment-preservation-during-updates).

The login result must show that employee's own object ID, authentication
method, GitHub login, GitHub account ID, model list, and binding revision. Stop
if either tester sees the other tester's identity or models.

### 5. Run the isolation acceptance

Run both Claude Code clients concurrently for at least 15 minutes:

1. Start separate conversations with distinct non-secret marker strings.
2. Exercise streaming, tools, one agent branch, compaction, and a client
   restart on both accounts.
3. Confirm neither user sees the other's marker, history, GitHub login, models,
   tool results, or restart state.
4. Confirm both remain usable during concurrent long responses and that a
   cancelled request is not replayed.
5. As IT, revoke only the colleague's binding using a private copy of
   `docs/examples/enterprise-revoke-user.example.json`.
6. Confirm the colleague's current/new admissions fail while the IT tester
   continues successfully.
7. Re-link the colleague through the full verified device flow; do not restore
   or copy the previous user's key material.

Review Container Apps and Azure Monitor metadata after the test. Logs may
contain service, status, capacity, and opaque identifiers, but must not contain
authorization headers, prompts, responses, tool bodies, LiteLLM keys, GitHub
tokens, or device codes.

```bash
npm run enterprise:manage -- revoke \
  --url "$BROKER_URL" \
  --audience "$ENTRA_AUDIENCE" \
  --input "$HOME/.config/ccgc/pilot/colleague/revoke-user.json"
```

## Remaining release gates

- Vendor and organization approval for the unofficial Copilot route.
- Live validation of the broker's `CCGC.Admin` lifecycle workflow, virtual-key rotation,
  disconnect, and license/edition review.
- Real Azure deployment and Bicep-managed PostgreSQL/LiteLLM bootstrap.
- A real 10-15 minute Container Apps SSE proof, including first-token stalls,
  cancellation, scale-out, revision draining, and replica termination.
- Live two-account credential isolation, revoked-seat/model, noisy-neighbor,
  NAT/SNAT saturation, checkpoint conflict, and disaster-recovery tests.
- Signed release/rollback, monitoring privacy review, and cost approval.
- Azure Monitor Private Link Scope if fully private monitoring ingestion/query
  is required.

These gates prevent the foundation from being described as production-ready.
