import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const script = new URL('../scripts/ccgc-enterprise-macos.sh', import.meta.url);

test('macOS enrollment script has valid Bash syntax', async () => {
  await exec('/bin/bash', ['-n', script.pathname]);
});

test('macOS enrollment script documents the managed-device-safe flow', async () => {
  const { stdout } = await exec('/bin/bash', [script.pathname, 'help']);
  assert.match(stdout, /stores the\s+30-day employee key in macOS Keychain/);
  assert.match(stdout, /does not\s+disable Gatekeeper/);
});

test('macOS enrollment script rejects malformed codes before network access', async () => {
  await assert.rejects(
    exec('/bin/bash', [script.pathname, 'enroll', '--code', 'not-an-enrollment-code']),
    error => {
      assert.match(String((error as { stderr?: string }).stderr), /invalid enrollment code/);
      return true;
    },
  );
});

test('macOS enrollment script never removes quarantine or changes Gatekeeper policy', async () => {
  const source = await readFile(script, 'utf8');
  assert.doesNotMatch(source, /xattr\s+-[a-zA-Z]*d|spctl\s+--master-disable|defaults\s+write.*Gatekeeper/i);
  assert.doesNotMatch(source, /rm\s+-rf/);
  assert.doesNotMatch(source, /permission default conflicts/);
  assert.match(source, /if \[ -z "\$permission_mode" \]; then\s+plist_set_string "\$output" permissions\.defaultMode manual/);
  assert.match(source, /security find-generic-password/);
  assert.match(source, /security -i/);
});

test('macOS enrollment script requires a choice before replacing enterprise-managed settings', async () => {
  const source = await readFile(script, 'utf8');
  assert.match(source, /Back up Claude settings, replace only these enterprise-managed settings, and continue/);
  assert.match(source, /Cancel without changing Claude settings/);
  assert.match(source, /ccgc-backup\./);
  assert.match(source, /plutil -remove "env\.\$key"/);
  assert.match(source, /ANTHROPIC_BASE_URL=\$gateway/);
});

test('macOS enrollment requires the verified Claude Code compatibility version before network access', async () => {
  const source = await readFile(script, 'utf8');
  assert.match(source, /SUPPORTED_CLAUDE_VERSION='2\.1\.296'/);
  assert.match(source, /require_claude_version\s+install_self/);
  assert.match(source, /claude install \$SUPPORTED_CLAUDE_VERSION/);
});
