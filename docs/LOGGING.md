# Request and response logging

The administrator feature flag `--store-prompts-in-spend-logs true|false`
controls whether LiteLLM saves model inputs and outputs in PostgreSQL for the
**Logs** page. Usage metadata such as model, tokens, and cost is recorded
independently. This setting is separate from employee onboarding and MCP.

| Value | Behavior |
|---|---|
| `true` | Store content for new requests after running app instances pick up the setting. |
| `false` | Stop future content storage; keep usage metadata and existing logs. |
| Omitted during deployment | Preserve the current policy. New gateways default to content storage off. |

## Find your deployment values

| Value | Meaning and where to find it |
|---|---|
| Azure subscription ID | The ID of the **Azure subscription containing your resources**, not a GitHub/Copilot subscription or Azure tenant ID. Find it under **Subscriptions** in the Azure portal, or run `az account list --output table` while signed in. |
| Deployment prefix | The value supplied to `--prefix` during deployment. The default is `ccgc-pilot`. For example, prefix `ccgc-demo` produces resource group `rg-ccgc-demo-enterprise`. |
| Gateway URL | Your LiteLLM HTTPS address, printed by the deployment script or shown as the Container App's Application URL. Exclude `/ui/` and `/github/mcp`. |
| Secrets file | The existing private JSON file created by deployment on the administrator's computer. The script prints its path. It contains administrator credentials, not an employee's virtual key. |

The default secrets-file path is
`$HOME/.config/ccgc/<Azure-subscription-ID>/<deployment-prefix>.json`.
`$HOME` is your local home folder. **`<prefix>.json` is a filename pattern**:
if the prefix is `ccgc-demo`, the filename is `ccgc-demo.json`. It is not a file
literally named `prefix.json`. If deployment used `--secrets-file`, use that
custom path instead.

Use the existing file from the deployment administrator or private backup.
Do not create a replacement key, use an employee key, or commit this file to Git.

## Change an existing gateway

Open Bash or Zsh in this repository's folder, containing `package.json` and
`scripts/litellm-logging.mjs`. Use Node.js 24. Replace the three uppercase
placeholder values below with your own values, keeping the quotes:

```bash
CCGC_SUBSCRIPTION_ID="YOUR_AZURE_SUBSCRIPTION_ID"
CCGC_DEPLOYMENT_PREFIX="YOUR_DEPLOYMENT_PREFIX"
CCGC_GATEWAY_URL="https://YOUR_LITELLM_HOST"
CCGC_SECRETS_FILE="$HOME/.config/ccgc/$CCGC_SUBSCRIPTION_ID/$CCGC_DEPLOYMENT_PREFIX.json"
```

For a custom secrets-file location, set `CCGC_SECRETS_FILE` to its full path.
In the **same terminal**, check the file exists without displaying its contents,
then enable logging:

```bash
ls -l "$CCGC_SECRETS_FILE"
npm run logging -- \
  --gateway "$CCGC_GATEWAY_URL" \
  --secrets-file "$CCGC_SECRETS_FILE" \
  --store-prompts-in-spend-logs true
```

To disable, rerun the command with `false` instead of `true`. This command
requires an explicit value. It reads the administrator key from the file,
updates the existing gateway, and confirms both settings by reading them back.
It does not redeploy Azure or rotate credentials; rerunning is safe.

Expected confirmation when enabling:

```text
PostgreSQL prompt/response storage enabled; configuration read back successfully.
```

If the command reports that the file is not private, run
`chmod 600 "$CCGC_SECRETS_FILE"` to give only its owner read/write access, then
retry. If it is missing, recover the existing file before proceeding.

## Set the flag during deployment

Append `--store-prompts-in-spend-logs true` or `false` to your existing deployment
command, retaining its subscription, prefix, engine, region, and other options.
Preview without `--confirm-deploy`, then add `--confirm-deploy` to apply. Preview
does not change logging. Both Terraform and Bicep flows support the flag.
See the [deployment procedure](ENTERPRISE.md#deploy-or-update).

To change logging alone, use the existing-gateway command above.

## Verify input and output storage

1. Open your gateway URL with `/ui/` appended and sign in as an administrator.
2. Check **Admin Settings → Logging Settings** for prompt storage.
3. Send a new harmless Claude Code prompt, such as `Reply exactly LOGGING_TEST_OK`.
   This uses a small amount of Copilot allowance.
4. In **Logs**, open that new request and inspect its input and output. Allow
   time for configuration sync across app instances and asynchronous log writes.

Older logs are not backfilled. After disabling, verify a fresh request rather
than an existing log. For native Anthropic requests, input may be stored in
`proxy_server_request` even when `messages` is `{}`; output is in `response`.
Per-key/team logging restrictions can still apply. This feature does not
guarantee capture of every external MCP call.

## Persistence and data handling

The command updates only these fields through LiteLLM's `/config/update` API:

```yaml
general_settings:
  store_model_in_db: true
  store_prompts_in_spend_logs: true # false when disabling content storage
```

The configuration is saved in PostgreSQL and survives container replacement.
Unrelated settings are preserved; model storage stays enabled. No manual YAML
edit is required. The UI changes the same policy: a later explicit CLI value
sets it again, while deployment without the flag leaves it alone. Resolve any
API conflict with a separately managed YAML setting before proceeding.

Content can include source code, personal data, and secrets submitted in prompts.
Limit access to logs, PostgreSQL, and backups, and allow for additional database
storage. Disabling **does not delete existing logs or backups**. Set spend-log
retention separately in LiteLLM Logging Settings; the project's Azure Log
Analytics retention applies to infrastructure logs, not these PostgreSQL rows.
Database backup retention is also separate.

See LiteLLM's [UI logs guide](https://docs.litellm.ai/docs/proxy/ui_logs) and
[spend-log settings](https://docs.litellm.ai/docs/proxy/ui_spend_log_settings).
