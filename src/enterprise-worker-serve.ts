#!/usr/bin/env node
import { startEnterpriseWorkerServer } from './enterprise-worker-server.ts';
import { remoteModel } from './remote.ts';
import { object, parseJson, positive, safeError, BridgeError } from './protocol.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new BridgeError('INVALID_OPTIONS', `Missing required environment variable ${name}.`);
  return value;
}

const catalog = object(parseJson(required('CCGC_MODELS_JSON')));
if (!Array.isArray(catalog.models)) throw new BridgeError('INVALID_OPTIONS', 'CCGC_MODELS_JSON must contain a models array.');

const server = await startEnterpriseWorkerServer({
  token: required('CCGC_WORKER_TOKEN'),
  principalId: required('CCGC_PRINCIPAL_ID'),
  githubAccountId: positive(Number(required('CCGC_GITHUB_ACCOUNT_ID')), 'GitHub account ID'),
  models: catalog.models.map(remoteModel),
  litellmUrl: required('CCGC_LITELLM_URL'),
  litellmToken: required('CCGC_LITELLM_TOKEN'),
  expectedHost: required('CCGC_EXPECTED_HOST'),
  maxTurns: Number(process.env.CCGC_MAX_TURNS ?? '50'),
  stateDir: process.env.CCGC_WORKER_STATE_DIR,
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
