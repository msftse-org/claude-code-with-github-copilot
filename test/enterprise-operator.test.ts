import assert from 'node:assert/strict';
import test from 'node:test';
import type { EnterpriseAuthenticator, EnterprisePrincipal } from '../src/enterprise-auth.ts';
import { startEnterpriseOperatorServer, type OperatorActions } from '../src/enterprise-operator-server.ts';
import { BridgeError, type ObjectValue } from '../src/protocol.ts';
import { EnterpriseOperator } from '../src/enterprise-operator.ts';

const principal: EnterprisePrincipal = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  objectId: '22222222-2222-2222-2222-222222222222',
  subject: 'operator',
};

class AdminAuthenticator implements EnterpriseAuthenticator {
  async authenticate(token: string): Promise<EnterprisePrincipal> {
    if (token !== 'admin-role') throw new BridgeError('ACCESS_DENIED', 'CCGC.Admin is required.', 403);
    return principal;
  }
}

class FakeActions implements OperatorActions {
  calls: Array<{ operation: string; input: ObjectValue }> = [];
  private called(operation: string, input: ObjectValue): Promise<ObjectValue> {
    this.calls.push({ operation, input });
    return Promise.resolve({ status: 'ok', operation });
  }
  bootstrap(input: ObjectValue) { return this.called('bootstrap', input); }
  createUser(input: ObjectValue) { return this.called('create-user', input); }
  startConnection(input: ObjectValue) { return this.called('connect-start', input); }
  pollConnection(input: ObjectValue) { return this.called('connect-poll', input); }
  bootstrapDatabase() { return this.called('database', {}); }
  link(input: ObjectValue) { return this.called('link', input); }
  revoke(input: ObjectValue) { return this.called('revoke', input); }
  status() { return this.called('status', {}); }
}

test('operator API requires the administrator role before executing actions', async () => {
  const actions = new FakeActions();
  const server = await startEnterpriseOperatorServer({
    authenticator: new AdminAuthenticator(),
    actions,
  });
  try {
    const employee = await fetch(`http://127.0.0.1:${server.port}/ccgc/operator/bootstrap`, {
      method: 'POST',
      headers: { authorization: 'Bearer employee-role', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(employee.status, 403);
    assert.equal(actions.calls.length, 0);

    const admin = await fetch(`http://127.0.0.1:${server.port}/ccgc/operator/bootstrap`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-role', 'content-type': 'application/json' },
      body: JSON.stringify({ credentialName: 'github-copilot-user' }),
    });
    assert.equal(admin.status, 200);
    assert.deepEqual(actions.calls, [{
      operation: 'bootstrap',
      input: { credentialName: 'github-copilot-user' },
    }]);
    assert.equal(admin.headers.get('cache-control'), 'no-store');
  } finally {
    await server.close();
  }
});

test('operator API rejects browser origins and never invokes administrative actions', async () => {
  const actions = new FakeActions();
  const server = await startEnterpriseOperatorServer({
    authenticator: new AdminAuthenticator(),
    actions,
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/ccgc/operator/revoke`, {
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

test('operator split device flow verifies the expected employee GitHub account', async () => {
  const requests: string[] = [];
  const operator = new EnterpriseOperator({
    litellmUrl: 'https://litellm.internal',
    litellmMasterKey: `sk-${'m'.repeat(32)}`,
    postgresUrl: 'postgresql://operator@postgres.internal/postgres?sslmode=require',
    brokerDatabasePrincipal: 'id-ccgc-broker',
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
  const started = await operator.startConnection(input);
  assert.equal(started.status, 'authorization_required');
  assert.equal(started.userCode, 'ABCD-1234');
  assert.equal(JSON.stringify(started).includes('mmmm'), false);

  const connected = await operator.pollConnection({ ...input, flowHandle: started.flowHandle });
  assert.deepEqual(connected, {
    status: 'connected',
    githubLogin: 'developer',
    credentialName: 'github-copilot-user',
  });
  assert.equal(requests.length, 3);
});

test('operator suppresses LiteLLM error bodies and rejects a different GitHub account', async () => {
  const input = {
    litellmApiKey: `sk-${'u'.repeat(32)}`,
    litellmCredentialName: 'github-copilot-user',
    githubLogin: 'developer',
    flowHandle: 'opaque-flow',
  };
  const conflicting = new EnterpriseOperator({
    litellmUrl: 'https://litellm.internal',
    litellmMasterKey: `sk-${'m'.repeat(32)}`,
    postgresUrl: 'postgresql://operator@postgres.internal/postgres?sslmode=require',
    brokerDatabasePrincipal: 'id-ccgc-broker',
    fetcher: (async () => Response.json({
      status: 'connected',
      github_login: 'another-user',
    })) as typeof fetch,
  });
  await assert.rejects(
    () => conflicting.pollConnection(input),
    (error: unknown) => error instanceof BridgeError && error.code === 'IDENTITY_CONFLICT',
  );

  const failing = new EnterpriseOperator({
    litellmUrl: 'https://litellm.internal',
    litellmMasterKey: `sk-${'m'.repeat(32)}`,
    postgresUrl: 'postgresql://operator@postgres.internal/postgres?sslmode=require',
    brokerDatabasePrincipal: 'id-ccgc-broker',
    fetcher: (async () => new Response('upstream-secret-value', { status: 500 })) as typeof fetch,
  });
  await assert.rejects(
    () => failing.startConnection(input),
    (error: unknown) => error instanceof BridgeError
      && error.message === 'LiteLLM returned HTTP 500.'
      && !error.message.includes('upstream-secret-value'),
  );
});
