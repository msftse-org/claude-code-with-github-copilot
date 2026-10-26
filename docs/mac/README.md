# Enterprise Mac setup and operation

This guide covers the employee Mac configuration for the enterprise CCGC
architecture.

## What is installed or stored on the Mac

| Item | What it does | Required action |
|---|---|---|
| Official Claude Code `2.1.296` or newer | Provides the unchanged coding interface and runs local Read, Edit, Bash, and permission decisions. | Install and verify the minimum supported version. |
| Enterprise CCGC helper | Shell-based self-enrollment client and Claude `apiKeyHelper`. | Keep the installed private script at its stable path. |
| Admission credential in macOS Keychain | Authenticates Claude requests for one employee and one bounded admission. | Allow the helper to create and renew it; never copy it manually. |
| `~/.claude/settings.json` | Routes Claude to the enterprise broker and installs the credential helper. | Enrollment applies a conflict-checked update. |
| Enterprise profile | Stores non-secret Entra/GitHub binding, catalog, revision, and admission metadata. | Let the helper create it; do not hand-edit or restore stale grants. |

GitHub OAuth and Copilot tokens do not belong on the Mac. LiteLLM encrypts the
GitHub connection in its private PostgreSQL database; Key Vault stores only the
matching LiteLLM user key used by workers.

## 1. Install prerequisites

Required for self-service API-key enrollment:

- macOS
- Official Claude Code `2.1.296` or newer
- The repository's `scripts/ccgc-enterprise-macos.sh` enrollment script
- A broker URL and unexpired single-use enrollment code from Enterprise IT

Download the tracked script from the private organization repository with an
authenticated GitHub CLI session:

```bash
gh auth status
gh api \
  -H 'Accept: application/vnd.github.raw+json' \
  repos/msftse-org/claude-code-with-github-copilot/contents/scripts/ccgc-enterprise-macos.sh \
  > "$HOME/Downloads/ccgc-enterprise-macos.sh"
chmod 600 "$HOME/Downloads/ccgc-enterprise-macos.sh"

claude --version
/bin/bash "$HOME/Downloads/ccgc-enterprise-macos.sh" help
```

Enterprise IT can instead distribute the same repository file through the
approved corporate software channel. Employees should not accept a script from
chat, email, or an unverified fork. If IT publishes a SHA-256 checksum, verify
it with `shasum -a 256` before enrollment.

If Claude Code is missing or older than the minimum supported version:

```bash
claude install 2.1.296
claude --version
```

Enrollment copies the script to a stable private path under
`~/.local/share/ccgc/enterprise/` and configures Claude to invoke it through
`/bin/bash`. It does not disable Gatekeeper, remove quarantine attributes, or
change MDM policy. If organizational policy also blocks approved shell scripts,
IT must distribute the script through the corporate software channel.

## 2. Self-enroll with the one-time code

```bash
/bin/bash "$HOME/Downloads/ccgc-enterprise-macos.sh" enroll \
  --code CCGC-ONE-TIME-CODE
```

The script defaults to the deployed pilot broker. A different deployment can
be selected explicitly with `--gateway https://PUBLIC_BROKER_FQDN`.

The script opens GitHub's device page, displays the expected GitHub login,
and waits for authorization. The broker rejects a different GitHub identity or
an account without an active Copilot entitlement. After verification, the
script stores the employee API key directly in Keychain, writes the
non-secret profile, and configures Claude Code. The administrator never sees
or transfers the API key.

Enrollment also checks broker health, model discovery, the human-readable model
name, the approved output limit, and one real bounded inference response before
it saves local credentials or acknowledges the one-time code.

> [!IMPORTANT]
> `enroll` is an initial or recovery action, not an update command. Once
> enrollment succeeds, do not run the downloaded script's `enroll` command
> again for routine service, LiteLLM, model, script, or Claude Code updates.
> Keep using the installed helper and run `doctor`; use `models` or `configure`
> when their specific checks or repairs are needed.

## 3. Alternative Entra or manual API-key login

Enterprise IT provides:

- the public HTTPS enterprise broker URL
- the Entra application audience, such as `api://APPLICATION-ID`
- confirmation that the employee is assigned to the authorized Entra pilot group
- confirmation that the employee's Entra principal is linked to the same
  employee's GitHub account and approved credential reference

Run:

```bash
npm run enterprise:client -- login \
  --gateway https://PUBLIC_BROKER_FQDN \
  --audience api://ENTRA-APPLICATION-ID
```

The helper uses `DefaultAzureCredential` to obtain an Entra token for the
configured audience over the public internet. The enterprise broker verifies
the tenant, audience, `CCGC.Access` scope/app role, and immutable object ID,
then returns the approved employee binding and model catalog. No VPN is
required; worker, LiteLLM, and data endpoints remain private.

The organization must define which `DefaultAzureCredential` source is allowed in
production. Before login, remove unintended developer, CLI, IDE, or managed
identity credentials that could select the wrong principal.

If Enterprise IT assigned an employee API key instead, receive its private JSON
file through an approved secret-delivery channel and ensure it has mode `0600`:

```bash
chmod 600 "$HOME/.config/ccgc/api-key.json"
npm run enterprise:client -- login-api-key \
  --gateway https://PUBLIC_BROKER_FQDN \
  --api-key-file "$HOME/.config/ccgc/api-key.json"
rm "$HOME/.config/ccgc/api-key.json"
```

The helper verifies the bound profile before storing the 30-day key in macOS
Keychain. The key is never written to the enterprise profile or Claude
settings. API keys cannot authorize enterprise administration routes.

## 4. Understand the enterprise profile

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
- GitHub or worker-service credentials
- the opaque admission token

The profile is private operational state. Do not commit it, synchronize it,
hand-edit it, or copy an old admission to another Mac.

## 5. Update and re-enrollment policy

An existing enrollment remains valid across normal control-plane, LiteLLM,
model-catalog, helper-script, and Claude Code updates. Updating the tracked
script does not consume a new enrollment code and does not require GitHub
device authorization again. Enterprise IT should preserve the existing
binding and employee credential during those rollouts.

Run enrollment again only when:

- setting up a different Mac or macOS user profile;
- Enterprise IT revoked or intentionally rebound the employee identity;
- the 30-day employee key expired or was revoked;
- the local profile or Keychain credential was lost and cannot be recovered;
- Enterprise IT explicitly announces a migration that requires
  re-enrollment and provides a new one-time code.

If Claude stops working after an ordinary update, run `doctor` first. Do not
request a new enrollment code or delete the profile/Keychain entry as a generic
troubleshooting step.

## 6. Reapply Claude settings

Enrollment configures Claude automatically. To reapply the same conflict-checked
configuration later, run:

```bash
/bin/bash "$HOME/.local/share/ccgc/enterprise/ccgc-enterprise-macos.sh" configure
```

This updates `~/.claude/settings.json` and:

- sets the enterprise broker as `ANTHROPIC_BASE_URL`
- configures the default approved model
- enables gateway model discovery
- installs the enterprise `apiKeyHelper`
- sets a one-minute helper cache
- preserves an existing permission default, or uses `manual` when none is set
- sets `CLAUDE_CODE_AUTO_MODE_SERVER=0`, allowing opt-in auto mode to use
  Claude Code's local classifier instead of Anthropic-only server safeguards
- removes obsolete project-owned feature-disable flags
- preserves unrelated Claude settings and existing allow/deny rules

If the existing Claude settings contain `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, or `CLAUDE_CODE_OAUTH_TOKEN`, the script asks whether
to create a private timestamped backup and replace only conflicting
enterprise-managed credential and routing settings, or cancel without changing
the file. This also safely handles an existing `ANTHROPIC_BASE_URL`. Shell
environment settings are never edited automatically; unset them explicitly and
retry.

Configuration fails without changing the file if it finds a conflicting shell
environment variable, provider route, credential helper, or user setting.
Resolve the conflict explicitly; do not overwrite organizational policy.

## 7. Inspect the approved models

```bash
/bin/bash "$HOME/.local/share/ccgc/enterprise/ccgc-enterprise-macos.sh" models
```

The command shows:

- the default model
- all models approved for this employee
- the current binding revision

The catalog comes from the employee binding. It is not an unrestricted provider
catalog.

## 8. Run the end-to-end doctor

Run this after enrollment, after a client update, or before opening a support
case:

```bash
/bin/bash "$HOME/.local/share/ccgc/enterprise/ccgc-enterprise-macos.sh" doctor
```

The doctor fails closed and reports the first actionable problem. It verifies:

- the minimum supported Claude Code version
- private, user-owned, non-symlink helper/profile/settings files
- absence of conflicting shell and Claude credentials
- the enterprise base URL, model, helper, cache, permissions, and auto-mode settings
- the employee key in macOS Keychain
- broker health and the current account binding
- the approved model ID and human-readable discovery name
- the Sonnet 5.5 128K output limit
- one real bounded inference response

It never prints the employee key or admission token.

## 9. Create an admission and start Claude

Start Claude normally:

```bash
claude
```

When Claude invokes the `apiKeyHelper`, the helper:

1. obtains an Entra token for the broker audience or loads the employee API key
   from macOS Keychain
2. requests an eight-hour, 50-attempt bounded admission
3. stores the random opaque admission token in macOS Keychain
4. stores only the admission ID and expiry in the non-secret profile
5. returns the token to Claude on standard output

The Keychain service name is derived from the enterprise broker URL. The
credential is never written to the profile or Claude settings.

Use `/model` inside Claude Code to select another approved model. Do not add
provider keys or override the broker URL.

## 10. Supported and unsupported behavior

### Validated features

- Chat and streaming
- Read, Edit, and Bash
- Model discovery and switching
- Bounded admission renewal
- Image and PDF input
- Adaptive thinking
- Low-effort between-tools thinking
- Exact token counting
- Completed-turn resume after admission renewal or gateway restart
- Exact pending-tool resume after an enterprise worker restart
- Coordinated agents/subagents
- Background Bash tasks
- Hooks
- Automatic compaction through a real context-limit continuation cycle
- Cron create/list/delete, durable restart, and timed one-shot firing
- Automatic-memory write, persistence, and fresh-session reload
- Auto permission mode through Claude Code's local classifier

| Feature | Status | Employee impact |
|---|---|---|
| Explicit fixed-budget thinking | Not supported by the current model | Use adaptive thinking; the current Sonnet model rejects explicit thinking budgets. |
| Advisor | Anthropic API only | Claude Code omits the Advisor server tool when configured with this custom Copilot gateway. |

Auto mode is not the default. Start or select it only under the organization's
normal Claude Code permission policy; the local classifier path has official
client coverage through this gateway and does not require LiteLLM to emulate
Anthropic safeguard results.

The detailed reasons and enforcement points are in the root
[feature compatibility table](../../README.md#claude-code-feature-compatibility).

## 11. Keychain behavior

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

## 12. Binding changes and revocation

An administrator binding update increments the binding revision and revokes
existing admissions and API keys. The employee must obtain the updated profile
through a reviewed enterprise login or new enrollment issued by Enterprise IT
before continuing. API keys also expire after 30 days and can be revoked
independently. This exceptional recovery flow does not change the rule that
routine updates preserve enrollment.

Stop and contact enterprise IT if any of these change unexpectedly:

- tenant, object ID, or authentication method
- GitHub account ID or login
- model catalog
- binding revision
- enterprise broker URL

Do not delete or edit the profile to bypass an identity conflict.

## 13. Troubleshooting

| Symptom | Action |
|---|---|
| Entra sign-in returns no token | Verify the approved credential source can obtain `<audience>/.default`. |
| Broker returns HTTP 401 | Reauthenticate with the intended Entra principal and confirm audience configuration. |
| Broker returns HTTP 403 | Ask enterprise IT to verify the employee binding and its revision. |
| Keychain credential is unavailable | Unlock Keychain and confirm the current macOS user owns the enrollment. |
| Routing conflict | Remove or resolve the reported environment or Claude setting; do not force an overwrite. |
| No models are listed | Ask enterprise IT to verify the employee's approved catalog and account binding. |
| Claude stopped working after an update | Run the installed helper's `doctor`; do not delete credentials or repeat enrollment unless Enterprise IT confirms a lifecycle condition above. |
| A worker replica restarts | Retry only through normal Claude behavior. The next admitted turn can restore the encrypted branch checkpoint on another replica; an uncertain in-flight inference is never replayed automatically. |

Useful checks:

```bash
claude --version
npm run enterprise:client -- models
npm run enterprise:client -- configure
```

## 14. Security rules

- Use only the employee's own Entra identity and Copilot seat.
- Never pool, copy, or share admission or Copilot credentials.
- Never add an Anthropic, GitHub, or Copilot token to Claude settings.
- Never place the profile or Keychain data in source control or synchronized
  storage.
- Do not enable provider fallback, response caching, inference retries, hooks,
  or payload logging without a separate security review.
- Treat unexpected identity, model, or binding changes as an enterprise IT event.
