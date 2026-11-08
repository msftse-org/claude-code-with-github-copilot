# Enterprise LiteLLM direct-key architecture

The target architecture uses LiteLLM as the only user-facing control plane.
Each person receives a distinct LiteLLM virtual key and connects their own
GitHub account through LiteLLM's per-user GitHub Copilot OAuth capability.
Claude Code, Claude Desktop, Anthropic-compatible clients, and
OpenAI-compatible clients send that virtual key directly to LiteLLM.

[Open the interactive authentication comparison](diagrams/ccgc-auth-options-comparison.html).

## Target request path

1. An administrator creates or invites the user in the LiteLLM UI and issues a
   user-owned virtual key.
2. The user opens **Models + Endpoints → LLM Credentials → Your connections**
   and connects GitHub Copilot.
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

After verification through `/v1/models`, the client stores the key in Keychain
or the platform credential store and writes no key to the profile or Claude
settings.

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
| `src/enterprise-cli.ts` | `login-litellm-key` command |
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
API-key/admission rollback path. Claude Desktop GUI, broader two-user
concurrency, and traffic observation remain required before the broker is
removed.
