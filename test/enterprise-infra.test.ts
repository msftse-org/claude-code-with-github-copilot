import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), 'utf8');
}

test('enterprise model catalog uses the worker model contract', async () => {
  const main = await source('infra/enterprise/main.bicep');
  const match = main.match(/param modelsJson string = '([^']+)'/);
  assert.ok(match);
  const catalog = JSON.parse(match[1]!) as {
    models: Array<Record<string, unknown>>;
  };
  assert.deepEqual(catalog.models, [{
    id: 'claude-sonnet-5.5',
    name: 'Claude Sonnet 5.5',
    responseIds: ['claude-sonnet-5.5', 'claude-sonnet-5-5'],
    context: 1000000,
    output: 128000,
  }]);
});

test('enterprise deployment stages private image publication before runtime', async () => {
  const [main, platform, automation] = await Promise.all([
    source('infra/enterprise/main.bicep'),
    source('infra/enterprise/modules/platform.bicep'),
    source('scripts/enterprise-pilot.mjs'),
  ]);

  assert.match(main, /param deployRuntime bool = true/);
  assert.match(platform, /registries\/agentPools@2025-03-01-preview/);
  assert.match(platform, /agentPools@2025-03-01-preview' = if \(buildAgentPoolCount > 0\)/);
  assert.match(platform, /count: buildAgentPoolCount/);
  assert.match(platform, /resource broker .* = if \(deployRuntime\)/);
  assert.match(platform, /resource bootstrapJob 'Microsoft\.App\/jobs@2025-01-01' = if \(deployRuntime\)/);
  assert.match(platform, /resource worker .* = if \(deployRuntime\)/);
  assert.match(platform, /resource litellm .* = if \(deployRuntime\)/);
  assert.match(automation, /deployRuntime: false/);
  assert.match(automation, /'acr', 'build'/);
  assert.match(automation, /'acr', 'agentpool', 'delete'/);
  assert.match(automation, /@sha256:/);
  assert.match(automation, /has\('--confirm-deploy'\) \? 'create' : 'what-if'/);
  assert.match(automation, /if \(action === 'what-if'\) args\.push\('--no-pretty-print'\)/);
});

test('the broker is the only public API and carries separate employee and admin authorization', async () => {
  const [platform, authenticator, entraAutomation] = await Promise.all([
    source('infra/enterprise/modules/platform.bicep'),
    source('src/enterprise-auth.ts'),
    source('scripts/enterprise-entra.mjs'),
  ]);

  assert.match(platform, /internal: false/);
  assert.equal((platform.match(/external: true/g) ?? []).length, 1);
  assert.equal((platform.match(/external: false/g) ?? []).length, 2);
  assert.equal((platform.match(/transport: 'auto'/g) ?? []).length, 2);
  assert.equal((platform.match(/transport: 'http'/g) ?? []).length, 1);
  assert.match(platform, /var entraTokenAudience = startsWith\(entraAudience, 'api:\/\/'\) \? substring\(entraAudience, 6\) : entraAudience/);
  assert.match(platform, /name: 'CCGC_ENTRA_AUDIENCE'[\s\S]*value: entraTokenAudience/);
  assert.match(platform, /name: 'CCGC_ENTRA_ROLE'[\s\S]*value: 'CCGC\.Access'/);
  assert.match(platform, /enterprise-bootstrap\.ts/);
  assert.match(platform, /brokerIdentity[\s\S]*Key Vault Secrets Officer/);
  assert.match(platform, /bootstrapIdentity[\s\S]*Key Vault Secrets User/);
  assert.match(platform, /name: 'AZURE_CLIENT_ID'[\s\S]*value: brokerIdentity\.properties\.clientId/);
  assert.match(platform, /name: 'AZURE_CLIENT_ID'[\s\S]*value: bootstrapIdentity\.properties\.clientId/);
  assert.match(platform, /name: 'AZURE_CLIENT_ID'[\s\S]*value: workerIdentity\.properties\.clientId/);
  assert.match(platform, /var privateEnvironmentDomain = 'internal\.\$\{environment\.properties\.defaultDomain\}'/);
  assert.doesNotMatch(platform, /https:\/\/\$\{(?:workerName|litellmName)\}\.\$\{environment\.properties\.defaultDomain\}/);
  assert.match(platform, /https:\/\/\$\{workerName\}\.\$\{privateEnvironmentDomain\}/);
  assert.match(platform, /https:\/\/\$\{litellmName\}\.\$\{privateEnvironmentDomain\}/);
  assert.match(authenticator, /requiredRole \?\? 'CCGC\.Access'/);
  assert.match(authenticator, /hasEnterpriseRole\(payload, this\.requiredRole\)/);
  assert.doesNotMatch(authenticator, /payload\.scp/);
  assert.match(entraAutomation, /appRoleAssignmentRequired: true/);
  assert.match(entraAutomation, /pilotGroupObjectId/);
  assert.match(entraAutomation, /value: 'CCGC\.Access'/);
  assert.match(entraAutomation, /value: 'CCGC\.Admin'/);
  assert.match(entraAutomation, /value: 'CCGC\.Invoke'/);
  assert.match(entraAutomation, /adminGroupObjectId/);
  assert.match(entraAutomation, /--confirm-entra-changes/);
});

test('the runtime design contract matches deployed service boundaries and dependencies', async () => {
  const [platform, diagram] = await Promise.all([
    source('infra/enterprise/modules/platform.bicep'),
    source('docs/diagrams/ccgc-enterprise-runtime-poster.architecture.json'),
  ]);
  const architecture = JSON.parse(diagram) as {
    components: Array<{ id: string; sublabel?: string; tag?: string }>;
    boundaries: Array<{ label: string; wraps: string[] }>;
    connections: Array<{ id: string; from: string; to: string }>;
  };
  const ids = new Set(architecture.components.map(component => component.id));
  for (const id of [
    'claude-code', 'entra-id', 'enterprise-broker', 'multiuser-worker',
    'litellm-gateway', 'key-vault', 'github-copilot', 'claude-models',
    'azure-monitor', 'enterprise-postgres', 'blob-checkpoints', 'litellm-postgres',
  ]) assert.equal(ids.has(id), true, `missing design component ${id}`);

  const inferencePlane = architecture.boundaries.find(boundary =>
    boundary.label === 'Shared inference plane - Azure Container Apps');
  assert.deepEqual(inferencePlane?.wraps, ['multiuser-worker', 'litellm-gateway']);

  const connections = new Set(architecture.connections.map(connection =>
    `${connection.from}->${connection.to}`));
  for (const relationship of [
    'claude-code->enterprise-broker',
    'enterprise-broker->multiuser-worker',
    'multiuser-worker->litellm-gateway',
    'litellm-gateway->github-copilot',
    'github-copilot->claude-models',
    'entra-id->enterprise-broker',
    'enterprise-broker->key-vault',
    'multiuser-worker->key-vault',
    'key-vault->litellm-gateway',
    'enterprise-broker->enterprise-postgres',
    'multiuser-worker->blob-checkpoints',
    'litellm-gateway->litellm-postgres',
  ]) assert.equal(connections.has(relationship), true, `missing design relationship ${relationship}`);

  assert.match(platform, /resource broker 'Microsoft\.App\/containerApps@2025-01-01'/);
  assert.match(platform, /resource worker 'Microsoft\.App\/containerApps@2025-01-01'/);
  assert.match(platform, /resource litellm 'Microsoft\.App\/containerApps@2025-01-01'/);
  assert.match(platform, /minReplicas: 2[\s\S]*maxReplicas: 10/);
  assert.match(platform, /resource worker[\s\S]*minReplicas: 2[\s\S]*maxReplicas: 30/);
  assert.match(platform, /resource litellm[\s\S]*minReplicas: 2[\s\S]*maxReplicas: 10/);
  assert.match(platform, /workerKeyVaultAccess[\s\S]*Key Vault Secrets User/);
  assert.match(platform, /litellmKeyVaultAccess[\s\S]*Key Vault Secrets User/);
  assert.match(platform, /workerStorageAccess[\s\S]*Storage Blob Data Contributor/);
  assert.match(platform, /APPLICATIONINSIGHTS_CONNECTION_STRING/g);
});
