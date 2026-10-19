import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  assert.match(stdout, /doctor/);
  assert.match(stdout, /real bounded inference request/);
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
  assert.match(source, /Choose an action before the enrollment code is used:/);
  assert.match(source, /Cancel without using the enrollment code or changing Claude settings/);
  assert.match(source, /Back up Claude settings, replace only these enterprise-managed settings, and continue/);
  assert.match(source, /Cancel without changing Claude settings/);
  assert.match(source, /ccgc-backup\./);
  assert.match(source, /plutil -remove "env\.\$key"/);
  assert.match(source, /ANTHROPIC_BASE_URL=\$gateway/);
});

test('macOS enrollment preflight succeeds when settings are absent or conflict-free', async () => {
  const harness = `
eval "$(/usr/bin/sed '/^command=/,$d' "$1")"
preflight_enrollment_settings 'https://broker.example'
printf 'preflight-ok\\n'
`;
  const home = await mkdtemp(join(tmpdir(), 'ccgc-preflight-'));
  try {
    const absent = await exec('/bin/bash', ['-c', harness, 'bash', script.pathname], {
      env: { ...process.env, HOME: home },
    });
    assert.equal(absent.stdout.trim(), 'preflight-ok');

    const claudeDirectory = join(home, '.claude');
    const settings = join(claudeDirectory, 'settings.json');
    await mkdir(claudeDirectory, { recursive: true });
    await writeFile(settings, '{}\n', { mode: 0o600 });
    await chmod(settings, 0o600);
    const clean = await exec('/bin/bash', ['-c', harness, 'bash', script.pathname], {
      env: { ...process.env, HOME: home },
    });
    assert.equal(clean.stdout.trim(), 'preflight-ok');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('macOS enrollment requires the minimum Claude Code compatibility version before network access', async () => {
  const source = await readFile(script, 'utf8');
  assert.match(source, /MINIMUM_CLAUDE_VERSION='2\.1\.296'/);
  assert.match(source, /require_claude_version[\s\S]*preflight_enrollment_settings "\$gateway"[\s\S]*install_self/);
  assert.match(source, /Claude Code \$MINIMUM_CLAUDE_VERSION or newer is required/);
  assert.match(source, /\[ "\$current_patch" -lt "\$minimum_patch" \]/);
  assert.doesNotMatch(source, /\[ "\$version" = "\$MINIMUM_CLAUDE_VERSION" \]/);
});

test('macOS enrollment accepts newer Claude Code versions and rejects older ones', async () => {
  const harness = `
eval "$(/usr/bin/sed '/^command=/,$d' "$1")"
claude() { printf '%s\\n' "$CLAUDE_TEST_VERSION"; }
require_claude_version
printf '%s\\n' "$DETECTED_CLAUDE_VERSION"
`;
  const newer = await exec('/bin/bash', ['-c', harness, 'bash', script.pathname], {
    env: { ...process.env, CLAUDE_TEST_VERSION: '2.1.302' },
  });
  assert.equal(newer.stdout.trim(), '2.1.302');

  await assert.rejects(
    exec('/bin/bash', ['-c', harness, 'bash', script.pathname], {
      env: { ...process.env, CLAUDE_TEST_VERSION: '2.1.295' },
    }),
    error => {
      assert.match(String((error as { stderr?: string }).stderr), /2\.1\.296 or newer is required \(found 2\.1\.295\)/);
      return true;
    },
  );
});

test('macOS enrollment verifies health, discovery, output limits and inference before acknowledgment', async () => {
  const source = await readFile(script, 'utf8');
  assert.match(source, /preflight_enrollment_settings "\$gateway"[\s\S]*install_self[\s\S]*ccgc\/enroll\/start/);
  assert.match(source, /verify_gateway_health "\$gateway" "\$tmp_dir\/health\.json"[\s\S]*ccgc\/enroll\/start/);
  assert.match(source, /verify_gateway_access "\$gateway" "\$api_key" "\$default_model" "\$tmp_dir"[\s\S]*prepare_profile/);
  assert.match(source, /output_limit=128000/);
  assert.match(source, /Reply exactly CCGC_CLIENT_READY/);
  assert.match(source, /gateway model display mismatch/);
  assert.match(source, /ccgc\/enroll\/complete/);
});

test('macOS doctor covers local security, conflicts, Keychain, binding and live inference', async () => {
  const source = await readFile(script, 'utf8');
  assert.match(source, /doctor\(\)/);
  assert.match(source, /require_private_file "\$INSTALL_PATH"/);
  assert.match(source, /require_private_file "\$PROFILE_PATH"/);
  assert.match(source, /require_private_file "\$SETTINGS_PATH"/);
  assert.match(source, /ANTHROPIC_AUTH_TOKEN/);
  assert.match(source, /CLAUDE_CODE_OAUTH_TOKEN/);
  assert.match(source, /Claude settings do not route to the enrolled enterprise gateway/);
  assert.match(source, /enterprise profile models no longer match the gateway binding/);
  assert.match(source, /verify_gateway_access "\$gateway" "\$api_key" "\$default_model" "\$tmp_dir"/);
  assert.match(source, /CCGC doctor passed/);
});

test('macOS gateway failures include safe server-side error messages', async () => {
  const source = await readFile(script, 'utf8');
  assert.match(source, /json_raw "\$output_file" error\.message/);
  assert.match(source, /enterprise gateway returned HTTP \$code: \$message/);
});
