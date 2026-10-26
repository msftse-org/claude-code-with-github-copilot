import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bearerToken,
  DualEnterpriseAuthenticator,
  type EnterpriseAuthenticator,
  type EnterprisePrincipal,
} from '../src/enterprise-auth.ts';
import { startEnterpriseServer } from '../src/enterprise-server.ts';
import type { AccountBinding, DispatchReservation, EnterpriseStore } from '../src/enterprise-store.ts';
import type { WorkerResolver } from '../src/enterprise-worker.ts';
import { BridgeError } from '../src/protocol.ts';
import type { Backend } from '../src/copilot.ts';
import { startEnterpriseWorkerServer } from '../src/enterprise-worker-server.ts';
import { DispatchSigner, DispatchVerifier, type DispatchClaims } from '../src/enterprise-dispatch.ts';
import { MemoryCheckpointStore } from '../src/enterprise-checkpoint.ts';
import { AccountScopedConnectorPool, type AccountConnectorFactory } from '../src/enterprise-connector.ts';
import { message, model, request, tools } from './fixtures.ts';
import { createServer as createNetServer } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EnterpriseClient, configureEnterprise } from '../src/enterprise-client.ts';
import type { Secrets } from '../src/remote-client.ts';

const principal: EnterprisePrincipal = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  objectId: '22222222-2222-2222-2222-222222222222',
  subject: 'subject',
};
const binding: AccountBinding = {
  tenantId: principal.tenantId,
  objectId: principal.objectId,
  githubAccountId: 1234,
  githubLogin: 'developer',
  credentialSecretName: 'copilot-developer',
  models: ['claude-sonnet-5.5'],
  revision: 1,
};

class FakeAuthenticator implements EnterpriseAuthenticator {
  async authenticate(_token: string): Promise<EnterprisePrincipal> {
    return principal;
  }
}

class FakeStore implements EnterpriseStore {
  initialized = false;
  closed = false;
  finished: Array<{ id: string; outcome: string }> = [];
  reservations = 0;

  async initialize() { this.initialized = true; }
  async binding(value: EnterprisePrincipal) {
    assert.equal(value.tenantId, principal.tenantId);
    assert.equal(value.objectId, principal.objectId);
    return binding;
  }
  async authenticateApiKey(token: string) {
    if (token !== `ccgc_sk_${'a'.repeat(43)}`) throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'invalid', 401);
    return { ...principal, authentication: 'apiKey' as const };
  }
  async issueApiKey(): Promise<{ id: string; apiKey: string; expiresAt: string }> { throw new Error('not used'); }
  async revokeApiKey() { throw new Error('not used'); }
  async createEnrollment(): Promise<{ id: string; expiresAt: string }> { throw new Error('not used'); }
  async reusableEnrollmentUser(): Promise<null> { return null; }
  async enrollment(): Promise<never> { throw new Error('not used'); }
  async setEnrollmentFlow() { throw new Error('not used'); }
  async beginEnrollmentCompletion(): Promise<boolean> { throw new Error('not used'); }
  async completeEnrollment() { throw new Error('not used'); }
  async consumeEnrollment() { throw new Error('not used'); }
  async createAdmission(value: EnterprisePrincipal, ttlSeconds: number, maxAttempts: number) {
    assert.equal(value.tenantId, principal.tenantId);
    assert.equal(value.objectId, principal.objectId);
    assert.equal(ttlSeconds, 3600);
    assert.equal(maxAttempts, 10);
    return { id: '33333333-3333-3333-3333-333333333333', token: 'a'.repeat(64), expiresAt: '2026-10-10T00:00:00.000Z' };
  }
  async admissionBinding(tokenHash: string) {
    assert.match(tokenHash, /^[a-f0-9]{64}$/);
    return { admissionId: '33333333-3333-3333-3333-333333333333', binding };
  }
  async reserveDispatch(tokenHash: string, requestHash: string, model: string, branchId: string): Promise<DispatchReservation> {
    assert.match(tokenHash, /^[a-f0-9]{64}$/);
    assert.match(requestHash, /^[a-f0-9]{64}$/);
    assert.equal(model, 'claude-sonnet-5.5');
    assert.equal(branchId, 'main');
    this.reservations++;
    return {
      id: '44444444-4444-4444-4444-444444444444',
      admissionId: '33333333-3333-3333-3333-333333333333',
      fence: 7,
      requestHash,
      branchId,
      binding,
    };
  }
  async finishDispatch(id: string, outcome: 'completed' | 'failed' | 'cancelled') {
    this.finished.push({ id, outcome });
  }
  async close() { this.closed = true; }
}

class FakeWorkers implements WorkerResolver {
  async resolve(value: AccountBinding) {
    assert.deepEqual(value, binding);
    return { url: 'https://worker.internal', credentialSecretName: binding.credentialSecretName };
  }
}

const dispatchSecret = 'dispatch-secret-'.repeat(4);
const brokerOrigin = 'https://broker.internal';
const workerOrigin = 'https://worker.internal';

function dispatchClaims(fence: number, dispatchId = `${String(fence).padStart(8, '0')}-4444-4444-8444-444444444444`): DispatchClaims {
  return {
    dispatchId,
    tenantId: principal.tenantId,
    objectId: principal.objectId,
    admissionId: '33333333-3333-3333-3333-333333333333',
    branchId: 'main',
    bindingRevision: binding.revision,
    githubAccountId: binding.githubAccountId,
    githubLogin: binding.githubLogin,
    credentialSecretName: binding.credentialSecretName,
    fence,
    model: model.id,
  };
}

function connector(send: Backend['send']): AccountConnectorFactory {
  return { async connector() { return { send }; } };
}

test('enterprise bearer parsing fails closed', () => {
  assert.equal(bearerToken('Bearer token'), 'token');
  assert.throws(() => bearerToken(undefined), /bearer token/i);
  assert.throws(() => bearerToken('Basic abc'), /bearer token/i);
  assert.throws(() => bearerToken('Bearer bad\nvalue'), /bearer token/i);
});

test('enterprise broker gives API-key employees the same bound profile and admission path', async () => {
  const store = new FakeStore();
  const server = await startEnterpriseServer({
    authenticator: new DualEnterpriseAuthenticator(new FakeAuthenticator(), store),
    store,
    workers: new FakeWorkers(),
    dispatchSigner: new DispatchSigner(dispatchSecret, brokerOrigin, workerOrigin),
  });
  const apiKey = `ccgc_sk_${'a'.repeat(43)}`;
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const info = await fetch(`${base}/ccgc/enterprise/info`, {
      headers: { authorization: ['Bearer', apiKey].join(' ') },
    });
    assert.equal(info.status, 200);
    assert.equal((await info.json()).authentication, 'apiKey');

    const admission = await fetch(`${base}/ccgc/enterprise/admissions`, {
      method: 'POST',
      headers: {
        authorization: ['Bearer', apiKey].join(' '),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ttlSeconds: 3600, maxAttempts: 10 }),
    });
    assert.equal(admission.status, 201);
  } finally {
    await server.close();
  }
});

test('single-tenant control plane publishes central LiteLLM and does not proxy inference', async () => {
  const store = new FakeStore();
  const server = await startEnterpriseServer({
    authenticator: new DualEnterpriseAuthenticator(new FakeAuthenticator(), store),
    store,
    inferenceGateway: 'https://litellm.customer.example',
  });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const config = await fetch(`${base}/ccgc/enterprise/config`);
    assert.equal(config.status, 200);
    assert.deepEqual(await config.json(), { inferenceGateway: 'https://litellm.customer.example' });
    const info = await fetch(`${base}/ccgc/enterprise/info`, {
      headers: { authorization: 'invalid' },
    });
    assert.equal(info.status, 401);
    const authenticatedInfo = await fetch(`${base}/ccgc/enterprise/info`, {
      headers: { authorization: ['Bearer', 'valid'].join(' ') },
    });
    assert.equal(authenticatedInfo.status, 200);
    assert.equal((await authenticatedInfo.json()).inferenceGateway, 'https://litellm.customer.example');
    const inference = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${'a'.repeat(64)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: model.id, max_tokens: 1, messages: [] }),
    });
    assert.equal(inference.status, 404);
  } finally {
    await server.close();
  }
});

test('isolated enterprise worker restores an exact pending tool batch after restart', async () => {
  const port = await freePort();
  const checkpoints = new MemoryCheckpointStore();
  const signer = new DispatchSigner(dispatchSecret, brokerOrigin, workerOrigin);
  const verifier = new DispatchVerifier(dispatchSecret, brokerOrigin, workerOrigin);
  const headers = async (fence: number) => ({
    authorization: 'Bearer ' + await signer.sign(dispatchClaims(fence)),
    'content-type': 'application/json',
  });
  const blocks = [{ type: 'tool_use', id: 'durable-read', name: 'Read', input: { file_path: 'synthetic.txt' } }];
  const options = {
    verifier,
    checkpoints,
    models: [model],
    expectedHost: `127.0.0.1:${port}`,
    port,
  };
  let worker = await startEnterpriseWorkerServer({
    ...options,
    connectors: connector(async () => Response.json(message(blocks, 'tool_use'))),
  });
  try {
    const first = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: await headers(1),
      body: JSON.stringify(request({ tools })),
    });
    assert.equal(first.status, 200, await first.text());
    await worker.close();

    let restoredCalls = 0;
    worker = await startEnterpriseWorkerServer({
      ...options,
      connectors: connector(async body => {
        restoredCalls++;
        assert.match(JSON.stringify(body.messages), /durable-read/);
        return Response.json(message());
      }),
    });
    const continuation = request({
      tools,
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: blocks },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'durable-read', content: 'synthetic file' }] },
      ],
    });
    const second = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: await headers(2),
      body: JSON.stringify(continuation),
    });
    assert.equal(second.status, 200, await second.text());
    assert.equal(restoredCalls, 1);
    await worker.close();
    assert.equal(checkpoints.values.size, 0);
  } finally {
    await worker.close().catch(() => undefined);
  }
});

test('enterprise broker binds principal, admission, dispatch fence and isolated worker', async () => {
  const store = new FakeStore();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const server = await startEnterpriseServer({
    authenticator: new FakeAuthenticator(),
    store,
    workers: new FakeWorkers(),
    dispatchSigner: new DispatchSigner(dispatchSecret, brokerOrigin, workerOrigin),
    fetcher: async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response('event: message_stop\ndata: {}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  try {
    assert.equal(store.initialized, true);
    const base = `http://127.0.0.1:${server.port}`;
    const anonymous = await fetch(`${base}/ccgc/enterprise/info`);
    assert.equal(anonymous.status, 401);

    const info = await fetch(`${base}/ccgc/enterprise/info`, { headers: { authorization: 'Bearer valid' } });
    assert.equal(info.status, 200);
    assert.deepEqual(await info.json(), {
      tenantId: principal.tenantId,
      objectId: principal.objectId,
      githubLogin: binding.githubLogin,
      githubAccountId: binding.githubAccountId,
      models: binding.models,
      bindingRevision: 1,
      authentication: 'entra',
    });

    const admission = await fetch(`${base}/ccgc/enterprise/admissions`, {
      method: 'POST',
      headers: { authorization: 'Bearer valid', 'content-type': 'application/json' },
      body: JSON.stringify({ ttlSeconds: 3600, maxAttempts: 10 }),
    });
    assert.equal(admission.status, 201);
    const models = await fetch(`${base}/v1/models`, {
      headers: { authorization: `Bearer ${'a'.repeat(64)}` },
    });
    assert.equal(models.status, 200);
    assert.deepEqual((await models.json()).data[0], {
      id: 'claude-sonnet-5-5',
      type: 'model',
      display_name: 'Claude Sonnet 5.5',
      description: 'GitHub Copilot isolated worker: claude-sonnet-5.5. No provider fallback.',
    });

    const message = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${'a'.repeat(64)}`,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: 'claude-sonnet-5.5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(message.status, 200);
    assert.equal(await message.text(), 'event: message_stop\ndata: {}\n\n');
    assert.equal(store.reservations, 1);
    assert.deepEqual(store.finished, [{ id: '44444444-4444-4444-4444-444444444444', outcome: 'completed' }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'https://worker.internal/v1/messages');
    const headers = new Headers(calls[0]?.init.headers);
    const assertion = headers.get('authorization')?.slice('Bearer '.length) ?? '';
    const claims = await new DispatchVerifier(dispatchSecret, brokerOrigin, workerOrigin).verify(assertion);
    assert.equal(claims.fence, 7);
    assert.equal(claims.admissionId, '33333333-3333-3333-3333-333333333333');
    assert.equal(claims.objectId, principal.objectId);
    assert.equal(claims.credentialSecretName, binding.credentialSecretName);
    assert.equal(headers.get('anthropic-version'), '2023-06-01');
  } finally {
    await server.close();
    assert.equal(store.closed, true);
  }
});

test('enterprise broker records failed worker calls without retry', async () => {
  const store = new FakeStore();
  let calls = 0;
  const server = await startEnterpriseServer({
    authenticator: new FakeAuthenticator(),
    store,
    workers: new FakeWorkers(),
    dispatchSigner: new DispatchSigner(dispatchSecret, brokerOrigin, workerOrigin),
    fetcher: async () => {
      calls++;
      throw new Error('synthetic worker failure');
    },
  });

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${'a'.repeat(64)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude-sonnet-5.5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 500);
    assert.equal(calls, 1);
    assert.deepEqual(store.finished, [{ id: '44444444-4444-4444-4444-444444444444', outcome: 'failed' }]);
  } finally {
    await server.close();
  }
});

test('enterprise broker bounds dispatch duration and records cancellation', async () => {
  const store = new FakeStore();
  const server = await startEnterpriseServer({
    authenticator: new FakeAuthenticator(),
    store,
    workers: new FakeWorkers(),
    dispatchSigner: new DispatchSigner(dispatchSecret, brokerOrigin, workerOrigin),
    dispatchTimeoutMs: 10,
    fetcher: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }),
  });

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: ['Bearer', 'a'.repeat(64)].join(' '),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude-sonnet-5.5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 503, await response.text());
    assert.deepEqual(store.finished, [{ id: '44444444-4444-4444-4444-444444444444', outcome: 'cancelled' }]);
  } finally {
    await server.close();
  }
});

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No free port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

test('isolated enterprise worker rejects stale dispatch fences before inference', async () => {
  const port = await freePort();
  let calls = 0;
  const signer = new DispatchSigner(dispatchSecret, brokerOrigin, workerOrigin);
  const worker = await startEnterpriseWorkerServer({
    verifier: new DispatchVerifier(dispatchSecret, brokerOrigin, workerOrigin),
    checkpoints: new MemoryCheckpointStore(),
    models: [model],
    expectedHost: `127.0.0.1:${port}`,
    port,
    connectors: connector(async () => {
      calls++;
      return Response.json(message());
    }),
  });

  try {
    const headers = {
      authorization: `Bearer ${await signer.sign(dispatchClaims(1))}`,
      'content-type': 'application/json',
    };
    const first = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(request()),
    });
    assert.equal(first.status, 200, await first.text());
    const duplicate = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(request()),
    });
    assert.equal(duplicate.status, 409);
    assert.equal(calls, 1);
  } finally {
    await worker.close();
  }
});

test('one shared worker serves two users without sharing connector or checkpoint state', async () => {
  const port = await freePort();
  const signer = new DispatchSigner(dispatchSecret, brokerOrigin, workerOrigin);
  const accounts: string[] = [];
  const worker = await startEnterpriseWorkerServer({
    verifier: new DispatchVerifier(dispatchSecret, brokerOrigin, workerOrigin),
    checkpoints: new MemoryCheckpointStore(),
    models: [model],
    expectedHost: `127.0.0.1:${port}`,
    port,
    connectors: {
      async connector(claims) {
        accounts.push(`${claims.objectId}:${claims.githubLogin}`);
        return { async send() { return Response.json(message()); } };
      },
    },
  });
  const second: DispatchClaims = {
    ...dispatchClaims(1, '55555555-5555-4555-8555-555555555555'),
    objectId: '66666666-6666-4666-8666-666666666666',
    admissionId: '77777777-7777-4777-8777-777777777777',
    githubAccountId: 5678,
    githubLogin: 'second-developer',
    credentialSecretName: 'copilot-second-developer',
  };
  try {
    const [firstResponse, secondResponse] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await signer.sign(dispatchClaims(1))}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(request()),
      }),
      fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await signer.sign(second)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(request()),
      }),
    ]);
    assert.equal(firstResponse.status, 200, await firstResponse.text());
    assert.equal(secondResponse.status, 200, await secondResponse.text());
    assert.deepEqual(accounts.sort(), [
      `${principal.objectId}:developer`,
      `${second.objectId}:second-developer`,
    ].sort());
  } finally {
    await worker.close();
  }
});

test('a conversation branch moves between live worker replicas through durable checkpoints', async () => {
  const [firstPort, secondPort] = await Promise.all([freePort(), freePort()]);
  const checkpoints = new MemoryCheckpointStore();
  const signer = new DispatchSigner(dispatchSecret, brokerOrigin, workerOrigin);
  const verifier = new DispatchVerifier(dispatchSecret, brokerOrigin, workerOrigin);
  const blocks = [{ type: 'tool_use', id: 'replica-read', name: 'Read', input: { file_path: 'synthetic.txt' } }];
  const firstWorker = await startEnterpriseWorkerServer({
    verifier,
    checkpoints,
    models: [model],
    expectedHost: `127.0.0.1:${firstPort}`,
    port: firstPort,
    connectors: connector(async () => Response.json(message(blocks, 'tool_use'))),
  });
  let restored = false;
  const secondWorker = await startEnterpriseWorkerServer({
    verifier,
    checkpoints,
    models: [model],
    expectedHost: `127.0.0.1:${secondPort}`,
    port: secondPort,
    connectors: connector(async body => {
      restored = JSON.stringify(body.messages).includes('replica-read');
      return Response.json(message());
    }),
  });
  try {
    const first = await fetch(`http://127.0.0.1:${firstPort}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await signer.sign(dispatchClaims(1))}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(request({ tools })),
    });
    assert.equal(first.status, 200, await first.text());
    const continuation = request({
      tools,
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: blocks },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'replica-read', content: 'synthetic file' }] },
      ],
    });
    const second = await fetch(`http://127.0.0.1:${secondPort}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await signer.sign(dispatchClaims(2, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(continuation),
    });
    assert.equal(second.status, 200, await second.text());
    assert.equal(restored, true);
  } finally {
    await Promise.all([firstWorker.close(), secondWorker.close()]);
  }
});

test('account connector pool keeps LiteLLM user keys account scoped', async () => {
  const claimsA = dispatchClaims(1);
  const claimsB: DispatchClaims = {
    ...claimsA,
    dispatchId: '88888888-8888-4888-8888-888888888888',
    objectId: '99999999-9999-4999-8999-999999999999',
    githubAccountId: 5678,
    githubLogin: 'second-developer',
    credentialSecretName: 'litellm-second-developer',
  };
  const resolverCalls: string[] = [];
  const upstreamAuthorization: string[] = [];
  const pool = new AccountScopedConnectorPool({
    async resolve(claims) {
      resolverCalls.push(claims.githubLogin);
      return {
        login: claims.githubLogin,
        apiKey: `sk-${claims.githubLogin}-synthetic-user-key`,
        githubAccountId: claims.githubAccountId,
        credentialName: 'github-copilot',
      };
    },
  }, 'https://litellm.internal', async (_input, init = {}) => {
    upstreamAuthorization.push(new Headers(init.headers).get('authorization') ?? '');
    return Response.json(message());
  });
  const [first, firstConcurrent] = await Promise.all([
    pool.connector(claimsA),
    pool.connector(claimsA),
  ]);
  assert.equal(firstConcurrent, first);
  const second = await pool.connector(claimsB);
  assert.equal(await pool.connector(claimsA), first);
  await first.send(request(), new Headers(), new AbortController().signal);
  await second.send(request(), new Headers(), new AbortController().signal);
  assert.deepEqual(resolverCalls, ['developer', 'second-developer']);
  assert.deepEqual(upstreamAuthorization, [
    'Bearer sk-developer-synthetic-user-key',
    'Bearer sk-second-developer-synthetic-user-key',
  ]);
});

test('enterprise client uses Entra for control and an opaque admission token for Claude', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccgc-enterprise-client-'));
  const values = new Map<string, string>();
  const secrets: Secrets = {
    async get(id) {
      const value = values.get(id);
      if (!value) throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'missing', 401);
      return value;
    },
    async set(id, value) { values.set(id, value); },
    async remove(id) { values.delete(id); },
  };
  let admissions = 0;
  const client = new EnterpriseClient(
    home,
    secrets,
    { async getToken(scope) {
      assert.equal(scope, 'api://ccgc/.default');
      return { token: 'entra-token' };
    } },
    async (input, init) => {
      const url = String(input);
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer entra-token');
      if (url.endsWith('/ccgc/enterprise/info')) {
        return Response.json({
          tenantId: principal.tenantId,
          objectId: principal.objectId,
          githubLogin: binding.githubLogin,
          githubAccountId: binding.githubAccountId,
          models: binding.models,
          bindingRevision: 1,
          inferenceGateway: 'https://litellm.example',
        });
      }
      assert.equal(url, 'https://enterprise.example/ccgc/enterprise/admissions');
      admissions++;
      return Response.json({
        id: '33333333-3333-3333-3333-333333333333',
        token: 'a'.repeat(64),
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      }, { status: 201 });
    },
  );
  try {
    const profile = await client.login('https://enterprise.example', 'api://ccgc');
    assert.equal(profile.objectId, principal.objectId);
    assert.equal(profile.authMethod, 'entra');
    assert.equal(profile.controlPlane, 'https://enterprise.example');
    assert.equal(profile.gateway, 'https://litellm.example');
    assert.equal(await client.token(), 'a'.repeat(64));
    assert.equal(await client.token(), 'a'.repeat(64));
    assert.equal(admissions, 1);
    const configured = await configureEnterprise(await client.load(), true, home);
    assert.equal(configured.applied, true);
    const settings = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8')) as Record<string, unknown>;
    assert.equal((settings.env as Record<string, string>).ANTHROPIC_BASE_URL, 'https://litellm.example');
    assert.equal((settings.env as Record<string, string>).CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, undefined);
    assert.equal((settings.env as Record<string, string>).CLAUDE_CODE_DISABLE_AUTO_MEMORY, undefined);
    assert.equal((settings.env as Record<string, string>).CLAUDE_CODE_DISABLE_CRON, undefined);
    assert.equal((settings.env as Record<string, string>).CLAUDE_CODE_DISABLE_ADVISOR_TOOL, undefined);
    assert.equal((settings.env as Record<string, string>).CLAUDE_CODE_AUTO_MODE_SERVER, '0');
    assert.equal(settings.disableAllHooks, undefined);
    assert.deepEqual(settings.permissions, { defaultMode: 'manual' });
    assert.match(String(settings.apiKeyHelper), /enterprise-cli\.ts' token$/);
  } finally {
    await rm(home, { recursive: true });
  }
});

test('enterprise client keeps a long-lived API key only in Keychain and exchanges it for admissions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccgc-enterprise-api-key-client-'));
  const values = new Map<string, string>();
  const secrets: Secrets = {
    async get(id) {
      const value = values.get(id);
      if (!value) throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'missing', 401);
      return value;
    },
    async set(id, value) { values.set(id, value); },
    async remove(id) { values.delete(id); },
  };
  const apiKey = `ccgc_sk_${'k'.repeat(43)}`;
  let admissions = 0;
  const client = new EnterpriseClient(
    home,
    secrets,
    { async getToken() { throw new Error('Entra must not be used for API-key profiles'); } },
    async (input, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), ['Bearer', apiKey].join(' '));
      if (String(input).endsWith('/ccgc/enterprise/info')) {
        return Response.json({
          tenantId: principal.tenantId,
          objectId: principal.objectId,
          githubLogin: binding.githubLogin,
          githubAccountId: binding.githubAccountId,
          models: binding.models,
          bindingRevision: 1,
          authentication: 'apiKey',
          inferenceGateway: 'https://litellm.example',
        });
      }
      assert.equal(String(input), 'https://enterprise.example/ccgc/enterprise/admissions');
      admissions++;
      return Response.json({
        id: '33333333-3333-3333-3333-333333333333',
        token: 'b'.repeat(64),
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      }, { status: 201 });
    },
  );
  try {
    const loggedIn = await client.loginApiKey('https://enterprise.example', apiKey);
    assert.equal(loggedIn.authMethod, 'apiKey');
    assert.equal(loggedIn.audience, undefined);
    assert.equal(loggedIn.gateway, 'https://litellm.example');
    const persisted = await readFile(join(home, '.local', 'share', 'ccgc', 'enterprise', 'profile.json'), 'utf8');
    assert.equal(persisted.includes(apiKey), false);
    assert.equal([...values.values()].includes(apiKey), true);
    assert.equal(await client.token(), 'b'.repeat(64));
    assert.equal(admissions, 1);
  } finally {
    await rm(home, { recursive: true });
  }
});
