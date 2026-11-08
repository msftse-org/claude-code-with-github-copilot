#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { EnterpriseClient, configureEnterprise } from './enterprise-client.ts';
import { BridgeError, object, parseJson, safeError, text } from './protocol.ts';
import { readPrivate } from './private-state.ts';

const help = `ccgc enterprise - enterprise client profile

  ccgc-enterprise login --gateway https://private-gateway --audience api://APP-ID
  ccgc-enterprise login-api-key --gateway https://private-gateway --api-key-file /private/key.json
  ccgc-enterprise login-litellm-key --gateway https://litellm-gateway --api-key-file /private/key.json
  ccgc-enterprise configure [--apply]
  ccgc-enterprise token
  ccgc-enterprise models

The token command is the Claude apiKeyHelper. Direct LiteLLM virtual keys are
returned unchanged from macOS Keychain. Legacy Entra and CCGC API-key profiles
continue to use bounded admissions during migration.
`;

async function main(argv = process.argv.slice(2)): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      gateway: { type: 'string' },
      audience: { type: 'string' },
      'api-key-file': { type: 'string' },
      apply: { type: 'boolean' },
    },
  });
  if (values.help || !positionals.length) { console.log(help); return; }
  const command = positionals[0];
  if (positionals.length !== 1 || !['login', 'login-api-key', 'login-litellm-key', 'configure', 'token', 'models'].includes(command ?? '')) {
    throw new BridgeError('INVALID_OPTIONS', 'Unknown enterprise command.');
  }
  const client = new EnterpriseClient();
  if (command === 'login') {
    if (!values.gateway || !values.audience || values['api-key-file'] || values.apply) {
      throw new BridgeError('INVALID_OPTIONS', 'login requires --gateway and --audience.');
    }
    console.log(JSON.stringify(await client.login(values.gateway, values.audience), null, 2));
    return;
  }
  if (command === 'login-api-key') {
    if (!values.gateway || !values['api-key-file'] || values.audience || values.apply) {
      throw new BridgeError('INVALID_OPTIONS', 'login-api-key requires --gateway and --api-key-file.');
    }
    const input = object(parseJson(await readPrivate(values['api-key-file'])));
    console.log(JSON.stringify(await client.loginApiKey(values.gateway, text(input.apiKey, 'enterprise API key')), null, 2));
    return;
  }
  if (command === 'login-litellm-key') {
    if (!values.gateway || !values['api-key-file'] || values.audience || values.apply) {
      throw new BridgeError('INVALID_OPTIONS', 'login-litellm-key requires --gateway and --api-key-file.');
    }
    const input = object(parseJson(await readPrivate(values['api-key-file'])));
    console.log(JSON.stringify(
      await client.loginLiteLLMKey(values.gateway, text(input.apiKey, 'LiteLLM virtual key')),
      null,
      2,
    ));
    return;
  }
  if (values.gateway || values.audience || values['api-key-file'] || (command !== 'configure' && values.apply)) {
    throw new BridgeError('INVALID_OPTIONS', 'Options do not apply to this enterprise command.');
  }
  if (command === 'token') {
    console.log(await client.token());
    return;
  }
  if (command === 'models') {
    const value = await client.load();
    console.log(JSON.stringify({
      default: value.models[0],
      models: value.models,
      ...(value.bindingRevision ? { bindingRevision: value.bindingRevision } : {}),
    }, null, 2));
    return;
  }
  console.log(JSON.stringify(await configureEnterprise(await client.load(), values.apply ?? false), null, 2));
}

main().catch(error => {
  const failure = safeError(error);
  console.error(`${failure.code}: ${failure.message}`);
  process.exitCode = 1;
});
