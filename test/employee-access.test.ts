import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { describeAccess, findSecretsFile, parseOptions, readMasterKey, runAccess } from '../scripts/employee-access.mjs';
import { GITHUB_MCP_CONFIG } from '../scripts/github-mcp.mjs';

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

const run = async (_command: string, args: string[]) => (args[0] === 'repo' ? 'example/repository' : 'https://litellm.example');

interface Call {
  path: string;
  method: string;
  authorization: string | null;
  body?: Record<string, unknown>;
}

// The gateway starts with the restricted GitHub MCP server registered unless mcpRegistered is false.
function mockFetch({ mcpRegistered = true } = {}) {
  const calls: Call[] = [];
  let mcpServer: Record<string, unknown> | undefined = mcpRegistered ? { ...GITHUB_MCP_CONFIG } : undefined;
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    calls.push({ path: `${url.hostname}${url.pathname}`, method, authorization: new Headers(init?.headers).get('authorization'), body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (url.hostname === 'api.github.com') return json({ id: 14850440, login: 'Example-User', type: 'User' });
    if (url.pathname === '/user/list') return json({ users: [], total_pages: 1 });
    if (url.pathname === '/v1/mcp/server/ccgc-github-web-search' && method === 'GET') {
      return mcpServer ? json(mcpServer) : json({}, 404);
    }
    if (url.pathname === '/v1/mcp/server' && method === 'POST') {
      mcpServer = body;
      return json(body);
    }
    if (url.pathname === '/v1/models') return json({ data: [{ id: 'claude-sonnet-5.5' }] });
    if (url.pathname === '/user/new') return json({ status: 'ok' });
    if (url.pathname === '/key/generate') {
      return json({ key: employeeKey, expires: new Date(Date.now() + 90 * 86_400_000).toISOString() });
    }
    throw new Error(`Unexpected request ${method} ${url.pathname}`);
  };
  return { calls, fetcher };
}

function assertKeyKeepsWebSearch(calls: Call[]) {
  const key = calls.find(call => call.path === 'litellm.example/key/generate')?.body;
  const routes = (key?.allowed_routes ?? []) as string[];
  for (const route of ['/github/mcp', '/mcp', '/mcp/']) assert.ok(routes.includes(route), `${route} is allowed`);
  assert.ok(!routes.includes('/v1/mcp/server'));
  assert.deepEqual(key?.object_permission, {
    mcp_servers: ['ccgc-github-web-search'],
    mcp_tool_permissions: { 'ccgc-github-web-search': ['web_search'] },
  });
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

test('local access fails instead of guessing when a candidate secrets file cannot be inspected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccgc-access-'));
  try {
    await writeSecrets(root, firstSubscription);
    // A symlink to itself makes stat fail with ELOOP, not ENOENT, like an unreadable file would.
    await mkdir(join(root, secondSubscription), { recursive: true });
    await symlink('ccgc-pilot.json', join(root, secondSubscription, 'ccgc-pilot.json'));

    await assert.rejects(findSecretsFile({ prefix: 'ccgc-pilot' }, root), { code: 'ELOOP' });

    await rm(join(root, firstSubscription), { recursive: true });
    await assert.rejects(findSecretsFile({ prefix: 'ccgc-pilot' }, root), { code: 'ELOOP' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('local enrollment writes the setup file, then issues the key with the master key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccgc-access-'));
  try {
    await writeSecrets(root, firstSubscription);
    const installerFile = join(root, 'setup.command');
    const { calls, fetcher } = mockFetch();
    const options = parseOptions(['enroll', 'Example-User', '--installer', installerFile]);
    assert.ok(!('help' in options));

    const outcome = await runAccess(options, { fetcher, run, configRoot: root });
    assert.match(await readFile(installerFile, 'utf8'), /^DEFAULT_GATEWAY='https:\/\/litellm\.example'$/m);
    const litellmCalls = calls.filter(call => call.path.startsWith('litellm.example/'));
    assert.ok(litellmCalls.some(call => call.path === 'litellm.example/key/generate'));
    assert.ok(litellmCalls.every(call => call.authorization === `Bearer ${masterKey}`));
    assertKeyKeepsWebSearch(calls);
    assert.ok(!calls.some(call => call.method === 'POST' && call.path === 'litellm.example/v1/mcp/server'));
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

test('local enrollment registers the restricted GitHub MCP server before issuing a key that uses it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccgc-access-'));
  try {
    await writeSecrets(root, firstSubscription);
    const { calls, fetcher } = mockFetch({ mcpRegistered: false });
    const options = parseOptions(['enroll', 'Example-User', '--installer', join(root, 'setup.command')]);
    assert.ok(!('help' in options));
    await runAccess(options, { fetcher, run, configRoot: root });

    const registrations = calls.filter(call => call.method === 'POST' && call.path === 'litellm.example/v1/mcp/server');
    assert.equal(registrations.length, 1);
    const server = registrations[0];
    assert.equal(server?.authorization, `Bearer ${masterKey}`);
    assert.equal(server?.body?.url, 'https://api.githubcopilot.com/mcp/readonly');
    assert.deepEqual(server?.body?.allowed_tools, ['web_search']);
    assert.equal(server?.body?.allow_all_keys, false);
    assert.equal(server?.body?.auth_type, 'none');
    assert.equal(server?.body?.credentials, undefined);
    assert.ok(server && calls.indexOf(server) < calls.findIndex(call => call.path === 'litellm.example/key/generate'));
    assertKeyKeepsWebSearch(calls);
  } finally { await rm(root, { recursive: true, force: true }); }
});
