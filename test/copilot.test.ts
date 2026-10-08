import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopilotBackend, CredentialStore, copilotEndpoint } from '../src/copilot.ts';
import { claudeModels } from '../src/protocol.ts';
import { childEnvironment, inspectSettings } from '../src/claude.ts';
import { model, request, message } from './fixtures.ts';

test('credential store is isolated, private, atomic, and rejects symlinks or permissive modes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ccgc-store-'));
  const store = new CredentialStore(join(directory, 'state'));
  try {
    await assert.rejects(store.load(), /Run ccgc login/);
    await store.save({ login: 'fixture-user', accessToken: 'fixture-secret' });
    assert.equal((await stat(join(directory, 'state', 'credentials.json'))).mode & 0o777, 0o600);
    assert.equal((await store.load()).login, 'fixture-user');
    await chmod(join(directory, 'state', 'credentials.json'), 0o644);
    await assert.rejects(store.load(), /must be private/);
    await chmod(join(directory, 'state', 'credentials.json'), 0o600);
    await store.logout();
    await writeFile(join(directory, 'outside.json'), '{"accessToken":"never-read"}');
    await symlink(join(directory, 'outside.json'), join(directory, 'state', 'credentials.json'));
    await assert.rejects(store.load());
    assert.equal(await readFile(join(directory, 'outside.json'), 'utf8'), '{"accessToken":"never-read"}');
  } finally { await rm(directory, { recursive: true }); }
});

test('endpoint allowlist rejects credential forwarding to arbitrary hosts, ports and paths', () => {
  assert.equal(copilotEndpoint('https://api.individual.githubcopilot.com'), 'https://api.individual.githubcopilot.com');
  for (const value of ['http://api.githubcopilot.com', 'https://evil.githubcopilot.com', 'https://api.githubcopilot.com.evil.test', 'https://user:secret@api.githubcopilot.com', 'https://api.githubcopilot.com:444', 'https://api.githubcopilot.com/path', 'https://api.githubcopilot.com?url=x']) {
    assert.throws(() => copilotEndpoint(value));
  }
});

test('model catalog requires Claude vendor, tools, limits and permitted policy', () => {
  const entry = {
    id: model.id, name: 'Fixture', vendor: 'Anthropic', version: model.responseIds[1],
    capabilities: { supports: { tool_calls: true }, limits: { max_context_window_tokens: 200000, max_output_tokens: 16384 } },
  };
  assert.equal(claudeModels({ data: [entry] })[0]?.id, model.id);
  assert.deepEqual(claudeModels({ data: [{ ...entry, vendor: 'OpenAI' }, { ...entry, policy: { state: 'disabled' } }, { ...entry, id: 'gpt-5' }] }), []);
  assert.throws(() => claudeModels({ data: [{ ...entry, capabilities: { supports: { tool_calls: true }, limits: {} } }] }));
});

test('native backend uses only its own login, token metadata endpoint and allowlisted headers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ccgc-auth-'));
  const store = new CredentialStore(directory);
  const calls: { url: string; init: RequestInit }[] = [];
  try {
    await store.save({ login: 'fixture-user', accessToken: 'fixture-oauth-secret' });
    const backend = new CopilotBackend(store, async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      assert.equal(init.redirect, 'error');
      if (url.endsWith('/user')) return Response.json({ login: 'fixture-user' });
      if (url.endsWith('/copilot_internal/v2/token')) return Response.json({
        token: 'fixture-copilot-secret', expires_at: Math.floor(Date.now() / 1000) + 600,
        endpoints: { api: 'https://api.individual.githubcopilot.com' },
      });
      return Response.json(message());
    });
    assert.equal(await backend.initialize(), 'fixture-user');
    await backend.send(request(), new Headers({ 'anthropic-beta': 'fixture-beta', authorization: 'Bearer local-secret', 'x-api-key': 'local-key' }), new AbortController().signal);
    const call = calls.at(-1);
    assert.equal(call?.url, 'https://api.individual.githubcopilot.com/v1/messages');
    const headers = new Headers(call?.init.headers);
    assert.equal(headers.get('authorization'), 'Bearer fixture-copilot-secret');
    assert.equal(headers.get('x-api-key'), null);
    assert.equal(headers.get('anthropic-beta'), 'fixture-beta');
    assert.equal(headers.get('x-github-api-version'), '2026-06-01');
    assert.equal(calls.length, 3);
  } finally { await rm(directory, { recursive: true }); }
});

test('identity mismatch and denied seat do not silently choose another identity or route', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ccgc-denial-'));
  const store = new CredentialStore(directory);
  try {
    await store.save({ login: 'intended', accessToken: 'fixture-secret' });
    await assert.rejects(new CopilotBackend(store, async () => Response.json({ login: 'other' })).initialize(), /differs from the saved login/);
    const backend = new CopilotBackend(store, async input => String(input).endsWith('/user')
      ? Response.json({ login: 'intended' }) : new Response('secret denial body', { status: 403 }));
    await assert.rejects(backend.initialize(), error => error instanceof Error && /denied/.test(error.message) && !error.message.includes('secret denial body'));
  } finally { await rm(directory, { recursive: true }); }
});

test('device login stores only the explicitly authorized account after successful Copilot exchange', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ccgc-device-'));
  const store = new CredentialStore(directory);
  const announced: string[] = [];
  const endpoints: string[] = [];
  try {
    const backend = new CopilotBackend(store, async input => {
      const url = String(input);
      endpoints.push(url);
      if (url.endsWith('/device/code')) return Response.json({
        verification_uri: 'https://github.com/login/device', device_code: 'fixture-device',
        user_code: 'FIXTURE-CODE', interval: 1, expires_in: 60,
      });
      if (url.endsWith('/oauth/access_token')) return Response.json({ access_token: 'fixture-authorized-token' });
      if (url.endsWith('/user')) return Response.json({ login: 'authorized-fixture' });
      return Response.json({ token: 'fixture-session', expires_at: Math.floor(Date.now() / 1000) + 600, endpoints: { api: 'https://api.githubcopilot.com' } });
    });
    assert.equal(await backend.login((url, code) => announced.push(url, code)), 'authorized-fixture');
    assert.deepEqual(announced, ['https://github.com/login/device', 'FIXTURE-CODE']);
    assert.deepEqual(await store.load(), { login: 'authorized-fixture', accessToken: 'fixture-authorized-token' });
    assert.equal(endpoints.length, 4);
    assert.ok(!endpoints.some(url => url.endsWith('/v1/messages')));
  } finally { await rm(directory, { recursive: true }); }
});

test('denied device authorization never saves a credential or starts inference', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ccgc-device-denied-'));
  const store = new CredentialStore(directory);
  try {
    let calls = 0;
    const backend = new CopilotBackend(store, async () => {
      calls++;
      return calls === 1 ? Response.json({
        verification_uri: 'https://github.com/login/device', device_code: 'fixture-device',
        user_code: 'FIXTURE-CODE', interval: 1, expires_in: 60,
      }) : Response.json({ error: 'access_denied' });
    });
    await assert.rejects(backend.login(() => {}), /denied/);
    await assert.rejects(store.load(), /Run ccgc login/);
    assert.equal(calls, 2);
  } finally { await rm(directory, { recursive: true }); }
});

test('child environment carries only local credentials and explicit Claude mappings', () => {
  const env = childEnvironment('http://127.0.0.1:1234', 'local-token', model, {
    PATH: '/bin', HOME: '/home/fixture', GH_TOKEN: 'secret', GITHUB_TOKEN: 'secret',
    ANTHROPIC_API_KEY: 'secret', CLAUDE_CODE_OAUTH_TOKEN: 'secret', AZURE_OPENAI_API_KEY: 'secret', NODE_OPTIONS: '--require malicious',
  });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'local-token');
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, model.id);
  assert.doesNotMatch(JSON.stringify(env), /secret|malicious/);
});

test('routing conflicts block without changing settings; ordinary permissions are preserved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ccgc-settings-'));
  try {
    await mkdir(join(directory, '.claude'));
    const file = join(directory, '.claude', 'settings.json');
    const permissions = '{"permissions":{"deny":["Bash(curl *)"]}}';
    await writeFile(file, permissions);
    await inspectSettings(directory, directory, join(directory, 'managed.json'));
    assert.equal(await readFile(file, 'utf8'), permissions);
    const conflict = '{"env":{"ANTHROPIC_BASE_URL":"https://do-not-use.invalid"}}';
    await writeFile(file, conflict);
    await assert.rejects(inspectSettings(directory, directory, join(directory, 'managed.json')), /routing/);
    assert.equal(await readFile(file, 'utf8'), conflict);
  } finally { await rm(directory, { recursive: true }); }
});
