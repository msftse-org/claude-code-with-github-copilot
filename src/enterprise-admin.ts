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

function litellmOrigin(): string {
  const value = required('CCGC_LITELLM_URL');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/'
    || url.search || url.hash) {
    throw new BridgeError('INVALID_OPTIONS', 'CCGC_LITELLM_URL must be a fixed HTTPS origin.');
  }
  return url.origin;
}

async function verifyLiteLLMConnection(
  apiKey: string,
  credentialName: string,
  githubLogin: string,
): Promise<void> {
  const response = await fetch(`${litellmOrigin()}/credentials/user_connections`, {
    headers: { authorization: ['Bearer', apiKey].join(' ') },
    redirect: 'error',
  });
  if (!response.ok) {
    throw new BridgeError('ACCESS_UNVERIFIED', `LiteLLM connection verification failed with HTTP ${response.status}.`, 403);
  }
  const payload = object(parseJson(await response.text()));
  if (!Array.isArray(payload.connections)) {
    throw new BridgeError('ACCESS_UNVERIFIED', 'LiteLLM returned an invalid user-connection response.', 403);
  }
  const connection = payload.connections
    .map(value => object(value))
    .find(value => value.credential_name === credentialName);
  if (!connection || connection.connected !== true || connection.github_login !== githubLogin) {
    throw new BridgeError(
      'IDENTITY_CONFLICT',
      'The LiteLLM user key is not connected to the confirmed GitHub account.',
      403,
    );
  }
}

async function litellmAdminRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const masterKey = required('CCGC_LITELLM_MASTER_KEY');
  if (!/^sk-[A-Za-z0-9._-]{16,}$/.test(masterKey)) {
    throw new BridgeError('INVALID_OPTIONS', 'CCGC_LITELLM_MASTER_KEY is invalid.');
  }
  return fetch(`${litellmOrigin()}${path}`, {
    ...init,
    headers: {
      authorization: ['Bearer', masterKey].join(' '),
      'content-type': 'application/json',
      ...init.headers,
    },
    redirect: 'error',
  });
}

async function bootstrapLiteLLM(input: Record<string, unknown>): Promise<void> {
  const credentialName = text(input.litellmCredentialName, 'LiteLLM credential name');
  const models = Array.isArray(input.models) ? input.models.map(value => text(value, 'model ID')) : [];
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(credentialName)
    || !models.length || models.length > 100
    || models.some(model => !/^claude-[a-z0-9.-]+$/.test(model))) {
    throw new BridgeError('INVALID_REQUEST', 'LiteLLM bootstrap input is invalid.');
  }

  const credentialCheck = await litellmAdminRequest(`/credentials/by_name/${encodeURIComponent(credentialName)}`);
  if (credentialCheck.status === 404) {
    const created = await litellmAdminRequest('/credentials', {
      method: 'POST',
      body: JSON.stringify({
        credential_name: credentialName,
        display_name: 'GitHub Copilot per-user OAuth',
        credential_values: { github_copilot_auth_type: 'per_user_oauth' },
        credential_info: { custom_llm_provider: 'github_copilot' },
      }),
    });
    if (!created.ok) {
      throw new BridgeError('GATEWAY_UNAVAILABLE', `LiteLLM credential bootstrap failed with HTTP ${created.status}.`, 502);
    }
  } else if (!credentialCheck.ok) {
    throw new BridgeError('GATEWAY_UNAVAILABLE', `LiteLLM credential lookup failed with HTTP ${credentialCheck.status}.`, 502);
  } else {
    const existing = object(parseJson(await credentialCheck.text()));
    const values = object(existing.credential_values);
    const info = object(existing.credential_info);
    if (values.github_copilot_auth_type !== 'per_user_oauth'
      || info.custom_llm_provider !== 'github_copilot') {
      throw new BridgeError(
        'IDENTITY_CONFLICT',
        `LiteLLM credential ${credentialName} exists but is not a per-user GitHub Copilot credential.`,
        409,
      );
    }
  }

  const modelInfo = await litellmAdminRequest('/model/info');
  if (!modelInfo.ok) {
    throw new BridgeError('GATEWAY_UNAVAILABLE', `LiteLLM model lookup failed with HTTP ${modelInfo.status}.`, 502);
  }
  const payload = object(parseJson(await modelInfo.text()));
  const configured = Array.isArray(payload.data) ? payload.data.map(value => object(value)) : [];
  const createdModels: string[] = [];
  for (const model of [...new Set(models)]) {
    const existing = configured.filter(value => value.model_name === model);
    if (existing.length) {
      const expectedProviderModel = `github_copilot/${model}`;
      const valid = existing.some(value => {
        const params = object(value.litellm_params);
        return params.model === expectedProviderModel
          && params.custom_llm_provider === 'github_copilot'
          && params.litellm_credential_name === credentialName;
      });
      if (!valid) {
        throw new BridgeError(
          'IDENTITY_CONFLICT',
          `LiteLLM model ${model} exists but is not bound to ${credentialName}.`,
          409,
        );
      }
      continue;
    }
    const created = await litellmAdminRequest('/model/new', {
      method: 'POST',
      body: JSON.stringify({
        model_name: model,
        litellm_params: {
          model: `github_copilot/${model}`,
          custom_llm_provider: 'github_copilot',
          litellm_credential_name: credentialName,
        },
      }),
    });
    if (!created.ok) {
      throw new BridgeError('GATEWAY_UNAVAILABLE', `LiteLLM model bootstrap failed for ${model} with HTTP ${created.status}.`, 502);
    }
    createdModels.push(model);
  }
  console.log(JSON.stringify({
    status: 'bootstrapped',
    litellmCredentialName: credentialName,
    models,
    createdModels,
  }, null, 2));
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      'confirm-same-user': { type: 'boolean' },
      'confirm-revoke': { type: 'boolean' },
      'confirm-bootstrap': { type: 'boolean' },
    },
  });
  const command = positionals[0];
  if (positionals.length !== 1 || !['bootstrap', 'link', 'revoke'].includes(command ?? '')) {
    throw new BridgeError('INVALID_OPTIONS', 'Use enterprise-admin bootstrap, link, or revoke with the matching confirmation flag and JSON on stdin.');
  }
  const raw = await stdin();
  const input = object(parseJson(raw));
  if (command === 'bootstrap') {
    if (!values['confirm-bootstrap']) {
      throw new BridgeError('ACCESS_UNVERIFIED', 'LiteLLM bootstrap requires --confirm-bootstrap.');
    }
    await bootstrapLiteLLM(input);
    return;
  }
  const credential = new DefaultAzureCredential();
  const store = new PostgresEnterpriseStore(required('CCGC_POSTGRES_URL'), credential);
  await store.initialize();
  try {
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
    const credentialSecretName = text(input.credentialSecretName, 'credential secret name');
    const credentialName = text(input.litellmCredentialName, 'LiteLLM credential name');
    const credentialValue = {
      login: githubLogin,
      apiKey: text(input.litellmApiKey, 'LiteLLM user key'),
      githubAccountId: positive(input.githubAccountId, 'GitHub account ID'),
      credentialName,
    };
    if (!/^sk-[A-Za-z0-9._-]{16,}$/.test(credentialValue.apiKey)
      || !/^[A-Za-z0-9._-]{1,128}$/.test(credentialName)) {
      throw new BridgeError('INVALID_REQUEST', 'The LiteLLM user key or credential name is invalid.');
    }
    await verifyLiteLLMConnection(credentialValue.apiKey, credentialName, githubLogin);
    const vault = new SecretClient(required('CCGC_KEY_VAULT_URL'), credential);
    await vault.setSecret(credentialSecretName, JSON.stringify(credentialValue), {
      contentType: 'application/vnd.ccgc.litellm-user-key+json',
      tags: {
        tenantId,
        objectId,
        githubAccountId: String(credentialValue.githubAccountId),
        litellmCredentialName: credentialName,
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
