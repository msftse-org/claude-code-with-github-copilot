import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { deploy, generateSecrets, parseOptions } from '../scripts/deploy.mjs';
import type { BootstrapOptions } from '../scripts/litellm-bootstrap.mjs';

const subscription = '00000000-0000-4000-8000-000000000001';
const tenant = '00000000-0000-4000-8000-000000000002';
const storageBlobDataContributor = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe';
const stateAccountId = '/subscriptions/example/providers/Microsoft.Storage/storageAccounts/state';
const perimeter = `/subscriptions/${subscription}/resourceGroups/rg-ccgc-pilot-tfstate`
  + '/providers/Microsoft.Network/networkSecurityPerimeters/nsp-ccgc-pilot-tfstate';
const perimeterProfile = `${perimeter}/profiles/terraform-state`;

interface Command {
  command: string;
  args: string[];
  input?: string;
  env?: Record<string, string>;
  workspace?: string[];
  varFile?: string;
  variables?: Record<string, string>;
  varFileMode?: number;
  parameterFile?: string;
  parameters?: { parameters: Record<string, { value: string }> };
  parameterMode?: number;
}

function fakeCli({
  groupExists = false,
  stateStorageExists = false,
  terraformState = '',
  statePublicNetworkAccess = 'SecuredByPerimeter',
  associationStates = ['Succeeded'],
  applyFailures = 0,
  plannedChanges = [] as unknown[],
  diagnosticSettings = {} as Record<string, string[]>,
} = {}) {
  const commands: Command[] = [];
  const run = async (command: string, args: string[], options: { input?: string; env?: Record<string, string> } = {}) => {
    const entry: Command = { command, args, input: options.input, env: options.env };
    commands.push(entry);
    const parameterArgument = args.find(arg => arg.startsWith('@'));
    if (parameterArgument) {
      entry.parameterFile = parameterArgument.slice(1);
      entry.parameters = JSON.parse(await readFile(entry.parameterFile, 'utf8'));
      entry.parameterMode = (await stat(entry.parameterFile)).mode & 0o777;
    }
    const chdir = args.find(arg => arg.startsWith('-chdir='));
    if (chdir) entry.workspace = await readdir(chdir.slice('-chdir='.length));
    const varFile = args.find(arg => arg.startsWith('-var-file='));
    if (varFile) {
      entry.varFile = varFile.slice('-var-file='.length);
      entry.variables = JSON.parse(await readFile(entry.varFile, 'utf8'));
      entry.varFileMode = (await stat(entry.varFile)).mode & 0o777;
    }
    const line = `${command} ${args.join(' ')}`;
    if (line.startsWith('az account show')) {
      return JSON.stringify({ id: subscription, name: 'Test subscription', tenantId: tenant, user: { name: 'admin@example.com', type: 'user' } });
    }
    if (line.startsWith('az group exists --name rg-ccgc-pilot-tfstate')) return String(stateStorageExists);
    if (line.startsWith('az group exists')) return String(groupExists);
    if (line.startsWith('az storage account list')) return stateStorageExists ? '1' : '0';
    if (line.startsWith('az storage account create')) return stateAccountId;
    if (line.startsWith('az storage account show')) {
      return JSON.stringify({ id: stateAccountId, publicNetworkAccess: statePublicNetworkAccess });
    }
    if (line.startsWith('az rest --method get')) return associationStates.length > 1 ? associationStates.shift()! : associationStates[0]!;
    if (line.startsWith('az storage container-rm list') || line.startsWith('az role assignment list')) return '0';
    if (line.startsWith('az ad signed-in-user show')) return 'deployer-object-id';
    if (/^az (group create|storage account (blob-service-properties )?update|storage container-rm create|role assignment create|storage blob list|rest --method put) /.test(line)) return '';
    if (line === 'terraform version -json') return JSON.stringify({ terraform_version: '1.14.3' });
    if (command === 'terraform' && args[1] === 'state') return terraformState;
    if (command === 'terraform' && args[1] === 'output') {
      return JSON.stringify({
        litellm_url: { value: 'https://litellm.example' },
        egress_ip: { value: '203.0.113.10' },
        resource_group_name: { value: 'rg-ccgc-pilot-enterprise' },
      });
    }
    if (command === 'terraform' && args[1] === 'apply' && applyFailures-- > 0) throw new Error('terraform apply failed');
    if (command === 'terraform' && args[1] === 'show') return JSON.stringify({ resource_changes: plannedChanges });
    if (line.startsWith('az monitor diagnostic-settings list')) {
      return JSON.stringify(diagnosticSettings[argumentAfter(entry, '--resource')!] ?? []);
    }
    if (command === 'terraform' && ['init', 'plan', 'apply', 'import'].includes(args[1]!)) return '';
    if (line.startsWith('az deployment sub what-if')) return '';
    if (line.startsWith('az deployment sub create')) {
      return JSON.stringify({
        litellmUrl: { value: 'https://litellm.example' },
        egressIp: { value: '203.0.113.10' },
        resourceGroupName: { value: 'rg-ccgc-pilot-enterprise' },
      });
    }
    if (line.startsWith('gh repo view')) return 'example/repository';
    if (line.startsWith('gh api') || line.startsWith('gh variable set') || line.startsWith('gh secret set')) return '';
    throw new Error(`unexpected command: ${line}`);
  };
  return { commands, run };
}

function terraform(commands: Command[], subcommand: string) {
  return commands.find(entry => entry.command === 'terraform' && entry.args[1] === subcommand);
}

function argumentAfter(entry: Command | undefined, flag: string) {
  return entry?.args[entry.args.indexOf(flag) + 1];
}

function indexOf(commands: Command[], prefix: string) {
  return commands.findIndex(entry => `${entry.command} ${entry.args.join(' ')}`.startsWith(prefix));
}

function perimeterWrites(commands: Command[]) {
  return commands.filter(entry => entry.args.slice(0, 3).join(' ') === 'rest --method put').map(entry => ({
    url: argumentAfter(entry, '--url')!,
    body: JSON.parse(argumentAfter(entry, '--body')!),
    index: commands.indexOf(entry),
  }));
}

function options(directory: string, extra: string[] = []) {
  const parsed = parseOptions(['--subscription', subscription, '--secrets-file', join(directory, 'secrets.json'), ...extra]);
  assert.ok(!('help' in parsed));
  return parsed;
}

async function secretValues(directory: string): Promise<string[]> {
  return Object.values(JSON.parse(await readFile(join(directory, 'secrets.json'), 'utf8')) as Record<string, string>);
}

function assertNoSecretArguments(commands: Command[], secrets: string[]) {
  for (const secret of secrets) {
    for (const entry of commands) assert.equal(entry.args.join(' ').includes(secret), false);
  }
}

test('Terraform preview plans against empty local state and passes secrets only in a private, deleted file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ccgc-deploy-test-'));
  try {
    const cli = fakeCli();
    const result = await deploy(options(directory, ['--store-prompts-in-spend-logs', 'true']), {
      run: cli.run, log: () => {},
      bootstrap: async () => { assert.fail('preview must not apply models or logging policy'); },
    });
    assert.equal(result.deployed, false);
    const init = terraform(cli.commands, 'init');
    const plan = terraform(cli.commands, 'plan');
    assert.ok(init && plan);
    assert.ok(init.workspace?.includes('local_backend_override.tf') && init.workspace.includes('.terraform.lock.hcl'));
    assert.equal(init.args.some(arg => arg.startsWith('-backend-config')), false);
    assert.ok(plan.args.includes('-var=name_seed=litellm2') && plan.args.includes(`-var=tenant_id=${tenant}`));
    assert.equal(terraform(cli.commands, 'apply'), undefined);
    assert.equal(cli.commands.some(entry => entry.command === 'az' && entry.args.includes('create')), false);
    const secrets = JSON.parse(await readFile(join(directory, 'secrets.json'), 'utf8')) as Record<string, string>;
    assert.deepEqual(plan.variables, {
      postgres_admin_password: secrets.postgresAdminPassword,
      litellm_master_key: secrets.litellmMasterKey,
      litellm_salt_key: secrets.litellmSaltKey,
    });
    assert.equal(plan.varFileMode, 0o600);
    await assert.rejects(stat(plan.varFile!), { code: 'ENOENT' });
    for (const entry of cli.commands) {
      assert.equal(Object.values(entry.env ?? {}).some(value => Object.values(secrets).includes(value)), false);
    }
    assertNoSecretArguments(cli.commands, Object.values(secrets));
    assert.equal((await stat(join(directory, 'secrets.json'))).mode & 0o777, 0o600);
    await assert.rejects(stat(dirname(init.args[0]!.slice('-chdir='.length))), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Bicep preview keeps generated secrets in a private, deleted parameter file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ccgc-deploy-test-'));
  try {
    const cli = fakeCli();
    const result = await deploy(options(directory, ['--engine', 'bicep']), { run: cli.run, log: () => {} });
    assert.equal(result.deployed, false);
    const preview = cli.commands.find(entry => entry.args.slice(0, 3).join(' ') === 'deployment sub what-if');
    assert.ok(preview?.parameters && preview.parameterFile);
    assert.equal(cli.commands.some(entry => entry.command === 'terraform' || entry.args.includes('create')), false);
    assert.equal(preview.parameterMode, 0o600);
    await assert.rejects(stat(preview.parameterFile), { code: 'ENOENT' });
    const secrets = await secretValues(directory);
    assert.equal(preview.parameters.parameters.nameSeed!.value, 'litellm2');
    assert.match(preview.parameters.parameters.litellmMasterKey!.value, /^sk-[A-Za-z0-9_-]{43}$/);
    for (const secret of secrets) {
      assert.ok(Object.values(preview.parameters.parameters).some(parameter => parameter.value === secret));
    }
    assertNoSecretArguments(cli.commands, secrets);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('deploy refuses to invent new secrets for an existing resource group', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ccgc-deploy-test-'));
  try {
    const cli = fakeCli({ groupExists: true });
    await assert.rejects(deploy(options(directory), { run: cli.run, log: () => {} }), /resource group already exists/);
    assert.equal(cli.commands.some(entry => entry.command === 'terraform' || entry.args[0] === 'deployment'), false);
    await assert.rejects(stat(join(directory, 'secrets.json')), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Terraform refuses a resource group that was deployed without Terraform state', async () => {
  for (const [state, extra] of [
    [{ stateStorageExists: false }, []],
    [{ stateStorageExists: true }, ['--confirm-deploy', '--state-client-ip', '203.0.113.7']],
  ] as const) {
    const directory = await mkdtemp(join(tmpdir(), 'ccgc-deploy-test-'));
    try {
      await writeFile(join(directory, 'secrets.json'), JSON.stringify(generateSecrets()), { mode: 0o600 });
      const cli = fakeCli({ groupExists: true, ...state });
      await assert.rejects(deploy(options(directory, [...extra]), { run: cli.run, log: () => {}, sleep: async () => {} }),
        /deployed without Terraform/);
      assert.equal(terraform(cli.commands, 'plan') ?? terraform(cli.commands, 'apply'), undefined);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test('Terraform preview of a deployment admits only the given caller IP through the state perimeter before planning', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ccgc-deploy-test-'));
  try {
    await writeFile(join(directory, 'secrets.json'), JSON.stringify(generateSecrets()), { mode: 0o600 });
    const cli = fakeCli({
      groupExists: true, stateStorageExists: true, terraformState: 'azapi_resource.resource_group', statePublicNetworkAccess: 'Disabled',
    });
    const lookups: string[] = [];
    const result = await deploy(options(directory, ['--state-client-ip', '203.0.113.7']), {
      run: cli.run,
      log: () => {},
      sleep: async () => {},
      fetcher: async input => { lookups.push(String(input)); throw new Error('unexpected network call'); },
    });
    assert.equal(result.deployed, false);
    assert.deepEqual(lookups, []);
    const update = cli.commands.find(entry => entry.args.slice(0, 3).join(' ') === 'storage account update');
    assert.equal(argumentAfter(update, '--public-network-access'), 'SecuredByPerimeter');
    const rule = perimeterWrites(cli.commands).find(write => write.url.includes('/accessRules/'));
    assert.deepEqual(rule?.body, { properties: { direction: 'Inbound', addressPrefixes: ['203.0.113.7/32'] } });
    assert.equal(cli.commands.some(entry => entry.command === 'az' && entry.args.includes('create')), false);
    const init = terraform(cli.commands, 'init');
    assert.ok(init?.args.includes('-backend-config=key=ccgc-pilot.tfstate'));
    assert.ok(rule!.index < indexOf(cli.commands, 'az storage blob list') && indexOf(cli.commands, 'az storage blob list') < cli.commands.indexOf(init!));
    assert.ok(terraform(cli.commands, 'plan')?.args.includes('-lock=false'));
    assert.equal(terraform(cli.commands, 'apply'), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Terraform opens nothing in the state perimeter when it cannot detect the caller IP', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ccgc-deploy-test-'));
  try {
    await writeFile(join(directory, 'secrets.json'), JSON.stringify(generateSecrets()), { mode: 0o600 });
    const cli = fakeCli({ groupExists: true, stateStorageExists: true, terraformState: 'azapi_resource.resource_group' });
    await assert.rejects(deploy(options(directory), {
      run: cli.run, log: () => {}, sleep: async () => {}, fetcher: async () => new Response('<html>proxy login</html>'),
    }), /--state-client-ip/);
    assert.equal(cli.commands.some(entry => entry.args[0] === 'rest' || entry.args.includes('update')), false);
    assert.equal(terraform(cli.commands, 'init'), undefined);
    assert.throws(() => options(directory, ['--state-client-ip', '2001:db8::7']), /IPv4/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('confirmed Terraform deploy stores state in Azure, bootstraps LiteLLM, and gives GitHub the master key only on stdin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ccgc-deploy-test-'));
  try {
    const cli = fakeCli({ associationStates: ['Creating', 'Succeeded'] });
    const bootstraps: BootstrapOptions[] = [];
    const result = await deploy(options(directory, [
      '--confirm-deploy', '--store-prompts-in-spend-logs', 'true', '--models', 'claude-sonnet-5.5', '--installer', join(directory, 'setup.command'),
    ]), {
      run: cli.run,
      log: () => {},
      sleep: async () => {},
      fetcher: async input => new Response(String(input) === 'https://api.ipify.org'
        ? '198.51.100.20\n'
        : JSON.stringify({ db: 'connected', litellm_version: '1.108.3' })),
      bootstrap: async input => {
        bootstraps.push(input);
        return { createdCredential: true, createdModels: ['claude-sonnet-5.5'], models: ['claude-sonnet-5.5'] };
      },
    });
    const masterKey = JSON.parse(await readFile(join(directory, 'secrets.json'), 'utf8')).litellmMasterKey as string;
    assert.equal(result.deployed, true);
    assert.equal(result.litellmUrl, 'https://litellm.example');
    assert.equal(result.installer?.path, join(directory, 'setup.command'));
    assert.match(await readFile(join(directory, 'setup.command'), 'utf8'), /^DEFAULT_GATEWAY='https:\/\/litellm\.example'$/m);
    assert.equal((await stat(join(directory, 'setup.command'))).mode & 0o777, 0o700);

    const storage = cli.commands.find(entry => entry.args.slice(0, 3).join(' ') === 'storage account create');
    const account = argumentAfter(storage, '--name')!;
    assert.match(account, /^[a-z0-9]{3,24}$/);
    assert.equal(argumentAfter(storage, '--allow-shared-key-access'), 'false');
    assert.equal(argumentAfter(storage, '--public-network-access'), 'SecuredByPerimeter');
    const grant = cli.commands.find(entry => entry.args.slice(0, 3).join(' ') === 'role assignment create');
    assert.deepEqual([argumentAfter(grant, '--assignee-object-id'), argumentAfter(grant, '--role')],
      ['deployer-object-id', storageBlobDataContributor]);
    const writes = perimeterWrites(cli.commands);
    assert.deepEqual(writes.map(write => write.url), [
      `${perimeter}?api-version=2026-01-01`,
      `${perimeterProfile}?api-version=2026-01-01`,
      `${perimeterProfile}/accessRules/deployer-deployer-object-id?api-version=2026-01-01`,
      `${perimeter}/resourceAssociations/${account}?api-version=2026-01-01`,
    ]);
    assert.deepEqual(writes[2]!.body.properties.addressPrefixes, ['198.51.100.20/32']);
    assert.deepEqual(writes[3]!.body, {
      properties: { accessMode: 'Enforced', privateLinkResource: { id: stateAccountId }, profile: { id: perimeterProfile } },
    });
    assert.equal(cli.commands.filter(entry => entry.args.slice(0, 3).join(' ') === 'rest --method get').length, 2);
    assert.equal(indexOf(cli.commands, 'az storage account update'), -1);
    const init = terraform(cli.commands, 'init');
    assert.ok(writes[3]!.index < indexOf(cli.commands, 'az storage blob list')
      && indexOf(cli.commands, 'az storage blob list') < cli.commands.indexOf(init!));
    assert.deepEqual(init?.args.filter(arg => arg.startsWith('-backend-config=')), [
      `-backend-config=storage_account_name=${account}`,
      '-backend-config=container_name=tfstate',
      '-backend-config=key=ccgc-pilot.tfstate',
      `-backend-config=tenant_id=${tenant}`,
    ]);
    assert.equal(init?.workspace?.includes('local_backend_override.tf'), false);
    assert.equal(terraform(cli.commands, 'apply')?.variables?.litellm_master_key, masterKey);

    assert.equal(bootstraps.length, 1);
    assert.equal(bootstraps[0]!.storePromptsInSpendLogs, true);
    assert.equal(bootstraps[0]!.litellmUrl, 'https://litellm.example');
    assert.equal(bootstraps[0]!.masterKey, masterKey);
    assert.deepEqual(bootstraps[0]!.models, ['claude-sonnet-5.5']);
    const secret = cli.commands.find(entry => entry.args.slice(0, 3).join(' ') === 'secret set LITELLM_MASTER_KEY');
    assert.equal(secret?.input, masterKey);
    assert.deepEqual(secret?.args.slice(3), ['--env', 'ccgc-admin', '--repo', 'example/repository']);
    const variable = cli.commands.find(entry => entry.args.slice(0, 3).join(' ') === 'variable set LITELLM_URL');
    assert.ok(variable?.args.includes('https://litellm.example'));
    assertNoSecretArguments(cli.commands, await secretValues(directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const environmentId = '/subscriptions/example/resourceGroups/rg-ccgc-pilot-enterprise/providers/Microsoft.App/managedEnvironments/cae';
const vaultId = '/subscriptions/example/resourceGroups/rg-ccgc-pilot-enterprise/providers/Microsoft.KeyVault/vaults/kv';

function diagnosticSettingCreate(address: string, parentId: string | null) {
  return {
    address,
    type: 'azapi_resource',
    change: {
      actions: ['create'],
      after: { type: 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview', name: 'send-to-workspace', parent_id: parentId },
    },
  };
}

async function confirmedDeploy(directory: string, cli: ReturnType<typeof fakeCli>) {
  return deploy(options(directory, ['--confirm-deploy', '--installer', join(directory, 'setup.command')]), {
    run: cli.run,
    log: () => {},
    sleep: async () => {},
    fetcher: async input => new Response(String(input) === 'https://api.ipify.org' ? '198.51.100.20\n' : JSON.stringify({ db: 'connected' })),
    bootstrap: async () => ({ createdCredential: false, createdModels: [], models: [] }),
  });
}

test('Terraform deploy imports diagnostic settings Azure kept from deleted resources and retries the apply', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ccgc-deploy-test-'));
  try {
    const cli = fakeCli({
      applyFailures: 1,
      plannedChanges: [
        diagnosticSettingCreate('azapi_resource.environment_diagnostics', environmentId),
        diagnosticSettingCreate('azapi_resource.vault_diagnostics', vaultId),
        diagnosticSettingCreate('azapi_resource.other_diagnostics', null),
      ],
      diagnosticSettings: { [environmentId]: ['send-to-workspace'], [vaultId]: ['other-setting'] },
    });
    const result = await confirmedDeploy(directory, cli);
    assert.equal(result.deployed, true);
    assert.equal(cli.commands.filter(entry => entry.command === 'terraform' && entry.args[1] === 'apply').length, 2);
    const imports = cli.commands.filter(entry => entry.command === 'terraform' && entry.args[1] === 'import');
    assert.deepEqual(imports.map(entry => entry.args.slice(-2)), [[
      'azapi_resource.environment_diagnostics',
      `${environmentId}/providers/Microsoft.Insights/diagnosticSettings/send-to-workspace?api-version=2021-05-01-preview`,
    ]]);
    const masterKey = JSON.parse(await readFile(join(directory, 'secrets.json'), 'utf8')).litellmMasterKey as string;
    assert.equal(imports[0]!.variables?.litellm_master_key, masterKey);
    assert.ok(cli.commands.indexOf(imports[0]!) < cli.commands.findLastIndex(entry => entry.args[1] === 'apply'));
    assertNoSecretArguments(cli.commands, await secretValues(directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Terraform deploy reports the original apply failure when there is nothing to import', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ccgc-deploy-test-'));
  try {
    const cli = fakeCli({
      applyFailures: 1,
      plannedChanges: [diagnosticSettingCreate('azapi_resource.vault_diagnostics', vaultId)],
    });
    await assert.rejects(confirmedDeploy(directory, cli), /terraform apply failed/);
    assert.equal(cli.commands.filter(entry => entry.command === 'terraform' && entry.args[1] === 'apply').length, 1);
    assert.equal(terraform(cli.commands, 'import'), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
