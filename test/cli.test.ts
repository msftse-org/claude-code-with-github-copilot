import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

test('public CLI supports a symlink entry point and rejects invalid/unacknowledged operations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ccgc-cli-'));
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10000, env: { ...process.env, HOME: directory } });
  try {
    const link = join(directory, 'ccgc.ts');
    await symlink(cli, link);
    const linked = spawnSync(process.execPath, [link, '--help'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(linked.status, 0);
    assert.match(linked.stdout, /remote LiteLLM/);
    assert.match(run(['local', '--help']).stdout, /Copilot model-access bridge/);
    for (const args of [
      ['unknown'], ['start', '--unknown'], ['start', '--max-upstream-turns', '0'],
      ['start', '--max-upstream-turns', '1.5'], ['doctor', '--print', 'wrong'],
      ['start', '--print', ''], ['models', '--live'], ['doctor', '--client', 'app'],
      ['login'], ['models'], ['start', '--model', 'claude-sonnet-4.5'],
    ]) {
      const result = run(['local', ...args]);
      assert.equal(result.status, 1, JSON.stringify(args));
      assert.match(result.stderr, /INVALID_OPTIONS|CLIENT_UNSUPPORTED|ACCESS_UNVERIFIED/);
      assert.doesNotMatch(result.stderr, /INTERNAL_ERROR/);
    }
    for (const args of [['unknown'], ['login'], ['configure', '--live'], ['doctor', '--live'], ['doctor', '--remote', '--live'], ['token', '--gateway', 'https://example.test'], ['login', '--gateway', 'http://example.test', '--accept-unofficial']]) {
      const result = run(args);
      assert.equal(result.status, 1, JSON.stringify(args));
      assert.match(result.stderr, /INVALID_OPTIONS|ACCESS_UNVERIFIED/);
    }
    for (const command of ['token', 'models', 'configure', 'doctor', 'close', 'logout']) {
      const result = run([command]);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /GATEWAY_AUTH_REQUIRED/);
    }
  } finally { await rm(directory, { recursive: true }); }
});
