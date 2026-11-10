import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureGitHubMcp, GITHUB_MCP_CONFIG } from '../scripts/github-mcp.mjs';

const options = { litellmUrl: 'https://gateway.example', masterKey: `sk-${'x'.repeat(32)}` };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

test('MCP registration is restricted, contains no shared credential, and is idempotent', async () => {
  let saved: Record<string, unknown> | undefined;
  let writes = 0;
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(new URL(String(input)).origin, options.litellmUrl);
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${options.masterKey}`);
    if (init?.method === 'POST') {
      writes++;
      saved = JSON.parse(String(init.body));
      return json(saved);
    }
    return saved ? json(saved) : json({}, 404);
  };
  assert.deepEqual(await ensureGitHubMcp({ ...options, fetcher }), { serverId: 'ccgc-github-web-search', created: true });
  assert.equal(saved?.url, 'https://api.githubcopilot.com/mcp/readonly');
  assert.deepEqual(saved?.allowed_tools, ['web_search']);
  assert.deepEqual(saved?.static_headers, { 'X-MCP-Toolsets': 'web_search' });
  assert.equal(saved?.allow_all_keys, false);
  assert.equal(saved?.auth_type, 'none');
  assert.equal(saved?.credentials, undefined);
  assert.equal((await ensureGitHubMcp({ ...options, fetcher })).created, false);
  assert.equal(writes, 1);
});

test('MCP registration fails closed on conflicting URLs, shared credentials, or broader tool access', async () => {
  for (const changed of [
    { url: 'https://elsewhere.example' }, { allowed_tools: [] }, { allow_all_keys: true },
    { static_headers: { Authorization: 'Bearer fake' } }, { credentials: { auth_value: 'fake' } },
    { extra_headers: ['Authorization'] }, { alias: 'other' },
  ]) {
    await assert.rejects(ensureGitHubMcp({ ...options, fetcher: async (_input, init) => {
      assert.equal(init?.method, 'GET');
      return json({ ...GITHUB_MCP_CONFIG, ...changed });
    } }), /differs/);
  }
});

test('MCP registration reports failures without echoing upstream bodies or secrets', async () => {
  await assert.rejects(ensureGitHubMcp({ ...options, fetcher: async () => json({ detail: 'secret' }, 500) }),
    error => error instanceof Error && error.message.includes('HTTP 500') && !error.message.includes('secret'));
});
