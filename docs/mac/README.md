# Enterprise Mac setup and operation

This guide covers standalone macOS enrollment with a personal LiteLLM key.
Claude Code calls the enterprise LiteLLM gateway directly with that key, and
LiteLLM serves each request through the employee's own GitHub Copilot
connection. Employees get a key from Enterprise IT, run one script, paste the
key, and approve GitHub in the browser that opens automatically. No checkout,
Node.js, npm, or LiteLLM dashboard login is required. See also the
[root README](../../README.md#getting-started).
CLI settings and this guide's `doctor` do not establish Desktop routing.

## What is installed or stored on the Mac

| Item | What it does | Required action |
|---|---|---|
| Official Claude Code `2.1.296` or newer | Provides the unchanged coding interface and runs local Read, Edit, Bash, and permission decisions. | Install and verify the minimum supported version. |
| Enterprise CCGC helper | Shell-based self-enrollment client and Claude `apiKeyHelper`. | Keep the installed private script at its stable path. |
| Personal LiteLLM key in macOS Keychain | Authenticates that employee's inference requests directly for up to 90 days. | Use a newly issued key for renewal. |
| `~/.claude/settings.json` | Routes Claude to LiteLLM and installs the Keychain credential helper. | Enrollment applies a conflict-checked update. |
| Enterprise profile | Stores the gateway, verified LiteLLM/GitHub identity, credential reference, and model catalog; no secrets. | Let the helper create it; do not hand-edit it. |
| `desktop-gateway.json` | Secret-free import file for Desktop's separate Gateway mode. | Import through Developer > Configure Third-Party Inference and relaunch. |

GitHub OAuth and Copilot tokens do not belong on the Mac. LiteLLM encrypts the
GitHub connection in its private PostgreSQL schema. The employee's personal
LiteLLM key is saved in macOS Keychain.

## 1. Get your personal key and the script

Required:

- macOS
- Official Claude Code `2.1.296` or newer
- Your own GitHub account with GitHub Copilot access
- The repository's `scripts/ccgc-enterprise-macos.sh` enrollment script
- The LiteLLM HTTPS URL and your 90-day personal key from Enterprise IT

Enterprise IT issues the key with the `CCGC employee access` GitHub Actions
workflow (`enroll` action). The workflow creates or reuses your LiteLLM user
and a new 90-day key. Its protected run summary shows the key, its expiry, the
approved models, and the exact enrollment command with the LiteLLM URL.
Anyone who can read that workflow run can use the key until it expires or is
revoked, so IT keeps repository read access limited and sends the key only
through an approved private channel.

Enterprise IT distributes the tracked script through the approved software
channel. An administrator with an authenticated GitHub CLI session can
retrieve it from the private organization repository:

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

## 2. Enroll with your personal key

Run the enrollment command from the Actions run summary. It has this form:

```bash
bash "$HOME/Downloads/ccgc-enterprise-macos.sh" enroll --gateway https://LITELLM_FQDN
```

Use the LiteLLM HTTPS origin from Enterprise IT, without a path. Running the
script without arguments enrolls against the deployed pilot LiteLLM endpoint
built into the script.

1. The script checks the Claude Code version and your existing Claude
   settings. A conflicting shell environment variable stops enrollment; unset
   it and retry. If `~/.claude/settings.json` already sets another
   `apiKeyHelper`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
   `CLAUDE_CODE_OAUTH_TOKEN`, or a different `ANTHROPIC_BASE_URL`, the script
   asks before the key is used whether to back up and replace only those
   settings after verification, or cancel.
2. Paste your personal key when prompted. Input is hidden, and the key does
   not go into shell history.
3. The script checks LiteLLM health, the key owner, the employee role, the key
   expiry, and the Claude models available to the key.
4. GitHub's device page opens automatically in your browser. Enter the code
   that the script displays and approve with your own GitHub account that has
   Copilot; the script names the expected account. With `--no-browser`, open
   `https://github.com/login/device` yourself. If your LiteLLM user is already
   connected to that account, for example when you renew with a new key, this
   step is skipped.
5. LiteLLM verifies the connected GitHub account and Copilot entitlement. If
   the approving account does not match your LiteLLM user, the script removes
   that connection and fails.
6. Before saving anything, the script verifies the key owner, the connected
   GitHub account, and the exact per-user `github-copilot-user` route for
   every visible Claude model. It also checks model discovery, the
   human-readable model name, the approved output limit, and one real bounded
   inference response.
7. It then stores the key in macOS Keychain, writes the non-secret profile,
   configures Claude Code, and writes the Desktop import file.

Failed identity or routing verification does not replace the previous local
profile or credentials. When the script prints `Enrollment complete`, restart
any open Claude sessions and run `claude`.

> [!IMPORTANT]
> `enroll` is an initial or recovery action, not an update command. Once
> enrollment succeeds, do not run the downloaded script's `enroll` command
> again for routine service, LiteLLM, model, script, or Claude Code updates.
> Keep using the installed helper and run `doctor`; use `models` or `configure`
> when their specific checks or repairs are needed.

## 3. Understand the enterprise profile

Enrollment writes a private profile to:

```text
~/.local/share/ccgc/enterprise/profile.json
```

It contains:

- LiteLLM gateway URL
- verified LiteLLM user ID and GitHub login
- selected per-user Copilot credential name and isolated Keychain identifier
- approved Claude model IDs

It does not contain:

- the personal LiteLLM key
- GitHub OAuth credentials
- Copilot tokens
- GitHub or gateway-service credentials

The profile is private operational state. Do not commit it, synchronize it,
hand-edit it, or copy it to another Mac.

## 4. Renewal and re-enrollment policy

An existing enrollment remains valid across normal LiteLLM,
model-catalog, helper-script, and Claude Code updates. Updating the tracked
script does not require a new key or GitHub device authorization. Enterprise
IT should preserve the existing employee key during those rollouts.

Personal keys last 90 days. To renew, ask Enterprise IT to issue a new key,
then run the `enroll` command from step 2 again and paste the new key. If your
LiteLLM user is still connected to your GitHub account, enrollment skips the
GitHub device step.

Run enrollment again, always with a new personal key from Enterprise IT, only
when:

- setting up a different Mac or macOS user profile;
- Enterprise IT revoked your access;
- the 90-day personal key expired or is about to expire;
- the local profile or Keychain credential was lost and cannot be recovered;
- the installed helper reports that this enrollment is no longer supported;
- Enterprise IT explicitly announces a migration that requires
  re-enrollment and provides a new key.

If Claude stops working after an ordinary update, run `doctor` first. Do not
request a replacement key or delete the profile/Keychain entry as a generic
troubleshooting step.

## 5. Reapply Claude settings

Enrollment configures Claude automatically. To reapply the same conflict-checked
configuration later, run:

```bash
/bin/bash "$HOME/.local/share/ccgc/enterprise/ccgc-enterprise-macos.sh" configure
```

This re-verifies the enrollment with LiteLLM, refreshes the approved model
catalog in the profile, rewrites `desktop-gateway.json`, and updates
`~/.claude/settings.json`. The settings update:

- sets the enrolled LiteLLM gateway as `ANTHROPIC_BASE_URL`
- configures the default approved model
- enables gateway model discovery
- installs the enterprise `apiKeyHelper`
- sets a one-minute helper cache
- preserves an existing permission default, or uses `manual` when none is set
- sets `CLAUDE_CODE_AUTO_MODE_SERVER=0`, allowing opt-in auto mode to use
  Claude Code's local classifier instead of Anthropic-only server safeguards
- preserves unrelated Claude settings and existing allow/deny rules

If the existing Claude settings contain `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, or `CLAUDE_CODE_OAUTH_TOKEN`, the script asks whether
to create a private timestamped backup and replace only conflicting
enterprise-managed credential and routing settings, or cancel without changing
the file. This also safely handles an existing `ANTHROPIC_BASE_URL`. Shell
environment settings are never edited automatically; unset them explicitly and
retry.

Configuration fails without changing the file if a shell environment variable
conflicts, the settings file is unsafe or invalid, or you cancel the conflict
prompt. Resolve the conflict explicitly; do not overwrite organizational policy.

## 6. Inspect the approved models

```bash
/bin/bash "$HOME/.local/share/ccgc/enterprise/ccgc-enterprise-macos.sh" models
```

The command re-verifies the enrollment with LiteLLM and shows:

- the verified GitHub login
- the default model
- all models approved for this employee

The catalog is refreshed from LiteLLM and restricted to models routed through
your own `github-copilot-user` connection. It is not an unrestricted provider
catalog.

## 7. Run the end-to-end doctor

Run this after enrollment, after a client update, or before opening a support
case:

```bash
/bin/bash "$HOME/.local/share/ccgc/enterprise/ccgc-enterprise-macos.sh" doctor
```

The doctor fails closed and reports the first actionable problem. It verifies:

- the minimum supported Claude Code version
- a current personal-key enrollment
- private, user-owned, non-symlink helper/profile/settings files
- absence of conflicting shell and Claude credentials
- the enterprise base URL, model, helper, cache, permissions, and auto-mode settings
- LiteLLM health
- the personal key in macOS Keychain, its LiteLLM owner and employee role, and
  the connected GitHub account
- the per-user `github-copilot-user` route for every approved model, and an
  unchanged model catalog (if it changed, run `configure`)
- the approved model ID and human-readable discovery name
- the Sonnet 5.5 128K output limit
- one real bounded inference response

It never prints the personal key.

## 8. Start Claude

Start Claude normally:

```bash
claude
```

When Claude invokes the `apiKeyHelper`, the helper:

1. validates the private profile and its isolated Keychain reference
2. loads the personal LiteLLM key from macOS Keychain
3. returns it to Claude on standard output

The Keychain service name is derived from the gateway, verified user, and key,
so a failed replacement cannot overwrite another employee's credential.
The key is never written to the profile or Claude settings.

Use `/model` inside Claude Code to select another approved model. Do not add
provider keys or override the LiteLLM gateway URL.

## 9. Claude Desktop

CLI settings do not select Claude Desktop's inference provider; Desktop needs
its own third-party inference configuration. Enrollment and `configure` write
a secret-free import file:

```text
~/.local/share/ccgc/enterprise/desktop-gateway.json
```

It selects Gateway mode with the enrolled LiteLLM URL, bearer authentication,
and model discovery, and uses the installed helper's `token` command as the
credential helper; it contains no key. Import it through Developer > Configure
Third-Party Inference, then relaunch Desktop. When Desktop is installed,
enrollment prints this reminder. `doctor` reports the installed Desktop
version but does not verify Desktop routing.

## 10. Supported and unsupported behavior

Broader Claude Code features (Edit, Bash, subagents, hooks, compaction, image
and PDF input, adaptive thinking) were exercised against earlier gateway
architectures and must be re-verified on the current LiteLLM deployment before
you rely on them. The root README's [Evidence](../../README.md#evidence)
section records what has been verified and at which evidence level.

| Feature | Status | Employee impact |
|---|---|---|
| Explicit fixed-budget thinking | Not supported by the current model | Use adaptive thinking; the current Sonnet model rejects explicit thinking budgets. |
| Advisor | Anthropic API only | Claude Code omits the Advisor server tool when configured with this custom Copilot gateway. |

Auto mode is not the default. Start or select it only under the organization's
normal Claude Code permission policy. Enrollment sets
`CLAUDE_CODE_AUTO_MODE_SERVER=0`, so auto mode uses Claude Code's local
classifier and does not require LiteLLM to emulate Anthropic safeguard
results.

## 11. Keychain behavior

The personal LiteLLM key is stored in macOS Keychain. It is:

- specific to one customer deployment
- bound to the LiteLLM user who connected the enrolled GitHub account
- limited to the approved model catalog and routes
- valid for 90 days, unless revoked earlier
- replaced through a newly issued key; prior keys remain until expiry or revocation
- useless as a GitHub or Copilot credential

Do not export, copy, log, or share the Keychain entry.

If Keychain access fails, confirm that:

- the same macOS user performed enrollment
- Keychain is unlocked
- the `security` command is permitted
- the profile still points to the expected LiteLLM gateway

## 12. Binding changes and revocation

The Actions workflow's `revoke` action removes the employee's LiteLLM user,
keys, and Copilot connection. Personal keys also expire after 90 days.
The employee needs a newly issued key after expiry or revocation.
Routine service updates do not require re-enrollment.

Stop and contact enterprise IT if any of these change unexpectedly:

- GitHub account ID or login
- model catalog
- LiteLLM gateway URL

Do not delete or edit the profile to bypass an identity conflict.

## 13. Troubleshooting

| Symptom | Action |
|---|---|
| Enrollment returns HTTP 401 | Check the key, LiteLLM URL, and whether the key has expired or been revoked; ask IT to issue a new key if needed. |
| Enrollment rejects the GitHub identity | Approve as the exact account named by the script; do not use another person's Copilot seat. |
| Enrollment says the LiteLLM user is connected to a different GitHub account | Contact Enterprise IT; do not approve with another account. |
| GitHub authorization expired | Run `enroll` again with the same key and approve the displayed code promptly. |
| The GitHub account has no GitHub Copilot entitlement | Approve with your own Copilot-entitled account, or ask IT to confirm your Copilot access. |
| `this enrollment is no longer supported` | Ask Enterprise IT for a new personal LiteLLM key and run `enroll` again. |
| `enterprise profile models changed` | Run the installed helper's `configure`, then `doctor`. |
| LiteLLM returns HTTP 401 or 403 | Run `doctor`; ask IT to check key expiry, revocation, and Copilot entitlement. Do not add a provider key. |
| Keychain credential is unavailable | Unlock Keychain and confirm the current macOS user owns the enrollment. |
| Routing conflict | Remove or resolve the reported environment or Claude setting; do not force an overwrite. |
| No models are listed | Ask enterprise IT to verify the employee's approved catalog and account binding. |
| Claude stopped working after an update | Run the installed helper's `doctor`; do not delete credentials or repeat enrollment unless Enterprise IT confirms a lifecycle condition above. |
| A LiteLLM replica or gateway restarts | Run `doctor` and resume only through normal Claude behavior. Never replay an uncertain in-flight inference automatically. |

Useful checks:

```bash
claude --version
bash "$HOME/.local/share/ccgc/enterprise/ccgc-enterprise-macos.sh" models
bash "$HOME/.local/share/ccgc/enterprise/ccgc-enterprise-macos.sh" configure
```

## 14. Security rules

- Use only the employee's own enrolled GitHub account and Copilot seat.
- Never pool, copy, or share your personal key or Copilot credentials.
- Never add an Anthropic, GitHub, or Copilot token to Claude settings.
- Never place the profile or Keychain data in source control or synchronized
  storage.
- Do not enable provider fallback, response caching, inference retries, hooks,
  or payload logging without a separate security review.
- Treat unexpected identity, model, or binding changes as an enterprise IT event.
