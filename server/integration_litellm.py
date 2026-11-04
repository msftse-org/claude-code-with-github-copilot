"""Installed-package contract checks. No real GitHub credentials or network calls."""

from importlib.metadata import version
import os
import tempfile
import unittest
from unittest.mock import Mock, patch


class InstalledProviderTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.dict(os.environ, {
            "LITELLM_LOCAL_MODEL_COST_MAP": "True", "DO_NOT_TRACK": "True",
        }))
        for target in ["socket.getaddrinfo", "socket.socket.connect", "socket.socket.connect_ex"]:
            network = self.enterContext(patch(target, side_effect=AssertionError("Unexpected network access")))
            self.addCleanup(network.assert_not_called)

    def test_native_messages_preserve_sonnet_output_effort(self):
        with tempfile.TemporaryDirectory(prefix="ccgc-litellm-effort-") as state, patch.dict(os.environ, {
            "GITHUB_COPILOT_TOKEN_DIR": state,
        }):
            from litellm.llms.anthropic.common_utils import AnthropicModelInfo
            from litellm.llms.github_copilot.authenticator import Authenticator
            from litellm.llms.github_copilot.messages.transformation import GithubCopilotAnthropicMessagesConfig

            capabilities = {
                "supports_adaptive_thinking": True,
                "supports_legacy_thinking": False,
                "thinking_always_on": False,
            }

            def capability(model, key, custom_llm_provider):
                self.assertEqual(model, "claude-sonnet-5.5")
                self.assertEqual(custom_llm_provider, "github_copilot")
                return capabilities[key]

            self.enterContext(patch.object(AnthropicModelInfo, "_supports_model_capability", side_effect=capability))
            self.enterContext(patch.object(Authenticator, "get_api_base", return_value="https://api.business.githubcopilot.com"))
            authentication = self.enterContext(patch.object(Authenticator, "get_api_key", side_effect=AssertionError("Unexpected authentication")))
            self.addCleanup(authentication.assert_not_called)
            config = GithubCopilotAnthropicMessagesConfig()
            messages = [{"role": "user", "content": "synthetic"}, {"role": "system", "content": "Synthetic instruction"}]
            request = config.transform_anthropic_messages_request(
                model="claude-sonnet-5.5", messages=messages,
                anthropic_messages_optional_request_params={
                    "max_tokens": 128, "thinking": {"type": "disabled"}, "output_config": {"effort": "high"},
                },
                litellm_params=Mock(), headers={},
            )
        self.assertEqual(request["model"], "claude-sonnet-5.5")
        self.assertEqual(request["max_tokens"], 128)
        self.assertEqual(request["messages"], messages)
        self.assertEqual(request["thinking"], {"type": "disabled"})
        self.assertEqual(request["output_config"], {"effort": "high"})

    def test_authentication_errors_do_not_require_a_database(self):
        self.assertEqual(version("prisma"), "0.11.0")
        from litellm.proxy.db.exception_handler import PrismaDBExceptionHandler

        self.assertFalse(PrismaDBExceptionHandler.is_database_service_unavailable_error(
            Exception("No api key passed in."),
        ))

    def test_pinned_package_native_messages_dispatch_and_authentication_boundary(self):
        self.assertEqual(version("litellm"), "1.108.0")
        with tempfile.TemporaryDirectory(prefix="ccgc-litellm-contract-") as state, patch.dict(os.environ, {
            "GITHUB_COPILOT_TOKEN_DIR": state, "LITELLM_LOCAL_MODEL_COST_MAP": "True", "DO_NOT_TRACK": "True",
        }):
            from litellm.llms.github_copilot.messages.transformation import GithubCopilotAnthropicMessagesConfig
            from litellm.types.utils import LlmProviders
            from litellm.utils import ProviderConfigManager

            config = ProviderConfigManager.get_provider_anthropic_messages_config(
                model="github_copilot/claude-sonnet-4.5", provider=LlmProviders.GITHUB_COPILOT,
            )
            self.assertIsInstance(config, GithubCopilotAnthropicMessagesConfig)
            config.authenticator = Mock()
            config.authenticator.get_api_key.return_value = "synthetic-upstream-key"
            config.authenticator.get_api_base.return_value = "https://api.business.githubcopilot.com"
            headers, base = config.validate_anthropic_messages_environment(
                headers={"anthropic-version": "2023-06-01"}, model="claude-sonnet-4.5",
                messages=[{"role": "user", "content": "synthetic"}], optional_params={}, litellm_params={},
                api_key="caller-key-must-not-route", api_base="https://untrusted.invalid",
            )
            self.assertEqual(base, "https://api.business.githubcopilot.com")
            self.assertIn("synthetic-upstream-key", headers["Authorization"])
            self.assertEqual(config.get_complete_url(base, None, "claude-sonnet-4.5", {}, {}), base + "/v1/messages")
            self.assertFalse(config.should_filter_anthropic_beta_headers())
            self.assertFalse(config.handles_web_search_natively())
            self.assertIsNone(ProviderConfigManager.get_provider_anthropic_messages_config(
                model="github_copilot/gpt-fixture", provider=LlmProviders.GITHUB_COPILOT,
            ))

    def test_all_catalog_routes_preserve_exact_native_model_ids(self):
        with tempfile.TemporaryDirectory(prefix="ccgc-litellm-catalog-") as state, patch.dict(os.environ, {
            "GITHUB_COPILOT_TOKEN_DIR": state,
        }):
            from litellm.llms.anthropic.common_utils import AnthropicModelInfo
            from litellm.llms.github_copilot.authenticator import Authenticator
            from litellm.types.utils import LlmProviders
            from litellm.utils import ProviderConfigManager

            self.enterContext(patch.object(AnthropicModelInfo, "_supports_model_capability", return_value=False))
            self.enterContext(patch.object(Authenticator, "get_api_base", return_value="https://api.business.githubcopilot.com"))
            authentication = self.enterContext(patch.object(Authenticator, "get_api_key", side_effect=AssertionError("Unexpected authentication")))
            self.addCleanup(authentication.assert_not_called)
            for model_id in ["claude-sonnet-5.5", "claude-sonnet-5", "claude-opus-5.5",
                             "claude-opus-5", "claude-opus-4.8", "claude-haiku-4.5"]:
                with self.subTest(model=model_id):
                    config = ProviderConfigManager.get_provider_anthropic_messages_config(
                        model="github_copilot/" + model_id, provider=LlmProviders.GITHUB_COPILOT,
                    )
                    self.assertIsNotNone(config)
                    messages = [{"role": "user", "content": "Synthetic route check"}]
                    request = config.transform_anthropic_messages_request(
                        model=model_id, messages=messages,
                        anthropic_messages_optional_request_params={"max_tokens": 128},
                        litellm_params=Mock(), headers={},
                    )
                    self.assertEqual(request["model"], model_id)
                    self.assertEqual(request["messages"], messages)
                    self.assertEqual(request["max_tokens"], 128)


if __name__ == "__main__":
    unittest.main()
