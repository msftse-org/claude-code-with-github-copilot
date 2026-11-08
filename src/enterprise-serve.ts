#!/usr/bin/env node
import { DualEnterpriseAuthenticator, EntraAuthenticator } from './enterprise-auth.ts';
import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import { startEnterpriseServer } from './enterprise-server.ts';
import { PostgresEnterpriseStore } from './enterprise-store.ts';
import { SharedWorkerResolver } from './enterprise-worker.ts';
import { DispatchSigner } from './enterprise-dispatch.ts';
import { BridgeError, object, parseJson, safeError, text } from './protocol.ts';
import { EnterpriseManagement } from './enterprise-management.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new BridgeError('INVALID_OPTIONS', `Missing required environment variable ${name}.`);
  return value;
}

const credential = new DefaultAzureCredential();
const vaultUrl = required('CCGC_KEY_VAULT_URL');
const brokerOrigin = required('CCGC_BROKER_ORIGIN');
const entraTenantId = required('CCGC_ENTRA_TENANT_ID');
const entraAudience = required('CCGC_ENTRA_AUDIENCE');
const modelCatalog = object(parseJson(required('CCGC_MODELS_JSON')));
if (!Array.isArray(modelCatalog.models) || modelCatalog.models.length === 0) {
  throw new BridgeError('INVALID_OPTIONS', 'CCGC_MODELS_JSON must contain approved models.');
}
const enrollmentModels = modelCatalog.models.map(value => text(object(value).id, 'model ID'));
const vault = new SecretClient(vaultUrl, credential);
const litellmMasterKey = await vault.getSecret(required('CCGC_LITELLM_MASTER_KEY_SECRET_NAME'));
if (!litellmMasterKey.value) throw new BridgeError('STARTUP_FAILED', 'LiteLLM administration secret is unavailable.');
const store = new PostgresEnterpriseStore(
  required('CCGC_POSTGRES_URL'),
  process.env.CCGC_POSTGRES_ENTRA === 'true' ? credential : undefined,
  false,
  false,
);
const employeeEntra = new EntraAuthenticator({
  tenantId: entraTenantId,
  audience: entraAudience,
  requiredRole: process.env.CCGC_ENTRA_ROLE,
});
const workerUrl = process.env.CCGC_LEGACY_WORKER_URL;
const dispatchSecretName = process.env.CCGC_DISPATCH_SECRET_NAME;
const dispatchSecret = workerUrl && dispatchSecretName
  ? await vault.getSecret(dispatchSecretName)
  : undefined;
if (workerUrl && !dispatchSecret?.value) {
  throw new BridgeError('STARTUP_FAILED', 'Legacy dispatch signing secret is unavailable.');
}
const server = await startEnterpriseServer({
  authenticator: new DualEnterpriseAuthenticator(employeeEntra, store),
  store,
  ...(workerUrl && dispatchSecret?.value ? {
    workers: new SharedWorkerResolver(workerUrl, required('CCGC_WORKER_DNS_SUFFIX')),
    dispatchSigner: new DispatchSigner(dispatchSecret.value, brokerOrigin, workerUrl),
  } : {}),
  inferenceGateway: required('CCGC_LITELLM_PUBLIC_URL'),
  nativeEntraInference: process.env.CCGC_NATIVE_ENTRA_INFERENCE === 'true',
  adminAuthenticator: new EntraAuthenticator({
    tenantId: entraTenantId,
    audience: entraAudience,
    requiredRole: 'CCGC.Admin',
  }),
  adminActions: new EnterpriseManagement({
    litellmUrl: required('CCGC_LITELLM_URL'),
    litellmMasterKey: litellmMasterKey.value,
    postgresUrl: required('CCGC_POSTGRES_URL'),
    tenantId: entraTenantId,
    enrollmentModels,
    nativeEntraJwtMappings: process.env.CCGC_NATIVE_ENTRA_JWT_MAPPINGS === 'true',
    credential,
    enrollmentSecrets: {
      async set(name, value, expiresAt) {
        await vault.setSecret(name, value, {
          expiresOn: expiresAt,
          contentType: 'application/vnd.ccgc.enrollment-secret',
        });
      },
      async get(name) {
        const secret = await vault.getSecret(name);
        if (!secret.value) throw new BridgeError('GATEWAY_UNAVAILABLE', 'Enrollment secret is unavailable.', 503);
        return secret.value;
      },
      async remove(name) {
        try {
          await vault.beginDeleteSecret(name);
        } catch (error) {
          const statusCode = error instanceof Error && 'statusCode' in error
            ? Number(error.statusCode)
            : undefined;
          if (statusCode !== 404 && statusCode !== 409) throw error;
        }
      },
    },
  }),
  adminBrowserOrigin: brokerOrigin,
  adminBrowserIdentity: {
    tenantId: entraTenantId,
    clientId: entraAudience,
    scope: `api://${entraAudience}/CCGC.Invoke`,
    redirectUri: `${brokerOrigin}/ccgc/admin`,
  },
  host: process.env.CCGC_BIND_HOST ?? '0.0.0.0',
  port: Number(process.env.PORT ?? '8080'),
  onError(error) {
    console.error(JSON.stringify({ code: error.code, status: error.status }));
  },
}).catch(error => {
  const failure = safeError(error);
  console.error(`${failure.code}: ${failure.message}`);
  if (error instanceof Error) {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : error.name;
    const detail = error.message
      .replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, 'postgresql://[redacted]@')
      .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]');
    console.error(`STARTUP_DIAGNOSTIC: ${code}: ${detail}`);
  }
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void server.close().finally(() => process.exit());
  });
}
