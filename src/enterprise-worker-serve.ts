#!/usr/bin/env node
import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import { EncryptedAzureBlobCheckpointStore } from './enterprise-checkpoint.ts';
import { AccountScopedConnectorPool, KeyVaultAccountCredentialResolver } from './enterprise-connector.ts';
import { DispatchVerifier } from './enterprise-dispatch.ts';
import { startEnterpriseWorkerServer } from './enterprise-worker-server.ts';
import { remoteModel } from './remote.ts';
import { object, parseJson, safeError, BridgeError } from './protocol.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new BridgeError('INVALID_OPTIONS', `Missing required environment variable ${name}.`);
  return value;
}

const catalog = object(parseJson(required('CCGC_MODELS_JSON')));
if (!Array.isArray(catalog.models)) throw new BridgeError('INVALID_OPTIONS', 'CCGC_MODELS_JSON must contain a models array.');

const credential = new DefaultAzureCredential();
const vaultUrl = required('CCGC_KEY_VAULT_URL');
const vault = new SecretClient(vaultUrl, credential);
const [dispatchSecret, checkpointKey] = await Promise.all([
  vault.getSecret(required('CCGC_DISPATCH_SECRET_NAME')),
  vault.getSecret(required('CCGC_CHECKPOINT_KEY_SECRET_NAME')),
]);
if (!dispatchSecret.value || !checkpointKey.value) {
  throw new BridgeError('STARTUP_FAILED', 'Worker signing or checkpoint encryption material is unavailable.');
}
const workerOrigin = required('CCGC_WORKER_ORIGIN');
const server = await startEnterpriseWorkerServer({
  verifier: new DispatchVerifier(dispatchSecret.value, required('CCGC_BROKER_ORIGIN'), workerOrigin),
  connectors: new AccountScopedConnectorPool(
    new KeyVaultAccountCredentialResolver(vaultUrl),
    fetch,
    Number(process.env.CCGC_MAX_CONNECTORS ?? '500'),
  ),
  checkpoints: new EncryptedAzureBlobCheckpointStore(
    required('CCGC_CHECKPOINT_STORAGE_URL'),
    process.env.CCGC_CHECKPOINT_CONTAINER ?? 'checkpoints',
    checkpointKey.value,
    credential,
  ),
  models: catalog.models.map(remoteModel),
  expectedHost: required('CCGC_EXPECTED_HOST'),
  maxTurns: Number(process.env.CCGC_MAX_TURNS ?? '50'),
  maxActiveBranches: Number(process.env.CCGC_MAX_ACTIVE_BRANCHES ?? '500'),
  maxActiveBranchesPerUser: Number(process.env.CCGC_MAX_ACTIVE_BRANCHES_PER_USER ?? '4'),
  host: process.env.CCGC_BIND_HOST ?? '0.0.0.0',
  port: Number(process.env.PORT ?? '8080'),
  onError(error) {
    console.error(JSON.stringify({ code: error.code, status: error.status }));
  },
}).catch(error => {
  const failure = safeError(error);
  console.error(`${failure.code}: ${failure.message}`);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void server.close().finally(() => process.exit());
  });
}
