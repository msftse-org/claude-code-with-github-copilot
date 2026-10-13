import assert from 'node:assert/strict';
import test from 'node:test';
import type { EnterpriseAuthenticator, EnterprisePrincipal } from '../src/enterprise-auth.ts';
import { startEnterpriseServer, type EnterpriseAdministrationActions } from '../src/enterprise-server.ts';
import type {
  EnterpriseEnrollment,
  EnterpriseStore,
  PostgresEnterpriseStore,
} from '../src/enterprise-store.ts';
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
  createApiKey(input: ObjectValue) { return this.called('create-api-key', input); }
  revokeApiKey(input: ObjectValue) { return this.called('revoke-api-key', input); }
  createEnrollment(input: ObjectValue) { return this.called('create-enrollment', input); }
  startEnrollment(input: ObjectValue) { return this.called('enrollment-start', input); }
  pollEnrollment(input: ObjectValue) { return this.called('enrollment-poll', input); }
  completeEnrollment(input: ObjectValue) { return this.called('enrollment-complete', input); }
  status() { return this.called('status', {}); }
}

function brokerDependencies() {
  const store: EnterpriseStore = {
    initialize: async () => undefined,
    binding: async () => { throw new Error('not used'); },
    authenticateApiKey: async () => { throw new Error('not used'); },
    issueApiKey: async () => { throw new Error('not used'); },
    revokeApiKey: async () => { throw new Error('not used'); },
    createEnrollment: async () => { throw new Error('not used'); },
    enrollment: async () => { throw new Error('not used'); },
    setEnrollmentFlow: async () => { throw new Error('not used'); },
    beginEnrollmentCompletion: async () => { throw new Error('not used'); },
    completeEnrollment: async () => { throw new Error('not used'); },
    consumeEnrollment: async () => { throw new Error('not used'); },
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

    const employeeApiKey = await fetch(`http://127.0.0.1:${server.port}/ccgc/admin/api-keys`, {
      method: 'POST',
      headers: { authorization: ['Bearer', 'employee-role'].join(' '), 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(employeeApiKey.status, 403);
    assert.equal(actions.calls.length, 1);

    const adminApiKey = await fetch(`http://127.0.0.1:${server.port}/ccgc/admin/api-keys`, {
      method: 'POST',
      headers: { authorization: ['Bearer', 'admin-role'].join(' '), 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: principal.tenantId, objectId: principal.objectId, label: 'pilot' }),
    });
    assert.equal(adminApiKey.status, 200);
    assert.deepEqual(actions.calls[1], {
      operation: 'create-api-key',
      input: { tenantId: principal.tenantId, objectId: principal.objectId, label: 'pilot' },
    });
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

test('enrollment creation is Entra-admin-only while enrollment exchange is public', async () => {
  const actions = new FakeActions();
  const server = await startEnterpriseServer({
    authenticator: new TokenAuthenticator('employee-role'),
    adminAuthenticator: new TokenAuthenticator('admin-role'),
    adminActions: actions,
    ...brokerDependencies(),
  });
  try {
    const denied = await fetch(`http://127.0.0.1:${server.port}/ccgc/admin/enrollments`, {
      method: 'POST',
      headers: {
        authorization: ['Bearer', 'employee-role'].join(' '),
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(denied.status, 403);

    const created = await fetch(`http://127.0.0.1:${server.port}/ccgc/admin/enrollments`, {
      method: 'POST',
      headers: {
        authorization: ['Bearer', 'admin-role'].join(' '),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ githubLogin: 'developer' }),
    });
    assert.equal(created.status, 200);

    const started = await fetch(`http://127.0.0.1:${server.port}/ccgc/enroll/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: `CCGC-${'a'.repeat(24)}` }),
    });
    assert.equal(started.status, 200);
    assert.deepEqual(actions.calls.map(call => call.operation), ['create-enrollment', 'enrollment-start']);
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

test('self-service enrollment is retry-safe and consumes temporary secrets after acknowledgment', async () => {
  const secrets = new Map<string, string>();
  let enrollment: EnterpriseEnrollment | undefined;
  let codeHash = '';
  let consumed = false;
  let linkCalls = 0;
  const store = {
    createEnrollment: async (input: {
      codeHash: string;
      tenantId: string;
      objectId: string;
      userEmail: string;
      userAlias: string;
      githubAccountId: number;
      githubLogin: string;
      credentialSecretName: string;
      pendingSecretName: string;
      models: string[];
    }) => {
      codeHash = input.codeHash;
      enrollment = {
        id: '33333333-3333-3333-3333-333333333333',
        tenantId: input.tenantId,
        objectId: input.objectId,
        userEmail: input.userEmail,
        userAlias: input.userAlias,
        githubAccountId: input.githubAccountId,
        githubLogin: input.githubLogin,
        credentialSecretName: input.credentialSecretName,
        pendingSecretName: input.pendingSecretName,
        models: input.models,
        status: 'pending',
        expiresAt: '2099-01-01T00:00:00.000Z',
      };
      return { id: enrollment.id, expiresAt: enrollment.expiresAt };
    },
    enrollment: async (actualCodeHash: string) => {
      assert.equal(actualCodeHash, codeHash);
      if (!enrollment || consumed) throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'used', 401);
      return { ...enrollment };
    },
    setEnrollmentFlow: async (id: string, flowHandle: string) => {
      assert.equal(id, enrollment?.id);
      if (!enrollment) throw new Error('missing enrollment');
      enrollment = {
        ...enrollment,
        flowHandle,
        flowExpiresAt: '2099-01-01T00:00:00.000Z',
        status: 'authorizing',
      };
    },
    beginEnrollmentCompletion: async (id: string) => {
      assert.equal(id, enrollment?.id);
      if (!enrollment || enrollment.status !== 'authorizing') return false;
      enrollment = { ...enrollment, status: 'finalizing' };
      return true;
    },
    issueApiKey: async () => ({
      id: '44444444-4444-4444-4444-444444444444',
      apiKey: `ccgc_sk_${'k'.repeat(43)}`,
      expiresAt: '2099-01-01T00:00:00.000Z',
    }),
    completeEnrollment: async (id: string, outputSecretName: string) => {
      assert.equal(id, enrollment?.id);
      if (!enrollment || enrollment.status !== 'finalizing') throw new Error('invalid completion state');
      enrollment = { ...enrollment, outputSecretName, status: 'completed' };
    },
    consumeEnrollment: async (id: string) => {
      assert.equal(id, enrollment?.id);
      consumed = true;
    },
    close: async () => undefined,
  };
  const management = new EnterpriseManagement({
    litellmUrl: 'https://litellm.internal',
    litellmMasterKey: `sk-${'m'.repeat(32)}`,
    postgresUrl: 'postgresql://broker@postgres.internal/postgres?sslmode=require',
    enrollmentSecrets: {
      set: async (name, value) => { secrets.set(name, value); },
      get: async name => {
        const value = secrets.get(name);
        if (!value) throw new Error(`missing secret ${name}`);
        return value;
      },
      remove: async name => { secrets.delete(name); },
    },
    storeFactory: () => store as unknown as PostgresEnterpriseStore,
    fetcher: (async input => {
      const url = String(input);
      if (url.endsWith('/user/new')) {
        return Response.json({ user_id: '55555555-5555-4555-8555-555555555555', key: `sk-${'u'.repeat(32)}` });
      }
      if (url.endsWith('/credentials/user_connections')) return Response.json({ connections: [] });
      if (url.endsWith('/user_connection/start')) {
        return Response.json({
          verification_uri: 'https://github.com/login/device',
          user_code: 'ABCD-1234',
          flow_handle: 'opaque-flow',
          expires_in: 900,
          interval: 5,
        });
      }
      if (url.endsWith('/user_connection/poll')) {
        return Response.json({ status: 'connected', github_login: 'developer' });
      }
      throw new Error(`unexpected URL ${url}`);
    }) as typeof fetch,
  });
  management.link = async input => {
    linkCalls += 1;
    assert.equal(input.githubLogin, 'developer');
    return { status: 'linked' };
  };

  const created = await management.createEnrollment({
    tenantId: principal.tenantId,
    userEmail: 'developer@example.com',
    userAlias: 'developer',
    githubAccountId: 12345,
    githubLogin: 'developer',
    models: ['claude-sonnet-4-5'],
  });
  const code = String(created.code);
  assert.match(code, /^CCGC-[A-Za-z0-9_-]{24}$/);
  assert.equal(JSON.stringify(store).includes(code), false);

  const started = await management.startEnrollment({ code });
  assert.equal(started.status, 'authorization_required');
  const completed = await management.pollEnrollment({ code });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.apiKey, `ccgc_sk_${'k'.repeat(43)}`);
  assert.equal(linkCalls, 1);

  const retried = await management.pollEnrollment({ code });
  assert.deepEqual(retried, completed);
  assert.equal(linkCalls, 1);

  const acknowledged = await management.completeEnrollment({ code });
  assert.deepEqual(acknowledged, { status: 'completed' });
  assert.equal(consumed, true);
  assert.equal(secrets.size, 0);
  await assert.rejects(
    () => management.pollEnrollment({ code }),
    (error: unknown) => error instanceof BridgeError && error.code === 'GATEWAY_AUTH_REQUIRED',
  );
});

test('self-service enrollment can recover an existing isolated LiteLLM user', async () => {
  const storedSecrets = new Map<string, string>();
  let createdInput: Record<string, unknown> | undefined;
  const management = new EnterpriseManagement({
    litellmUrl: 'https://litellm.internal',
    litellmMasterKey: `sk-${'m'.repeat(32)}`,
    postgresUrl: 'postgresql://broker@postgres.internal/postgres?sslmode=require',
    enrollmentSecrets: {
      set: async (name, value) => { storedSecrets.set(name, value); },
      get: async () => { throw new Error('not used'); },
      remove: async name => { storedSecrets.delete(name); },
    },
    storeFactory: () => ({
      createEnrollment: async (input: Record<string, unknown>) => {
        createdInput = input;
        return { id: '33333333-3333-3333-3333-333333333333', expiresAt: '2099-01-01T00:00:00.000Z' };
      },
      close: async () => undefined,
    }) as unknown as PostgresEnterpriseStore,
    fetcher: (async () => { throw new Error('existing user recovery must not create another LiteLLM user'); }) as typeof fetch,
  });

  const result = await management.createEnrollment({
    tenantId: principal.tenantId,
    objectId: principal.objectId,
    litellmApiKey: `sk-${'u'.repeat(32)}`,
    userEmail: 'developer@example.com',
    userAlias: 'developer',
    githubAccountId: 12345,
    githubLogin: 'developer',
    models: ['claude-sonnet-4-5'],
  });

  assert.equal(result.objectId, principal.objectId);
  assert.equal(createdInput?.objectId, principal.objectId);
  assert.deepEqual([...storedSecrets.values()], [`sk-${'u'.repeat(32)}`]);
});
