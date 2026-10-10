# Claude Code with GitHub Copilot

## Product invariant

- The product must use the actual, unmodified Claude Code app or CLI with Anthropic/Claude models made available through the user's GitHub Copilot seat.
- GitHub Copilot supplies model access and entitlement; Claude Code owns the coding workflow, repository tools, and permission controls.
- Do not replace Claude Code with another coding client or a second agent, describe the goal as billing redirection, introduce a separate Anthropic/BYOK inference credential, or assume Azure is required.
- A model label, successful text prompt, SDK call, or billing record does not prove the invariant. Success requires the real client, a Copilot-entitled Claude model, the effective Copilot route, and a functioning Claude Code tool workflow.

## Commands

Use Node.js 24 and install with `npm ci`.

```bash
npm run check          # strict TypeScript check, no emit
npm test               # synthetic unit and protocol tests
npm run test:client    # real pinned Claude CLI against local fake upstream
npm run enterprise:client -- --help
```

Run one test file with `node --test test/gateway.test.ts`. Run one named test with:

```bash
node --test --test-name-pattern="<test name>" test/gateway.test.ts
```

`npm run test:client` does not call Copilot inference or prove account entitlement. Live commands can consume Copilot allowance and require the user's explicit authorization; do not initiate device login, provision cloud resources, or treat a blocked live check as permission to bypass account or organization controls.

## Architecture

- `src/cli.ts` is the configuration-first remote CLI. It configures the supported Claude gateway surface, performs diagnostics, and manages the gateway credential without running a persistent local inference listener.
- `src/remote-client.ts`, `src/remote-server.ts`, and `src/remote.ts` implement the remote profile, admission, metadata, and credential boundaries.
- `src/litellm.ts` represents the preferred first connector candidate: LiteLLM's native GitHub Copilot Anthropic Messages provider.
- `src/enterprise-auth.ts`, `src/enterprise-store.ts`, and `src/enterprise-server.ts` implement the Entra-authenticated, PostgreSQL-fenced enterprise broker.
- `src/enterprise-worker-server.ts` is the isolated per-user LiteLLM wrapper; `src/enterprise-client.ts` supplies Claude with opaque bounded admission tokens.
- `infra/enterprise/` is additive private Bicep. APIM is optional governance ingress, not a LiteLLM replacement.
- `src/local-cli.ts`, `src/gateway.ts`, `src/copilot.ts`, and `src/claude.ts` retain the local native Messages adapter as an experimental development and regression harness, not the target deployment.
- `src/protocol.ts` owns strict parsing and explicit bridge errors. Unsupported or ambiguous input must fail closed rather than be silently removed, retried, or routed to another provider.
- `test/claude.integration.ts` exercises the pinned real Claude Code CLI with fake upstreams and disposable repositories; the other test files cover CLI, Copilot, gateway, and protocol behavior.

The target decision order is:

1. Evaluate ordinary Claude client gateway configuration with a remote LiteLLM native Copilot Messages provider.
2. Add Azure API Management only when centralized governance requires it; APIM does not provide Copilot entitlement.
3. Use custom remote connector code only for controls LiteLLM cannot satisfy economically.
4. Retain the local adapter as a proof/regression fallback, not the default product experience.

Normally prove the selected Copilot-entitled Claude model through the smallest approved live harness before remote hosting. The owner explicitly approved a hosting-first investigation and Sweden Central scaffolding on 2026-10-06; follow `docs/AZURE.md` for this exception. Billable deployment still requires separate approval, and hosting does not authorize Copilot linking/inference or waive live proof. Do not add automatic provider, model, region, or SKU fallback.

## Evidence and documentation

- `docs/PRD.md` is the target product and architecture contract. `README.md` describes implemented behavior and current evidence.
- When research changes feasibility, architecture, support status, or a selected provider, update `docs/PRD.md` in the same task rather than only reporting findings in chat.
- When implementation or verification status changes, update the corresponding README claims in the same task. Keep target architecture and implemented alpha behavior explicitly separate.
- Distinguish source/documentation review, synthetic tests, real-client/fake-upstream tests, and live Copilot verification. Never promote one evidence level into another.
- Record exact client/provider versions and whether each app/CLI path is verified, blocked, or untested. CLI evidence does not establish Desktop compatibility.

## Implementation conventions

- TypeScript runs directly as ESM with `.ts` import extensions. Keep compatibility with strict `NodeNext`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, and `erasableSyntaxOnly`.
- Use Node built-ins for runtime behavior unless a dependency is justified by the selected architecture; current npm dependencies are development-only.
- Preserve explicit `BridgeError` codes and safe user-facing errors. Do not add broad catches, implicit retries, redirects, caller-selected upstreams, or success-shaped fallbacks.
- Keep credentials out of command arguments, logs, Claude Code's environment, and client-facing headers. Preserve HTTPS-only gateway validation, exact Claude model mapping, bounded responses, and explicit unofficial-access acknowledgement.
- Keep tests synthetic by default. Any live test must be isolated from repository content, clearly state that it may consume allowance, and report live access as unverified until the actual client route succeeds.
