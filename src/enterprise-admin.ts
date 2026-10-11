#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import { parseArgs } from 'node:util';
import { object, parseJson, safeError, text, BridgeError, positive } from './protocol.ts';
import { PostgresEnterpriseStore } from './enterprise-store.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new BridgeError('INVALID_OPTIONS', `Missing required environment variable ${name}.`);
  return value;
}

async function stdin(): Promise<string> {
  if (process.stdin.isTTY) throw new BridgeError('INVALID_OPTIONS', 'Supply private operator input through stdin.');
  let value = '';
  for await (const chunk of process.stdin) {
    value += String(chunk);
    if (value.length > 32 * 1024) throw new BridgeError('REQUEST_TOO_LARGE', 'Operator input exceeds 32 KiB.');
  }
  return value;
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      'confirm-same-user': { type: 'boolean' },
      'confirm-revoke': { type: 'boolean' },
    },
  });
  const command = positionals[0];
  if (positionals.length !== 1 || !['link', 'revoke'].includes(command ?? '')) {
    throw new BridgeError('INVALID_OPTIONS', 'Use enterprise-admin link --confirm-same-user or revoke --confirm-revoke with JSON on stdin.');
  }
  const credential = new DefaultAzureCredential();
  const store = new PostgresEnterpriseStore(required('CCGC_POSTGRES_URL'), credential);
  await store.initialize();
  try {
    const raw = await stdin();
    const input = object(parseJson(raw));
    const evidence = text(input.evidence, 'operator evidence');
    const evidenceDigest = createHash('sha256').update(evidence).digest('hex');
    const tenantId = text(input.tenantId, 'tenant ID').toLowerCase();
    const objectId = text(input.objectId, 'object ID').toLowerCase();
    if (command === 'revoke') {
      if (!values['confirm-revoke']) throw new BridgeError('ACCESS_UNVERIFIED', 'Revocation requires --confirm-revoke.');
      await store.revokeBinding(tenantId, objectId, evidenceDigest);
      console.log(JSON.stringify({ status: 'revoked', tenantId, objectId, evidenceDigest }, null, 2));
      return;
    }
    if (!values['confirm-same-user']) {
      throw new BridgeError('ACCESS_UNVERIFIED', 'Linking requires operator confirmation that Entra and GitHub identities belong to the same user.');
    }
    const githubLogin = text(input.githubLogin, 'GitHub login');
    const credentialInput = object(input.credential);
    const credentialSecretName = text(input.credentialSecretName, 'credential secret name');
    const credentialValue = {
      login: text(credentialInput.login, 'credential GitHub login'),
      accessToken: text(credentialInput.accessToken, 'GitHub credential'),
      githubAccountId: positive(input.githubAccountId, 'GitHub account ID'),
    };
    if (credentialValue.login !== githubLogin || credentialValue.accessToken.length < 20
      || /[\r\n]/.test(credentialValue.accessToken)) {
      throw new BridgeError('IDENTITY_CONFLICT', 'The credential identity does not match the confirmed GitHub account.', 403);
    }
    const vault = new SecretClient(required('CCGC_KEY_VAULT_URL'), credential);
    await vault.setSecret(credentialSecretName, JSON.stringify(credentialValue), {
      contentType: 'application/vnd.ccgc.copilot-credential+json',
      tags: {
        tenantId,
        objectId,
        githubAccountId: String(credentialValue.githubAccountId),
      },
    });
    const models = Array.isArray(input.models) ? input.models.map(value => text(value, 'model ID')) : [];
    const binding = await store.linkAccount({
      tenantId,
      objectId,
      githubAccountId: credentialValue.githubAccountId,
      githubLogin,
      credentialSecretName,
      models,
      evidenceDigest,
    });
    console.log(JSON.stringify({
      status: 'linked',
      tenantId: binding.tenantId,
      objectId: binding.objectId,
      githubLogin: binding.githubLogin,
      githubAccountId: binding.githubAccountId,
      models: binding.models,
      revision: binding.revision,
      evidenceDigest,
    }, null, 2));
  } finally {
    await store.close();
  }
}

main().catch(error => {
  const failure = safeError(error);
  console.error(`${failure.code}: ${failure.message}`);
  process.exitCode = 1;
});
