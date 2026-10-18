#!/usr/bin/env node
import { EntraAuthenticator } from './enterprise-auth.ts';
import { EnterpriseOperator } from './enterprise-operator.ts';
import { startEnterpriseOperatorServer } from './enterprise-operator-server.ts';
import { BridgeError, safeError } from './protocol.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new BridgeError('INVALID_OPTIONS', `Missing required environment variable ${name}.`);
  return value;
}

const server = await startEnterpriseOperatorServer({
  authenticator: new EntraAuthenticator({
    tenantId: required('CCGC_ENTRA_TENANT_ID'),
    audience: required('CCGC_ENTRA_AUDIENCE'),
    requiredRole: 'CCGC.Admin',
  }),
  actions: new EnterpriseOperator({
    litellmUrl: required('CCGC_LITELLM_URL'),
    litellmMasterKey: required('CCGC_LITELLM_MASTER_KEY'),
    postgresUrl: required('CCGC_POSTGRES_URL'),
    brokerDatabasePrincipal: required('CCGC_BROKER_DATABASE_PRINCIPAL'),
  }),
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
