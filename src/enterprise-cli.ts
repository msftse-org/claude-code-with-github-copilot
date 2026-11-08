#!/usr/bin/env node
import { parseArgs, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { dirname, join } from 'node:path';
import { EnterpriseClient, configureEnterprise, enterpriseDesktopConfig, type EnterpriseProfile } from './enterprise-client.ts';
import { setupEnterprise } from './enterprise-setup.ts';
import { BridgeError, object, parseJson, safeError, text } from './protocol.ts';
import { readPrivate, writePrivate } from './private-state.ts';
import { gatewayUrl } from './remote.ts';

const help = `ccgc enterprise - enterprise client profile

  ccgc-enterprise setup --gateway https://enterprise-broker --audience api://APP-ID [--apply] [--no-browser]
    [--credential NAME]
  ccgc-enterprise login --gateway https://private-gateway --audience api://APP-ID
  ccgc-enterprise login-api-key --gateway https://private-gateway --api-key-file /private/key.json
  ccgc-enterprise login-litellm-key --gateway https://litellm-gateway --api-key-file /private/key.json
  ccgc-enterprise configure [--apply]
  ccgc-enterprise desktop-config
  ccgc-enterprise token
  ccgc-enterprise models

The token command is the Claude apiKeyHelper. Direct LiteLLM virtual keys are
returned unchanged from macOS Keychain. Legacy Entra and CCGC API-key profiles
continue to use bounded admissions during migration.
setup authenticates through Microsoft Entra, provisions a non-invited internal
LiteLLM identity and scoped key on the server, and connects GitHub through its
native device authorization. Employees do not need a LiteLLM login or dashboard
account. GitHub determines the username after consent.
--apply writes CLI settings; setup also writes a secret-free Desktop import file.
Older direct-key profiles require setup or a fresh login-litellm-key before use.
desktop-config prints a secret-free JSON configuration to import through
Desktop's Developer > Configure Third-Party Inference window. CLI settings
do not configure Desktop's separate third-party mode.
`;

async function guidedSetup(client: EnterpriseClient, options: {
  gateway: string;
  audience: string;
  credentialName?: string;
  apply: boolean;
  noBrowser: boolean;
}): Promise<void> {
  const gateway = gatewayUrl(options.gateway);
  if (process.platform !== 'darwin') throw new BridgeError('CREDENTIAL_STORE_UNAVAILABLE', 'This setup currently requires macOS Keychain.');
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new BridgeError('INTERACTIVE_LOGIN_REQUIRED', 'Run setup in a terminal to confirm your identity and approve GitHub.');
  }
  const cancellation = new AbortController();
  let hidden = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!hidden) process.stderr.write(chunk, encoding);
      callback();
    },
  });
  const terminal = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  terminal.on('SIGINT', () => cancellation.abort());
  terminal.on('close', () => cancellation.abort());
  const prompt = async (label: string, secret = false): Promise<string> => {
    const answer = terminal.question(label, { signal: cancellation.signal });
    hidden = secret;
    try { return await answer; }
    finally {
      hidden = false;
      if (secret) process.stderr.write('\n');
    }
  };
  try {
    console.error('Authenticating with Microsoft Entra; no LiteLLM login or dashboard account is required.');
    const provisioned = await client.provisionLiteLLMUser(gateway, options.audience);
    console.error(`Service-managed LiteLLM identity: ${JSON.stringify(provisioned.userAlias)} (${JSON.stringify(provisioned.userId)}).`);
    let profile: EnterpriseProfile;
    try {
      profile = await setupEnterprise(client, provisioned.inferenceGateway, { apiKey: provisioned.apiKey }, {
        ...(options.credentialName ? { credentialName: options.credentialName } : {}),
        signal: cancellation.signal,
        async confirmIdentity(identity) {
          console.error(`LiteLLM identity: ${JSON.stringify(identity.userAlias ?? identity.userId)} (${JSON.stringify(identity.userId)})`);
          console.error(`GitHub connection: ${identity.githubLogin ? JSON.stringify(identity.githubLogin) : 'not connected yet'}`);
          return /^(y|yes)$/i.test((await prompt('Is this your account and, if already connected, your GitHub identity? [y/N] ')).trim());
        },
        async authorizeDevice(device) {
          console.error(`Open ${device.verificationUri} and enter ${device.userCode}. Approve only using your own Copilot-entitled GitHub account.`);
          console.error(`Waiting for GitHub approval (up to ${device.expiresIn} seconds). Ctrl-C cancels.`);
          if (!options.noBrowser) {
            try { await promisify(execFile)('/usr/bin/open', [device.verificationUri], { timeout: 10_000 }); }
            catch { console.error('Could not launch the browser. Open the verification URL above manually.'); }
          }
        },
      });
    } catch (error) {
      try {
        await client.revokeLiteLLMSetupKey(gateway, options.audience, provisioned.apiKey);
      } catch {
        throw new BridgeError(
          'KEY_CLEANUP_REQUIRED',
          'Setup failed and the new LiteLLM key could not be revoked. Ask an administrator to revoke the ccgc-claude key; the previous local profile was preserved.',
        );
      }
      throw error;
    }
    const desktopPath = join(dirname(client.statePath), 'desktop-gateway.json');
    await writePrivate(desktopPath, enterpriseDesktopConfig(profile));
    const cli = await configureEnterprise(profile, options.apply);
    console.log(JSON.stringify({
      liteLLMUserId: profile.liteLLMUserId,
      liteLLMUserAlias: profile.liteLLMUserAlias,
      githubLogin: profile.githubLogin,
      credentialName: profile.copilotCredentialName,
      models: profile.models,
      cli,
      desktopConfig: desktopPath,
    }, null, 2));
    console.error('No LiteLLM login or dashboard access is needed; the server-managed internal identity owns the GitHub connection.');
    console.error(`Desktop: if Gateway already uses this helper, relaunch it. Otherwise import ${desktopPath} in Developer > Configure Third-Party Inference and apply/relaunch.`);
    console.error('Restart existing Claude sessions to discard any previously cached credentials. Setup does not run inference or prove client feature parity.');
  } catch (error) {
    if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) {
      throw new BridgeError('SETUP_CANCELLED', 'Setup was cancelled or timed out; no automatic retry was attempted.');
    }
    throw error;
  } finally { terminal.close(); output.destroy(); }
}

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
      'use-key': { type: 'boolean' },
      credential: { type: 'string' },
      'no-browser': { type: 'boolean' },
      apply: { type: 'boolean' },
    },
  });
  if (values.help || !positionals.length) { console.log(help); return; }
  const command = positionals[0];
  if (positionals.length !== 1 || !['setup', 'login', 'login-api-key', 'login-litellm-key', 'configure', 'desktop-config', 'token', 'models'].includes(command ?? '')) {
    throw new BridgeError('INVALID_OPTIONS', 'Unknown enterprise command.');
  }
  const client = new EnterpriseClient();
  if (command === 'setup') {
    if (!values.gateway || !values.audience || values['use-key'] || values['api-key-file']) {
      throw new BridgeError('INVALID_OPTIONS', 'setup requires --gateway and --audience and does not accept a LiteLLM key.');
    }
    await guidedSetup(client, {
      gateway: values.gateway,
      audience: values.audience,
      ...(values.credential ? { credentialName: values.credential } : {}),
      apply: values.apply ?? false,
      noBrowser: values['no-browser'] ?? false,
    });
    return;
  }
  if (values.credential || values['no-browser'] || values['use-key']) {
    throw new BridgeError('INVALID_OPTIONS', '--credential, --no-browser and --use-key apply only to setup.');
  }
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
  if (command === 'desktop-config') {
    console.log(JSON.stringify(enterpriseDesktopConfig(await client.refreshModels()), null, 2));
    return;
  }
  if (command === 'models') {
    const value = await client.refreshModels();
    console.log(JSON.stringify({
      default: value.models[0],
      models: value.models,
      ...(value.bindingRevision ? { bindingRevision: value.bindingRevision } : {}),
    }, null, 2));
    return;
  }
  console.log(JSON.stringify(await configureEnterprise(await client.refreshModels(), values.apply ?? false), null, 2));
}

main().catch(error => {
  const failure = safeError(error);
  console.error(`${failure.code}: ${failure.message}`);
  process.exitCode = 1;
});
