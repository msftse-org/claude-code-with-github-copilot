# Enterprise LiteLLM direct-key architecture

The target architecture uses LiteLLM as the only user-facing control plane.
Each person receives a distinct LiteLLM virtual key and connects their own
GitHub account through LiteLLM's per-user GitHub Copilot OAuth capability.
Claude Code, Claude Desktop, Anthropic-compatible clients, and
OpenAI-compatible clients send that virtual key directly to LiteLLM.

[Open the interactive authentication comparison](diagrams/ccgc-auth-options-comparison.html).

## Target request path

1. An administrator creates or invites a personal internal user in LiteLLM.
   The employee completes native invitation/password setup.
2. The guided TypeScript `setup` authenticates that user, runs native GitHub
   device authorization, and creates a user-owned virtual key. Alternatively,
   the employee supplies their own key and connects through the same flow or
   **Models + Endpoints → LLM Credentials → Your connections**.
3. The managed client stores the virtual key only in the operating-system
   credential store. The non-secret profile contains the LiteLLM URL and
   discovered Claude model IDs.
4. Claude's `apiKeyHelper` returns the virtual key. `ANTHROPIC_BASE_URL` points
   directly to LiteLLM.
5. LiteLLM authenticates the key, applies model/team/budget/rate/spend policy,
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
npm run enterprise:client -- setup --gateway https://LITELLM_FQDN --apply
```

The password is entered privately in a terminal, never as a command argument.
The script calls LiteLLM's native `/v2/login`, validates the resulting session
against `/key/info` and `/user/info`, and rejects shared/proxy-admin identities.
It discovers the credential referenced by exact GitHub Copilot Claude routes,
then uses `/credentials/{name}/user_connection/start` and `/poll`. GitHub
supplies the login after approval. No GitHub token is downloaded to the client.
Pending/slowdown/expiry/denial/no-seat outcomes are handled without fallback.

An existing connection is displayed for confirmation, never automatically
disconnected or replaced. Personal-key creation uses the authenticated user's
ID and approved model subset without changing budgets, rates, roles or other
server policy. The generated key's owner and connection are rechecked before
the active private profile changes. Keychain entries are isolated by gateway,
user and key, so failed replacement cannot overwrite another employee's key.

`--use-key` prompts privately for an existing personal virtual key, including
for SSO-only users. `--api-key-file` reads the same key from a private file.
`--no-browser` suppresses browser launching; `--credential NAME` resolves
multiple configured per-user credentials explicitly. Supplied keys exposing
other Claude routes are rejected rather than silently selecting another
provider or GitHub credential. Native account invitation and human GitHub
approval cannot be bypassed by the script.

Setup writes `~/.local/share/ccgc/enterprise/desktop-gateway.json`. Apply it
through Desktop's supported third-party configuration UI; an existing Gateway
configuration using this helper only needs a relaunch. CLI configuration and
Desktop configuration remain separate. Sign into LiteLLM's dashboard as the
same user shown by setup to see **Your connections**; the script does not
reuse or modify browser sessions.

Older TypeScript direct-key profiles without verified owner metadata now
require fresh setup or explicit own-key login. They are not silently migrated
by trusting the key already present on a machine. Inference still uses only a
LiteLLM virtual key, not the dashboard session or Entra JWT.

For advanced manual-key installation without GitHub OAuth automation:

```bash
npm run enterprise:client -- login-litellm-key \
  --gateway https://LITELLM_FQDN \
  --api-key-file /private/path/litellm-key.json
```

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
OAuth outcomes, URL validation, cancellation, model-route isolation and
failed-installation cleanup. That coverage is not live proof of a new user's
Copilot seat or Desktop/CLI workflow.
