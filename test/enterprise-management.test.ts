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
import { BridgeError, object, type ObjectValue } from '../src/protocol.ts';

const principal: EnterprisePrincipal = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  objectId: '22222222-2222-2222-2222-222222222222',
  subject: 'administrator',
};

class TokenAuthenticator implements EnterpriseAuthenticator {
  readonly expected: string;
  readonly principal: EnterprisePrincipal;

  constructor(expected: string, value = principal) {
    this.expected = expected;
    this.principal = value;
  }

  async authenticate(token: string): Promise<EnterprisePrincipal> {
    if (token !== this.expected) throw new BridgeError('ACCESS_DENIED', 'Required Entra role is missing.', 403);
    return this.principal;
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
  revokeGitHubUser(input: ObjectValue) { return this.called('revoke-github-user', input); }
  reconcileJwtMappings() { return this.called('reconcile-jwt-mappings', {}); }
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
    enrollmentUser: async () => null,
    revokeGitHubAccount: async () => { throw new Error('not used'); },
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

    const revokeRequest = (token: string) => fetch(`http://127.0.0.1:${server.port}/ccgc/admin/github-users/revoke`, {
      method: 'POST',
      headers: { authorization: ['Bearer', token].join(' '), 'content-type': 'application/json' },
      body: JSON.stringify({ githubLogin: 'developer' }),
    });
    assert.equal((await revokeRequest('employee-role')).status, 403);
    assert.equal(actions.calls.length, 2);
    assert.equal((await revokeRequest('admin-role')).status, 200);
    assert.deepEqual(actions.calls[2], { operation: 'revoke-github-user', input: { githubLogin: 'developer' } });

    const retiredSetup = await fetch(`http://127.0.0.1:${server.port}/ccgc/enterprise/setup/provision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(retiredSetup.status, 404);
    assert.equal(actions.calls.length, 3);

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

const masterKey = `sk-${'m'.repeat(32)}`;
const pendingKey = `sk-${'p'.repeat(32)}`;
const employeeKey = `sk-${'e'.repeat(32)}`;

interface LiteLLMCall {
  method: string;
  path: string;
  authorization: string | null;
  body?: ObjectValue;
}

function recordingFetcher(handle: (call: LiteLLMCall) => Response | undefined) {
  const calls: LiteLLMCall[] = [];
  const fetcher = (async (input, init) => {
    const url = new URL(String(input));
    const path = url.origin === 'https://litellm.internal' ? `${url.pathname}${url.search}` : url.href;
    const body = init?.body ? object(JSON.parse(String(init.body))) : undefined;
    const call: LiteLLMCall = {
      method: init?.method ?? 'GET',
      path,
      authorization: new Headers(init?.headers).get('authorization'),
      ...(body ? { body } : {}),
    };
    calls.push(call);
    if (path === 'https://api.github.com/users/developer') {
      return Response.json({ login: 'developer', id: 12345, type: 'User' });
    }
    const response = handle(call);
    if (!response) throw new Error(`unexpected ${call.method} ${path}`);
    return response;
  }) as typeof fetch;
  return { calls, fetcher };
}

function memorySecrets() {
  const values = new Map<string, string>();
  return {
    values,
    secrets: {
      set: async (name: string, value: string) => { values.set(name, value); },
      get: async (name: string) => {
        const value = values.get(name);
        if (!value) throw new Error(`missing secret ${name}`);
        return value;
      },
      remove: async (name: string) => { values.delete(name); },
    },
  };
}

function enrollmentStore(existingUser: string | null = null) {
  const state: { enrollment?: EnterpriseEnrollment; codeHash: string; consumed: boolean } = { codeHash: '', consumed: false };
  const store = {
    enrollmentUser: async (tenantId: string, githubAccountId: number) => {
      assert.equal(tenantId, principal.tenantId);
      assert.equal(githubAccountId, 12345);
      return existingUser;
    },
    createEnrollment: async (input: Parameters<EnterpriseStore['createEnrollment']>[0]) => {
      assert.equal(input.ttlSeconds, 60 * 60);
      state.codeHash = input.codeHash;
      state.consumed = false;
      state.enrollment = {
        id: '33333333-3333-4333-8333-333333333333',
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
      return { id: state.enrollment.id, expiresAt: state.enrollment.expiresAt };
    },
    enrollment: async (codeHash: string) => {
      if (!state.enrollment || state.consumed || codeHash !== state.codeHash) {
        throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'used', 401);
      }
      return { ...state.enrollment };
    },
    setEnrollmentFlow: async (_id: string, flowHandle: string) => {
      state.enrollment = { ...state.enrollment!, flowHandle, flowExpiresAt: '2099-01-01T00:00:00.000Z', status: 'authorizing' };
    },
    beginEnrollmentCompletion: async () => {
      if (state.enrollment?.status !== 'authorizing') return false;
      state.enrollment = { ...state.enrollment, status: 'finalizing' };
      return true;
    },
    completeEnrollment: async (_id: string, outputSecretName: string) => {
      assert.equal(state.enrollment?.status, 'finalizing');
      state.enrollment = { ...state.enrollment!, outputSecretName, status: 'completed' };
    },
    consumeEnrollment: async () => { state.consumed = true; },
    close: async () => undefined,
  };
  return { state, store: store as unknown as PostgresEnterpriseStore };
}

function enrollmentManagement(
  store: PostgresEnterpriseStore,
  secrets: ReturnType<typeof memorySecrets>['secrets'],
  fetcher: typeof fetch,
  models = ['claude-sonnet-5.5'],
) {
  return new EnterpriseManagement({
    litellmUrl: 'https://litellm.internal',
    litellmMasterKey: masterKey,
    postgresUrl: 'postgresql://broker@postgres.internal/postgres?sslmode=require',
    tenantId: principal.tenantId,
    enrollmentModels: models,
    enrollmentSecrets: secrets,
    storeFactory: () => store,
    fetcher,
  });
}

const isCode = (code: string) => (error: unknown) => error instanceof BridgeError && error.code === code;

test('enrollment forces one GitHub device flow and issues a scoped 90-day LiteLLM key', async () => {
  const { state, store } = enrollmentStore();
  const { values, secrets } = memorySecrets();
  let userId = '';
  let employeeAlias = '';
  const { calls, fetcher } = recordingFetcher(call => {
    if (call.path.startsWith('/user/info?user_id=')) return Response.json({ error: 'missing' }, { status: 404 });
    if (call.path === '/user/new') {
      userId = String(call.body?.user_id);
      assert.match(userId, /^[0-9a-f-]{36}$/);
      assert.deepEqual(call.body, {
        user_id: userId,
        user_alias: 'developer',
        user_role: 'internal_user',
        models: ['claude-sonnet-5.5'],
        auto_create_key: false,
        send_invite_email: false,
        metadata: {
          ccgc_managed: true,
          github_login: 'developer',
          github_account_id: 12345,
          ccgc_email: 'developer@example.com',
        },
      });
      return Response.json({ user_id: userId });
    }
    if (call.path === '/key/generate' && call.body?.duration === '2h') {
      assert.equal(call.authorization, ['Bearer', masterKey].join(' '));
      assert.equal(call.body.user_id, userId);
      assert.match(String(call.body.key_alias), /^ccgc-enroll-[0-9a-f-]{36}$/);
      assert.deepEqual(call.body.allowed_routes, [
        '/credentials/user_connections',
        '/credentials/github-copilot-user/user_connection',
      ]);
      return Response.json({ key: pendingKey, expires: '2099-01-01T02:00:00Z' });
    }
    if (call.path === '/key/generate') {
      employeeAlias = String(call.body?.key_alias);
      assert.match(employeeAlias, /^ccgc-claude-[0-9a-f-]{36}$/);
      assert.equal(call.body?.user_id, userId);
      assert.equal(call.body?.duration, '90d');
      assert.deepEqual(call.body?.models, ['claude-sonnet-5.5']);
      assert.deepEqual(call.body?.allowed_routes, ['llm_api_routes', 'info_routes', '/credentials/user_connections']);
      assert.equal(Object.hasOwn(call.body ?? {}, 'key_type'), false);
      return Response.json({ key: employeeKey, expires: '2099-04-01T00:00:00Z' });
    }
    if (call.path === '/credentials/github-copilot-user/user_connection/start') {
      assert.equal(call.authorization, ['Bearer', pendingKey].join(' '));
      return Response.json({
        verification_uri: 'https://github.com/login/device',
        user_code: 'ABCD-1234',
        flow_handle: 'opaque-flow',
        expires_in: 900,
        interval: 5,
      });
    }
    if (call.path === '/credentials/github-copilot-user/user_connection/poll') {
      assert.equal(call.authorization, ['Bearer', pendingKey].join(' '));
      assert.deepEqual(call.body, { flow_handle: 'opaque-flow' });
      return Response.json({ status: 'connected', github_login: 'developer' });
    }
    if (call.path.startsWith('/key/list?')) {
      assert.equal(call.path, `/key/list?user_id=${userId}&page=1&size=100&return_full_object=true`);
      return Response.json({
        keys: [
          { token: 'hash-old', key_alias: 'ccgc-claude-old' },
          { token: 'hash-pending', key_alias: 'ccgc-enroll-old' },
          { token: 'hash-new', key_alias: employeeAlias },
        ],
        total_pages: 1,
      });
    }
    if (call.path === '/key/delete') {
      assert.deepEqual(call.body, { keys: ['hash-old', 'hash-pending'] });
      return Response.json({ deleted_keys: ['hash-old', 'hash-pending'] });
    }
    return undefined;
  });
  const management = enrollmentManagement(store, secrets, fetcher);

  const created = await management.createEnrollment({ userEmail: 'developer@example.com', githubLogin: 'developer' });
  const code = String(created.code);
  assert.match(code, /^CCGC-[A-Za-z0-9_-]{24}$/);
  assert.equal(created.objectId, userId);
  assert.equal(JSON.stringify(state).includes(code), false);
  assert.deepEqual([...values.values()], [pendingKey]);

  await assert.rejects(() => management.startEnrollment({ code }), isCode('CLIENT_UPGRADE_REQUIRED'));
  const started = await management.startEnrollment({ code, credentialType: 'litellm' });
  assert.deepEqual(started, {
    status: 'authorization_required',
    verificationUri: 'https://github.com/login/device',
    userCode: 'ABCD-1234',
    expiresIn: 900,
    interval: 5,
    githubLogin: 'developer',
  });
  assert.equal(calls.some(call => call.path === '/credentials/user_connections'), false);

  const completed = await management.pollEnrollment({ code, credentialType: 'litellm' });
  assert.deepEqual(completed, {
    status: 'completed',
    apiKey: employeeKey,
    apiKeyExpiresAt: '2099-04-01T00:00:00.000Z',
    litellmUserId: userId,
    litellmCredentialName: 'github-copilot-user',
    githubLogin: 'developer',
    githubAccountId: 12345,
    models: ['claude-sonnet-5.5'],
  });
  assert.deepEqual(await management.pollEnrollment({ code, credentialType: 'litellm' }), completed);
  assert.deepEqual(await management.startEnrollment({ code, credentialType: 'litellm' }), completed);
  assert.equal(calls.filter(call => call.path === '/key/generate').length, 2);

  assert.deepEqual(await management.completeEnrollment({ code }), { status: 'completed', replacedKeys: 2 });
  assert.equal(state.consumed, true);
  assert.equal(values.size, 0);
  await assert.rejects(() => management.pollEnrollment({ code, credentialType: 'litellm' }), isCode('GATEWAY_AUTH_REQUIRED'));
});

test('re-enrollment reuses the GitHub account’s LiteLLM user and rejects unsafe input', async () => {
  const existing = '55555555-5555-4555-8555-555555555555';
  let role = 'internal_user';
  const { state, store } = enrollmentStore(existing);
  const { secrets } = memorySecrets();
  const { calls, fetcher } = recordingFetcher(call => {
    if (call.path === `/user/info?user_id=${existing}`) {
      return Response.json({ user_id: existing, user_info: { user_id: existing, user_role: role } });
    }
    if (call.path === '/user/update') {
      assert.deepEqual(call.body, {
        user_id: existing,
        user_alias: 'developer',
        models: ['claude-sonnet-5.5', 'claude-opus-5.5'],
      });
      return Response.json({ status: 'success' });
    }
    if (call.path === '/key/generate') return Response.json({ key: pendingKey, expires: '2099-01-01T02:00:00Z' });
    return undefined;
  });
  const management = enrollmentManagement(store, secrets, fetcher, ['claude-sonnet-5.5', 'claude-opus-5.5']);

  await assert.rejects(
    () => management.createEnrollment({ githubLogin: 'developer', objectId: existing, litellmApiKey: pendingKey }),
    isCode('INVALID_REQUEST'),
  );
  await assert.rejects(
    () => management.createEnrollment({ githubLogin: 'developer', userEmail: 'not-an-email' }),
    isCode('INVALID_REQUEST'),
  );
  assert.equal(calls.length, 0);

  const created = await management.createEnrollment({ githubLogin: 'developer' });
  assert.equal(created.objectId, existing);
  assert.equal(state.enrollment?.objectId, existing);
  assert.equal(state.enrollment?.userEmail, '');
  assert.equal(calls.some(call => call.path === '/user/new'), false);

  role = 'proxy_admin';
  const generated = calls.filter(call => call.path === '/key/generate').length;
  await assert.rejects(() => management.createEnrollment({ githubLogin: 'developer' }), isCode('IDENTITY_CONFLICT'));
  assert.equal(calls.filter(call => call.path === '/key/generate').length, generated);
});

test('enrollment disconnects and rejects a different approving GitHub account', async () => {
  const { store } = enrollmentStore();
  const { secrets } = memorySecrets();
  const { calls, fetcher } = recordingFetcher(call => {
    if (call.path.startsWith('/user/info?user_id=')) return Response.json({ error: 'missing' }, { status: 404 });
    if (call.path === '/user/new') return Response.json({ user_id: call.body?.user_id });
    if (call.path === '/key/generate') return Response.json({ key: pendingKey, expires: '2099-01-01T02:00:00Z' });
    if (call.path.endsWith('/user_connection/start')) {
      return Response.json({
        verification_uri: 'https://github.com/login/device',
        user_code: 'ABCD-1234',
        flow_handle: 'opaque-flow',
        expires_in: 900,
        interval: 5,
      });
    }
    if (call.path.endsWith('/user_connection/poll')) return Response.json({ status: 'connected', github_login: 'another-user' });
    if (call.method === 'DELETE' && call.path === '/credentials/github-copilot-user/user_connection') {
      assert.equal(call.authorization, ['Bearer', pendingKey].join(' '));
      return Response.json({ status: 'disconnected' });
    }
    return undefined;
  });
  const management = enrollmentManagement(store, secrets, fetcher);
  const code = String((await management.createEnrollment({ githubLogin: 'developer' })).code);
  await management.startEnrollment({ code, credentialType: 'litellm' });
  await assert.rejects(() => management.pollEnrollment({ code, credentialType: 'litellm' }), isCode('IDENTITY_CONFLICT'));
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 1);
  assert.equal(calls.filter(call => call.path === '/key/generate').length, 1);
});

test('offboarding disconnects Copilot, deletes the LiteLLM user, and removes enrollment secrets', async () => {
  const active = '55555555-5555-4555-8555-555555555555';
  const missing = '66666666-6666-4666-8666-666666666666';
  const cleanupKey = `sk-${'c'.repeat(32)}`;
  let revocation = { objectIds: [active, missing], secretNames: ['ccgc-enrollment-output-x'], revokedEnrollments: 1 };
  const { values, secrets } = memorySecrets();
  values.set('ccgc-enrollment-output-x', '{}');
  const store = {
    revokeGitHubAccount: async (tenantId: string, githubAccountId: number) => {
      assert.equal(tenantId, principal.tenantId);
      assert.equal(githubAccountId, 12345);
      return revocation;
    },
    close: async () => undefined,
  } as unknown as PostgresEnterpriseStore;
  const { calls, fetcher } = recordingFetcher(call => {
    if (call.path === `/user/info?user_id=${active}`) {
      return Response.json({ user_info: { user_id: active, user_role: 'internal_user' } });
    }
    if (call.path === `/user/info?user_id=${missing}`) return Response.json({ error: 'missing' }, { status: 404 });
    if (call.path === '/key/generate') {
      assert.equal(call.body?.user_id, active);
      assert.equal(call.body?.duration, '10m');
      assert.deepEqual(call.body?.allowed_routes, ['/credentials/github-copilot-user/user_connection']);
      return Response.json({ key: cleanupKey, expires: '2099-01-01T00:10:00Z' });
    }
    if (call.method === 'DELETE' && call.path === '/credentials/github-copilot-user/user_connection') {
      assert.equal(call.authorization, ['Bearer', cleanupKey].join(' '));
      return Response.json({ status: 'disconnected' });
    }
    if (call.path === '/user/delete') {
      assert.deepEqual(call.body, { user_ids: [active] });
      return Response.json({ deleted_users: [active] });
    }
    return undefined;
  });
  const management = enrollmentManagement(store, secrets, fetcher);

  assert.deepEqual(await management.revokeGitHubUser({ githubLogin: 'developer' }), {
    status: 'revoked',
    githubLogin: 'developer',
    githubAccountId: 12345,
    deletedLiteLLMUsers: 1,
    revokedEnrollments: 1,
  });
  const paths = calls.map(call => call.path);
  assert.ok(paths.indexOf('/credentials/github-copilot-user/user_connection') < paths.indexOf('/user/delete'));
  assert.equal(values.size, 0);

  revocation = { objectIds: [], secretNames: [], revokedEnrollments: 0 };
  await assert.rejects(() => management.revokeGitHubUser({ githubLogin: 'developer' }), isCode('NOT_FOUND'));
});
