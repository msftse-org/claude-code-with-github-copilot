# Enterprise Mac setup and operation

This guide covers the employee Mac configuration for the enterprise CCGC
architecture.

> [!IMPORTANT]
> The enterprise environment is not deployed yet. These commands describe the
> implemented client flow and become usable after the operator completes the
> enterprise deployment and employee binding.

## What is installed or stored on the Mac

| Item | What it does | Required action |
|---|---|---|
| Official Claude Code `2.1.296` | Provides the unchanged coding interface and runs local Read, Edit, Bash, and permission decisions. | Install and verify the exact supported version. |
| Enterprise CCGC helper | Uses Entra for broker control requests and acts as Claude's `apiKeyHelper`. | Keep this repository and Node.js at stable paths. |
| Admission credential in macOS Keychain | Authenticates Claude requests for one employee and one bounded admission. | Allow the helper to create and renew it; never copy it manually. |
| `~/.claude/settings.json` | Routes Claude to the enterprise broker and installs the credential helper. | Preview and explicitly apply the generated patch. |
| Enterprise profile | Stores non-secret Entra/GitHub binding, catalog, revision, and admission metadata. | Let the helper create it; do not hand-edit or restore stale grants. |

GitHub OAuth and Copilot tokens do not belong on the Mac. They remain inside the
employee's isolated worker.

## 1. Install prerequisites

Required:

- macOS
- Node.js 24
- npm
- Official Claude Code `2.1.296`
- A stable checkout of this repository
- An approved Microsoft Entra credential source

From the repository root:

```bash
npm ci
node --version
claude --version
npm run enterprise:client -- --help
```

If Claude Code is missing or has another version:

```bash
claude install 2.1.296
claude --version
```

Do not move the repository or replace the Node.js executable after applying the
settings without previewing and applying configuration again. The generated
`apiKeyHelper` uses their absolute paths.

## 2. Sign in with Microsoft Entra

The operator provides:

- the private enterprise broker URL
- the Entra application audience, such as `api://APPLICATION-ID`
- confirmation that the employee's Entra principal is linked to the same
  employee's GitHub account and private worker

Run:

```bash
npm run enterprise:client -- login \
  --gateway https://PRIVATE_GATEWAY \
  --audience api://ENTRA-APPLICATION-ID
```

The helper uses `DefaultAzureCredential` to obtain an Entra token for the
configured audience. The enterprise broker verifies the tenant and immutable
object ID, then returns the approved employee binding and model catalog.

The organization must define which `DefaultAzureCredential` source is allowed in
production. Before login, remove unintended developer, CLI, IDE, or managed
identity credentials that could select the wrong principal.

## 3. Understand the enterprise profile

Login writes a private profile to:

```text
~/.local/share/ccgc/enterprise/profile.json
```

It contains:

- enterprise broker URL and Entra audience
- Entra tenant and immutable object ID
- linked GitHub login and immutable account ID
- approved Claude model IDs
- binding revision
- current admission ID and expiry, when present

It does not contain:

- the Entra access token
- GitHub OAuth credentials
- Copilot tokens
- worker credentials
- the opaque admission token

The profile is private operational state. Do not commit it, synchronize it,
hand-edit it, or copy an old admission to another Mac.

## 4. Preview and apply Claude settings

Preview:

```bash
npm run enterprise:client -- configure
```

The preview shows the non-secret patch only. Review it before applying.

Apply:

```bash
npm run enterprise:client -- configure --apply
```

This updates `~/.claude/settings.json` and:

- sets the enterprise broker as `ANTHROPIC_BASE_URL`
- configures the default approved model
- enables gateway model discovery
- installs the enterprise `apiKeyHelper`
- sets a one-minute helper cache
- selects `manual` permission mode because Claude Code auto mode depends on an
  Anthropic safety classifier that is unavailable through this custom route
- removes obsolete project-owned feature-disable flags
- preserves unrelated Claude settings and existing allow/deny rules

Configuration fails without changing the file if it finds a conflicting shell
environment variable, provider route, credential helper, or user setting.
Resolve the conflict explicitly; do not overwrite organizational policy.

## 5. Inspect the approved models

```bash
npm run enterprise:client -- models
```

The command shows:

- the default model
- all models approved for this employee
- the current binding revision

The catalog comes from the employee binding. It is not an unrestricted provider
catalog.

## 6. Create an admission and start Claude

Start Claude normally:

```bash
claude
```

When Claude invokes the `apiKeyHelper`, the helper:

1. obtains an Entra token for the broker audience
2. requests an eight-hour, 50-attempt bounded admission
3. stores the random opaque admission token in macOS Keychain
4. stores only the admission ID and expiry in the non-secret profile
5. returns the token to Claude on standard output

The Keychain service name is derived from the enterprise broker URL. The
credential is never written to the profile or Claude settings.

Use `/model` inside Claude Code to select another approved model. Do not add
provider keys or override the broker URL.

## 7. Supported and unsupported behavior

### Validated features

- Chat and streaming
- Read, Edit, and Bash
- Model discovery and switching
- Bounded admission renewal
- Image and PDF input
- Adaptive thinking
- Exact token counting
- Completed-turn resume after admission renewal or gateway restart
- Agents/subagents
- Background Bash tasks
- Hooks

| Feature | Status | Employee impact |
|---|---|---|
| Explicit fixed-budget thinking | Not supported by the current model | Use adaptive thinking; the current Sonnet model rejects explicit thinking budgets. |
| Automatic compaction | Not fully verified | Thinking cleanup works, but do not rely on full context-limit compaction until a real long-context cycle passes release testing. |
| Resume with a pending tool batch | Not working | Completed turns resume, but a conversation paused inside a tool batch cannot yet resume safely. |
| Agent teams | Exposed, not fully verified | Claude Code 2.1.296 exposes Agent, ListAgents, SendMessage, and Workflow. Full coordinated multi-agent execution remains a release-test gap. |
| Cron | Exposed, not fully verified | Claude Code 2.1.296 exposes CronCreate, CronDelete, and CronList, but scheduled firing and durable restart have not completed release testing. |
| Automatic memory | Enabled, not fully verified | Automatic memory is no longer disabled, but controlled persistence and reload testing is still pending. |
| Advisor | Not available in Claude Code 2.1.296 | The disable flag is gone, but the client does not expose an Advisor tool. |
| Auto permission mode | Not supported through this route | The custom route cannot reach Claude Code's Anthropic safety classifier. The generated profile uses manual mode and preserves explicit allow/deny rules. |

The detailed reasons and enforcement points are in the root
[feature compatibility table](../../README.md#claude-code-feature-compatibility).

## 8. Keychain behavior

Only the opaque admission token is stored in macOS Keychain. It is:

- specific to one enterprise broker
- bound server-side to one Entra/GitHub employee binding
- short-lived and attempt-limited
- replaced when fewer than five minutes remain
- useless as a GitHub or Copilot credential

Do not export, copy, log, or share the Keychain entry.

If Keychain access fails, confirm that:

- the same macOS user performed enrollment
- Keychain is unlocked
- the `security` command is permitted
- the profile still points to the expected broker

## 9. Binding changes and revocation

An operator binding update increments the binding revision and revokes existing
admissions. The employee must obtain the updated profile through a reviewed
enterprise login before continuing.

Stop and contact the operator if any of these change unexpectedly:

- Entra tenant or object ID
- GitHub account ID or login
- model catalog
- binding revision
- enterprise broker URL

Do not delete or edit the profile to bypass an identity conflict.

## 10. Troubleshooting

| Symptom | Action |
|---|---|
| Entra sign-in returns no token | Verify the approved credential source can obtain `<audience>/.default`. |
| Broker returns HTTP 401 | Reauthenticate with the intended Entra principal and confirm audience configuration. |
| Broker returns HTTP 403 | Ask the operator to verify the employee binding and its revision. |
| Keychain credential is unavailable | Unlock Keychain and confirm the current macOS user owns the enrollment. |
| Routing conflict | Remove or resolve the reported environment or Claude setting; do not force an overwrite. |
| No models are listed | Ask the operator to verify the employee's approved catalog and worker binding. |
| Worker restart interrupts a conversation | Retire the old admission and start a new foreground conversation; durable resume is not implemented. |

Useful checks:

```bash
claude --version
npm run enterprise:client -- models
npm run enterprise:client -- configure
```

## 11. Security rules

- Use only the employee's own Entra identity and Copilot seat.
- Never pool, copy, or share admission or Copilot credentials.
- Never add an Anthropic, GitHub, or Copilot token to Claude settings.
- Never place the profile or Keychain data in source control or synchronized
  storage.
- Do not enable provider fallback, response caching, inference retries, hooks,
  or payload logging without a separate security review.
- Treat unexpected identity, model, or binding changes as an operator event.
