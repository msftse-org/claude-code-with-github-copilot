# Gateway model operations

Use this guide to add an approved Claude model to a running LiteLLM gateway,
make it available to an employee, and verify it from the employee's client.
The standard deployment routes Claude requests to each employee's own
GitHub Copilot seat.

## Add a Copilot model

1. Check `GET /health/readiness` for a healthy gateway and connected
   PostgreSQL. Confirm the exact model ID and supported endpoints for the
   intended users. Availability depends on their Copilot plan and organization
   policy. Claude Desktop and Claude Code use the Anthropic Messages API.
   [GitHub catalog](https://docs.github.com/en/copilot/reference/ai-models/supported-models) ·
   [LiteLLM Copilot provider](https://docs.litellm.ai/docs/providers/github_copilot)
2. In **Models + Endpoints**, add a GitHub Copilot model using the existing
   `github-copilot-user` credential. Use the exact Copilot model ID as the public
   routing name, with the `claude-` prefix and the original spelling. The
   installer checks both the upstream ID and the per-user credential binding.
3. Read the route back with `GET /model/info` and check that it appears in
   `GET /v1/models`. Allow the gateway replicas time to pick up database changes.

The equivalent administrator request is `POST /model/new`. For example, a
gateway missing Sonnet 5.5 would use this body.

```json
{
  "model_name": "claude-sonnet-5.5",
  "litellm_params": {
    "model": "github_copilot/claude-sonnet-5.5",
    "custom_llm_provider": "github_copilot",
    "litellm_credential_name": "github-copilot-user"
  }
}
```

Check for an existing route before creating one. On deployment,
[`--models`](ENTERPRISE.md#deploy-or-update) selects which Copilot routes the
[bootstrap](../scripts/litellm-bootstrap.mjs) ensures. Bootstrap adds missing
routes and rejects conflicting provider bindings. On a running deployment,
the [Model Management API](https://docs.litellm.ai/docs/proxy/model_management)
persists changes to PostgreSQL.

## Grant access and verify discovery

1. For an existing employee with scoped model access, add the route to the
   LiteLLM user in **Internal Users** and to the specific application key in
   **Virtual Keys**. The corresponding API operations are `POST /user/update`
   and `POST /key/update`. Each update takes the complete intended model
   list, including existing approved entries. The user and the key have
   separate allowlists. Update the key the application actually uses.
2. With the employee key, check `GET /v1/models` and `GET /v1/model/info`.
   Confirm that the key's owner has connected the expected GitHub account
   under **LLM Credentials**. Send a small `POST /v1/messages` request with
   the exact model ID. A discovery result confirms visibility. A successful
   response confirms that the connected account can run the model.
3. The installer enables gateway discovery in Claude Code and Desktop. On an
   enrolled Mac, run the installed helper's `models` command to inspect the
   approved catalog. Run `configure` if the saved profile needs a refresh,
   then relaunch Claude. [Employee Mac guide](mac/README.md#6-inspect-the-approved-models)

For example, test Sonnet 5.5 with this Messages request body.

```json
{
  "model": "claude-sonnet-5.5",
  "max_tokens": 32,
  "messages": [{"role": "user", "content": "Reply with OK."}]
}
```

Enrollment and renewal populate access from the gateway's current `claude-`
catalog. Keep manually scoped pilot access separate from that workflow.

In the dashboard, **Your Models → Personal** uses the browser sign-in's scope.
If it shows an earlier subset after an access update, sign out and sign back in.
LiteLLM can copy the user's allowlist into the dashboard session key when it
issues that key. Claude Desktop queries discovery with its own application key.
[LiteLLM session key creation](https://github.com/BerriAI/litellm/blob/v1.109.1/litellm/proxy/management_endpoints/key_management_endpoints.py#L5483-L5492)

## Evaluate subscription-to-Copilot failover

Provider failover requires a separate security review under the
[employee security rules](mac/README.md#14-security-rules). Evaluate it with a
scoped pilot key and the key owner's existing per-user Copilot connection.
An Anthropic subscription primary requires the caller's Claude OAuth session.
LiteLLM authenticates the pilot key in `x-litellm-api-key` and uses the
client's OAuth token in `Authorization` for the Anthropic request. The
standard Desktop Gateway profile supplies a LiteLLM bearer key, so a pilot
route selected in that profile may go straight to its Copilot fallback after
the Anthropic authentication attempt fails.
[LiteLLM subscription setup](https://docs.litellm.ai/docs/tutorials/claude_code_max_subscription)

1. Register an approved direct Anthropic primary under a separate routing
   name such as `anth-sonnet-seat`, backed by `anthropic/claude-sonnet-5-5`.
   Keep the existing `claude-sonnet-5.5` Copilot route and its binding. The
   enrollment workflow selects `claude-` routing names, and the installer
   requires each selected route to use the matching Copilot model and
   `github-copilot-user` credential. For a clearer Desktop picker, set
   `model_info.display_name` on the pilot route and choose distinct labels
   when both routes are visible. Routing, key permissions, and fallback
   rules use model IDs. [Claude Desktop discovery](https://claude.com/docs/third-party/claude-desktop/gateway#models)
2. Grant the pilot user and key access to the primary and its backup.
   Test the backup directly with the pilot key on `/v1/messages`. Choose
   the same model when the connected Copilot account supports it. For a
   model without an equivalent, select an approved, tested substitute.
   Keep per-user model access checks enabled for fallback targets.
3. Use the gateway's fallback settings or `POST /fallback` to save a
   general fallback for that primary. Repeat for each approved primary.
   Record any previous rule first.

```json
{
  "model": "anth-sonnet-seat",
  "fallback_models": ["claude-sonnet-5.5"],
  "fallback_type": "general"
}
```

Read each rule back with `GET /fallback/<primary>`. Use a pilot-only test to
exercise primary failure without interrupting the gateway. For example, send a
short Messages request with the pilot key alone to test the missing-OAuth
case on a primary that requires client OAuth. Check for a successful response,
a positive `x-litellm-attempted-fallbacks` count, and the expected Copilot
deployment ID in `x-litellm-model-id`. Also test a streaming request if Desktop
will use the route. Test successful primary inference separately with an
authorized Claude subscription session.

To roll back, restore the prior rule with `POST /fallback`, or remove a newly
added general rule with `DELETE /fallback/<primary>`. Verify routing with the
same pilot key after the change.
[LiteLLM fallback behavior](https://docs.litellm.ai/docs/proxy/reliability) ·
[Fallback Management API in v1.109.1](https://github.com/BerriAI/litellm/blob/v1.109.1/litellm/proxy/management_endpoints/fallback_management_endpoints.py)
