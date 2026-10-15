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
import { connectLiteLLMUser } from '../src/enterprise-admin.ts';
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
