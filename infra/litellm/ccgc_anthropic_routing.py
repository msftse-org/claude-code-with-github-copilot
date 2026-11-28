"""Optional Anthropic routing for employees who sign Claude Code in to claude.ai.

GitHub Copilot stays the default for every request. A request is sent to
Anthropic, on the employee's own claude.ai subscription, only when:

* the employee chose an Anthropic model, named ``ccgc-anthropic/<model>``; or
* the request uses Anthropic's server-side web search tool, and both the
  employee's LiteLLM key and LiteLLM user list ``ccgc-anthropic/<model>``.

Anthropic routes hold no credential. LiteLLM forwards the employee's claude.ai
sign-in to provider ``anthropic`` only, so Anthropic requests can never use a
shared account. A request that needs Anthropic but has no claude.ai sign-in is
rejected with HTTP 400: Claude Code retries HTTP 403 for minutes but reports
HTTP 400 at once. Copilot failures are never retried on Anthropic.
"""

from typing import Any

from fastapi import HTTPException
from litellm._logging import verbose_proxy_logger
from litellm.integrations.custom_logger import CustomLogger

ANTHROPIC_PREFIX = "ccgc-anthropic/"
SERVER_TOOL_PREFIX = "web_search_"


def _metadata(data: dict) -> dict:
    for name in ("litellm_metadata", "metadata"):
        value = data.get(name)
        if isinstance(value, dict) and "used_client_oauth_token" in value:
            return value
    # Fail closed if a LiteLLM upgrade stops reporting the claude.ai sign-in.
    raise HTTPException(status_code=500, detail="LiteLLM did not report whether a claude.ai sign-in was sent.")


def _server_tool(data: dict) -> str | None:
    for tool in data.get("tools") or []:
        tool_type = tool.get("type") if isinstance(tool, dict) else None
        if isinstance(tool_type, str) and tool_type.startswith(SERVER_TOOL_PREFIX):
            return tool_type
    return None


def key_lists(user_api_key_dict: Any, target: str) -> bool:
    """Return True only if the key's own model list names the Anthropic route.

    An empty LiteLLM model list allows every model, so it never turns on
    automatic routing. A team model list, when present, must allow it too.
    """
    if target not in list(getattr(user_api_key_dict, "models", None) or []):
        return False
    team_models = list(getattr(user_api_key_dict, "team_models", None) or [])
    return not getattr(user_api_key_dict, "team_id", None) or not team_models or target in team_models


async def user_lists(user_api_key_dict: Any, target: str) -> bool:
    """Apply LiteLLM's personal-key rule: the employee's user model list must allow the route too.

    LiteLLM checks the user list only for the model the client asked for, so
    without this an older key would keep routing after IT removed the grant.
    """
    user_id = getattr(user_api_key_dict, "user_id", None)
    if not user_id or getattr(user_api_key_dict, "team_id", None):
        return True
    try:
        from litellm.proxy import proxy_server
        from litellm.proxy.auth.auth_checks import get_user_object

        user = await get_user_object(
            user_id=user_id,
            prisma_client=proxy_server.prisma_client,
            user_api_key_cache=proxy_server.user_api_key_cache,
            user_id_upsert=False,
            proxy_logging_obj=proxy_server.proxy_logging_obj,
        )
    except Exception as error:
        # Fail closed: never route on a grant that cannot be checked.
        raise HTTPException(
            status_code=500,
            detail="LiteLLM could not check the employee's Anthropic routing grant. Ask IT to check CCGC employee access.",
        ) from error
    user_models = list(getattr(user, "models", None) or [])
    return not user_models or target in user_models


def _require_sign_in(metadata: dict, model: str, reason: str) -> None:
    if metadata.get("used_client_oauth_token") is not True:
        raise HTTPException(
            status_code=400,
            detail=f"{reason} uses Anthropic model {model}, but Claude Code is not signed in to claude.ai. "
            "Run claude auth login with your Anthropic account, or ask IT to turn off Anthropic routing.",
        )


class AnthropicRouting(CustomLogger):
    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        if call_type != "anthropic_messages":
            return data
        model = data.get("model")
        if not isinstance(model, str):
            return data
        if model.startswith(ANTHROPIC_PREFIX):
            # LiteLLM has already checked that the key may use this model.
            _require_sign_in(_metadata(data), model, "This session")
            return data

        tool = _server_tool(data)
        target = ANTHROPIC_PREFIX + model
        if tool is None or not key_lists(user_api_key_dict, target) or not await user_lists(user_api_key_dict, target):
            return data
        metadata = _metadata(data)
        _require_sign_in(metadata, target, f"Web search ({tool})")
        data["model"] = target
        tags = metadata.get("tags")
        metadata["tags"] = [*(tags if isinstance(tags, list) else []), "ccgc-route:anthropic", f"ccgc-reason:{tool}"]
        verbose_proxy_logger.debug("ccgc routed %s to %s for %s", model, target, tool)
        return data


handler = AnthropicRouting()
