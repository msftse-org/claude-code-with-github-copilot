# Enterprise Mac setup and operation

This guide covers standalone macOS enrollment with a personal LiteLLM key.
Claude Code calls the enterprise LiteLLM gateway directly with that key, and
LiteLLM serves each request through the employee's own GitHub Copilot
connection. Employees get a key and a setup file from Enterprise IT, run the
file, paste the key, and approve GitHub in the browser that opens
automatically. No checkout, Node.js, npm, or LiteLLM dashboard login is
required. See also the [root README](../../README.md#getting-started).
Enrollment and `configure` also update an installed Desktop's local Gateway
profile. Restart Desktop after configuration changes.

## What is installed or stored on the Mac

| Item | What it does | Required action |
|---|---|---|
| Official Claude Code `2.1.296` or newer | Provides the unchanged coding interface and runs local Read, Edit, Bash, and permission decisions. | Install and verify the minimum supported version. |
| Enterprise CCGC helper | Shell-based self-enrollment client and Claude `apiKeyHelper`. | Keep the installed private script at its stable path. |
| Personal LiteLLM key in macOS Keychain | Authenticates that employee's inference requests directly for up to 90 days. | Use a newly issued key for renewal. |
| `~/.claude/settings.json` | Routes Claude to LiteLLM and installs the Keychain credential helper. | Enrollment backs up configuration from another setup and starts clean; `configure` resets only conflicting routing. |
| Enterprise profile | Stores the gateway, verified LiteLLM/GitHub identity, credential reference, and model catalog; no secrets. | Let the helper create it; do not hand-edit it. |
| `desktop-gateway.json` | Secret-free copy of Desktop's Gateway configuration. | The script applies it to the local Desktop profile; restart Desktop afterward. |

GitHub OAuth and Copilot tokens do not belong on the Mac. LiteLLM encrypts the
GitHub connection in its private PostgreSQL schema. The employee's personal
LiteLLM key is saved in macOS Keychain.

## 1. Get your personal key and the setup file

Required:

- macOS
- Official Claude Code `2.1.296` or newer
- Your own GitHub account with GitHub Copilot access
- The setup file `ccgc-enterprise-setup.command` and your 90-day personal key
  from Enterprise IT

Enterprise IT issues the key with the `CCGC employee access` GitHub Actions
workflow (`enroll` action). The workflow creates or reuses your LiteLLM user
and a new 90-day key. Its protected run summary shows the key, its expiry, the
approved models, and your setup command, and attaches the setup file built
for your organization's gateway.
Anyone who can read that workflow run can use the key until it expires or is
revoked, so IT keeps repository read access limited and sends the key only
through an approved private channel.

The setup file is the repository's `scripts/ccgc-enterprise-macos.sh` with
your organization's LiteLLM URL built in, so you run it without options. IT
builds it as described in the
[enterprise runbook](../ENTERPRISE.md#employee-setup-file) and publishes its
SHA-256 checksum. Accept the file only through a channel IT approves, not
from an unverified source or fork. Save it in Downloads, then check it:

```bash
shasum -a 256 "$HOME/Downloads/ccgc-enterprise-setup.command"
claude --version
/bin/bash "$HOME/Downloads/ccgc-enterprise-setup.command" help
```

Compare the checksum with the one from IT before enrollment.

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

Run the setup file:

```bash
bash "$HOME/Downloads/ccgc-enterprise-setup.command"
```

Run it with `bash` as shown. Double-clicking a downloaded file can be blocked
by Gatekeeper, and a file extracted from the workflow artifact is not
executable. If IT gave you the generic repository script instead, pass the
LiteLLM HTTPS origin, without a path:
`bash ccgc-enterprise-macos.sh enroll --gateway https://LITELLM_HOST`.
Without a gateway, the script stops before asking for your key.

1. The script checks the Claude Code version and your existing Claude
   configuration. A conflicting shell environment variable stops enrollment;
   unset it and retry. If `~/.claude/settings.json` or Claude Desktop's
   gateway profiles contain anything from another setup, for example another
   gateway URL, virtual key, `apiKeyHelper`, model override, or extra
   environment settings, the script lists them and asks once, before the key
   is used, whether to back them up and start from scratch after
   verification, or cancel. Cancelling changes nothing. See
   [Fresh start and backups](#fresh-start-and-backups).
2. Paste your personal key from the enrollment workflow when prompted, not
   the LiteLLM administrator/master key. Input is hidden, and the key does
   not go into shell history.
3. The script checks LiteLLM readiness and its database connection, the key
   owner, the employee role, the key expiry, and the Claude models available
   to the key.
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
   configures Claude Code, and applies the Desktop Gateway configuration
   when Desktop is installed. Replaced configuration is backed up privately
   and the backup paths are printed.

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

Enrollment configures Claude automatically. To reapply the enterprise
configuration later, run:

```bash
/bin/bash "$HOME/.local/share/ccgc/enterprise/ccgc-enterprise-macos.sh" configure
```

This re-verifies the enrollment with LiteLLM, refreshes the approved model
catalog in the profile, rewrites `desktop-gateway.json`, applies the local
Desktop Gateway configuration, and updates
`~/.claude/settings.json`. The settings update:

- sets the enrolled LiteLLM gateway as `ANTHROPIC_BASE_URL`
- configures the default approved model
- enables gateway model discovery
- installs the enterprise `apiKeyHelper`
- sets a one-minute helper cache
- preserves an existing permission default, or uses `manual` when none is set
- sets `CLAUDE_CODE_AUTO_MODE_SERVER=0`, allowing opt-in auto mode to use
  Claude Code's local classifier instead of Anthropic-only server safeguards
- preserves personal Claude settings added after enrollment, such as plugins,
  hooks, and allow/deny rules

### Fresh start and backups

`enroll` and `configure` never merge routing from another setup into the
enterprise configuration. When they find it, they list what was found and ask
once:

```text
Existing Claude configuration from another setup was found:
  - Claude Code settings (~/.claude/settings.json)
  - Claude Desktop gateway profiles
...
  1. After gateway verification, back up this configuration and start from scratch.
  2. Cancel without using the LiteLLM key or changing Claude configuration.
Enter 1 or 2:
```

`configure` shows the same list with a shorter choice, because the key is
already enrolled.

| Command | What triggers a fresh start | What is kept |
|---|---|---|
| `enroll` | Anything in `~/.claude/settings.json` besides the enterprise settings, an invalid settings file, or a Desktop gateway profile that differs from the enterprise profile | Nothing outside the backup; re-add personal settings from it if needed |
| `configure` | Conflicting routing only: another gateway URL, credential, virtual key, `apiKeyHelper`, model override, unknown environment setting, an invalid settings file, or Desktop `apiKey`, OIDC, custom headers, or another gateway | Personal settings such as plugins, hooks, permission rules, and unrelated Desktop preferences |

Claude conversations, `~/.claude.json` (including MCP servers), and Desktop app
preferences are never reset.

With option `1`, the script verifies the gateway and key first, then:

- copies the old Claude Code settings to a private (`0600`) backup at
  `~/.claude/settings.json.ccgc-backup.<UTC timestamp>.<random>`
- copies the old Desktop gateway profiles to a private directory at
  `~/Library/Application Support/Claude-3p/configLibrary.ccgc-backup.<UTC timestamp>.<random>/`
- writes a clean enterprise `settings.json` and a single active Desktop
  profile named `GitHub Copilot via LiteLLM`, and removes the old profiles
- prints both backup paths

Option `2`, an empty answer, or any other input cancels without using the
key or changing any file. Shell environment variables are never edited
automatically; unset conflicting ones, such as `ANTHROPIC_AUTH_TOKEN`, in
`~/.zshrc` or `~/.bash_profile`, open a new terminal, and retry.

The script still refuses to proceed if the settings file is a symlink, is not
a regular file, or is not owned by the current user, and it never overrides
managed policy.

To restore a previous configuration, quit Claude, then copy the backup back:

```bash
cp -p "$HOME/.claude/settings.json.ccgc-backup.<timestamp>.<random>" "$HOME/.claude/settings.json"
```

For Desktop, copy the needed profile files from the
`configLibrary.ccgc-backup.*` directory back into
`~/Library/Application Support/Claude-3p/configLibrary/`. Restoring
another setup's routing disconnects Claude from the enterprise gateway until
`configure` runs again.

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
- absence of conflicting shell and Claude credentials, model overrides, and
  other leftover routing settings (if found, run `configure` to back them up
  and start from scratch)
- the enterprise base URL, model, helper, cache, permissions, and auto-mode settings
- LiteLLM health
- the personal key in macOS Keychain, its LiteLLM owner and employee role, and
  the connected GitHub account
- the per-user `github-copilot-user` route for every approved model, and an
  unchanged model catalog (if it changed, run `configure`)
- the approved model ID and human-readable discovery name
- the Sonnet 5.5 128K output limit
- one real bounded inference response
- Desktop's saved gateway, credential helper, discovery setting, and local
  third-party mode when Desktop is installed

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
its own third-party inference configuration. Enrollment and `configure`
automatically update its active local profile under
`~/Library/Application Support/Claude-3p/configLibrary/`. A fresh installation
gets a new profile. Profiles from another setup are backed up and replaced as
described in [Fresh start and backups](#fresh-start-and-backups); unrelated
Desktop preferences are retained, and changed files get private
`.ccgc-backup.*` copies. A secret-free copy is also kept:

```text
~/.local/share/ccgc/enterprise/desktop-gateway.json
```

It selects Gateway mode with the enrolled LiteLLM URL, bearer authentication,
and model discovery, and uses the installed helper's `token` command as the
credential helper; it contains no key. Quit and reopen Desktop after the script
finishes. No manual import, replacement key, or repeat GitHub approval is needed
for this configuration update. The script does not forcibly close active sessions.

The script refuses to override managed policy or remote/bootstrap configuration;
IT must update those through the existing management channel. It also rejects
unsafe paths and invalid configuration rather than replacing them blindly.
`doctor` detects stale saved Desktop URLs and helpers, but does not claim that a
running Desktop process has reloaded them or that Desktop-specific features work.

## 10. Supported and unsupported behavior

Feature support depends on the Claude Code version and the models enabled
for your Copilot account. Enrollment and `doctor` verify discovery and a
bounded inference request, not every client feature. See the root README's
[Compatibility](../../README.md#compatibility) section and verify the
workflows you need in your environment.

| Feature | Status | Employee impact |
|---|---|---|
| Explicit fixed-budget thinking | Model-dependent | Use adaptive thinking for models that reject explicit thinking budgets. |
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
| Desktop cannot load the organization's model list | Run the updated script's `configure` command, then quit and reopen Desktop. It replaces stale local gateway URLs and retired credential-helper paths without re-enrollment. If policy is managed, contact IT. |
| LiteLLM health check fails | Ask IT to check gateway reachability and confirm `/health/readiness` reports `status: healthy` and `db: connected`. A gateway health failure does not require a new personal key. |
| `the supplied LiteLLM key has expired` | The personal key passed its expiry. Ask IT to run the enrollment workflow again and use the new key. |
| `the supplied LiteLLM key was rejected (revoked, blocked, or mistyped)` | Re-copy the key from the workflow summary without extra characters. If it still fails, the key was revoked; ask IT for a new one. |
| `the supplied key is not a personal employee key` | The administrator (master) key was entered. Use only the personal key from the enrollment workflow summary. |
| Enrollment rejects the GitHub identity | Approve as the exact account named by the script; do not use another person's Copilot seat. |
| Enrollment says the LiteLLM user is connected to a different GitHub account | Contact Enterprise IT; do not approve with another account. |
| GitHub authorization expired | Run `enroll` again with the same key and approve the displayed code promptly. |
| The GitHub account has no GitHub Copilot entitlement | Approve with your own Copilot-entitled account, or ask IT to confirm your Copilot access. |
| `this enrollment is no longer supported` | Ask Enterprise IT for a new personal LiteLLM key and run `enroll` again. |
| `enterprise profile models changed` | Run the installed helper's `configure`, then `doctor`. |
| LiteLLM returns HTTP 401 or 403 | Run `doctor`; ask IT to check key expiry, revocation, and Copilot entitlement. Do not add a provider key. |
| Keychain credential is unavailable | Unlock Keychain and confirm the current macOS user owns the enrollment. |
| Routing conflict in the shell environment | Unset the reported variable in your shell startup file, open a new terminal, and retry. |
| Old settings, a virtual key, or another gateway remain after setup | Run the installed helper's `configure` and choose `1` to back them up and start from scratch, then run `doctor`. |
| `Claude settings contain ... from another setup` | Run `configure` and choose `1`; the previous settings are backed up first. |
| `setup cancelled; the LiteLLM key and Claude configuration were not changed` | Nothing was changed. Run the command again and choose `1` when ready. |
| `model_not_supported` for one model while others work | The employee's GitHub Copilot plan or organization policy does not enable that model. Enable it in Copilot settings or policies, or select another approved model with `/model`. |
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

## GitHub web search

Every enrollment includes GitHub MCP web search. Setup reuses GitHub CLI (`gh`) or installs a verified official copy for your user automatically. A matching existing GitHub CLI login is reused; otherwise setup starts a separate GitHub CLI sign-in. If setup stops, rerun the same file: completed installation and logins are reused, and successful enrollment requires both inference and MCP verification. See [GitHub MCP setup](../GITHUB-MCP.md). Restart Claude Code and check `/mcp` after setup.
