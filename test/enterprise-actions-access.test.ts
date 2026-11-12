import assert from 'node:assert/strict';
import test from 'node:test';
import { GITHUB_MCP_CONFIG } from '../scripts/github-mcp.mjs';
import { manageEmployeeAccess } from '../scripts/enterprise-actions-access.mjs';

const masterKey = `sk-${'m'.repeat(32)}`;
const employeeKey = `sk-${'u'.repeat(32)}`;
const userId = '12345678-1234-4234-8234-123456789012';
const githubLogin = 'Example-User';
const githubAccountId = 14850440;

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function mockFetch(existingUsers: object[] = []) {
  const calls: Array<{
    url: URL;
    method: string;
    body?: Record<string, unknown>;
    authorization?: string;
    userAgent?: string;
  }> = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    const authorization = new Headers(init?.headers).get('authorization') ?? undefined;
    const userAgent = new Headers(init?.headers).get('user-agent') ?? undefined;
    calls.push({ url, method, body, authorization, userAgent });
    if (url.hostname === 'api.github.com') {
      return response({ id: githubAccountId, login: githubLogin, type: 'User' });
    }
    if (url.pathname === '/v1/mcp/server/ccgc-github-web-search') return response(GITHUB_MCP_CONFIG);
    if (url.pathname === '/user/list') {
      return response({ users: existingUsers, total_pages: 1 });
    }
    if (url.pathname === '/v1/models') {
      return response({ data: [{ id: 'claude-sonnet-5.5' }, { id: 'claude-haiku-4.5' }, { id: 'gpt-4o' }] });
    }
    if (url.pathname === '/user/new' || url.pathname === '/user/update' || url.pathname === '/user/delete'
      || url.pathname.includes('/user_connection')) {
      return response({ status: 'ok' });
    }
    if (url.pathname === '/key/generate') {
      const cleanup = String(body?.key_alias).startsWith('ccgc-offboard-');
      return response({
        key: cleanup ? employeeKey : employeeKey,
        expires: new Date(Date.now() + 90 * 86_400_000).toISOString(),
      });
    }
    throw new Error(`Unexpected request ${method} ${url.pathname}`);
  };
  return { calls, fetcher };
}

test('Actions enrollment creates a scoped 90-day key for a non-invited LiteLLM user', async () => {
  const { calls, fetcher } = mockFetch();
  const result = await manageEmployeeAccess({
    action: 'enroll',
    githubLogin,
    litellmUrl: 'https://litellm.example',
    masterKey,
    fetcher,
  });
  assert.equal(result.githubLogin, githubLogin);
  assert.equal(result.key, employeeKey);
  assert.equal(result.reusedUser, false);
  assert.equal(calls.find(call => call.url.hostname === 'api.github.com')?.userAgent, 'ccgc-employee-access');
  assert.deepEqual(result.models, ['claude-sonnet-5.5', 'claude-haiku-4.5']);
  const create = calls.find(call => call.url.pathname === '/user/new');
  assert.equal(create?.body?.user_role, 'internal_user');
  assert.equal(create?.body?.send_invite_email, false);
  assert.equal(create?.body?.auto_create_key, false);
  assert.equal((create?.body?.metadata as Record<string, unknown>).github_account_id, githubAccountId);
  const generate = calls.find(call => call.url.pathname === '/key/generate');
  assert.equal(generate?.body?.duration, '90d');
  assert.ok((generate?.body?.allowed_routes as string[]).includes('/credentials/github-copilot-user/user_connection'));
  assert.equal(calls.filter(call => call.url.hostname === 'litellm.example')
    .every(call => call.authorization?.startsWith('Bearer sk-')), true);
});

test('Actions enrollment reuses the LiteLLM user identified by immutable GitHub account ID', async () => {
  const existing = {
    user_id: userId,
    user_role: 'internal_user',
    metadata: { github_account_id: String(githubAccountId) },
  };
  const { calls, fetcher } = mockFetch([existing]);
  const result = await manageEmployeeAccess({
    action: 'enroll',
    githubLogin,
    litellmUrl: 'https://litellm.example',
    masterKey,
    fetcher,
  });
  assert.equal(result.userId, userId);
  assert.equal(result.reusedUser, true);
  assert.equal(calls.some(call => call.url.pathname === '/user/update'), true);
  assert.equal(calls.some(call => call.url.pathname === '/user/new'), false);
});

test('Actions revocation disconnects Copilot before deleting the LiteLLM user', async () => {
  const existing = {
    user_id: userId,
    user_role: 'internal_user',
    metadata: { github_account_id: githubAccountId },
  };
  const { calls, fetcher } = mockFetch([existing]);
  const result = await manageEmployeeAccess({
    action: 'revoke',
    githubLogin,
    litellmUrl: 'https://litellm.example',
    masterKey,
    fetcher,
  });
  assert.equal(result.deleted, 1);
  assert.equal(calls.findIndex(call => call.url.pathname.endsWith('/user_connection'))
    < calls.findIndex(call => call.url.pathname === '/user/delete'), true);
  assert.equal(calls.find(call => call.url.pathname === '/user/delete')?.body?.user_ids instanceof Array, true);
});

test('Actions rejects unsafe LiteLLM origins before making requests', async () => {
  const { calls, fetcher } = mockFetch();
  await assert.rejects(manageEmployeeAccess({
    action: 'enroll',
    githubLogin,
    litellmUrl: 'https://user:pass@litellm.example/path',
    masterKey,
    fetcher,
  }), /HTTPS origin/);
  assert.equal(calls.length, 0);
});


test('every enrollment grants only the configured web-search MCP server and tool', async () => {
  const { calls, fetcher } = mockFetch();
  await manageEmployeeAccess({ action: 'enroll', githubLogin, litellmUrl: 'https://litellm.example', masterKey, fetcher });
  const key = calls.find(call => call.url.pathname === '/key/generate')?.body;
  for (const route of ['/github/mcp', '/mcp', '/mcp/']) assert.equal((key?.allowed_routes as string[]).includes(route), true);
  assert.deepEqual(key?.object_permission, { mcp_servers: ['ccgc-github-web-search'], mcp_tool_permissions: { 'ccgc-github-web-search': ['web_search'] } });
  assert.equal((key?.allowed_routes as string[]).includes('/v1/mcp/server'), false);
  assert.equal(key?.duration, '90d');
});
