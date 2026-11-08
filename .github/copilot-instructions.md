# Claude Code with GitHub Copilot

## Product invariant

- The product must use the actual, unmodified Claude Code app or CLI with Anthropic/Claude models made available through the user's GitHub Copilot seat.
- GitHub Copilot supplies model access and entitlement; Claude Code owns the coding workflow, repository tools, and permission controls.
- Do not replace Claude Code with another coding client or a second agent, describe the goal as billing redirection, or introduce a separate Anthropic/BYOK inference credential.
- A model label, successful text prompt, SDK call, or billing record does not prove the invariant. Success requires the real client, a Copilot-entitled Claude model, the effective Copilot route, and a functioning Claude Code tool workflow.

## Architecture

- Claude clients call LiteLLM directly with a personal 90-day LiteLLM virtual key. There is no broker, admission service, API Management, or custom LiteLLM auth.
- LiteLLM resolves each request to the key owner's own GitHub connection through the native per-user OAuth credential `github-copilot-user` (`github_copilot_auth_type: per_user_oauth`). A key must never reach another user's Copilot connection.
- `infra/main.bicep` (subscription scope) and `infra/modules/litellm.bicep` deploy the official, digest-pinned LiteLLM image on Azure Container Apps with private PostgreSQL, a private Key Vault, and NAT egress.
- `scripts/deploy.mjs` previews or deploys the infrastructure, then `scripts/litellm-bootstrap.mjs` registers the per-user credential and the Claude model routes.
- `.github/workflows/ccgc-employee-access.yml` runs `scripts/enterprise-actions-access.mjs` to enroll (user plus 90-day key) or revoke an employee. It uses the `ccgc-admin` environment, which holds `LITELLM_URL` and the `LITELLM_MASTER_KEY` secret.
- `scripts/ccgc-enterprise-macos.sh` is the standalone employee setup. It stores the key in macOS Keychain, starts the GitHub device flow through LiteLLM, verifies the connection and model routes, and configures Claude Code.

## Commands

Use Node.js 24 and install with `npm ci`.

```bash
npm run check                 # strict TypeScript check of tests and script declarations
npm test                      # synthetic tests
node --test test/deploy.test.ts
node scripts/deploy.mjs --help
az bicep build --file infra/main.bicep --stdout >/dev/null && az bicep lint --file infra/main.bicep
bash -n scripts/ccgc-enterprise-macos.sh
```

Live commands can consume Copilot allowance, create billable Azure resources, or change who can use a gateway. They require the user's explicit authorization. `deploy.mjs` only previews unless `--confirm-deploy` is passed. Never initiate device login on someone's behalf, and never treat a blocked live check as permission to bypass account or organization controls.

## Evidence and documentation

- `README.md` describes implemented behavior and current evidence; `docs/ENTERPRISE.md` is the administrator runbook; `docs/mac/README.md` is the employee guide.
- When implementation, deployment, or verification status changes, update the corresponding documentation in the same task.
- Distinguish source/documentation review, synthetic tests, real-client/fake-upstream tests, and live Copilot verification. Never promote one evidence level into another. Evidence from an earlier deployment must be re-established after a rebuild or upgrade.
- Record exact client and LiteLLM versions and whether each path is verified, blocked, or untested. CLI evidence does not establish Desktop compatibility.

## Implementation conventions

- Scripts are dependency-free Node.js ESM (`.mjs`) with `.d.mts` declarations; tests are strict TypeScript run directly by `node --test`. Keep compatibility with `NodeNext`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, and `erasableSyntaxOnly`.
- Fail closed with clear errors. Do not add broad catches, implicit retries, redirects, provider or model fallback, or success-shaped fallbacks.
- Keep secrets (master key, salt key, database password, employee keys, GitHub tokens) out of command arguments, logs, repository files, Claude Code's environment, and client-facing headers. Pass them through stdin, private 0600 files, Key Vault, or GitHub environment secrets.
- The LiteLLM salt key encrypts stored GitHub connections; it must never change for an existing database.
- Keep tests synthetic by default. Any live test must state that it may consume allowance and report live access as unverified until the actual client route succeeds.
