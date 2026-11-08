import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { EnterpriseClient, responseJson } from '../src/enterprise-client.ts';
import { setupEnterprise, type SetupCallbacks } from '../src/enterprise-setup.ts';
import { writePrivate } from '../src/private-state.ts';
import { BridgeError, object, type ObjectValue } from '../src/protocol.ts';

const origin = 'https://litellm.example';
const generatedKey = `sk-personal-${'p'.repeat(32)}`;
const oldKey = `sk-other-${'o'.repeat(32)}`;
const oldId = 'a'.repeat(64);
const credentialName = 'github-copilot-user';
const models = ['claude-sonnet-5.5', 'claude-haiku-4.5'];

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'ccgc-personal-setup-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const values = new Map([[oldId, oldKey]]);
  const reads: string[] = [];
  const calls: Array<{ path: string; body?: ObjectValue }> = [];
  const confirmations: Array<Parameters<SetupCallbacks['confirmIdentity']>[0]> = [];
  const devices: Array<Parameters<SetupCallbacks['authorizeDevice']>[0]> = [];
  const state = {
    role: 'internal_user',
    generatedOwner: 'own-user',
    keyOwner: 'own-user',
    connected: false,
    githubLogin: 'own-github',
    changedConnection: false,
    verificationUri: 'https://github.com/login/device',
    expiresIn: 60,
    polls: [{ status: 'connected', github_login: 'own-github' }] as ObjectValue[],
    visibleModels: [...models],
    extraRoutes: [] as ObjectValue[],
    failWrite: false,
  };
  const client = new EnterpriseClient(home, {
    async get(id) {
      reads.push(id);
      const value = values.get(id);
      if (!value) throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'missing', 401);
      return value;
    },
    async set(id, value) {
      values.set(id, value);
      if (state.failWrite) await chmod(dirname(client.statePath), 0o755);
    },
    async remove(id) { values.delete(id); },
  }, { async getToken() { throw new Error('Entra must not be used'); } }, async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, origin);
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    const body = init?.body ? object(JSON.parse(String(init.body))) : undefined;
    calls.push({ path: url.pathname, ...(body ? { body } : {}) });
    const auth = new Headers(init?.headers).get('authorization');
    assert.equal(auth, ['Bearer', generatedKey].join(' '));
    const personalKey = auth === ['Bearer', generatedKey].join(' ');
    const userId = personalKey ? state.generatedOwner : 'own-user';
    if (url.pathname === '/key/info') return Response.json({ info: { user_id: state.keyOwner } });
    if (url.pathname === '/user/info') return Response.json({ user_info: { user_id: userId, user_alias: 'developer', user_role: state.role } });
    if (url.pathname === '/v1/model/info') return Response.json({ data: [...models.map(model => ({
      model_name: model,
      litellm_params: { model: `github_copilot/${model}`, litellm_credential_name: credentialName },
    })), ...state.extraRoutes] });
    if (url.pathname === '/v1/models') return Response.json({
      data: state.visibleModels.map(id => ({ id })),
    });
    if (url.pathname === '/credentials/user_connections') return Response.json({ connections: [{
      credential_name: credentialName,
      provider: 'github_copilot',
      connected: state.connected,
      github_login: personalKey && state.changedConnection ? 'different-github' : state.connected ? state.githubLogin : null,
    }] });
    if (url.pathname.endsWith('/user_connection/start')) {
      assert.equal(state.connected, false, 'must not reconnect an existing account');
      return Response.json({
        verification_uri: state.verificationUri,
        user_code: 'ABCD-1234',
        flow_handle: 'private-flow-handle',
        interval: 1,
        expires_in: state.expiresIn,
      });
    }
    if (url.pathname.endsWith('/user_connection/poll')) {
      assert.deepEqual(body, { flow_handle: 'private-flow-handle' });
      const result = state.polls.shift();
      assert.ok(result, 'must not poll after a terminal status');
      if (result.status === 'connected') state.connected = true;
      return Response.json(result);
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const oldProfile = {
    gateway: origin, controlPlane: origin, authMethod: 'litellmKey', inferenceAuthentication: 'directKey',
    liteLLMUserId: 'other-user', keychainId: oldId, models,
  };
  await writePrivate(client.statePath, oldProfile);
  const original = await readFile(client.statePath, 'utf8');
  const callbacks: SetupCallbacks = {
    async confirmIdentity(identity) { confirmations.push(identity); return true; },
    async authorizeDevice(device) { devices.push(device); },
  };
  const unchanged = async () => {
    assert.equal(await readFile(client.statePath, 'utf8'), original);
    assert.deepEqual([...values], [[oldId, oldKey]]);
    assert.deepEqual(reads, []);
  };
  return { client, state, callbacks, calls, values, reads, confirmations, devices, unchanged, oldProfile };
}

test('broker-provisioned setup uses native GitHub OAuth and an isolated key without reading the old credential', async t => {
  const f = await fixture(t);
  f.state.polls.unshift({ status: 'pending', interval: 1 });
  const profile = await setupEnterprise(f.client, origin, { apiKey: generatedKey }, f.callbacks);
  assert.equal(profile.liteLLMUserId, 'own-user');
  assert.equal(profile.githubLogin, 'own-github');
  assert.equal(profile.copilotCredentialName, credentialName);
  assert.deepEqual(profile.models, models);
  assert.deepEqual(f.reads, []);
  assert.equal(f.values.get(oldId), oldKey);
  assert.equal(await f.client.token(), generatedKey);
  assert.notEqual(profile.keychainId, oldId);
  const stored = await readFile(f.client.statePath, 'utf8');
  for (const secret of [generatedKey, oldKey, 'private-flow-handle']) {
    assert.equal(stored.includes(secret), false);
  }
  assert.deepEqual(f.devices, [{ verificationUri: 'https://github.com/login/device', userCode: 'ABCD-1234', expiresIn: 60 }]);
  assert.equal(f.calls.filter(call => call.path.endsWith('/poll')).length, 2);
  assert.equal(f.calls.some(call => call.path === '/key/generate' || call.path === '/v2/login'), false);
});

test('explicit own key confirms its existing connection without reconnecting or creating another key', async t => {
  const f = await fixture(t);
  f.state.connected = true;
  f.state.role = 'internal_user_viewer';
  const profile = await setupEnterprise(f.client, origin, { apiKey: generatedKey }, f.callbacks);
  assert.equal(profile.githubLogin, 'own-github');
  assert.equal(f.confirmations[0]?.githubLogin, 'own-github');
  assert.equal(f.calls.some(call => call.path.endsWith('/start') || call.path === '/key/generate'), false);
});

test('setup rejects shared admins, key-owner conflicts, and identity refusal without changing the old profile', async t => {
  for (const scenario of ['admin', 'key-user', 'refused']) {
    await t.test(scenario, async sub => {
      const f = await fixture(sub);
      if (scenario === 'admin') f.state.role = 'proxy_admin';
      if (scenario === 'key-user') f.state.keyOwner = 'someone-else';
      if (scenario === 'refused') f.callbacks.confirmIdentity = async () => false;
      await assert.rejects(setupEnterprise(f.client, origin, { apiKey: generatedKey }, f.callbacks), BridgeError);
      await f.unchanged();
      assert.equal(f.calls.some(call => call.path.endsWith('/start') || call.path === '/key/generate'), false);
    });
  }
});

test('native OAuth terminal failures preserve prior credentials and never mint a key', async t => {
  for (const status of ['denied', 'expired', 'no_copilot_seat']) {
    await t.test(status, async sub => {
      const f = await fixture(sub);
      f.state.polls = [{ status }];
      await assert.rejects(setupEnterprise(f.client, origin, { apiKey: generatedKey }, f.callbacks), { code: 'GITHUB_CONNECTION_REQUIRED' });
      await f.unchanged();
      assert.equal(f.calls.some(call => call.path === '/key/generate'), false);
    });
  }
});

test('OAuth slowdown, expiry, cancellation and unsafe verification URLs never trigger faster polling or local replacement', async t => {
  for (const scenario of ['slow-down', 'expiry', 'cancel', 'host', 'userinfo', 'path']) {
    await t.test(scenario, async sub => {
      const f = await fixture(sub);
      if (scenario === 'slow-down') f.state.polls = [{ status: 'slow_down', interval: 120 }];
      if (scenario === 'expiry') f.state.expiresIn = 1;
      if (scenario === 'host') f.state.verificationUri = 'https://github.com.example.test/login/device';
      if (scenario === 'userinfo') f.state.verificationUri = 'https://other@github.com/login/device';
      if (scenario === 'path') f.state.verificationUri = 'https://github.com/other';
      if (scenario === 'cancel') {
        const cancellation = new AbortController();
        f.callbacks.signal = cancellation.signal;
        f.callbacks.authorizeDevice = async () => cancellation.abort();
      }
      await assert.rejects(setupEnterprise(f.client, origin, { apiKey: generatedKey }, f.callbacks));
      await f.unchanged();
      assert.equal(f.calls.filter(call => call.path.endsWith('/poll')).length, scenario === 'slow-down' ? 1 : 0);
    });
  }
});

test('key-owner mismatch, connection drift, and failed persistence preserve the previous local profile', async t => {
  for (const scenario of ['key-owner', 'connection', 'persistence']) {
    await t.test(scenario, async sub => {
      const f = await fixture(sub);
      f.state.connected = true;
      if (scenario === 'key-owner') f.state.keyOwner = 'another-user';
      if (scenario === 'connection') {
        f.callbacks.confirmIdentity = async () => {
          f.state.changedConnection = true;
          return true;
        };
      }
      if (scenario === 'persistence') f.state.failWrite = true;
      await assert.rejects(setupEnterprise(f.client, origin, { apiKey: generatedKey }, f.callbacks), BridgeError);
      await f.unchanged();
    });
  }
});

test('provided keys exposing other Claude routes are rejected instead of silently routing elsewhere', async t => {
  const f = await fixture(t);
  f.state.visibleModels.push('claude-other-provider');
  await assert.rejects(setupEnterprise(f.client, origin, { apiKey: generatedKey }, f.callbacks), { code: 'IDENTITY_CONFLICT' });
  await f.unchanged();
});

test('duplicate Claude names cannot hide an alternative provider or another GitHub credential', async t => {
  for (const alternate of [
    { model: `anthropic/${models[0]}`, litellm_credential_name: 'other-provider' },
    { model: `github_copilot/${models[0]}`, litellm_credential_name: 'other-github' },
  ]) {
    await t.test(alternate.litellm_credential_name, async sub => {
      const f = await fixture(sub);
      f.state.extraRoutes.push({ model_name: models[0], litellm_params: alternate });
      f.callbacks.credentialName = credentialName;
      await assert.rejects(setupEnterprise(f.client, origin, { apiKey: generatedKey }, f.callbacks), { code: 'IDENTITY_CONFLICT' });
      await f.unchanged();
      assert.equal(f.calls.some(call => call.path.endsWith('/start')), false);
    });
  }
});

test('unverified legacy direct-key profiles cannot silently supply an inherited key to Claude', async t => {
  const f = await fixture(t);
  const { liteLLMUserId: _userId, keychainId: _keychainId, ...legacy } = f.oldProfile;
  await writePrivate(f.client.statePath, legacy);
  await assert.rejects(f.client.token(), { code: 'USER_SETUP_REQUIRED' });
  await assert.rejects(f.client.refreshModels(), { code: 'USER_SETUP_REQUIRED' });
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.calls, []);
});

test('enterprise metadata is bounded and upstream authentication error bodies are never exposed', async () => {
  await assert.rejects(responseJson(new Response('x'.repeat(1024 * 1024 + 1))), { code: 'LIMIT_REACHED' });
  await assert.rejects(responseJson(new Response('private-upstream-error-details', { status: 401 })), error => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, 'GATEWAY_AUTH_REQUIRED');
    assert.equal(error.message.includes('private-upstream-error-details'), false);
    return true;
  });
});

test('enrollment setup requires the GitHub account verified by the broker and never starts another device flow', async t => {
  for (const scenario of ['missing', 'different'] as const) {
    await t.test(scenario, async sub => {
      const f = await fixture(sub);
      f.state.connected = scenario === 'different';
      f.state.githubLogin = 'other-github';
      await assert.rejects(
        setupEnterprise(f.client, origin, { apiKey: generatedKey }, { ...f.callbacks, verifiedGithubLogin: 'own-github' }),
        { code: scenario === 'missing' ? 'GITHUB_CONNECTION_REQUIRED' : 'IDENTITY_CONFLICT' },
      );
      assert.deepEqual(f.devices, []);
      assert.equal(f.calls.some(call => call.path.endsWith('/start')), false);
      await f.unchanged();
    });
  }
  const f = await fixture(t);
  f.state.connected = true;
  const profile = await setupEnterprise(f.client, origin, { apiKey: generatedKey }, { ...f.callbacks, verifiedGithubLogin: 'OWN-GITHUB' });
  assert.equal(profile.githubLogin, 'own-github');
  assert.deepEqual(f.devices, []);
});

test('enrollment codes exchange one GitHub approval for a validated personal LiteLLM key', async () => {
  const broker = 'https://broker.example';
  const code = `CCGC-${'a'.repeat(24)}`;
  const userId = '55555555-5555-4555-8555-555555555555';
  const completed = {
    status: 'completed',
    apiKey: generatedKey,
    apiKeyExpiresAt: '2099-04-01T00:00:00Z',
    litellmUserId: userId,
    litellmCredentialName: credentialName,
    githubLogin: 'own-github',
    githubAccountId: 12345,
    models,
  };
  const enrollmentClient = (responses: Record<string, ObjectValue[] | Response[]>, calls: Array<{ path: string; body?: ObjectValue }>) =>
    new EnterpriseClient(tmpdir(), {
      async get() { throw new Error('not used'); },
      async set() { throw new Error('not used'); },
      async remove() { throw new Error('not used'); },
    }, { async getToken() { throw new Error('Entra must not be used'); } }, async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, broker);
      assert.equal(init?.redirect, 'error');
      assert.equal(new Headers(init?.headers).get('authorization'), null);
      const body = init?.body ? object(JSON.parse(String(init.body))) : undefined;
      calls.push({ path: url.pathname, ...(body ? { body } : {}) });
      if (url.pathname === '/ccgc/enterprise/config') return Response.json({ inferenceGateway: origin });
      const next = responses[url.pathname]?.shift();
      assert.ok(next, `unexpected ${url.pathname}`);
      return next instanceof Response ? next : Response.json(next);
    });

  const calls: Array<{ path: string; body?: ObjectValue }> = [];
  const devices: unknown[] = [];
  const client = enrollmentClient({
    '/ccgc/enroll/start': [{
      status: 'authorization_required',
      verificationUri: 'https://github.com/login/device',
      userCode: 'ABCD-1234',
      expiresIn: 60,
      interval: 1,
      githubLogin: 'own-github',
    }],
    '/ccgc/enroll/poll': [{ status: 'pending' }, completed],
    '/ccgc/enroll/complete': [{ status: 'completed', replacedKeys: 1 }],
  }, calls);
  await assert.rejects(client.enrollWithCode(broker, 'CCGC-short', { authorizeDevice: async () => undefined }), { code: 'INVALID_REQUEST' });
  assert.equal(calls.length, 0);
  const enrolled = await client.enrollWithCode(broker, code, { authorizeDevice: async device => { devices.push(device); } });
  assert.deepEqual(enrolled, {
    controlPlane: broker,
    inferenceGateway: origin,
    apiKey: generatedKey,
    apiKeyExpiresAt: '2099-04-01T00:00:00.000Z',
    userId,
    githubLogin: 'own-github',
    credentialName,
    models,
  });
  assert.deepEqual(devices, [{ verificationUri: 'https://github.com/login/device', userCode: 'ABCD-1234', expiresIn: 60, githubLogin: 'own-github' }]);
  assert.deepEqual(calls.filter(call => call.body).map(call => call.body), [
    { code, credentialType: 'litellm' },
    { code, credentialType: 'litellm' },
    { code, credentialType: 'litellm' },
  ]);
  await client.acknowledgeEnrollment(broker, code);
  assert.deepEqual(calls.at(-1), { path: '/ccgc/enroll/complete', body: { code } });

  const mismatched = enrollmentClient({
    '/ccgc/enroll/start': [{
      status: 'authorization_required',
      verificationUri: 'https://github.com/login/device',
      userCode: 'ABCD-1234',
      expiresIn: 60,
      interval: 1,
      githubLogin: 'own-github',
    }],
    '/ccgc/enroll/poll': [{ ...completed, githubLogin: 'different-github' }],
  }, []);
  await assert.rejects(mismatched.enrollWithCode(broker, code, { authorizeDevice: async () => undefined }), { code: 'IDENTITY_CONFLICT' });

  const brokerError = enrollmentClient({
    '/ccgc/enroll/start': [Response.json(
      { type: 'error', error: { type: 'authentication_error', message: 'GATEWAY_AUTH_REQUIRED: Enrollment code is invalid, expired, or already used.' } },
      { status: 401 },
    )],
  }, []);
  await assert.rejects(brokerError.enrollWithCode(broker, code, { authorizeDevice: async () => undefined }), {
    code: 'GATEWAY_AUTH_REQUIRED',
    message: 'Enrollment code is invalid, expired, or already used.',
  });
});
