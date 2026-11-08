import assert from 'node:assert/strict';
import test from 'node:test';

test('runtime administration does not attempt schema migrations', async () => {
  const source = await readFile(new URL('../src/enterprise-admin.ts', import.meta.url), 'utf8');
  assert.match(
    source,
    /new PostgresEnterpriseStore\(required\('CCGC_POSTGRES_URL'\), credential, false, false\)/,
  );
});
import { readFile } from 'node:fs/promises';
import { additionalLiteLLMUserIds, connectLiteLLMUser, reconcileLiteLLMUsers } from '../src/enterprise-admin.ts';
import { BridgeError } from '../src/protocol.ts';

test('operator connection flow verifies the expected GitHub account', { concurrency: false }, async () => {
  const priorUrl = process.env.CCGC_LITELLM_URL;
  const priorLog = console.log;
  process.env.CCGC_LITELLM_URL = 'https://litellm.internal/';
  const logs: string[] = [];
  console.log = value => logs.push(String(value));
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const responses = [
    Response.json({ connections: [{ credential_name: 'github-copilot', connected: false }] }),
    Response.json({
      verification_uri: 'https://github.com/login/device',
      user_code: 'ABCD-EFGH',
      flow_handle: 'opaque-flow',
      expires_in: 900,
      interval: 5,
    }),
    Response.json({ status: 'pending', interval: 5 }),
    Response.json({ status: 'connected', github_login: 'ExpectedUser' }),
  ];
  try {
    await connectLiteLLMUser(
      {
        litellmApiKey: 'sk-user-key-1234567890',
        litellmCredentialName: 'github-copilot',
        githubLogin: 'expecteduser',
      },
      async (input, init) => {
        requests.push({ url: String(input), init });
        return responses.shift()!;
      },
      async () => {},
    );
  } finally {
    console.log = priorLog;
    if (priorUrl === undefined) delete process.env.CCGC_LITELLM_URL;
    else process.env.CCGC_LITELLM_URL = priorUrl;
  }

  assert.equal(requests.length, 4);
  assert.match(requests[1]!.url, /\/credentials\/github-copilot\/user_connection\/start$/);
  assert.match(requests[2]!.url, /\/credentials\/github-copilot\/user_connection\/poll$/);
  assert.equal(requests[0]!.init?.headers && Object(requests[0]!.init.headers).authorization, 'Bearer sk-user-key-1234567890');
  assert.equal(logs.some(value => value.includes('sk-user-key')), false);
  assert.equal(logs.some(value => value.includes('ABCD-EFGH')), true);
  assert.equal(logs.some(value => value.includes('"status": "connected"')), true);
});

test('operator connection flow rejects another GitHub account', { concurrency: false }, async () => {
  const priorUrl = process.env.CCGC_LITELLM_URL;
  process.env.CCGC_LITELLM_URL = 'https://litellm.internal/';
  try {
    await assert.rejects(
      connectLiteLLMUser(
        {
          litellmApiKey: 'sk-user-key-1234567890',
          litellmCredentialName: 'github-copilot',
          githubLogin: 'expected-user',
        },
        async () => Response.json({
          connections: [{
            credential_name: 'github-copilot',
            connected: true,
            github_login: 'other-user',
          }],
        }),
      ),
      (error: unknown) => error instanceof BridgeError && error.code === 'IDENTITY_CONFLICT',
    );
  } finally {
    if (priorUrl === undefined) delete process.env.CCGC_LITELLM_URL;
    else process.env.CCGC_LITELLM_URL = priorUrl;
  }
});

test('LiteLLM reconciliation assigns the complete catalog to every existing user', async () => {
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  const keyIds = new Map([
    ['11111111-1111-4111-8111-111111111111', ['key-hash-1', 'key-hash-2']],
    ['22222222-2222-4222-8222-222222222222', ['key-hash-3']],
  ]);
  await reconcileLiteLLMUsers(
    [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '11111111-1111-4111-8111-111111111111',
    ],
    ['claude-sonnet-5.5', 'claude-opus-5.5', 'claude-sonnet-5.5'],
    async (path, init) => {
      requests.push({ path, init });
      if (path.startsWith('/key/list?')) {
        const userId = new URL(`https://litellm.example${path}`).searchParams.get('user_id')!;
        return Response.json({
          keys: keyIds.get(userId)!.map(token => ({ token })),
          total_pages: 1,
        });
      }
      return Response.json({ status: 'success' });
    },
  );

  assert.equal(requests.length, 7);
  assert.deepEqual(requests.map(request => request.path), [
    '/user/update',
    '/key/list?user_id=11111111-1111-4111-8111-111111111111&page=1&size=100&return_full_object=true',
    '/key/update',
    '/key/update',
    '/user/update',
    '/key/list?user_id=22222222-2222-4222-8222-222222222222&page=1&size=100&return_full_object=true',
    '/key/update',
  ]);
  assert.deepEqual(
    requests.filter(request => request.path === '/user/update').map(request => JSON.parse(String(request.init?.body))),
    [
      {
        user_id: '11111111-1111-4111-8111-111111111111',
        models: ['claude-sonnet-5.5', 'claude-opus-5.5'],
      },
      {
        user_id: '22222222-2222-4222-8222-222222222222',
        models: ['claude-sonnet-5.5', 'claude-opus-5.5'],
      },
    ],
  );
  assert.deepEqual(
    requests.filter(request => request.path === '/key/update').map(request => JSON.parse(String(request.init?.body))),
    [
      { key: 'key-hash-1', models: ['claude-sonnet-5.5', 'claude-opus-5.5'] },
      { key: 'key-hash-2', models: ['claude-sonnet-5.5', 'claude-opus-5.5'] },
      { key: 'key-hash-3', models: ['claude-sonnet-5.5', 'claude-opus-5.5'] },
    ],
  );
});

test('additional LiteLLM users are validated, bounded, and deduplicated', () => {
  assert.deepEqual(
    additionalLiteLLMUserIds([
      '11111111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111111',
    ]),
    ['11111111-1111-4111-8111-111111111111'],
  );
  assert.throws(() => additionalLiteLLMUserIds(['not-a-uuid']));
  assert.throws(() => additionalLiteLLMUserIds(Array.from({ length: 101 }, () => '11111111-1111-4111-8111-111111111111')));
});

test('LiteLLM reconciliation fails closed when a user update fails', async () => {
  await assert.rejects(
    reconcileLiteLLMUsers(
      ['11111111-1111-4111-8111-111111111111'],
      ['claude-sonnet-5.5'],
      async path => path === '/user/update'
        ? new Response(null, { status: 404 })
        : Response.json({ keys: [], total_pages: 1 }),
    ),
    (error: unknown) => error instanceof BridgeError
      && error.code === 'GATEWAY_UNAVAILABLE'
      && !error.message.includes('response'),
  );
});
