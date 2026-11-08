import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deploy, parseOptions } from '../scripts/deploy.mjs';
import type { BootstrapOptions } from '../scripts/litellm-bootstrap.mjs';

const subscription = '00000000-0000-4000-8000-000000000001';

interface Command {
  command: string;
  args: string[];
  input?: string;
  parameterFile?: string;
  parameters?: { parameters: Record<string, { value: string }> };
  parameterMode?: number;
}

function fakeCli({ groupExists = false } = {}) {
  const commands: Command[] = [];
  const run = async (command: string, args: string[], options: { input?: string } = {}) => {
    const entry: Command = { command, args, input: options.input };
    commands.push(entry);
    const parameterArgument = args.find(arg => arg.startsWith('@'));
    if (parameterArgument) {
      entry.parameterFile = parameterArgument.slice(1);
      entry.parameters = JSON.parse(await readFile(entry.parameterFile, 'utf8'));
      entry.parameterMode = (await stat(entry.parameterFile)).mode & 0o777;
    }
    const line = `${command} ${args.join(' ')}`;
    if (line.startsWith('az account show')) return JSON.stringify({ id: subscription, name: 'Test subscription' });
    if (line.startsWith('az group exists')) return String(groupExists);
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

function options(directory: string, extra: string[] = []) {
  const parsed = parseOptions(['--subscription', subscription, '--secrets-file', join(directory, 'secrets.json'), ...extra]);
  assert.ok(!('help' in parsed));
  return parsed;
}

async function secretValues(directory: string): Promise<string[]> {
  return Object.values(JSON.parse(await readFile(join(directory, 'secrets.json'), 'utf8')) as Record<string, string>);
}

test('deploy previews by default and keeps generated secrets out of command arguments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ccgc-deploy-test-'));
  try {
    const cli = fakeCli();
    const result = await deploy(options(directory), { run: cli.run, log: () => {} });
    assert.equal(result.deployed, false);
    const preview = cli.commands.find(entry => entry.args.slice(0, 3).join(' ') === 'deployment sub what-if');
    assert.ok(preview?.parameters && preview.parameterFile);
    assert.equal(cli.commands.some(entry => entry.args.includes('create')), false);
    assert.equal((await stat(join(directory, 'secrets.json'))).mode & 0o777, 0o600);
    assert.equal(preview.parameterMode, 0o600);
    await assert.rejects(stat(preview.parameterFile), { code: 'ENOENT' });
    const secrets = await secretValues(directory);
    assert.match(preview.parameters.parameters.litellmMasterKey!.value, /^sk-[A-Za-z0-9_-]{43}$/);
    for (const secret of secrets) {
      assert.ok(Object.values(preview.parameters.parameters).some(parameter => parameter.value === secret));
      for (const entry of cli.commands) assert.equal(entry.args.join(' ').includes(secret), false);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('deploy refuses to invent new secrets for an existing resource group', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ccgc-deploy-test-'));
  try {
    const cli = fakeCli({ groupExists: true });
    await assert.rejects(deploy(options(directory), { run: cli.run, log: () => {} }), /resource group already exists/);
    assert.equal(cli.commands.some(entry => entry.args[0] === 'deployment'), false);
    await assert.rejects(stat(join(directory, 'secrets.json')), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('confirmed deploy bootstraps LiteLLM and gives GitHub the master key only on stdin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ccgc-deploy-test-'));
  try {
    const cli = fakeCli();
    const bootstraps: BootstrapOptions[] = [];
    const result = await deploy(options(directory, ['--confirm-deploy', '--models', 'claude-sonnet-5.5']), {
      run: cli.run,
      log: () => {},
      sleep: async () => {},
      fetcher: async () => new Response(JSON.stringify({ db: 'connected', litellm_version: '1.108.3' })),
      bootstrap: async input => {
        bootstraps.push(input);
        return { createdCredential: true, createdModels: ['claude-sonnet-5.5'], models: ['claude-sonnet-5.5'] };
      },
    });
    const masterKey = JSON.parse(await readFile(join(directory, 'secrets.json'), 'utf8')).litellmMasterKey as string;
    assert.equal(result.deployed, true);
    assert.equal(result.litellmUrl, 'https://litellm.example');
    assert.equal(bootstraps.length, 1);
    assert.equal(bootstraps[0]!.litellmUrl, 'https://litellm.example');
    assert.equal(bootstraps[0]!.masterKey, masterKey);
    assert.deepEqual(bootstraps[0]!.models, ['claude-sonnet-5.5']);
    const secret = cli.commands.find(entry => entry.args.slice(0, 3).join(' ') === 'secret set LITELLM_MASTER_KEY');
    assert.equal(secret?.input, masterKey);
    assert.deepEqual(secret?.args.slice(3), ['--env', 'ccgc-admin', '--repo', 'example/repository']);
    const variable = cli.commands.find(entry => entry.args.slice(0, 3).join(' ') === 'variable set LITELLM_URL');
    assert.ok(variable?.args.includes('https://litellm.example'));
    for (const entry of cli.commands) assert.equal(entry.args.join(' ').includes(masterKey), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
