# Claude Code with GitHub Copilot

Run the **official Claude Code CLI** with Claude models provided by **your own
GitHub Copilot seat**.

```text
Claude Code on your Mac
        |
        | HTTPS
        v
Admission gateway -> LiteLLM -> GitHub Copilot -> Anthropic Models
```

Claude Code remains unchanged. It reads and edits files and runs commands on
your Mac. The remote services only authenticate the session and carry model
requests to GitHub Copilot.

> [!WARNING]
> This is an experimental, unofficial integration. It uses GitHub Copilot
> endpoints through LiteLLM and is not endorsed by GitHub or Anthropic. Confirm
> that your account and organization permit this use.

## What is available

| Part | Status |
|---|---|
| Single-user Azure setup | Deployed and tested |
| Claude Code on macOS | Configured and tested |
| Model discovery and switching | Tested with the current Copilot catalog |
| Automated deployment and recovery | Implemented and tested locally |
| Multi-user enterprise foundation | Implemented, but not deployed |

The current Azure test gateway is:

`https://ccgc-dev-87b7.swedencentral.cloudapp.azure.com`

The Azure VM continues to incur charges while it is running.

## Why both the gateway and LiteLLM are needed

They have different jobs:

- **Admission gateway:** protects the public endpoint, checks credentials,
  limits sessions, prevents replay, validates conversation continuity, and
  enforces the approved model catalog.
- **LiteLLM:** signs in to GitHub Copilot, refreshes Copilot tokens, discovers
  entitled Claude models, and translates Anthropic Messages traffic to the
  Copilot service.

API Management is not used. It was removed because it did not replace either
of these required functions.

## Current deployed components

### On Azure

- One Linux VM
- Defender JIT access for temporary, source-restricted SSH

| Component | What it is | Why we need it |
|---|---|---|
| [Caddy](https://github.com/caddyserver/caddy) | Third-party open-source HTTPS server and reverse proxy. | Provides automatic TLS and exposes one secure public endpoint without publishing the internal services. |
| Node.js admission gateway | Project-developed TypeScript/Node.js service. | Authenticates the Mac client, creates bounded sessions, enforces the approved model catalog, and protects request history from replay or divergence. |
| [LiteLLM Copilot connector](https://github.com/BerriAI/litellm) | Third-party open-source model gateway. | Handles GitHub device authorization, Copilot token refresh, model discovery, and Anthropic Messages transport to the user's Copilot seat. |
| Private Docker state | Deployment-owned private Docker volume, not an external hosted service. | Keeps the account binding, Copilot token cache, gateway credentials, and approved model catalog across container restarts without storing them in Git or images. |

Only Caddy exposes public ports. The gateway and LiteLLM stay on private Docker
networks.

### On the Mac

- Official Claude Code `2.1.284`
- The `ccgc` command-line helper
- A gateway renewal credential stored in macOS Keychain
- `~/.claude/settings.json` pointing Claude Code to the Azure gateway
- A non-secret local profile containing the approved account and model metadata

GitHub and Copilot credentials remain on the Azure host.

## Models

The latest verified Copilot catalog contains:

- Claude Haiku 4.5
- Claude Haiku 5.5
- Claude Sonnet 5
- Claude Sonnet 5.5

Claude Sonnet 5.5 is the default.

List the models currently approved by the gateway:

```bash
node src/cli.ts models
```

Start Claude normally:

```bash
claude
```

Use Claude Code's `/model` command to switch models. Do not use a command-line
`--model` override because the credential helper intentionally rejects routing
that conflicts with the approved gateway configuration.

If Claude reports `ADMISSION_REQUIRED` with HTTP 410, the previous bounded
session expired or was lost. Create and verify a fresh admission:

```bash
node src/cli.ts doctor --live --accept-unofficial
```

## Install the development tools

Requirements:

- macOS
- Node.js 24
- npm
- Official Claude Code `2.1.284`

```bash
npm ci
npm run check
npm test
node src/cli.ts version
```

## Connect a Mac to a gateway

The operator provides a gateway renewal key. Pass it through standard input;
do not place it in source code, command arguments, shell history, or chat.

```bash
node src/cli.ts login \
  --gateway https://gateway.example.com \
  --accept-unofficial < /protected/owner-key

node src/cli.ts configure
node src/cli.ts configure --apply
node src/cli.ts doctor --remote
node src/cli.ts doctor --live --accept-unofficial
claude
```

What these commands do:

- `login` verifies the gateway and stores its renewal key in macOS Keychain.
- `configure` previews the Claude settings change.
- `configure --apply` applies the reviewed settings.
- `doctor --remote` checks the gateway without inference.
- `doctor --live` runs a small isolated Claude probe and may consume Copilot
  allowance.

## Automated Azure deployment

The deployment coordinator supports Bicep and Terraform:

```bash
python3 server/deploy.py plan \
  --config "$HOME/.config/ccgc/deployment.json"
```

After reviewing the generated plan and cost impact:

```bash
python3 server/deploy.py up \
  --config "$HOME/.config/ccgc/deployment.json" \
  --approve-plan REPLACE_WITH_PLAN_SHA256 \
  --approve-access \
  --accept-unofficial \
  --approve-client \
  --approve-live
```

Automation covers:

1. Azure infrastructure provisioning
2. Defender JIT SSH access and host identity verification
3. Container build and startup
4. GitHub account and Copilot catalog binding
5. Mac enrollment and Claude settings
6. Live Read/Edit/Bash checks through every approved model
7. Creation of a clean foreground admission

Human approval is still required for infrastructure cost, GitHub browser
authorization, client changes, catalog changes, and live inference.

See [docs/AUTOMATION.md](docs/AUTOMATION.md) for the complete runbook.

## Recover a stopped deployment

```bash
python3 server/deploy.py recover \
  --config "$HOME/.config/ccgc/deployment.json" \
  --approve-access \
  --approve-start \
  --accept-unofficial \
  --approve-client \
  --approve-live
```

Recovery can start the VM, renew JIT access, restart services, synchronize the
Mac, and create a fresh admission.

If the Copilot model catalog changed, recovery stops and writes
`catalog-preview.json`. Review it, then rerun recovery with the exact displayed
hash:

```bash
--approve-catalog REPLACE_WITH_CATALOG_SHA256
```

The coordinator never silently changes account identity or chooses a fallback
model.

## Enterprise solution

The repository also contains a multi-user enterprise foundation:

```text
Employee Claude Code
        |
        v
Entra-authenticated broker
        |
        v
Isolated per-user worker
        |
        v
LiteLLM -> employee's own Copilot seat -> Claude
```

Each employee uses their own Copilot seat. Credentials, sessions, quotas, and
worker state are not shared.

The foundation includes:

- Microsoft Entra authentication
- Azure Container Apps
- PostgreSQL admission and dispatch fencing
- Key Vault worker records
- Private Azure Container Registry
- Per-user worker isolation
- Azure Monitor and Application Insights metadata

It is implemented and locally validated, but **not deployed**. Deployment still
requires Entra registration, PostgreSQL setup, private signed images, user
onboarding, isolation/load/revocation testing, and cost approval.

See [docs/ENTERPRISE.md](docs/ENTERPRISE.md) for the release gates.

## Architecture poster

![Enterprise architecture](docs/diagrams/ccgc-enterprise-runtime-flare-v2.png)

Diagram sources and generation receipts are in
[docs/diagrams](docs/diagrams/README.md).

## Important limits

- One foreground Claude session per admission
- No shared Copilot account or credential pooling
- No provider fallback
- No response cache
- No automatic inference retry
- No prompt or response body logging
- No automatic acceptance of account or catalog changes
- Images, documents, compaction, background agents, and cross-admission resume
  are not yet fully verified

## More documentation

| Document | Purpose |
|---|---|
| [docs/AUTOMATION.md](docs/AUTOMATION.md) | Automated deployment and recovery |
| [docs/README.md](docs/README.md) | Detailed single-user operator runbook |
| [docs/AZURE.md](docs/AZURE.md) | Current Azure proof deployment |
| [docs/ENTERPRISE.md](docs/ENTERPRISE.md) | Enterprise architecture and release gates |
| [docs/PRD.md](docs/PRD.md) | Detailed product and security contract |
| [docs/diagrams/README.md](docs/diagrams/README.md) | Diagram sources and provenance |
