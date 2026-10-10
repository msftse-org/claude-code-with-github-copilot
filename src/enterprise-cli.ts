#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { EnterpriseClient, configureEnterprise } from './enterprise-client.ts';
import { BridgeError, safeError } from './protocol.ts';

const help = `ccgc enterprise - Entra-authenticated enterprise client profile

  ccgc-enterprise login --gateway https://private-gateway --audience api://APP-ID
  ccgc-enterprise configure [--apply]
  ccgc-enterprise token
  ccgc-enterprise models

The token command is the Claude apiKeyHelper. It obtains an Entra token through
DefaultAzureCredential, creates a bounded gateway admission, and stores only the
opaque admission credential in macOS Keychain.
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
      apply: { type: 'boolean' },
    },
  });
  if (values.help || !positionals.length) { console.log(help); return; }
  const command = positionals[0];
  if (positionals.length !== 1 || !['login', 'configure', 'token', 'models'].includes(command ?? '')) {
    throw new BridgeError('INVALID_OPTIONS', 'Unknown enterprise command.');
  }
  const client = new EnterpriseClient();
  if (command === 'login') {
    if (!values.gateway || !values.audience || values.apply) throw new BridgeError('INVALID_OPTIONS', 'login requires --gateway and --audience.');
    console.log(JSON.stringify(await client.login(values.gateway, values.audience), null, 2));
    return;
  }
  if (values.gateway || values.audience || (command !== 'configure' && values.apply)) {
    throw new BridgeError('INVALID_OPTIONS', 'Options do not apply to this enterprise command.');
  }
  if (command === 'token') {
    console.log(await client.token());
    return;
  }
  if (command === 'models') {
    const value = await client.load();
    console.log(JSON.stringify({ default: value.models[0], models: value.models, bindingRevision: value.bindingRevision }, null, 2));
    return;
  }
  console.log(JSON.stringify(await configureEnterprise(await client.load(), values.apply ?? false), null, 2));
}

main().catch(error => {
  const failure = safeError(error);
  console.error(`${failure.code}: ${failure.message}`);
  process.exitCode = 1;
});
