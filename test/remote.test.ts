import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, chmod, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRemoteServer } from '../src/remote-server.ts';
import type { RemoteServerOptions } from '../src/remote-server.ts';
import { clientHistory, clientModelId, gatewayUrl, credential, LEGACY_REMOTE_PROFILE, remoteInfo, remoteModel, remoteRequest, REMOTE_PROFILE, PROBE_PROMPT, resolveModel } from '../src/remote.ts';
import { LiteLLMBackend } from '../src/litellm.ts';
import { RemoteClient, configure, helperCommand, settingsPatch, inspectRemoteSettings } from '../src/remote-client.ts';
import type { Secrets } from '../src/remote-client.ts';
import { readPrivate, readState, writePrivate } from '../src/private-state.ts';
import { object, parseJson, text } from '../src/protocol.ts';
import type { ObjectValue } from '../src/protocol.ts';
import { message, model, request, stream } from './fixtures.ts';

const ownerKey = randomBytes(32).toString('hex');
const identity = { login: 'synthetic-account', accountId: 42, model, models: [model], maxTurns: 5 };

async function fixture(extra: Partial<RemoteServerOptions> = {}) {
  const calls: ObjectValue[] = [];
  let revoked = false;
  let clock = Date.now();
  const server = await startRemoteServer({
    publicUrl: 'https://gateway.test/bridge', ownerKey,
    backend: { async send(body) { calls.push(structuredClone(body)); return body.stream ? stream() : Response.json(message()); } },
    verify: async () => identity, ownerIsRevoked: async () => revoked,
    revokeOwner: async () => { revoked = true; }, now: () => clock, ...extra,
  });
  async function call(path: string, input?: ObjectValue, token = ownerKey, headers: Record<string, string> = {}) {
    return new Promise<{ status: number; value: ObjectValue; raw: string }>((resolve, reject) => {
      const outgoing = httpRequest({
        host: '127.0.0.1', port: server.port, path: `/bridge${path}`, method: input === undefined ? 'GET' : 'POST',
        headers: { host: 'gateway.test', authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      }, response => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', data => { raw += data; });
        response.on('end', () => resolve({ status: response.statusCode!, value: parseJson(raw), raw }));
        response.on('error', reject);
      });
      outgoing.on('error', reject);
      outgoing.end(input === undefined ? undefined : JSON.stringify(input));
    });
  }
  async function admit() {
    const probe = await call('/ccgc/probe', { profile: REMOTE_PROFILE, model: model.id });
    assert.equal(probe.status, 200);
    const generated = await call('/v1/messages', request({ messages: [{ role: 'user', content: PROBE_PROMPT }] }), credential(probe.value.token));
    assert.equal(generated.status, 200, generated.raw);
    const admitted = await call('/ccgc/admit', { probeId: probe.value.id });
    assert.equal(admitted.status, 200, admitted.raw);
    const result = await call('/ccgc/token', { id: admitted.value.id });
    assert.equal(result.status, 200, result.raw);
    return { id: text(admitted.value.id, 'id'), token: credential(result.value.token), attempts: result.value.attempts };
  }
  return { server, calls, call, admit, advance(ms: number) { clock += ms; }, revoke() { revoked = true; } };
}

test('remote URL, model and credential validation reject alternate routes and malformed profiles', () => {
  assert.equal(gatewayUrl('https://gateway.test/bridge/'), 'https://gateway.test/bridge');
  for (const url of ['http://gateway.test', 'https://u:p@gateway.test', 'https://gateway.test?x=1', 'https://gateway.test/#f',
    'https://gateway.test/a/../b', 'https://gateway.test/a/%2e%2e/b', 'https://gateway.test/a//b', 'https:\\\\gateway.test']) {
    assert.throws(() => gatewayUrl(url));
  }
  for (const invalid of ['', 'a'.repeat(63), 'x'.repeat(64), '😀'.repeat(32)]) assert.throws(() => credential(invalid));
  assert.deepEqual(remoteModel(model), model);
  assert.throws(() => remoteModel({ ...model, id: 'gpt-4o' }));
  assert.throws(() => remoteModel({ ...model, responseIds: ['claude-other'] }));
});

test('remote control calls bound responses, disallow redirects, and never disclose response bodies in errors', async () => {
  let count = 0;
  const fetcher: typeof fetch = async (url, init) => {
    count++;
    assert.equal(url, 'https://gateway.test/ccgc/info');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${ownerKey}`);
    return Response.json({ private: 'must-not-be-logged' }, { status: 403 });
  };
  await assert.rejects(remoteRequest('https://gateway.test', ownerKey, 'info', undefined, fetcher), error => {
    assert.match(String(error), /HTTP 403/); assert.doesNotMatch(String(error), /must-not-be-logged/); return true;
  });
  assert.equal(count, 1);
  await assert.rejects(remoteRequest('https://gateway.test', ownerKey, 'info', undefined, async () => new Response('x'.repeat(65537))), /too large/);
  await assert.rejects(remoteRequest('https://gateway.test', ownerKey, 'info', undefined, async () => { throw new Error('private transport detail'); }), /DNS, TLS/);
});

test('native LiteLLM forwarding replaces credentials and forwards only reviewed protocol headers', async () => {
  let calls = 0;
  const controller = new AbortController();
  const backend = new LiteLLMBackend('http://litellm:4000', 'sk-internal-fixture', async (url, init) => {
    calls++;
    assert.equal(url, 'http://litellm:4000/v1/messages');
    assert.equal(init?.signal, controller.signal);
    assert.equal(init?.redirect, 'error');
    assert.deepEqual(JSON.parse(String(init?.body)), request());
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer sk-internal-fixture');
    assert.equal(headers.get('x-api-key'), null);
    assert.equal(headers.get('x-private'), null);
    assert.equal(headers.get('anthropic-beta'), 'synthetic-beta');
    return Response.json(message());
  });
  const response = await backend.send(request(), new Headers({ authorization: 'Bearer client-key', 'x-api-key': 'other-key', 'x-private': 'private', 'anthropic-beta': 'synthetic-beta' }), controller.signal);
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  for (const url of ['https://user:pass@host', 'https://host/path', 'https://host/?query=1', 'file:///tmp']) assert.throws(() => new LiteLLMBackend(url, 'key'));
});

test('native LiteLLM forwarding preserves reviewed output effort', async () => {
  const body = request({ output_config: { effort: 'high' }, thinking: { type: 'disabled' } });
  let calls = 0;
  const backend = new LiteLLMBackend('http://litellm:4000', 'synthetic-internal-key', async (_url, init) => {
    calls++;
    assert.deepEqual(JSON.parse(String(init?.body)), body);
    return Response.json(message());
  });
  await backend.send(body, new Headers(), new AbortController().signal);
  assert.equal(calls, 1);
});

test('owner and probe keys cannot bypass admission, host checks, fixed probes, or one-session binding', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call('/v1/messages', request())).status, 401);
    assert.equal((await f.call('/ccgc/info', undefined, ownerKey, { origin: 'https://gateway.test' })).status, 403);
    assert.equal((await f.call('/ccgc/info', undefined, ownerKey, { host: 'evil.test' })).status, 403);
    assert.equal((await f.call('/ccgc/info', undefined, ownerKey, { 'x-api-key': 'b'.repeat(64) })).status, 401);
    assert.equal((await f.call('/ccgc/probe', { profile: 'wrong', model: model.id })).status, 400);
    const probe = await f.call('/ccgc/probe', { profile: REMOTE_PROFILE, model: model.id });
    const probeKey = credential(probe.value.token);
    assert.equal((await f.call('/ccgc/admit', { probeId: probe.value.id })).status, 409);
    assert.equal((await f.call('/ccgc/info', undefined, probeKey)).status, 401);
    assert.equal((await f.call('/v1/messages', request(), probeKey)).status, 400);
    assert.equal((await f.call('/v1/messages', request({ messages: [{ role: 'user', content: [
      { type: 'text', text: 'unapproved repository context' }, { type: 'text', text: PROBE_PROMPT },
    ] }] }), probeKey)).status, 400);
    assert.equal(f.calls.length, 0);
    assert.equal((await f.call('/ccgc/cancel', { id: probe.value.id })).status, 200);
    const grant = await f.admit();
    assert.equal(grant.attempts, 1);
    assert.equal((await f.call('/v1/models', undefined, grant.token)).status, 200);
    assert.equal((await f.call('/v1/messages', request(), grant.token, { 'x-claude-code-session-id': 'one' })).status, 200);
    assert.equal((await f.call('/v1/messages', request(), grant.token, { 'x-claude-code-session-id': 'two' })).status, 409);
    assert.equal((await f.call('/v1/messages', request(), grant.token, { 'x-claude-code-session-id': 'one' })).status, 409);
    assert.equal(f.calls.length, 2);
    assert.equal((await f.call('/ccgc/logout', {}, grant.token)).status, 401);
  } finally { await f.server.close(); }
});

test('renewal preserves server-owned cumulative attempts, rotates keys, and cannot reset the limit', async () => {
  const f = await fixture({ verify: async () => ({ ...identity, maxTurns: 8 }) });
  try {
    const grant = await f.admit();
    const history: ObjectValue[] = [];
    for (let i = 0; i < 7; i++) {
      f.advance(8 * 60_000);
      history.push({ role: 'user', content: `Turn ${i}` });
      const result = await f.call('/v1/messages', request({ messages: history }), grant.token);
      assert.equal(result.status, 200, result.raw);
    }
    const renewed = await f.call('/ccgc/token', { id: grant.id });
    assert.equal(renewed.value.attempts, 8);
    assert.notEqual(renewed.value.token, grant.token);
    assert.equal((await f.call('/v1/models', undefined, grant.token)).status, 401);
    history.push({ role: 'user', content: 'excess' });
    assert.equal((await f.call('/v1/messages', request({ messages: history }), credential(renewed.value.token))).status, 429);
    assert.equal((await f.call('/ccgc/token', { id: grant.id })).value.attempts, 8);
    assert.equal(f.calls.length, 8);
  } finally { await f.server.close(); }
});

test('idle lease, probe expiry, identity changes, logout, and external revocation fail closed', async () => {
  let current = identity;
  const f = await fixture({ verify: async () => current });
  try {
    const probe = await f.call('/ccgc/probe', { profile: REMOTE_PROFILE, model: model.id });
    f.advance(120_000);
    assert.equal((await f.call('/v1/messages', request({ messages: [{ role: 'user', content: PROBE_PROMPT }] }), credential(probe.value.token))).status, 401);
    const grant = await f.admit();
    f.advance(15 * 60_000);
    assert.equal((await f.call('/ccgc/token', { id: grant.id })).status, 410);
    const second = await f.admit();
    current = { ...identity, accountId: 99 };
    assert.equal((await f.call('/ccgc/token', { id: second.id })).status, 403);
    assert.equal((await f.call('/v1/messages', request(), second.token)).status, 401);
    current = identity;
    assert.equal((await f.call('/ccgc/logout', {})).status, 200);
    assert.equal((await f.call('/ccgc/info')).status, 401);
  } finally { await f.server.close(); }
  const external = await fixture();
  try {
    const grant = await external.admit();
    external.revoke();
    assert.equal((await external.call('/v1/messages', request(), grant.token)).status, 401);
  } finally { await external.server.close(); }
  await assert.rejects(startRemoteServer({
    publicUrl: 'https://gateway.test', ownerKey, backend: { async send() { return Response.json(message()); } },
    verify: async () => identity, ownerIsRevoked: async () => true, revokeOwner: async () => {},
  }), /revoked/);
});

test('expiry while verification is pending does not resurrect a probe or admission', async () => {
  let wait: (() => Promise<void>) | undefined;
  const f = await fixture({ verify: async () => { await wait?.(); return identity; } });
  try {
    const grant = await f.admit();
    wait = async () => { f.advance(15 * 60_000); };
    assert.equal((await f.call('/ccgc/token', { id: grant.id })).status, 410);
  } finally { await f.server.close(); }
});

class MemorySecrets implements Secrets {
  values = new Map<string, string>();
  async get(id: string) { return this.values.get(id)!; }
  async set(id: string, value: string) { this.values.set(id, value); }
  async remove(id: string) { this.values.delete(id); }
}

test('restart recovery cannot approve a changed identity and confirmed logout cleanup is retryable', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccgc-remote-recovery-'));
  let remote = { ...identity, instance: 'first', profile: REMOTE_PROFILE };
  const secrets = new MemorySecrets();
  let revocations = 0;
  const client = new RemoteClient(home, secrets, async url => {
    if (String(url).endsWith('/logout')) { revocations++; return Response.json({ status: 'revoked' }); }
    return Response.json(remote);
  });
  try {
    await client.login('https://gateway.test', ownerKey);
    remote = { ...remote, instance: 'restarted' };
    await assert.rejects(client.info(), /changed/);
    await client.close();
    assert.equal((await client.info()).instance, 'restarted');
    remote = { ...remote, accountId: 99 };
    await assert.rejects(client.close(), /re-enrollment/);
    assert.equal((await client.load()).info.accountId, 42);
    remote = { ...remote, accountId: 42 };
    const remove = secrets.remove.bind(secrets);
    secrets.remove = async () => { throw new Error('synthetic Keychain failure'); };
    await assert.rejects(client.logout(), /Keychain failure/);
    assert.equal((await client.load()).revoked, true);
    secrets.remove = remove;
    await client.logout();
    assert.equal(revocations, 1);
    assert.equal(await readState(client.statePath), undefined);
  } finally { await rm(home, { recursive: true }); }
});

test('client persists no tokens in profile/settings; configure requires consent and preserves unrelated permissions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccgc-remote-state-'));
  const secrets = new MemorySecrets();
  const calls: string[] = [];
  const info = { ...identity, instance: 'synthetic-instance', profile: REMOTE_PROFILE };
  const client = new RemoteClient(home, secrets, async url => {
    calls.push(String(url));
    return Response.json(String(url).endsWith('/info') ? info : { status: 'revoked' });
  });
  try {
    const profile = await client.login('https://gateway.test', ownerKey);
    await assert.rejects(client.login('https://other.test', ownerKey), /already exists/);
    const saved = await readPrivate(client.statePath);
    assert.doesNotMatch(saved, new RegExp(ownerKey));
    assert.equal(secrets.values.size, 1);
    await assert.rejects(client.token(), /live/);
    const dir = join(home, '.claude');
    const path = join(dir, 'settings.json');
    await mkdir(dir);
    const current = { permissions: { deny: ['Bash(rm *)'] }, env: { CUSTOM: 'preserved' } };
    await writeFile(path, JSON.stringify(current));
    const preview = await configure(profile, home, false, home, join(home, 'absent-managed'));
    assert.equal(preview.applied, false);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), current);
    await configure(profile, home, true, home, join(home, 'absent-managed'));
    const applied = parseJson(await readFile(path, 'utf8'));
    assert.deepEqual(applied.permissions, { ...current.permissions, defaultMode: 'manual' });
    assert.equal(object(applied.env).CUSTOM, 'preserved');
    assert.equal(object(applied.env).ANTHROPIC_BASE_URL, profile.gateway);
    assert.equal(object(applied.env).ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(object(applied.env).CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, undefined);
    assert.equal(object(applied.env).CLAUDE_CODE_DISABLE_AUTO_MEMORY, undefined);
    assert.equal(object(applied.env).CLAUDE_CODE_DISABLE_CRON, undefined);
    assert.equal(object(applied.env).CLAUDE_CODE_DISABLE_ADVISOR_TOOL, undefined);
    assert.equal(applied.disableAllHooks, undefined);
    assert.match(text(applied.apiKeyHelper, 'helper'), /cli\.ts' token$/);
    assert.doesNotMatch(JSON.stringify(applied), new RegExp(ownerKey));
    assert.deepEqual(settingsPatch(profile).apiKeyHelper, applied.apiKeyHelper);
    await client.close();
    await client.logout();
    assert.equal(secrets.values.size, 0);
    assert.equal(await readState(client.statePath), undefined);
    assert.ok(calls.some(url => url.endsWith('/logout')));
  } finally { await rm(home, { recursive: true }); }
});

test('unsafe private state and conflicting/symlinked Claude settings are rejected before edits', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccgc-remote-unsafe-'));
  const profile = { gateway: 'https://gateway.test', info: { ...identity, profile: REMOTE_PROFILE, instance: 'test' } };
  try {
    await assert.rejects(inspectRemoteSettings(home, profile, home, join(home, 'managed'), { ANTHROPIC_API_KEY: 'synthetic-conflict' }), /Shell environment/);
    await assert.rejects(inspectRemoteSettings(home, profile, home, join(home, 'managed'), { CLAUDE_CODE_USE_BEDROCK: '1' }), /Shell environment/);
    const state = join(home, 'state', 'profile.json');
    await writePrivate(state, { test: true });
    await chmod(state, 0o644);
    await assert.rejects(readPrivate(state), /private/);
    await chmod(state, 0o600);
    await chmod(join(home, 'state'), 0o755);
    await assert.rejects(readPrivate(state), /private/);
    await mkdir(join(home, '.claude'));
    const settings = join(home, '.claude', 'settings.json');
    await writeFile(settings, '{"apiKeyHelper":"unreviewed-helper"}');
    await assert.rejects(configure(profile, home, true, home, join(home, 'managed')), /helper/);
    assert.equal(await readFile(settings, 'utf8'), '{"apiKeyHelper":"unreviewed-helper"}');
    await rm(settings);
    await symlink(state, settings);
    await assert.rejects(inspectRemoteSettings(home, profile, home, join(home, 'managed')), /safely inspected/);
  } finally { await rm(home, { recursive: true }); }
});

test('approved catalog migration resets only an unavailable owned user model', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccgc-remote-model-reset-'));
  const profile = { gateway: 'https://gateway.test', info: { ...identity, profile: REMOTE_PROFILE, instance: 'test' } };
  try {
    await mkdir(join(home, '.claude'));
    const path = join(home, '.claude', 'settings.json');
    await writeFile(path, JSON.stringify({ apiKeyHelper: helperCommand(), model: 'claude-opus-removed' }));
    await assert.rejects(configure(profile, home, true, home, join(home, 'managed')), /model/i);
    await configure(profile, home, true, home, join(home, 'managed'), true);
    const applied = parseJson(await readFile(path, 'utf8'));
    assert.equal(applied.model, profile.info.model.id);
  } finally { await rm(home, { recursive: true }); }
});

test('catalog discovery uses native spellings and exact deterministic Copilot routes', async () => {
  const opus = { ...model, id: 'claude-opus-5.5', name: 'Claude Opus 5.5', output: 256, responseIds: ['claude-opus-5.5'] };
  const haiku = { ...model, id: 'claude-haiku-4.5', responseIds: ['claude-haiku-4.5'] };
  const models = [model, opus, haiku];
  assert.equal(clientModelId(opus), 'claude-opus-5-5');
  assert.equal(resolveModel(models, 'claude-haiku-4-5-20251001'), haiku);
  assert.equal(resolveModel(models, 'claude-haiku-4-5'), haiku);
  for (const id of ['opus', 'claude-opus-5', 'claude-fable-5', 'gpt-5', 'claude-opus-5-5[1m]']) assert.throws(() => resolveModel(models, id), /No fallback/);
  assert.throws(() => remoteInfo({ ...identity, instance: 'test', profile: REMOTE_PROFILE, models: [model, model] }), /Duplicate/);
  assert.throws(() => remoteInfo({ ...identity, instance: 'test', profile: REMOTE_PROFILE, models: [opus] }), /default/);
  const f = await fixture({
    verify: async () => ({ ...identity, models }),
    backend: { async send(body) { return Response.json({ ...message(), model: body.model }); } },
  });
  try {
    const grant = await f.admit();
    const discovery = await f.call('/v1/models?limit=1000', undefined, grant.token);
    assert.ok(Array.isArray(discovery.value.data));
    assert.deepEqual(object(discovery.value.data[1]), {
      id: 'claude-opus-5-5', type: 'model', display_name: 'Claude Opus 5.5',
      description: 'GitHub Copilot: claude-opus-5.5. No model fallback.',
    });
    const first = [{ role: 'user', content: 'First synthetic turn' }];
    assert.equal((await f.call('/v1/messages', request({ messages: first }), grant.token)).status, 200);
    assert.equal((await f.call('/v1/messages', request({ model: clientModelId(opus), messages: first }), grant.token)).status, 409);
    const next = [...first, { role: 'user', content: 'Explicit new-model turn' }];
    assert.equal((await f.call('/v1/messages', request({ model: clientModelId(opus), messages: next, max_tokens: 257 }), grant.token)).status, 400);
    assert.equal((await f.call('/v1/messages', request({ model: clientModelId(opus), messages: next }), grant.token)).status, 200);
    assert.equal((await f.call('/v1/messages', request({ messages: [{ role: 'user', content: 'Rewritten history' }, ...next] }), grant.token)).status, 409);
    const third = [...next, { role: 'user', content: 'Switch back without resetting admission' }];
    assert.equal((await f.call('/v1/messages', request({ messages: third }), grant.token)).status, 200);
    assert.equal((await f.call('/ccgc/token', { id: grant.id })).value.attempts, 4);
  } finally { await f.server.close(); }
});

test('native model validation consumes shared attempts without resetting conversation or failure state', async () => {
  const opus = { ...model, id: 'claude-opus-5.5', responseIds: ['claude-opus-5.5'] };
  let fail = false;
  const f = await fixture({
    verify: async () => ({ ...identity, models: [model, opus], maxTurns: 8 }),
    backend: { async send(body) { return fail ? new Response('', { status: 429 }) : Response.json({ ...message(), model: body.model }); } },
  });
  const check = {
    model: clientModelId(opus), max_tokens: 1,
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.296.abc; cc_entrypoint=sdk-cli;' },
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
    ],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  };
  try {
    const grant = await f.admit();
    const history = [{ role: 'user', content: 'Keep this history' }];
    assert.equal((await f.call('/v1/messages', request({ messages: history }), grant.token)).status, 200);
    for (let i = 0; i < 2; i++) assert.equal((await f.call('/v1/messages', check, grant.token)).status, 200);
    assert.equal((await f.call('/v1/messages', { ...check, messages: [{ role: 'user', content: 'not the fixed validation' }] }, grant.token)).status, 409);
    history.push({ role: 'user', content: 'Continue the original conversation' });
    assert.equal((await f.call('/v1/messages', request({ messages: history, model: opus.id }), grant.token)).status, 200);
    assert.equal((await f.call('/ccgc/token', { id: grant.id })).value.attempts, 5);
    fail = true;
    assert.equal((await f.call('/v1/messages', check, grant.token)).status, 429);
    fail = false;
    history.push({ role: 'user', content: 'No fallback after failure' });
    assert.equal((await f.call('/v1/messages', request({ messages: history }), grant.token)).status, 409);
  } finally { await f.server.close(); }
});

test('model-switch history normalization preserves every context value and user/tool block', () => {
  const identity = 'You are powered by the model named Sonnet 5.5. The exact model ID is claude-sonnet-5-5. Assistant knowledge cutoff is June 2026.';
  const native = [{ role: 'user', content: [{ type: 'text', text: 'Do not rewrite me' }] }, { role: 'system', content: identity }];
  const legacy = [{ role: 'user', content: [
    { type: 'text', text: `<system-reminder>\n${identity}\n</system-reminder>` }, { type: 'text', text: 'Do not rewrite me' },
  ] }];
  assert.deepEqual(clientHistory(native), clientHistory(legacy));
  assert.deepEqual(clientHistory([{ role: 'user', content: 'Do not rewrite me' }]), clientHistory([native[0]]));
  assert.notDeepEqual(clientHistory(native), clientHistory([{ ...native[0], content: [{ type: 'text', text: 'rewritten' }] }, native[1]]));
  const switchedIdentity = 'You are powered by the model named Haiku 4.5. The exact model ID is claude-haiku-4-5-20251001. Assistant knowledge cutoff is January 2025.';
  assert.deepEqual(clientHistory(native), clientHistory([native[0], { role: 'system', content: switchedIdentity }]));
  const environment = '# Environment\nSynthetic\n\n' + identity + '\n\n<total_tokens>999999 tokens left</total_tokens>';
  const switchedEnvironment = '# Environment\nSynthetic\n\n' + switchedIdentity + '\n\n<total_tokens>199999 tokens left</total_tokens>';
  assert.deepEqual(clientHistory([native[0], { role: 'system', content: environment }]),
    clientHistory([native[0], { role: 'system', content: switchedEnvironment }]));
  const changed = '<system-reminder>The model for this session has been changed to claude-haiku-4-5-20251001.</system-reminder>';
  assert.deepEqual(clientHistory([{ role: 'user', content: [{ type: 'text', text: changed }, ...(native[0]!.content as ObjectValue[])] }]), clientHistory([native[0]]));
  const unexpected = [{ role: 'user', content: [{ type: 'text', text: '<system-reminder>\narbitrary instructions\n</system-reminder>' }] }];
  assert.deepEqual(clientHistory(unexpected), unexpected);
});

test('Haiku tool-result budget reminders normalize without losing result data or budget identity', () => {
  const budget = '<total_tokens>14995941 tokens left</total_tokens>';
  const tool = { type: 'tool_result', tool_use_id: 'synthetic-read', content: '1\talpha\n2\t', is_error: false };
  const native = [{ role: 'user', content: [tool] }, { role: 'system', content: budget }];
  const embedded = [{ role: 'user', content: [{ ...tool, content: `1\talpha\n2\n\n<system-reminder>\n${budget}\n</system-reminder>` }] }];
  const original = structuredClone(native);
  assert.deepEqual(clientHistory(native), clientHistory(embedded));
  assert.deepEqual(native, original);
  assert.equal(tool.content, '1\talpha\n2\t');
  for (const changed of [
    [{ ...embedded[0], content: [{ ...embedded[0]!.content[0], content: embedded[0]!.content[0]!.content.replace('alpha', 'rewritten') }] }],
    [{ ...embedded[0], content: [{ ...embedded[0]!.content[0], content: embedded[0]!.content[0]!.content.replace('14995941', '42') }] }],
    [{ ...embedded[0], content: [{ ...embedded[0]!.content[0], is_error: true }] }],
  ]) assert.notDeepEqual(clientHistory(native), clientHistory(changed));
});

test('explicit legacy migration preserves account and credentials and removes only owned pins', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccgc-catalog-migration-'));
  const secrets = new MemorySecrets();
  let current = { ...identity, instance: 'old', profile: REMOTE_PROFILE };
  const client = new RemoteClient(home, secrets, async () => Response.json(current));
  try {
    const original = await client.login('https://gateway.test', ownerKey);
    const legacy = { ...original, info: { ...original.info, profile: LEGACY_REMOTE_PROFILE }, grant: { id: 'active', expires: Date.now() + 100000 } };
    await client.save(legacy);
    await mkdir(join(home, '.claude'));
    const settings = join(home, '.claude', 'settings.json');
    await writeFile(settings, JSON.stringify({ ...settingsPatch(legacy), permissions: { deny: ['Bash(rm *)'] } }));
    await inspectRemoteSettings(home, legacy, home, join(home, 'managed'));
    await assert.rejects(client.refresh(), /active admission/);
    current = { ...current, instance: 'new', accountId: 99 };
    await assert.rejects(client.refresh(), /re-enrollment/);
    current = { ...current, accountId: 42 };
    const upgraded = await client.refresh();
    assert.equal(upgraded.grant, undefined);
    await assert.rejects(inspectRemoteSettings(home, upgraded, home, join(home, 'managed')), /conflicting/);
    await configure(upgraded, home, true, home, join(home, 'managed'));
    const updated = parseJson(await readFile(settings, 'utf8'));
    assert.deepEqual(updated.permissions, { deny: ['Bash(rm *)'], defaultMode: 'manual' });
    assert.equal(object(updated.env).ANTHROPIC_MODEL, undefined);
    assert.equal(object(updated.env).ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);
    assert.equal(object(updated.env).CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, '1');
    assert.deepEqual([...secrets.values.values()], [ownerKey]);
    await writeFile(settings, JSON.stringify({ ...updated, model: 'opus' }));
    await inspectRemoteSettings(home, upgraded, home, join(home, 'managed'));
    await writeFile(settings, '{"model":"gpt-unapproved"}');
    await assert.rejects(inspectRemoteSettings(home, upgraded, home, join(home, 'managed')), /No fallback/);
  } finally { await rm(home, { recursive: true }); }
});

test('switching cannot bypass pending tools, catalog drift or response identity', async () => {
  const opus = { ...model, id: 'claude-opus-5.5', responseIds: ['claude-opus-5.5'] };
  let current = { ...identity, models: [model, opus] };
  let coding = false;
  const f = await fixture({
    verify: async () => current,
    backend: { async send() {
      return coding ? Response.json(message([{ type: 'tool_use', id: 'pending-tool', name: 'Read', input: { path: 'synthetic' } }], 'tool_use'))
        : Response.json(message());
    } },
  });
  try {
    const grant = await f.admit();
    coding = true;
    const tools = [{ name: 'Read', input_schema: { type: 'object' } }];
    const messages: ObjectValue[] = [{ role: 'user', content: 'Read synthetic fixture' }];
    assert.equal((await f.call('/v1/messages', request({ messages, tools }), grant.token)).status, 200);
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'pending-tool', content: 'synthetic result' }] });
    assert.equal((await f.call('/v1/messages', request({ model: opus.id, messages, tools }), grant.token)).status, 409);
    assert.equal((await f.call('/ccgc/token', { id: grant.id })).value.attempts, 2);
    current = { ...current, models: [model] };
    assert.equal((await f.call('/ccgc/token', { id: grant.id })).status, 403);
    assert.equal((await f.call('/v1/messages', request({ messages, tools }), grant.token)).status, 401);
  } finally { await f.server.close(); }
  const errors: string[] = [];
  const wrong = await fixture({
    verify: async () => ({ ...identity, models: [model, opus] }),
    onError: error => errors.push(error.code),
  });
  try {
    const grant = await wrong.admit();
    assert.equal((await wrong.call('/v1/messages', request({ model: opus.id }), grant.token)).status, 502);
    assert.equal((await wrong.call('/v1/messages', request(), grant.token)).status, 409);
    assert.deepEqual(errors, ['MODEL_MISMATCH', 'CONTEXT_CONFLICT']);
  } finally { await wrong.server.close(); }
});
