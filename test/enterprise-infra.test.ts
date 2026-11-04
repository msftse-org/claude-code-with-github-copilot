import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), 'utf8');
}

test('enterprise model catalog uses the central LiteLLM model contract', async () => {
  const main = await source('infra/enterprise/main.bicep');
  const match = main.match(/param modelsJson string = '([^']+)'/);
  assert.ok(match);
  const catalog = JSON.parse(match[1]!) as {
    models: Array<Record<string, unknown>>;
  };
  assert.deepEqual(catalog.models, [
    {
      id: 'claude-sonnet-5.5',
      name: 'Claude Sonnet 5.5',
      responseIds: ['claude-sonnet-5.5', 'claude-sonnet-5-5'],
      context: 1000000,
      output: 128000,
    },
    {
      id: 'claude-sonnet-5',
      name: 'Claude Sonnet 5',
      responseIds: ['claude-sonnet-5'],
      context: 1000000,
      output: 16384,
    },
    {
      id: 'claude-opus-5.5',
      name: 'Claude Opus 5.5',
      responseIds: ['claude-opus-5.5', 'claude-opus-5-5'],
      context: 1000000,
      output: 16384,
    },
    {
      id: 'claude-haiku-5.5',
      name: 'Claude Haiku 5.5',
      responseIds: ['claude-haiku-5.5', 'claude-haiku-5-5'],
      context: 1000000,
      output: 16384,
    },
    {
      id: 'claude-haiku-4.5',
      name: 'Claude Haiku 4.5',
      responseIds: ['claude-haiku-4.5', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001'],
      context: 200000,
      output: 16384,
    },
  ]);
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
  assert.match(platform, /resource worker .* = if \(deployRuntime && deployLegacyWorker\)/);
  assert.match(platform, /resource litellm .* = if \(deployRuntime && managedLiteLLM\)/);
  assert.equal((platform.match(/Microsoft\.DBforPostgreSQL\/flexibleServers@2024-08-01/g) ?? []).length, 1);
  assert.doesNotMatch(platform, /snet-litellm-postgres|litellmPostgresName/);
  assert.match(platform, /passwordAuth: managedLiteLLM \? 'Enabled' : 'Disabled'/);
  assert.match(platform, /postgres\?schema=ccgc&sslmode=require/);
  assert.match(platform, /postgres\?schema=litellm&sslmode=require/);
  assert.match(main, /param managedPostgresAdminLogin string = 'ccgcadmin'/);
  assert.doesNotMatch(main, /litellmPostgresHost|litellmPostgresAdmin/);
  assert.match(main, /param litellmMode string = 'managed'/);
  assert.match(main, /param existingLiteLLMUrl string = ''/);
  assert.match(automation, /deployRuntime: false/);
  assert.match(automation, /'acr', 'build'/);
  assert.match(automation, /'acr', 'agentpool', 'delete'/);
  assert.match(automation, /@sha256:/);
  assert.match(automation, /has\('--confirm-deploy'\) \? 'create' : 'what-if'/);
  assert.match(automation, /if \(action === 'what-if'\) args\.push\('--no-pretty-print'\)/);
});

test('enterprise image publication supports a fresh checkout with an allowlisted build context', async () => {
  const [ignore, dockerfile, automation] = await Promise.all([
    source('.dockerignore'),
    source('server/Dockerfile.enterprise-litellm'),
    source('scripts/enterprise-pilot.mjs'),
  ]);
  const rules = new Set(ignore.trim().split('\n'));
  assert.equal(rules.has('**'), true);
  for (const path of [
    'server/',
    'server/Dockerfile.enterprise-litellm',
    'server/litellm-github-copilot-bootstrap/',
    ...[...dockerfile.matchAll(/^COPY (?!--from=)(\S+) \S+$/gm)]
      .map(match => match[1]!),
  ]) {
    assert.equal(rules.has(`!${path}`), true, `build context excludes ${path}`);
  }
  assert.equal(rules.has('!server/*'), false);
  assert.match(automation, /mkdirSync\(resolve\(root, '\.azure'\), \{ recursive: true, mode: 0o700 \}\)/);
});

test('the control plane and central LiteLLM enforce separate single-tenant authorization', async () => {
  const [platform, authenticator, entraAutomation] = await Promise.all([
    source('infra/enterprise/modules/platform.bicep'),
    source('src/enterprise-auth.ts'),
    source('scripts/enterprise-entra.mjs'),
  ]);

  assert.match(platform, /internal: false/);
  assert.equal((platform.match(/external: true/g) ?? []).length, 2);
  assert.equal((platform.match(/external: false/g) ?? []).length, 1);
  assert.equal((platform.match(/transport: 'auto'/g) ?? []).length, 2);
  assert.equal((platform.match(/transport: 'http'/g) ?? []).length, 1);
  assert.match(platform, /var entraTokenAudience = startsWith\(entraAudience, 'api:\/\/'\) \? substring\(entraAudience, 6\) : entraAudience/);
  assert.match(platform, /name: 'CCGC_ENTRA_AUDIENCE'[\s\S]*value: entraTokenAudience/);
  assert.match(platform, /name: 'CCGC_ENTRA_ROLE'[\s\S]*value: 'CCGC\.Access'/);
  assert.equal((platform.match(/name: 'CCGC_MODELS_JSON'/g) ?? []).length, 3);
  assert.match(platform, /enterprise-bootstrap\.ts/);
  assert.match(platform, /brokerIdentity[\s\S]*Key Vault Secrets Officer/);
  assert.match(platform, /bootstrapIdentity[\s\S]*Key Vault Secrets User/);
  assert.match(platform, /name: 'AZURE_CLIENT_ID'[\s\S]*value: brokerIdentity\.properties\.clientId/);
  assert.match(platform, /name: 'AZURE_CLIENT_ID'[\s\S]*value: bootstrapIdentity\.properties\.clientId/);
  assert.match(platform, /name: 'AZURE_CLIENT_ID'[\s\S]*value: litellmIdentity!\.properties\.clientId/);
  assert.match(platform, /name: 'CCGC_DATABASE_PRINCIPALS_JSON'/);
  assert.match(platform, /name: 'CCGC_LITELLM_PUBLIC_URL'/);
  assert.match(platform, /var litellmGatewayUrl = managedLiteLLM \? managedLiteLLMUrl : existingLiteLLMUrl/);
  assert.match(platform, /var privateEnvironmentDomain = 'internal\.\$\{environment\.properties\.defaultDomain\}'/);
  assert.match(platform, /https:\/\/\$\{workerName\}\.\$\{privateEnvironmentDomain\}/);
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
    'employee', 'administrator', 'entra-id', 'control-plane',
    'litellm-gateway', 'key-vault', 'github-copilot', 'claude-models',
    'azure-monitor', 'shared-postgres',
  ]) assert.equal(ids.has(id), true, `missing design component ${id}`);

  assert.equal(ids.has('multiuser-worker'), false);
  const customerBoundary = architecture.boundaries.find(boundary =>
    boundary.label === 'One customer deployment / one Microsoft Entra tenant');
  assert.ok(customerBoundary?.wraps.includes('litellm-gateway'));

  const connections = new Set(architecture.connections.map(connection =>
    `${connection.from}->${connection.to}`));
  for (const relationship of [
    'employee->litellm-gateway',
    'litellm-gateway->github-copilot',
    'github-copilot->claude-models',
    'administrator->entra-id',
    'entra-id->control-plane',
    'entra-id->litellm-gateway',
    'control-plane->litellm-gateway',
    'key-vault->litellm-gateway',
    'litellm-gateway->shared-postgres',
  ]) {
    const [from, to] = relationship.split('->');
    assert.equal(
      connections.has(relationship) || connections.has(`${to}->${from}`),
      true,
      `missing design relationship ${relationship}`,
    );
  }

  assert.match(platform, /resource broker 'Microsoft\.App\/containerApps@2025-01-01'/);
  assert.match(platform, /resource litellm 'Microsoft\.App\/containerApps@2025-01-01'/);
  assert.match(platform, /minReplicas: 2[\s\S]*maxReplicas: 10/);
  assert.match(platform, /resource worker[\s\S]*if \(deployRuntime && deployLegacyWorker\)/);
  assert.match(platform, /resource litellm[\s\S]*minReplicas: 2[\s\S]*maxReplicas: 10/);
  assert.match(platform, /litellmKeyVaultAccess[\s\S]*Key Vault Secrets User/);
  assert.match(platform, /APPLICATIONINSIGHTS_CONNECTION_STRING/g);
});
