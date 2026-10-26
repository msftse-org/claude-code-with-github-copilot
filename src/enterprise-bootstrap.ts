#!/usr/bin/env node
import { DefaultAzureCredential } from '@azure/identity';
import { bootstrapLiteLLM, reconcileLiteLLMUsers } from './enterprise-admin.ts';
import { PostgresEnterpriseStore } from './enterprise-store.ts';
import { BridgeError, object, parseJson, safeError, text } from './protocol.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new BridgeError('INVALID_OPTIONS', `Missing required environment variable ${name}.`);
  return value;
}

async function bootstrapDatabase(models: string[]): Promise<{
  objectIds: string[];
  changedBindings: number;
  changedEnrollments: number;
}> {
  const configuredPrincipals = process.env.CCGC_DATABASE_PRINCIPALS_JSON;
  const principals = configuredPrincipals
    ? JSON.parse(configuredPrincipals) as unknown
    : [required('CCGC_BROKER_DATABASE_PRINCIPAL')];
  if (!Array.isArray(principals) || !principals.length
    || principals.some(principal => typeof principal !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(principal))) {
    throw new BridgeError('INVALID_OPTIONS', 'Runtime database principals are invalid.');
  }
  const store = new PostgresEnterpriseStore(required('CCGC_POSTGRES_URL'), new DefaultAzureCredential());
  try {
    await store.initialize();
    for (const principal of principals) {
      const identifier = `"${principal.replaceAll('"', '""')}"`;
      const existing = await store.pool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [principal]);
      if (existing.rowCount === 0) {
        await store.pool.query('SELECT * FROM pgaadauth_create_principal($1, false, false)', [principal]);
      }
      await store.pool.query(`GRANT CONNECT ON DATABASE postgres TO ${identifier}`);
      await store.pool.query(`GRANT USAGE ON SCHEMA public TO ${identifier}`);
      await store.pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${identifier}`);
      await store.pool.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${identifier}`);
      await store.pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${identifier}`);
      await store.pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${identifier}`);
    }
    return await store.reconcileModelCatalog(required('CCGC_ENTRA_TENANT_ID'), models);
  } finally {
    await store.close();
  }
}

async function main(): Promise<void> {
  const catalog = object(parseJson(required('CCGC_MODELS_JSON')));
  if (!Array.isArray(catalog.models)) throw new BridgeError('INVALID_OPTIONS', 'Model catalog is invalid.');
  const models = catalog.models.map(value => text(object(value).id, 'model ID'));
  await bootstrapLiteLLM({
    litellmCredentialName: required('CCGC_LITELLM_CREDENTIAL_NAME'),
    models,
  });
  const reconciliation = await bootstrapDatabase(models);
  await reconcileLiteLLMUsers(reconciliation.objectIds, models);
  console.log(JSON.stringify({ status: 'bootstrapped', models, reconciliation }));
}

main().catch(error => {
  const failure = safeError(error);
  console.error(`${failure.code}: ${failure.message}`);
  if (error instanceof Error) {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : error.name;
    const detail = error.message
      .replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, 'postgresql://[redacted]@')
      .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]');
    console.error(`BOOTSTRAP_DIAGNOSTIC: ${code}: ${detail}`);
  }
  process.exitCode = 1;
});
