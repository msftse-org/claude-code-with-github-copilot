import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { configurePromptStorage } from '../scripts/litellm-bootstrap.mjs';
import { configureLogging, parseLoggingOptions } from '../scripts/litellm-logging.mjs';
import { parseOptions } from '../scripts/deploy.mjs';

const litellmUrl = 'https://litellm.example';
const masterKey = `sk-${'m'.repeat(32)}`;
const subscription = '00000000-0000-4000-8000-000000000001';

function fakeConfig({ mismatch = false, failWrite = false } = {}) {
  const db: Record<string, unknown> = { unrelated_setting: 'preserve', store_prompts_in_spend_logs: false };
  const patches: unknown[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, litellmUrl);
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${masterKey}`);
    assert.equal(init?.redirect, 'error');
    if (url.pathname === '/config/update') {
      if (failWrite) return new Response('{}', { status: 403 });
      const body = JSON.parse(String(init?.body));
      patches.push(body);
      Object.assign(db, body.general_settings);
      return Response.json({ message: 'Config updated successfully' });
    }
    assert.equal(url.pathname, '/config/field/info');
    const field = url.searchParams.get('field_name')!;
    return Response.json({ field_name: field, field_value: mismatch ? null : db[field] });
  };
  return { db, patches, fetcher };
}

test('prompt logging toggles and reruns preserve other settings and keep DB model storage enabled', async () => {
  const fake = fakeConfig();
  for (const enabled of [true, true, false]) {
    const result = await configurePromptStorage({ litellmUrl, masterKey, enabled, fetcher: fake.fetcher });
    assert.deepEqual(result, { storeModelInDb: true, storePromptsInSpendLogs: enabled });
    assert.deepEqual(fake.db, { unrelated_setting: 'preserve', store_model_in_db: true, store_prompts_in_spend_logs: enabled });
    assert.deepEqual(fake.patches.at(-1), { general_settings: { store_model_in_db: true, store_prompts_in_spend_logs: enabled } });
  }
});

test('logging fails if the admin write is denied or configuration readback differs', async () => {
  for (const options of [{ failWrite: true }, { mismatch: true }]) {
    await assert.rejects(configurePromptStorage({ litellmUrl, masterKey, enabled: true, fetcher: fakeConfig(options).fetcher }),
      /HTTP 403|did not confirm/);
  }
});

test('feature flag distinguishes omitted, enabled and disabled, and rejects ambiguous values', () => {
  for (const value of [undefined, 'true', 'false']) {
    const options = parseOptions(['--subscription', subscription, ...(value === undefined ? [] : ['--store-prompts-in-spend-logs', value])]);
    assert.ok(!('help' in options));
    assert.equal(options.storePromptsInSpendLogs, value === undefined ? undefined : value === 'true');
  }
  for (const value of ['yes', '1', 'TRUE', '']) {
    assert.throws(() => parseOptions(['--subscription', subscription, '--store-prompts-in-spend-logs', value]), /must be true or false/);
  }
  assert.throws(() => parseLoggingOptions(['--gateway', litellmUrl, '--secrets-file', '/tmp/private.json']), /are required/);
});

test('existing-gateway command reads a private key file and refuses world-readable files before network access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ccgc-logging-'));
  try {
    const secretsFile = join(directory, 'secrets.json');
    await writeFile(secretsFile, JSON.stringify({ litellmMasterKey: masterKey }), { mode: 0o600 });
    const parsed = parseLoggingOptions(['--gateway', litellmUrl, '--secrets-file', secretsFile, '--store-prompts-in-spend-logs', 'true']);
    assert.ok(!('help' in parsed));
    const fake = fakeConfig();
    assert.equal((await configureLogging(parsed, { fetcher: fake.fetcher })).storePromptsInSpendLogs, true);
    await chmod(secretsFile, 0o644);
    await assert.rejects(configureLogging(parsed, { fetcher: async () => { assert.fail('must not send a request'); } }), /private file/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
