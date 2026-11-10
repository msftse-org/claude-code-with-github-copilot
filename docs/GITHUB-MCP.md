# GitHub web search through LiteLLM

Every employee enrollment includes GitHub's read-only `web_search` MCP tool
through the existing LiteLLM gateway. Model requests continue using the employee's
personal LiteLLM key and Copilot connection. No shared GitHub credential is used.

## Administrator setup

Run **Actions → CCGC employee access → enroll** with the employee's GitHub
username. The workflow registers MCP server `ccgc-github-web-search` with alias
`github`, pointing to `https://api.githubcopilot.com/mcp/readonly`. It restricts
the GitHub toolset and LiteLLM tool allowlist to `web_search`.

Each new employee key receives only this MCP server and tool, alongside the
existing model restrictions, 90-day expiry, and per-user Copilot connection.
The routes `/github/mcp`, `/mcp`, and `/mcp/` are required because LiteLLM
canonicalizes the named route during authorization. Server and tool permissions
still restrict access. A conflicting existing registration stops enrollment for
administrator review; other keys gain no MCP access automatically.

### Upgrade existing employee keys

Before distributing an updated installer to existing employees:

1. Register the restricted server using `ensureGitHubMcp` from
   `scripts/github-mcp.mjs`, or run the employee-access enrollment workflow.
2. For keys you are retaining, use LiteLLM `/key/update` to add:
   - `/github/mcp`, `/mcp`, and `/mcp/` to `allowed_routes`.
   - `ccgc-github-web-search` to `object_permission.mcp_servers`.
   - `web_search` to
     `object_permission.mcp_tool_permissions["ccgc-github-web-search"]`.
   Preserve existing routes, object permissions, expiry, and model policy.
3. Distribute the updated installer. Already enrolled employees can run
   `bash /path/to/updated-setup.command configure` to install the helper and
   refresh their configuration without repeating Copilot authorization.

An old key without these grants fails MCP verification. Keep administrator
credentials out of employee configuration.

## Employee onboarding and recovery

Use Claude Code 2.1.296 or later and run the generated setup file. Setup reuses
GitHub CLI (`gh`) or installs the official pinned release for Apple Silicon or
Intel under `~/.local/share/ccgc/enterprise/bin/gh`. The archive's SHA-256 is
verified before installation; Homebrew and administrator access are not required.

Setup reuses a matching GitHub CLI login or starts browser sign-in. The GitHub
account must match the enrolled employee. GitHub CLI and Copilot use **separate
OAuth authorizations**, so a new workstation can require both. Subsequent MCP
connections retrieve the current GitHub CLI token automatically; revoked
credentials or organization policies may require signing in again.

If setup stops, rerun the same file with the same unexpired personal key.
Completed installation, GitHub login, and Copilot authorization are reused.
Incomplete authorization may require a new device code. Setup verifies inference
and MCP before installing staged client configuration. Rerunning completed
setup preserves personal preferences and avoids duplicate permission entries.

## Client configuration and verification

The installer keeps model traffic on LiteLLM and merges a `github` MCP server
into `~/.claude.json` with URL `https://YOUR_GATEWAY/github/mcp` and the installed
helper's `mcp-headers` command. It preserves other servers and settings, and
backs up changed configuration privately.

At connection time, the helper validates the destination and GitHub account,
then supplies the personal LiteLLM key and GitHub CLI token through
`x-litellm-api-key` and `x-mcp-github-authorization`. Tokens are not written into
Claude JSON files. The server's `auth_type: none` means no shared upstream
credential; LiteLLM still checks the personal key and GitHub validates its token.
Do not run `mcp-headers` manually: its output contains credentials for the client.

The installer allows `mcp__github__github-web_search` and denies native
`WebSearch` in Claude's permissions. Models that support tool use can select
this tool when appropriate; configuration does not force a search on every
request. Other permission rules and consent settings are preserved.

Restart Claude Code, check `/mcp`, and ask it to search for a public source.
The installed helper's `doctor` command verifies inference and that MCP exposes
exactly `github-web_search`; a successful model response alone does not verify
web search. This integration configures Claude Code; Desktop MCP is unverified.

References: [LiteLLM client credentials](https://docs.litellm.ai/docs/mcp#using-your-mcp-with-client-side-credentials),
[Claude Code dynamic headers](https://code.claude.com/docs/en/mcp#use-dynamic-headers-for-custom-authentication),
[GitHub MCP server](https://github.com/github/github-mcp-server).
