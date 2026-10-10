#!/usr/bin/env node
import { EntraAuthenticator } from './enterprise-auth.ts';
import { DefaultAzureCredential } from '@azure/identity';
import { startEnterpriseServer } from './enterprise-server.ts';
import { PostgresEnterpriseStore } from './enterprise-store.ts';
import { KeyVaultWorkerResolver } from './enterprise-worker.ts';
import { BridgeError, safeError } from './protocol.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new BridgeError('INVALID_OPTIONS', `Missing required environment variable ${name}.`);
  return value;
}

const credential = new DefaultAzureCredential();
const server = await startEnterpriseServer({
  authenticator: new EntraAuthenticator({
    tenantId: required('CCGC_ENTRA_TENANT_ID'),
    audience: required('CCGC_ENTRA_AUDIENCE'),
    requiredScope: process.env.CCGC_ENTRA_SCOPE,
  }),
  store: new PostgresEnterpriseStore(
    required('CCGC_POSTGRES_URL'),
    process.env.CCGC_POSTGRES_ENTRA === 'true' ? credential : undefined,
  ),
  workers: new KeyVaultWorkerResolver(required('CCGC_KEY_VAULT_URL'), required('CCGC_WORKER_DNS_SUFFIX')),
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
