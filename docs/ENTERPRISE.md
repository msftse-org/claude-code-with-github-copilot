# Enterprise LiteLLM direct-key architecture

The target architecture uses LiteLLM as the only user-facing control plane.
Each person receives a distinct LiteLLM virtual key and connects their own
GitHub account through LiteLLM's per-user GitHub Copilot OAuth capability.
Claude Code, Claude Desktop, Anthropic-compatible clients, and
OpenAI-compatible clients send that virtual key directly to LiteLLM.

[Open the interactive authentication comparison](diagrams/ccgc-auth-options-comparison.html).

## Target request path

1. An administrator runs the **CCGC employee access** GitHub Actions workflow
   with the employee's GitHub username. The broker resolves the immutable
   GitHub account ID, creates or reuses a non-invited LiteLLM `internal_user`
   for that account, and returns a one-time `CCGC-…` code that expires after
   one hour. The administrator sends the code to the employee privately.
2. The employee runs guided setup and pastes the code. The broker starts
   LiteLLM's native per-user GitHub Copilot device flow for that LiteLLM user;
   the employee approves it with their own Copilot-entitled GitHub account.
   If a different GitHub account approves, the broker disconnects it and
   rejects the enrollment.
3. The broker issues a personal 90-day LiteLLM virtual key restricted to the
   approved Claude models and inference/model-info routes. The employee needs
   no Entra sign-in, LiteLLM password, dashboard login, or invitation, and the
   broker's LiteLLM administrator credential never leaves the server.
4. The managed client stores the virtual key only in the operating-system
   credential store. The non-secret profile contains the LiteLLM URL and
   discovered Claude model IDs.
5. Claude's `apiKeyHelper` returns the virtual key. `ANTHROPIC_BASE_URL` points
   directly to LiteLLM.
6. LiteLLM authenticates the key, applies model/team/budget/rate/spend policy,
   resolves the same LiteLLM user's encrypted GitHub connection, and invokes
   GitHub Copilot.

The user who owns the request key must be the same LiteLLM user who connected
GitHub. This is the identity boundary that prevents one user's key from using
another user's Copilot plan.

## Why API Management is not required

LiteLLM already provides the controls needed on the inference path: virtual-key
authentication, users, teams, model access, budgets, rate limits, spend
tracking, key rotation and revocation, provider routing, and the per-user
GitHub connection. Adding API Management would duplicate request-path gateway
functions without replacing LiteLLM's user-to-GitHub credential resolution.

API Management remains appropriate only if the organization has an independent
requirement for controls that must run outside LiteLLM, such as a mandatory
enterprise API perimeter shared by many unrelated APIs. It is not required by
this solution.

## Option comparison

| Area | LiteLLM direct key — target | CCGC admission — migration only |
|---|---|---|
| Request authentication | Native LiteLLM virtual key | Entra or CCGC API key exchanged for a bounded admission |
| User control panel | LiteLLM UI | Separate CCGC administration plus LiteLLM |
| GitHub identity | Same LiteLLM user owns the key and OAuth connection | CCGC binding resolves the admission to that user's LiteLLM key |
| Models, teams, budgets, rates, spend | Native LiteLLM | Native LiteLLM after custom-auth resolution |
| Key rotation and revocation | Native LiteLLM | CCGC credential/admission lifecycle plus LiteLLM key lifecycle |
| Enterprise LiteLLM license | Not required for API-key authentication | Not required for compatibility authentication |
| Extra runtime state | LiteLLM PostgreSQL only | Broker, `ccgc` schema, Key Vault records, admission state, custom auth |
| Primary benefit | Simplest path and one control plane | Preserves current clients during migration and rollback |
| Primary cost | Secure distribution and storage of user keys | More services, lifecycle code, failure modes, and operations |

Both paths use LiteLLM's per-user GitHub OAuth provider and therefore have the
same downstream Copilot model entitlement. The difference is how the request
is authenticated and how the LiteLLM user is selected.

## Client configuration

### TypeScript client

```bash
npm run enterprise:client -- setup \
  --gateway https://BROKER_FQDN \
  --apply
```

Setup prompts for the one-time enrollment code (input is hidden, so the code
never appears in shell history), prints the GitHub account that must approve,
and opens `https://github.com/login/device`. The enrollment routes are
unauthenticated; the 144-bit single-use code is the only bearer, and it is
useless without approving GitHub as the enrolled account. No Entra token,
LiteLLM key, or GitHub token is ever supplied by the client.

After GitHub approval the broker mints the employee key with LiteLLM's
`/key/generate`: `duration: 90d`, the approved model list, and
`allowed_routes` limited to `llm_api_routes`, `info_routes`, and
`/credentials/user_connections`. The client verifies that the key owner,
GitHub login, credential name, and Claude models match the enrollment, stores
the key only in Keychain, writes the profile and CLI settings, and then
acknowledges the enrollment. Acknowledgement consumes the code and deletes
every other key owned by that LiteLLM user, so each employee has exactly one
active key. If acknowledgement fails, rerunning setup with the same code
within the hour returns the same key and retries the cleanup.

Renewal and workstation replacement use the same path: the administrator runs
the workflow again, the existing LiteLLM user and GitHub connection are
reused, and the new setup rotates the key. The temporary enrollment key used
for the device flow is limited to the two GitHub connection routes and
expires after two hours.

The LiteLLM user is keyed by the immutable GitHub account ID, not by email or
Entra object ID. User creation sends no email, disables invitations and
automatic key creation, and assigns only `internal_user`. An optional email
recorded by the administrator is stored as metadata only. The employee's
browser **Your connections** view does not show this identity because it has
no dashboard login; setup verifies the connection through LiteLLM's API.

`--no-browser` suppresses browser launching; `--credential NAME` selects an
explicit per-user credential. Setup never starts a second device flow: if the
enrolled connection is missing or belongs to another GitHub account, setup
fails without changing the previous local profile. Human GitHub approval
cannot be bypassed. The legacy bash `enroll` command and the Go binary use the
older broker-key protocol and are rejected by the current enrollment routes.

Setup writes `~/.local/share/ccgc/enterprise/desktop-gateway.json`. Apply it
through Desktop's supported third-party configuration UI; an existing Gateway
configuration using this helper only needs a relaunch. CLI configuration and
Desktop configuration remain separate. Older TypeScript direct-key profiles
without verified owner metadata require fresh setup or explicit own-key login;
they are not silently migrated by trusting the key already present on a
machine.

For advanced manual-key installation without GitHub OAuth automation:

```bash
npm run enterprise:client -- login-litellm-key \
  --gateway https://LITELLM_FQDN \
  --api-key-file /private/path/litellm-key.json
```

### Administrator workflow (GitHub Actions)

[`.github/workflows/ccgc-employee-access.yml`](../.github/workflows/ccgc-employee-access.yml)
is the supported way to enroll and offboard employees. It runs only from the
Actions tab (`workflow_dispatch`) in the protected `ccgc-admin` environment,
signs in to Entra through GitHub OIDC (no stored secret), and calls the broker
with an app-only token that carries the `CCGC.Admin` role.

| Input | Meaning |
|---|---|
| `action` | `enroll` creates a one-time code; `revoke` offboards the account |
| `github_username` | Employee's GitHub username; it must have a Copilot seat |
| `email` | Optional work email stored as LiteLLM metadata (enroll only) |

**One-time setup.** After `scripts/enterprise-entra.mjs` has created the
broker API, run:

```bash
npm run enterprise:actions-identity -- \
  --repository msftse-org/claude-code-with-github-copilot \
  --broker-url https://BROKER_FQDN \
  --configure-github \
  --confirm-entra-changes
```

The script is idempotent. It allows `CCGC.Admin` to be assigned to
applications, creates the **CCGC Employee Access Automation** app registration
and service principal, adds a federated credential for the `ccgc-admin`
environment's OIDC subject, and assigns that service principal `CCGC.Admin`.
The subject is read from the repository's OIDC settings, so both the
name-based form (`repo:OWNER/REPO:environment:ccgc-admin`) and GitHub's
immutable form (`repo:OWNER@OWNER_ID/REPO@REPO_ID:environment:ccgc-admin`)
are supported. The identity has no client secret and no Azure RBAC role. With
`--configure-github` it also creates the `ccgc-admin` environment, restricts
it to the `main` branch, and sets the `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
`CCGC_ADMIN_AUDIENCE`, and `CCGC_BROKER_URL` environment variables. Assigning
an application role requires an Entra administrator who can grant consent for
the broker API. For a custom OIDC subject template, pass the exact subject
with `--subject`.

**Enroll or renew.** Run the workflow with `action=enroll`. The run summary
contains the code, its expiry, and copyable employee instructions; the code is
never written to the job log. Anyone who can read the repository's Actions
runs can see the summary, which is acceptable only because the code is
single-use, expires after one hour, and requires GitHub approval by the named
account. Delete the run if that exposure is not acceptable.

**Offboard.** Run the workflow with `action=revoke`. The broker marks every
enrollment for the GitHub account revoked, disconnects the account's Copilot
connection from LiteLLM, and deletes the LiteLLM user with all of its keys.
Claude stops working on the employee's next request. Removing the person from
GitHub or their Copilot seat also stops inference at GitHub, but run `revoke`
so that no LiteLLM user or key remains.

Anyone with write access to the repository can dispatch the workflow on
`main`. Keep the repository private and its write access limited to enterprise
IT; add required reviewers to the `ccgc-admin` environment if a second person
must approve each run.

### Native macOS/Windows client

```bash
ccgc-enterprise login-key \
  --gateway https://LITELLM_FQDN \
  --api-key-file /private/path/litellm-key.json
```

The key file must be a non-symlink regular file readable only by its owner and
contain:

```json
{"apiKey":"sk-REDACTED"}
```

Both manual paths verify `/v1/models` and store the key in the platform
credential store, not the profile or Claude settings. The TypeScript path also
validates the personal key owner. The native macOS/Windows helper does not yet
implement the new guided setup.

## Supported API surfaces

The LiteLLM GitHub Copilot provider supports these client-facing surfaces:

- Anthropic Messages: `/v1/messages`
- OpenAI Chat Completions: `/v1/chat/completions`
- OpenAI Responses: `/v1/responses`
- Embeddings: `/v1/embeddings`
- Model discovery: `/v1/models`

Actual models and endpoint behavior depend on the user's GitHub Copilot plan,
the LiteLLM model configuration, and the installed LiteLLM release.

## Migration and rollback

The first deployment is intentionally non-destructive:

1. Deploy direct-key client support and the LiteLLM 1.108.0 configuration.
2. Keep the existing broker and `ccgc_litellm_auth` compatibility path
   available but do not use it for newly migrated users.
3. Validate two-user isolation, connect/disconnect behavior, model restrictions,
   budgets, rate limits, rotation, revocation, Claude Code, Claude Desktop, and
   supported API protocols.
4. Confirm broker traffic is zero.
5. Review a separate Azure what-if that lists every broker, identity, database,
   and Key Vault deletion before cleanup.

The compatibility path remains a rollback mechanism until all direct-key gates
pass. It must not be presented as part of the final request architecture.

## Source layout

| Path | Purpose |
|---|---|
| `src/enterprise-client.ts` | TypeScript direct-key login, credential storage, token helper, and Claude configuration |
| `src/enterprise-setup.ts` | Fresh personal login, native GitHub OAuth and isolated key installation |
| `src/enterprise-cli.ts` | Guided `setup`, manual login and Desktop export commands |
| `src/enterprise-management.ts` | Broker enrollment codes, per-user key issuance, and GitHub-account offboarding |
| `.github/workflows/ccgc-employee-access.yml` | Administrator enroll/revoke workflow using GitHub OIDC |
| `scripts/enterprise-actions-identity.mjs` | Creates the workflow's Entra identity, `CCGC.Admin` grant, and GitHub environment |
| `scripts/ccgc-enterprise-launcher.sh` | Relocatable launcher suitable for Downloads |
| `cmd/ccgc-enterprise/` | Native `login-key` implementation for managed endpoints |
| `server/litellm.enterprise.yaml` | LiteLLM model and temporary compatibility-auth configuration |
| `server/ccgc_litellm_auth.py` | Migration-only CCGC API-key and admission compatibility |
| `infra/enterprise/` | Current Azure topology retained for the non-destructive migration |
| `.azure/deployment-plan.md` | Approved rollout, validation, deployment, and deferred-cleanup gates |

## Validation commands

```bash
npm run check
npm test
npm run test:bootstrap
go test ./...
GOOS=darwin GOARCH=arm64 go build ./cmd/ccgc-enterprise
GOOS=windows GOARCH=amd64 go build ./cmd/ccgc-enterprise
az bicep build --file infra/enterprise/main.bicep --stdout
```

The Sweden Central migration deployment has live proof for LiteLLM UI
availability, direct-key model discovery, Anthropic Messages, Chat
Completions, Responses, Claude Code CLI, model restriction, TPM limits, spend
accounting, delayed budget enforcement, replacement-key rotation, revocation,
fail-closed inference for an unconnected second user, and the temporary CCGC
API-key/admission rollback path. Desktop 4.23118.0 now has separate, supported
Gateway configuration with a Keychain-backed credential helper; a real Code
Read workflow passed with LiteLLM attribution to the key owner's Copilot
route. The Mac later proved to hold another employee's key; this does not
verify the current operator's identity. Fresh correct-user setup and client
retesting are still required. CLI settings alone do not configure this Desktop surface. See the root
README for setup and the model-by-model results: four configured models
passed, while Opus 5.5 returned upstream `model_not_supported`.

Broader two-user concurrency and traffic observation remain required before
the broker is removed. Desktop Chat/Cowork workflows were not verified in
this rollout.

Guided onboarding has synthetic coverage for ownership isolation, native
OAuth outcomes, URL validation, cancellation, model-route isolation,
enrollment-code exchange, wrong-GitHub-account rejection, key rotation on
acknowledgement, and GitHub-account offboarding. That coverage is not live
proof of a new user's Copilot seat or Desktop/CLI workflow.
