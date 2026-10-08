import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../server/azure-deploy.sh', import.meta.url));

test('Azure templates and helper agree on one general-purpose D-series VM in Sweden Central', async () => {
  const parameters = JSON.parse(await readFile(new URL('../infra/main.parameters.json', import.meta.url), 'utf8')).parameters;
  const sku: string = parameters.vmSize.value;
  assert.match(sku, /^Standard_D2(?:a)?s_v[56]$/);
  assert.equal(parameters.location.value, 'swedencentral');
  for (const name of ['main.bicep', 'vm.bicep']) {
    const source = await readFile(new URL(`../infra/${name}`, import.meta.url), 'utf8');
    const beforeParameter = source.slice(0, source.indexOf('param vmSize string'));
    const allowed = beforeParameter.slice(beforeParameter.lastIndexOf('@allowed('));
    assert.deepEqual([...allowed.matchAll(/'([^']+)'/g)].map(match => match[1]), [sku]);
  }
  const vm = await readFile(new URL('../infra/vm.bicep', import.meta.url), 'utf8');
  assert.match(vm, /disablePasswordAuthentication: true/);
  assert.match(vm, /diskSizeGB: 64/);
  const help = spawnSync('bash', [script, '--help'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(help.status, 0, help.stderr);
  assert.ok(help.stdout.includes(sku));
});

test('Azure SSH uses a shared source-restricted JIT policy, never a permanent allow rule', async () => {
  const vm = await readFile(new URL('../infra/vm.bicep', import.meta.url), 'utf8');
  const access = await readFile(new URL('../infra/access.bicep', import.meta.url), 'utf8');
  assert.match(vm, /module sshAccess '\.\/access\.bicep'/);
  assert.doesNotMatch(vm, /allow-ssh-operator|destinationPortRange: '22'/);
  assert.match(vm, /priority: 1000/);
  assert.match(vm, /priority: 1001/);
  assert.match(vm, /priority: 4095/);
  assert.match(access, /Microsoft\.Security\/locations\/jitNetworkAccessPolicies@2020-01-01/);
  assert.match(access, /number: 22/);
  assert.match(access, /protocol: 'TCP'/);
  assert.ok(access.includes("allowedSourceAddressPrefix: '${operatorIpv4Address}/32'"));
  assert.match(access, /maxRequestAccessDuration: 'PT1H'/);
  assert.match(access, /resource vm .* existing =/);
  assert.doesNotMatch(access, /\brequests:|3389|Microsoft\.Network/);
});

test('Azure commands require explicit deployment approval and constrain SSH and the region', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ccgc-azure-cli-'));
  try {
    const az = join(directory, 'az');
    await writeFile(az, '#!/usr/bin/env python3\nimport json,sys\nprint(json.dumps(sys.argv[1:]))\n', { mode: 0o700 });
    await chmod(az, 0o700);
    const key = join(directory, 'operator.pub');
    await writeFile(key, 'ssh-ed25519 c3ludGhldGlj synthetic-test-only\n');
    const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, CCGC_SSH_PUBLIC_KEY_FILE: key, CCGC_OPERATOR_IPV4_CIDR: '8.8.8.8/32', CCGC_APPROVE_PROVISIONING: '', CCGC_APPROVE_ACCESS: '' };
    const run = (args: string[], overrides: Record<string, string> = {}) =>
      spawnSync('bash', [script, ...args], { encoding: 'utf8', timeout: 10000, env: { ...env, ...overrides } });
    for (const args of [['provision'], ['access-configure'], ['access-open'], ['unknown'], ['validate', '--location', 'westus2'], ['access-open', '--port', '3389']]) {
      const result = run(args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /AZURE_DEPLOY_BLOCKED/);
      assert.equal(result.stdout, '');
    }
    for (const cidr of ['', '8.8.8.8', '0.0.0.0/0', '8.8.8.8/24', '127.0.0.1/32', '10.0.0.1/32', '224.0.0.1/32', '::1/128', 'invalid']) {
      for (const action of ['validate', 'access-what-if', 'access-configure', 'access-open']) {
        const result = run([action], { CCGC_OPERATOR_IPV4_CIDR: cidr, CCGC_APPROVE_ACCESS: 'yes' });
        assert.equal(result.status, 1, cidr);
        assert.match(result.stderr, /AZURE_DEPLOY_BLOCKED/);
        assert.equal(result.stdout, '');
      }
    }
    for (const action of ['validate', 'what-if', 'provision']) {
      const result = run([action], { CCGC_APPROVE_PROVISIONING: 'yes' });
      assert.equal(result.status, 0, result.stderr);
      const args: string[] = JSON.parse(result.stdout);
      assert.deepEqual(args.slice(0, 3), ['deployment', 'sub', action === 'provision' ? 'create' : action]);
      assert.equal(args[args.indexOf('--location') + 1], 'swedencentral');
      assert.equal(args[args.indexOf('--subscription') + 1], 'b8242aba-c397-4474-82e4-c96cbfd7fa7b');
      assert.ok(args.includes('operatorIpv4Address=8.8.8.8'));
      assert.ok(args.some(value => value.endsWith('/infra/main.parameters.json')));
    }
    for (const action of ['access-what-if', 'access-configure']) {
      const result = run([action], { CCGC_APPROVE_ACCESS: action === 'access-configure' ? 'yes' : '', CCGC_SSH_PUBLIC_KEY_FILE: '' });
      assert.equal(result.status, 0, result.stderr);
      const args: string[] = JSON.parse(result.stdout);
      assert.deepEqual(args.slice(0, 3), ['deployment', 'group', action === 'access-configure' ? 'create' : 'what-if']);
      assert.equal(args[args.indexOf('--subscription') + 1], 'b8242aba-c397-4474-82e4-c96cbfd7fa7b');
      assert.equal(args[args.indexOf('--resource-group') + 1], 'rg-ccgc-dev-87b7');
      assert.equal(args[args.indexOf('--mode') + 1], 'Incremental');
      assert.ok(args.some(value => value.endsWith('/infra/access.bicep')));
      assert.ok(args.includes('operatorIpv4Address=8.8.8.8'));
      assert.ok(args.includes('location=swedencentral'));
      assert.ok(args.includes('vmName=vm-ccgc-dev-87b7'));
      assert.ok(!args.some(value => value.startsWith('sshPublicKey=')));
    }
    const beforeRequest = Date.now();
    const opened = run(['access-open'], { CCGC_APPROVE_ACCESS: 'yes', CCGC_SSH_PUBLIC_KEY_FILE: '' });
    assert.equal(opened.status, 0, opened.stderr);
    const openArgs: string[] = JSON.parse(opened.stdout);
    assert.deepEqual(openArgs.slice(0, 3), ['rest', '--method', 'post']);
    assert.equal(openArgs[openArgs.indexOf('--subscription') + 1], 'b8242aba-c397-4474-82e4-c96cbfd7fa7b');
    assert.match(openArgs[openArgs.indexOf('--url') + 1]!, /\/locations\/swedencentral\/jitNetworkAccessPolicies\/ccgc-ssh\/initiate\?api-version=2020-01-01$/);
    const request = JSON.parse(openArgs[openArgs.indexOf('--body') + 1]!);
    assert.equal(request.virtualMachines.length, 1);
    assert.equal(request.virtualMachines[0].id, '/subscriptions/b8242aba-c397-4474-82e4-c96cbfd7fa7b/resourceGroups/rg-ccgc-dev-87b7/providers/Microsoft.Compute/virtualMachines/vm-ccgc-dev-87b7');
    const ports = request.virtualMachines[0].ports;
    assert.equal(ports.length, 1);
    assert.equal(ports[0].number, 22);
    assert.equal(ports[0].allowedSourceAddressPrefix, '8.8.8.8/32');
    assert.ok(Date.parse(ports[0].endTimeUtc) >= beforeRequest + 54 * 60_000);
    assert.ok(Date.parse(ports[0].endTimeUtc) <= Date.now() + 55 * 60_000);
    await writeFile(key, '-----BEGIN OPENSSH PRIVATE KEY-----\nnever-upload-me\n');
    const privateInput = run(['validate']);
    assert.equal(privateInput.status, 1);
    assert.doesNotMatch(privateInput.stderr + privateInput.stdout, /never-upload-me/);
    await writeFile(key, 'ssh-ed25519 c3ludGhldGlj one\nssh-ed25519 c3ludGhldGlj two\n');
    assert.equal(run(['validate']).status, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Azure source packaging allowlists files, excludes credentials, and refuses overwrite or symlinks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ccgc-azure-package-'));
  try {
    const root = join(directory, 'checkout with spaces');
    await mkdir(join(root, 'server'), { recursive: true });
    await mkdir(join(root, 'src'));
    const copied = join(root, 'server', 'azure-deploy.sh');
    await copyFile(script, copied);
    const allowed = ['.dockerignore', 'package.json', 'server/Dockerfile', 'server/pyproject.toml',
      'server/bootstrap.py', 'server/compose.yaml', 'server/Caddyfile',
      'server/integration_litellm.py', 'server/test_bootstrap.py', 'server/deploy-host.sh', 'src/serve.ts'];
    for (const file of allowed) await writeFile(join(root, file), 'synthetic-source\n');
    await writeFile(join(root, 'owner.key'), 'secret-must-not-upload');
    await writeFile(join(root, '.env'), 'secret-must-not-upload');
    const archive = join(directory, 'source.tar.gz');
    const run = (target: string) => spawnSync('bash', [copied, 'package', target], { encoding: 'utf8', timeout: 10000 });
    const result = run(archive);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /SHA256: [a-f0-9]{64}/);
    const listed = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8', timeout: 10000 });
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(listed.stdout.trim().split('\n').sort(), allowed.sort());
    const before = await readFile(archive);
    assert.equal(run(archive).status, 1);
    assert.deepEqual(await readFile(archive), before);
    assert.equal(run(join(root, 'inside.tar.gz')).status, 1);
    await rm(join(root, 'src', 'serve.ts'));
    await symlink(join(root, 'owner.key'), join(root, 'src', 'serve.ts'));
    const rejected = run(join(directory, 'unsafe.tar.gz'));
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /without symlink/);
    assert.doesNotMatch(rejected.stdout, /secret-must-not-upload/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
