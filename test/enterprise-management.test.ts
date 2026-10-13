import assert from 'node:assert/strict';
import test from 'node:test';
import type { EnterpriseAuthenticator, EnterprisePrincipal } from '../src/enterprise-auth.ts';
import { startEnterpriseServer, type EnterpriseAdministrationActions } from '../src/enterprise-server.ts';
import type { EnterpriseStore } from '../src/enterprise-store.ts';
import type { WorkerResolver } from '../src/enterprise-worker.ts';
import { EnterpriseManagement } from '../src/enterprise-management.ts';
import { DispatchSigner } from '../src/enterprise-dispatch.ts';
import { BridgeError, type ObjectValue } from '../src/protocol.ts';

const principal: EnterprisePrincipal = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  objectId: '22222222-2222-2222-2222-222222222222',
  subject: 'administrator',
};

class TokenAuthenticator implements EnterpriseAuthenticator {
  readonly expected: string;

  constructor(expected: string) {
    this.expected = expected;
  }

  async authenticate(token: string): Promise<EnterprisePrincipal> {
    if (token !== this.expected) throw new BridgeError('ACCESS_DENIED', 'Required Entra role is missing.', 403);
    return principal;
  }
}

class FakeActions implements EnterpriseAdministrationActions {
  calls: Array<{ operation: string; input: ObjectValue }> = [];

  private called(operation: string, input: ObjectValue): Promise<ObjectValue> {
    this.calls.push({ operation, input });
    return Promise.resolve({ status: 'ok', operation });
  }

  createUser(input: ObjectValue) { return this.called('create-user', input); }
  startConnection(input: ObjectValue) { return this.called('connect-start', input); }
  pollConnection(input: ObjectValue) { return this.called('connect-poll', input); }
  link(input: ObjectValue) { return this.called('link', input); }
  revoke(input: ObjectValue) { return this.called('revoke', input); }
  status() { return this.called('status', {}); }
}

function brokerDependencies() {
  const store: EnterpriseStore = {
    initialize: async () => undefined,
    binding: async () => { throw new Error('not used'); },
    createAdmission: async () => { throw new Error('not used'); },
    admissionBinding: async () => { throw new Error('not used'); },
    reserveDispatch: async () => { throw new Error('not used'); },
    finishDispatch: async () => undefined,
    close: async () => undefined,
  };
  const workers: WorkerResolver = {
    resolve: async () => { throw new Error('not used'); },
  };
  return {
    store,
    workers,
    dispatchSigner: new DispatchSigner(
      'dispatch-secret-'.repeat(4),
      'https://broker.internal',
      'https://worker.internal',
    ),
  };
}

test('broker administration routes require CCGC.Admin before executing actions', async () => {
  const actions = new FakeActions();
  const server = await startEnterpriseServer({
    authenticator: new TokenAuthenticator('employee-role'),
    adminAuthenticator: new TokenAuthenticator('admin-role'),
    adminActions: actions,
    ...brokerDependencies(),
  });
  try {
    const employee = await fetch(`http://127.0.0.1:${server.port}/ccgc/admin/users`, {
      method: 'POST',
      headers: { authorization: 'Bearer employee-role', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(employee.status, 403);
    assert.equal(actions.calls.length, 0);

    const admin = await fetch(`http://127.0.0.1:${server.port}/ccgc/admin/users`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-role', 'content-type': 'application/json' },
      body: JSON.stringify({ userId: principal.objectId }),
    });
    assert.equal(admin.status, 200);
    assert.deepEqual(actions.calls, [{
      operation: 'create-user',
      input: { userId: principal.objectId },
    }]);
    assert.equal(admin.headers.get('cache-control'), 'no-store');
  } finally {
    await server.close();
  }
});

test('broker rejects browser origins before invoking administrative actions', async () => {
  const actions = new FakeActions();
  const server = await startEnterpriseServer({
    authenticator: new TokenAuthenticator('employee-role'),
    adminAuthenticator: new TokenAuthenticator('admin-role'),
    adminActions: actions,
    ...brokerDependencies(),
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/ccgc/admin/revoke`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-role',
        'content-type': 'application/json',
        origin: 'https://malicious.example',
      },
      body: JSON.stringify({ credentialSecretName: 'secret' }),
    });
    assert.equal(response.status, 403);
    assert.equal(actions.calls.length, 0);
  } finally {
    await server.close();
  }
});

test('administration split device flow verifies the expected employee GitHub account', async () => {
  const requests: string[] = [];
  const management = new EnterpriseManagement({
    litellmUrl: 'https://litellm.internal',
    litellmMasterKey: `sk-${'m'.repeat(32)}`,
    postgresUrl: 'postgresql://broker@postgres.internal/postgres?sslmode=require',
    fetcher: (async (input, init) => {
      const url = String(input);
      requests.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/credentials/user_connections')) {
        return Response.json({ connections: [] });
      }
      if (url.endsWith('/user_connection/start')) {
        return Response.json({
          verification_uri: 'https://github.com/login/device',
          user_code: 'ABCD-1234',
          flow_handle: 'opaque-flow',
          expires_in: 900,
          interval: 5,
        });
      }
      return Response.json({ status: 'connected', github_login: 'developer' });
    }) as typeof fetch,
  });
  const input = {
    litellmApiKey: `sk-${'u'.repeat(32)}`,
    litellmCredentialName: 'github-copilot-user',
    githubLogin: 'developer',
  };
  const started = await management.startConnection(input);
  assert.equal(started.status, 'authorization_required');
  assert.equal(started.userCode, 'ABCD-1234');
  assert.equal(JSON.stringify(started).includes('mmmm'), false);

  const connected = await management.pollConnection({ ...input, flowHandle: started.flowHandle });
  assert.deepEqual(connected, {
    status: 'connected',
    githubLogin: 'developer',
    credentialName: 'github-copilot-user',
  });
  assert.equal(requests.length, 3);
});

test('administration suppresses LiteLLM error bodies and rejects a different GitHub account', async () => {
  const input = {
    litellmApiKey: `sk-${'u'.repeat(32)}`,
    litellmCredentialName: 'github-copilot-user',
    githubLogin: 'developer',
    flowHandle: 'opaque-flow',
  };
  const conflicting = new EnterpriseManagement({
    litellmUrl: 'https://litellm.internal',
    litellmMasterKey: `sk-${'m'.repeat(32)}`,
    postgresUrl: 'postgresql://broker@postgres.internal/postgres?sslmode=require',
    fetcher: (async () => Response.json({
      status: 'connected',
      github_login: 'another-user',
    })) as typeof fetch,
  });
  await assert.rejects(
    () => conflicting.pollConnection(input),
    (error: unknown) => error instanceof BridgeError && error.code === 'IDENTITY_CONFLICT',
  );

  const failing = new EnterpriseManagement({
    litellmUrl: 'https://litellm.internal',
    litellmMasterKey: `sk-${'m'.repeat(32)}`,
    postgresUrl: 'postgresql://broker@postgres.internal/postgres?sslmode=require',
    fetcher: (async () => new Response('upstream-secret-value', { status: 500 })) as typeof fetch,
  });
  await assert.rejects(
    () => failing.startConnection(input),
    (error: unknown) => error instanceof BridgeError
      && error.message === 'LiteLLM returned HTTP 500.'
      && !error.message.includes('upstream-secret-value'),
  );
});
