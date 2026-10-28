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
  listAccess(input: ObjectValue) { return this.called('list-access', input); }
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
    reusableEnrollmentUser: async () => null,
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

test('broker serves the administrator panel with locked-down browser headers', async () => {
  const actions = new FakeActions();
  const server = await startEnterpriseServer({
    authenticator: new TokenAuthenticator('employee-role'),
    adminAuthenticator: new TokenAuthenticator('admin-role'),
    adminActions: actions,
    ...brokerDependencies(),
  });

  try {
    const page = await fetch(`http://127.0.0.1:${server.port}/ccgc/admin`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /^text\/html/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.match(page.headers.get('content-security-policy') ?? '', /connect-src 'self' https:\/\/login\.microsoftonline\.com/);
    const pageSource = await page.text();
    assert.match(pageSource, /Employee access/);
    assert.match(pageSource, /Access inventory/);

    const script = await fetch(`http://127.0.0.1:${server.port}/ccgc/admin/assets/admin.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type') ?? '', /^text\/javascript/);
    const adminSource = await script.text();
    assert.equal(adminSource.includes('localStorage'), false);
    assert.match(adminSource, /\/ccgc\/admin\/access\/query/);

    const auth = await fetch(`http://127.0.0.1:${server.port}/ccgc/admin/assets/auth.js`);
    const authSource = await auth.text();
    assert.equal(auth.status, 200);
    assert.match(authSource, /code_challenge_method: 'S256'/);
    assert.match(authSource, /response_type: 'code'/);
    assert.match(authSource, /sessionStorage/);
    assert.equal(authSource.includes('localStorage'), false);
  } finally {
    await server.close();
  }
});

test('broker accepts only the configured browser origin for Entra admin calls', async () => {
  const actions = new FakeActions();
  const server = await startEnterpriseServer({
    authenticator: new TokenAuthenticator('employee-role'),
    adminAuthenticator: new TokenAuthenticator('admin-role'),
    adminActions: actions,
    adminBrowserOrigin: 'https://broker.example',
    ...brokerDependencies(),
  });

  try {
    const allowed = await fetch(`http://127.0.0.1:${server.port}/ccgc/admin/status`, {
      method: 'POST',
      headers: {
        authorization: ['Bearer', 'admin-role'].join(' '),
        'content-type': 'application/json',
        origin: 'https://broker.example',
      },
      body: '{}',
    });
    assert.equal(allowed.status, 200);
    assert.equal(actions.calls.length, 1);

    const rejected = await fetch(`http://127.0.0.1:${server.port}/ccgc/admin/status`, {
      method: 'POST',
      headers: {
        authorization: ['Bearer', 'admin-role'].join(' '),
        'content-type': 'application/json',
        origin: 'https://other.example',
      },
      body: '{}',
    });
    assert.equal(rejected.status, 403);
    assert.equal(actions.calls.length, 1);
  } finally {
    await server.close();
  }
});

test('broker exposes public browser identity configuration and protects access listing', async () => {
  const actions = new FakeActions();
  const server = await startEnterpriseServer({
    authenticator: new TokenAuthenticator('employee-role'),
    adminAuthenticator: new TokenAuthenticator('admin-role'),
    adminActions: actions,
    adminBrowserOrigin: 'https://broker.example',
    adminBrowserIdentity: {
      tenantId: principal.tenantId,
      clientId: '33333333-3333-3333-3333-333333333333',
      scope: 'api://33333333-3333-3333-3333-333333333333/CCGC.Invoke',
      redirectUri: 'https://broker.example/ccgc/admin',
    },
    ...brokerDependencies(),
  });
  try {
    const config = await fetch(`http://127.0.0.1:${server.port}/ccgc/admin/config`);
    assert.equal(config.status, 200);
    assert.equal(config.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await config.json(), {
      tenantId: principal.tenantId,
      clientId: '33333333-3333-3333-3333-333333333333',
      scope: 'api://33333333-3333-3333-3333-333333333333/CCGC.Invoke',
      redirectUri: 'https://broker.example/ccgc/admin',
    });

    const denied = await fetch(`http://127.0.0.1:${server.port}/ccgc/admin/access/query`, {
      method: 'POST',
      headers: {
        authorization: ['Bearer', 'employee-role'].join(' '),
        'content-type': 'application/json',
        origin: 'https://broker.example',
      },
      body: JSON.stringify({ limit: 25 }),
    });
    assert.equal(denied.status, 403);

    const listed = await fetch(`http://127.0.0.1:${server.port}/ccgc/admin/access/query`, {
      method: 'POST',
      headers: {
        authorization: ['Bearer', 'admin-role'].join(' '),
        'content-type': 'application/json',
        origin: 'https://broker.example',
      },
      body: JSON.stringify({ limit: 25 }),
    });
    assert.equal(listed.status, 200);
    assert.deepEqual(actions.calls, [{ operation: 'list-access', input: { limit: 25 } }]);
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
    tenantId: principal.tenantId,
    enrollmentModels: ['claude-sonnet-5.5'],
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
    tenantId: principal.tenantId,
    enrollmentModels: ['claude-sonnet-5.5'],
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
    tenantId: principal.tenantId,
    enrollmentModels: ['claude-sonnet-5.5'],
    fetcher: (async () => new Response('upstream-secret-value', { status: 500 })) as typeof fetch,
  });
  await assert.rejects(
    () => failing.startConnection(input),
    (error: unknown) => error instanceof BridgeError
      && error.message === 'LiteLLM returned HTTP 500.'
      && !error.message.includes('upstream-secret-value'),
  );
});

test('self-service enrollment validates GitHub identity and legacy identity hints before provisioning', async () => {
  const createManagement = (githubResponse: Response) => new EnterpriseManagement({
    litellmUrl: 'https://litellm.internal',
    litellmMasterKey: `sk-${'m'.repeat(32)}`,
    postgresUrl: 'postgresql://broker@postgres.internal/postgres?sslmode=require',
    tenantId: principal.tenantId,
    enrollmentModels: ['claude-sonnet-5.5', 'claude-opus-5.5'],
    fetcher: (async input => {
      assert.equal(String(input), 'https://api.github.com/users/developer');
      return githubResponse;
    }) as typeof fetch,
    storeFactory: () => {
      throw new Error('store must not be opened before identity validation');
    },
  });

  await assert.rejects(
    createManagement(new Response(null, { status: 404 })).createEnrollment({
      userEmail: 'developer@example.com',
      githubLogin: 'developer',
    }),
    (error: unknown) => error instanceof BridgeError
      && error.code === 'INVALID_REQUEST'
      && error.message === 'GitHub user was not found.',
  );
  await assert.rejects(
    createManagement(new Response('private-upstream-detail', { status: 503 })).createEnrollment({
      userEmail: 'developer@example.com',
      githubLogin: 'developer',
    }),
    (error: unknown) => error instanceof BridgeError
      && error.code === 'GATEWAY_UNAVAILABLE'
      && error.message === 'GitHub identity verification returned HTTP 503.'
      && !error.message.includes('private-upstream-detail'),
  );
  await assert.rejects(
    createManagement(Response.json({ login: 'developer', id: 12345, type: 'User' })).createEnrollment({
      userEmail: 'developer@example.com',
      githubLogin: 'developer',
      githubAccountId: 54321,
    }),
    (error: unknown) => error instanceof BridgeError
      && error.code === 'IDENTITY_CONFLICT'
      && error.message.includes('account ID'),
  );
  await assert.rejects(
    createManagement(Response.json({ login: 'developer', id: 12345, type: 'User' })).createEnrollment({
      tenantId: '99999999-9999-4999-8999-999999999999',
      userEmail: 'developer@example.com',
      githubLogin: 'developer',
    }),
    (error: unknown) => error instanceof BridgeError
      && error.code === 'IDENTITY_CONFLICT'
      && error.message.includes('tenant'),
  );
});

test('self-service enrollment is retry-safe and consumes temporary secrets after acknowledgment', async () => {
  const secrets = new Map<string, string>();
  let enrollment: EnterpriseEnrollment | undefined;
  let codeHash = '';
  let consumed = false;
  let linkCalls = 0;
  const store = {
    reusableEnrollmentUser: async () => null,
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
      ttlSeconds: number;
    }) => {
      assert.equal(input.ttlSeconds, 60 * 60);
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
    tenantId: principal.tenantId,
    enrollmentModels: ['claude-sonnet-5.5'],
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
      if (url === 'https://api.github.com/users/developer') {
        return Response.json({ login: 'developer', id: 12345, type: 'User' });
      }
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
    userEmail: 'developer@example.com',
    githubLogin: 'developer',
  });
  const code = String(created.code);
  assert.match(code, /^CCGC-[A-Za-z0-9_-]{24}$/);
  assert.equal(JSON.stringify(store).includes(code), false);
  assert.equal(enrollment?.tenantId, principal.tenantId);
  assert.equal(enrollment?.userAlias, 'developer');
  assert.equal(enrollment?.githubAccountId, 12345);
  assert.deepEqual(enrollment?.models, ['claude-sonnet-5.5']);

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

test('self-service enrollment reuses an expired pending user without exposing recovery fields', async () => {
  let createdInput: Record<string, unknown> | undefined;
  let userCreationAttempted = false;
  let userUpdated = false;
  const store = {
    reusableEnrollmentUser: async () => ({
      objectId: '55555555-5555-4555-8555-555555555555',
      pendingSecretName: 'ccgc-enrollment-pending-expired',
    }),
    createEnrollment: async (input: Record<string, unknown>) => {
      createdInput = input;
      return {
        id: '33333333-3333-4333-8333-333333333333',
        expiresAt: '2099-01-01T00:00:00.000Z',
      };
    },
    close: async () => undefined,
  };
  const management = new EnterpriseManagement({
    litellmUrl: 'https://litellm.internal',
    litellmMasterKey: `sk-${'m'.repeat(32)}`,
    postgresUrl: 'postgresql://broker@postgres.internal/postgres?sslmode=require',
    tenantId: principal.tenantId,
    enrollmentModels: ['claude-sonnet-5.5', 'claude-opus-5.5'],
    enrollmentSecrets: {
      set: async () => undefined,
      get: async name => {
        assert.equal(name, 'ccgc-enrollment-pending-expired');
        return `sk-${'u'.repeat(32)}`;
      },
      remove: async () => undefined,
    },
    storeFactory: () => store as unknown as PostgresEnterpriseStore,
    fetcher: (async (input, init) => {
      const url = String(input);
      if (url === 'https://api.github.com/users/marina-marenkov') {
        return Response.json({ login: 'marina-marenkov', id: 97739755, type: 'User' });
      }
      if (url === 'https://litellm.internal/user/update') {
        userUpdated = true;
        assert.deepEqual(JSON.parse(String(init?.body)), {
          user_id: '55555555-5555-4555-8555-555555555555',
          models: ['claude-sonnet-5.5', 'claude-opus-5.5'],
        });
        return Response.json({ status: 'success' });
      }
      if (url.endsWith('/user/new')) userCreationAttempted = true;
      throw new Error(`unexpected URL ${url}`);
    }) as typeof fetch,
  });

  const result = await management.createEnrollment({
    userEmail: 'mmarenkov@microsoft.com',
    githubLogin: 'marina-marenkov',
  });

  assert.equal(userCreationAttempted, false);
  assert.equal(userUpdated, true);
  assert.equal(result.objectId, '55555555-5555-4555-8555-555555555555');
  assert.equal(createdInput?.objectId, '55555555-5555-4555-8555-555555555555');
  assert.deepEqual(createdInput?.models, ['claude-sonnet-5.5', 'claude-opus-5.5']);
});

test('self-service enrollment completes when GitHub is already connected', async () => {
  const pendingSecretName = 'ccgc-enrollment-pending-11111111111141118111111111111111';
  let enrollment: EnterpriseEnrollment = {
    id: '33333333-3333-4333-8333-333333333333',
    tenantId: principal.tenantId,
    objectId: principal.objectId,
    userEmail: 'developer@example.com',
    userAlias: 'developer',
    githubAccountId: 12345,
    githubLogin: 'developer',
    credentialSecretName: 'ccgc-user-22222222222242228222222222222222',
    pendingSecretName,
    models: ['claude-sonnet-4-5'],
    status: 'pending',
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
  const secrets = new Map([[pendingSecretName, `sk-${'u'.repeat(32)}`]]);
  let linkCalls = 0;
  const management = new EnterpriseManagement({
    litellmUrl: 'https://litellm.internal',
    litellmMasterKey: `sk-${'m'.repeat(32)}`,
    postgresUrl: 'postgresql://broker@postgres.internal/postgres?sslmode=require',
    tenantId: principal.tenantId,
    enrollmentModels: ['claude-sonnet-5.5'],
    enrollmentSecrets: {
      set: async (name, value) => { secrets.set(name, value); },
      get: async name => {
        const value = secrets.get(name);
        if (!value) throw new Error(`missing secret ${name}`);
        return value;
      },
      remove: async name => { secrets.delete(name); },
    },
    storeFactory: () => ({
      enrollment: async () => ({ ...enrollment }),
      beginEnrollmentCompletion: async () => {
        if (enrollment.status !== 'pending' && enrollment.status !== 'authorizing') return false;
        enrollment = { ...enrollment, status: 'finalizing' };
        return true;
      },
      issueApiKey: async () => ({
        id: '44444444-4444-4444-8444-444444444444',
        apiKey: `ccgc_sk_${'k'.repeat(43)}`,
        expiresAt: '2099-01-01T00:00:00.000Z',
      }),
      completeEnrollment: async (_id: string, outputSecretName: string) => {
        enrollment = { ...enrollment, outputSecretName, status: 'completed' };
      },
      close: async () => undefined,
    }) as unknown as PostgresEnterpriseStore,
    fetcher: (async input => {
      assert.ok(String(input).endsWith('/credentials/user_connections'));
      return Response.json({
        connections: [{
          credential_name: 'github-copilot-user',
          connected: true,
          github_login: 'developer',
        }],
      });
    }) as typeof fetch,
  });
  management.link = async () => {
    linkCalls += 1;
    return { status: 'linked' };
  };

  const completed = await management.startEnrollment({ code: `CCGC-${'a'.repeat(24)}` });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.apiKey, `ccgc_sk_${'k'.repeat(43)}`);
  assert.equal(linkCalls, 1);
});

test('self-service enrollment can recover an existing isolated LiteLLM user', async () => {
  const storedSecrets = new Map<string, string>();
  let createdInput: Record<string, unknown> | undefined;
  const management = new EnterpriseManagement({
    litellmUrl: 'https://litellm.internal',
    litellmMasterKey: `sk-${'m'.repeat(32)}`,
    postgresUrl: 'postgresql://broker@postgres.internal/postgres?sslmode=require',
    tenantId: principal.tenantId,
    enrollmentModels: ['claude-sonnet-5.5'],
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
    fetcher: (async input => {
      if (String(input) === 'https://api.github.com/users/developer') {
        return Response.json({ login: 'developer', id: 12345, type: 'User' });
      }
      throw new Error('existing user recovery must not create another LiteLLM user');
    }) as typeof fetch,
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
  assert.equal(createdInput?.tenantId, principal.tenantId);
  assert.equal(createdInput?.userAlias, 'developer');
  assert.deepEqual(createdInput?.models, ['claude-sonnet-5.5']);
  assert.match(String(createdInput?.pendingSecretName), /^ccgc-enrollment-pending-[0-9a-f]{32}$/);
  assert.notEqual(createdInput?.pendingSecretName, `ccgc-enrollment-pending-${principal.objectId.replaceAll('-', '')}`);
  assert.deepEqual([...storedSecrets.values()], [`sk-${'u'.repeat(32)}`]);
});
