import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { describeAccess, findSecretsFile, parseOptions, readMasterKey, runAccess } from '../scripts/employee-access.mjs';

const masterKey = `sk-${'m'.repeat(32)}`;
const employeeKey = `sk-${'u'.repeat(32)}`;
const firstSubscription = '11111111-1111-4111-8111-111111111111';
const secondSubscription = '22222222-2222-4222-8222-222222222222';

async function writeSecrets(root: string, subscription: string, prefix = 'ccgc-pilot') {
  const directory = join(root, subscription);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${prefix}.json`);
  await writeFile(path, JSON.stringify({ litellmMasterKey: masterKey }), { mode: 0o600 });
  return path;
}

function mockFetch() {
  const calls: Array<{ path: string; authorization: string | null }> = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    calls.push({ path: `${url.hostname}${url.pathname}`, authorization: new Headers(init?.headers).get('authorization') });
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    if (url.hostname === 'api.github.com') return json({ id: 14850440, login: 'Example-User', type: 'User' });
    if (url.pathname === '/user/list') return json({ users: [], total_pages: 1 });
    if (url.pathname === '/v1/models') return json({ data: [{ id: 'claude-sonnet-5.5' }] });
    if (url.pathname === '/user/new') return json({ status: 'ok' });
    if (url.pathname === '/key/generate') {
      return json({ key: employeeKey, expires: new Date(Date.now() + 90 * 86_400_000).toISOString() });
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  };
  return { calls, fetcher };
}

test('local access takes an action and one valid GitHub username', () => {
  const parsed = parseOptions(['enroll', 'Example-User', '--subscription', firstSubscription.toUpperCase()]);
  assert.ok(!('help' in parsed));
  assert.equal(parsed.action, 'enroll');
  assert.equal(parsed.prefix, 'ccgc-pilot');
  assert.equal(parsed.subscription, firstSubscription);
  for (const argv of [
    ['delete', 'Example-User'], ['enroll'], ['revoke', 'a', 'b'], ['enroll', 'bad_login'],
    ['enroll', 'a', '--subscription', firstSubscription, '--secrets-file', 'secrets.json'],
  ]) {
    assert.throws(() => parseOptions(argv), Error, argv.join(' '));
  }
});

test('local access reads the master key from the only private secrets file for the prefix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccgc-access-'));
  try {
    const first = await writeSecrets(root, firstSubscription);
    await writeSecrets(root, secondSubscription, 'other-prefix');
    assert.equal(await findSecretsFile({ prefix: 'ccgc-pilot' }, root), first);
    assert.equal(await readMasterKey(first), masterKey);
    await assert.rejects(findSecretsFile({ prefix: 'missing-prefix' }, root), /No secrets file for prefix missing-prefix/);

    const second = await writeSecrets(root, secondSubscription);
    await assert.rejects(findSecretsFile({ prefix: 'ccgc-pilot' }, root), /Several subscriptions/);
    assert.equal(await findSecretsFile({ prefix: 'ccgc-pilot', subscription: secondSubscription }, root), second);

    await chmod(second, 0o644);
    await assert.rejects(readMasterKey(second), /chmod 600/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('local enrollment writes the setup file, then issues the key with the master key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccgc-access-'));
  try {
    await writeSecrets(root, firstSubscription);
    const run = async (_command: string, args: string[]) => (args[0] === 'repo' ? 'example/repository' : 'https://litellm.example');
    const installerFile = join(root, 'setup.command');
    const { calls, fetcher } = mockFetch();
    const options = parseOptions(['enroll', 'Example-User', '--installer', installerFile]);
    assert.ok(!('help' in options));

    const outcome = await runAccess(options, { fetcher, run, configRoot: root });
    assert.match(await readFile(installerFile, 'utf8'), /^DEFAULT_GATEWAY='https:\/\/litellm\.example'$/m);
    const litellmCalls = calls.filter(call => call.path.startsWith('litellm.example/'));
    assert.ok(litellmCalls.some(call => call.path === 'litellm.example/key/generate'));
    assert.ok(litellmCalls.every(call => call.authorization === `Bearer ${masterKey}`));
    const summary = describeAccess(outcome);
    assert.ok(summary.includes(`  ${employeeKey}\n`));
    assert.ok(summary.includes(installerFile));

    // A setup file that cannot be written must stop enrollment before LiteLLM is called.
    const blocked = mockFetch();
    await writeFile(join(root, 'not-a-directory'), '');
    const unwritable = parseOptions(['enroll', 'Example-User', '--installer', join(root, 'not-a-directory', 'setup.command')]);
    assert.ok(!('help' in unwritable));
    await assert.rejects(runAccess(unwritable, { fetcher: blocked.fetcher, run, configRoot: root }));
    assert.deepEqual(blocked.calls, []);

    const revoked = parseOptions(['revoke', 'Example-User', '--installer', join(root, 'revoke.command')]);
    assert.ok(!('help' in revoked));
    const revocation = await runAccess(revoked, { fetcher: mockFetch().fetcher, run, configRoot: root });
    assert.match(describeAccess(revocation), /nothing to revoke/);
    await assert.rejects(stat(join(root, 'revoke.command')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
