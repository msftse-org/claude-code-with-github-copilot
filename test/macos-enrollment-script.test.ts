import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  assert.match(stdout, /stores the\s+90-day personal LiteLLM key in macOS Keychain/);
  assert.match(stdout, /No repository checkout, Node\.js, npm/);
  assert.match(stdout, /GitHub opens automatically/);
  assert.match(stdout, /Claude Desktop requires separate third-party gateway configuration/);
  const source = await readFile(script, 'utf8');
  assert.match(source, /CLI settings do not select its provider/);
  assert.match(stdout, /does not\s+disable Gatekeeper/);
  assert.match(stdout, /do not repeat enrollment for routine service/i);
  assert.match(stdout, /Enroll again only with a new personal key/);
  assert.match(stdout, /doctor/);
  assert.match(stdout, /real bounded inference request/);
});

test('macOS enrollment script rejects malformed virtual keys before network access', async () => {
  await assert.rejects(
    exec('/bin/bash', ['-c', 'source "$1"; validate_litellm_key not-a-key', 'bash', script.pathname]),
    error => {
      assert.match(String((error as { stderr?: string }).stderr), /supplied LiteLLM key is invalid/);
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
  assert.match(source, /Choose an action before the LiteLLM key is used:/);
  assert.match(source, /Cancel without using the LiteLLM key or changing Claude settings/);
  assert.match(source, /Back up Claude settings, replace only these enterprise-managed settings, and continue/);
  assert.match(source, /Cancel without changing Claude settings/);
  assert.match(source, /ccgc-backup\./);
  assert.match(source, /setting_conflicts\+=\('apiKeyHelper'\)/);
  assert.match(source, /plutil -remove "\$key" "\$output"/);
  assert.match(source, /plutil -remove "env\.\$key"/);
  assert.match(source, /ANTHROPIC_BASE_URL=\$gateway/);
});

test('macOS enrollment preflight succeeds when settings are absent or conflict-free', async () => {
  const harness = `
source "$1"
json_raw() {
  node -e '
    const fs = require("node:fs");
    const [file, path] = process.argv.slice(1);
    let value = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const part of path.split(".")) value = value[part];
    if (value === undefined || value === null || typeof value === "object") process.exit(1);
    process.stdout.write(String(value));
  ' "$1" "$2"
}
valid_json() {
  node -e '
    const fs = require("node:fs");
    JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  ' "$1"
}
if [ "\${CCGC_TEST_APPROVE-}" = '1' ]; then
  preflight_enrollment_settings 'https://gateway.example' <<< '1'
else
  preflight_enrollment_settings 'https://gateway.example'
fi
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

    await writeFile(settings, '{"apiKeyHelper":"/bin/unrelated-helper"}\n', { mode: 0o600 });
    await chmod(settings, 0o600);
    const approved = await exec('/bin/bash', ['-c', harness, 'bash', script.pathname], {
      env: { ...process.env, HOME: home, CCGC_TEST_APPROVE: '1' },
    });
    assert.equal(approved.stdout.trim(), 'preflight-ok');
    assert.match(approved.stderr, /apiKeyHelper/);
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
source "$1"
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

test('macOS enrollment preserves canonical gateway model IDs for both clients', async () => {
  const harness = `
source "$1"
printf '%s\\n' "$(client_model 'claude-sonnet-5.5')"
printf '%s\\n' "$(client_model 'claude-haiku-4.5')"
`;
  const result = await exec('/bin/bash', ['-c', harness, 'bash', script.pathname]);
  assert.deepEqual(result.stdout.trim().split('\n'), ['claude-sonnet-5.5', 'claude-haiku-4.5']);
});

test('macOS enrollment connects directly through LiteLLM and verifies before installing credentials', async () => {
  const source = await readFile(script, 'utf8');
  assert.match(source, /preflight_enrollment_settings "\$gateway"[\s\S]*api_key="\$\(read_litellm_key\)"/);
  assert.match(source, /credentials\/\$credential\/user_connection\/start/);
  assert.match(source, /credentials\/\$credential\/user_connection\/poll/);
  assert.match(source, /verify_litellm_profile "\$gateway"[\s\S]*verify_gateway_access "\$gateway" "\$api_key" "\$default_model" "\$tmp_dir"[\s\S]*install_enrollment_files "\$tmp_dir"/);
  assert.match(source, /configure\(\)[\s\S]*refresh_profile "\$tmp_dir"[\s\S]*prepare_settings/);
  assert.doesNotMatch(source, /controlPlane|admission|ccgc\/enterprise\/(config|info|admissions)/i);
  assert.match(source, /output_limit=128000/);
  assert.match(source, /Reply exactly CCGC_CLIENT_READY/);
  assert.match(source, /gateway model display mismatch/);
  assert.match(source, /\[ "\$model_id" = "\$client_id" \] \|\| \[ "\$model_id" = "\$default_model" \]/);
  assert.doesNotMatch(source, /ccgc\/enroll\/(start|poll|complete)/);
});

test('macOS gateway verification accepts canonical model IDs without display labels', async () => {
  const harness = `
source "$1"
json_raw() {
  node -e '
    const fs = require("node:fs");
    const [file, path] = process.argv.slice(1);
    let value = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const part of path.split(".")) value = value[part];
    if (value === undefined || value === null || typeof value === "object") process.exit(1);
    process.stdout.write(String(value));
  ' "$1" "$2"
}
valid_json() {
  node -e '
    const fs = require("node:fs");
    JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  ' "$1"
}
request_json_status() {
  local method="$1"
  local url="$2"
  local output="$5"
  [ "$3" = "$CCGC_TEST_KEY" ] || return 1
  case "$method $url" in
    "GET https://gateway.example/v1/models")
      printf '{"data":[{"id":"claude-sonnet-5.5"}]}\\n' >"$output"
      ;;
    "POST https://gateway.example/v1/messages")
      printf '{"model":"claude-sonnet-5.5","content":[{"type":"text","text":"CCGC_CLIENT_READY"}]}\\n' >"$output"
      ;;
    *) return 1 ;;
  esac
  printf '200'
}
tmp="$CCGC_TEST_TEMP"
verify_gateway_access \
  'https://gateway.example' \
  "$CCGC_TEST_KEY" \
  'claude-sonnet-5.5' \
  "$tmp"
printf 'gateway-verification-ok\\n'
`;
  const tmp = await mkdtemp(join(tmpdir(), 'ccgc-direct-probe-'));
  try {
    const result = await exec('/bin/bash', ['-c', harness, 'bash', script.pathname], {
      env: { ...process.env, CCGC_TEST_TEMP: tmp, CCGC_TEST_KEY: `sk-${'k'.repeat(32)}` },
    });
    assert.equal(result.stdout.trim(), 'gateway-verification-ok');
  } finally { await rm(tmp, { recursive: true, force: true }); }
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
  assert.match(source, /Claude settings retain a conflicting default model/);
  assert.match(source, /enterprise profile models changed; run configure to refresh them/);
  assert.match(source, /doctor\(\)[\s\S]*verify_gateway_access "\$gateway" "\$api_key" "\$default_model" "\$tmp_dir"/);
  assert.match(source, /Claude Desktop: %s \(installed; gateway routing is not verified by CLI doctor\)/);
  assert.match(source, /CCGC doctor passed/);
});

test('macOS gateway failures include safe server-side error messages', async () => {
  const source = await readFile(script, 'utf8');
  assert.match(source, /json_raw "\$output_file" error\.message/);
  assert.match(source, /enterprise gateway returned HTTP \$code: \$message/);
});

const standaloneKey = `sk-${'k'.repeat(32)}`;
const standaloneUser = '11111111-2222-4333-8444-555555555555';
const standaloneCredential = 'github-copilot-user';
const standaloneHarness = `
source "$1"
claude() { printf '2.1.319 (Claude Code)\\n'; }
read_litellm_key() { printf '%s' "$CCGC_TEST_KEY"; }
open_github() { printf 'browser-opened\\n' >> "$HOME/events"; }
keychain_get() { /bin/cat "$HOME/keychain/$1" 2>/dev/null; }
keychain_set() { printf '%s' "$2" > "$HOME/keychain/$1"; }
keychain_delete() { /bin/rm -f "$HOME/keychain/$1"; }
request_json_status() {
  local method="$1" url="$2" bearer="$3" body="$4" output="$5"
  local fixture='' status=200 events
  printf '%s %s\\n' "$method" "$url" >> "$HOME/events"
  [ "$url" = https://gateway.example/health/liveliness ] && [ -z "$bearer" ] && {
    fixture=health
  } || {
    [ "$bearer" = "$CCGC_TEST_KEY" ] || fail 'wrong LiteLLM credential'
  }
  case "$method $url" in
    'GET https://gateway.example/health/liveliness') fixture=health ;;
    'GET https://gateway.example/key/info') fixture=key ;;
    'GET https://gateway.example/user/info') fixture=user ;;
    'GET https://gateway.example/credentials/user_connections')
      events="$(/bin/cat "$HOME/events")"
      if [ "$CCGC_TEST_MODE" = wrong-connection ] || [[ "$events" == *'/user_connection/poll'* ]]; then
        fixture=connection
      else
        fixture=empty-connection
      fi
      ;;
    'POST https://gateway.example/credentials/github-copilot-user/user_connection/start')
      fixture=start
      ;;
    'POST https://gateway.example/credentials/github-copilot-user/user_connection/poll')
      [ "$(json_value "$body" flow_handle)" = 'opaque-flow-handle==' ] || fail 'wrong device-flow handle'
      fixture=poll
      ;;
    'DELETE https://gateway.example/credentials/github-copilot-user/user_connection')
      fixture=disconnected
      ;;
    'GET https://gateway.example/v1/model/info') fixture=routes ;;
    'GET https://gateway.example/v1/models') fixture=models ;;
    'POST https://gateway.example/v1/messages') fixture=probe ;;
    *) fail "unexpected request $method $url" ;;
  esac
  /bin/cp "$HOME/fixtures/$fixture.json" "$output"
  printf '%s' "$status"
}
DEFAULT_GATEWAY=https://gateway.example
main
cleanup_temp
token > "$HOME/helper-token"
if [ "$CCGC_TEST_MODE" = success ]; then
  models
  cleanup_temp
  configure
  cleanup_temp
  doctor
fi
`;

async function standaloneFixture(mode: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'ccgc-standalone-'));
  for (const directory of ['fixtures', 'keychain', 'temp', '.local/share/ccgc/enterprise', '.claude']) {
    await mkdir(join(home, directory), { recursive: true, mode: 0o700 });
  }
  const start = {
    verification_uri: 'https://github.com/login/device', user_code: 'ABCD-EFGH',
    flow_handle: 'opaque-flow-handle==', interval: 1, expires_in: 900,
  };
  const poll: Record<string, unknown> = { status: 'connected', github_login: 'example-user' };
  const key = { info: { user_id: standaloneUser, expires: new Date(Date.now() + 90 * 86_400_000).toISOString() } };
  const connection = { connections: [{
    credential_name: standaloneCredential, provider: 'github_copilot', connected: true, github_login: 'Example-User',
  }] };
  const routes = { data: [{
    model_name: 'claude-sonnet-5.5',
    litellm_params: { model: 'github_copilot/claude-sonnet-5.5', litellm_credential_name: standaloneCredential },
  }, {
    model_name: 'claude-haiku-4.5',
    litellm_params: { model: 'github_copilot/claude-haiku-4.5', litellm_credential_name: standaloneCredential },
  }] };
  if (mode === 'wrong-account') poll.github_login = 'another-user';
  if (mode === 'wrong-owner') key.info.user_id = '99999999-2222-4333-8444-555555555555';
  if (mode === 'wrong-connection') connection.connections[0]!.github_login = 'another-user';
  if (mode === 'unsafe-url') start.verification_uri = 'https://example.net/login/device';
  if (mode === 'expired') poll.status = 'expired';
  if (mode === 'no-seat') poll.status = 'no_copilot_seat';
  if (mode === 'duplicate-route') routes.data.push({
    model_name: 'claude-sonnet-5.5',
    litellm_params: { model: 'anthropic/claude-sonnet-5.5', litellm_credential_name: standaloneCredential },
  });
  const fixtures = {
    start, poll, key, connection, routes,
    health: { status: 'healthy' },
    disconnected: { status: 'disconnected' },
    'empty-connection': { connections: [] },
    user: { user_info: {
      user_id: standaloneUser, user_role: 'internal_user', user_alias: 'example-user',
      metadata: { github_login: 'example-user' },
    } },
    models: { data: [{ id: 'claude-sonnet-5.5' }, { id: 'claude-haiku-4.5' }] },
    probe: { model: 'claude-sonnet-5.5', content: [{ type: 'text', text: 'CCGC_CLIENT_READY' }] },
  };
  for (const [name, value] of Object.entries(fixtures)) {
    await writeFile(join(home, 'fixtures', `${name}.json`), JSON.stringify(value), { mode: 0o600 });
  }
  await writeFile(join(home, '.local/share/ccgc/enterprise/profile.json'), '{"previousProfile":true}', { mode: 0o600 });
  await writeFile(join(home, '.claude/settings.json'), '{"unrelatedSetting":true,"permissions":{"defaultMode":"manual"}}', { mode: 0o600 });
  await writeFile(join(home, 'keychain', 'previous-key'), 'previous-personal-key', { mode: 0o600 });
  if (mode === 'write-failure') await chmod(join(home, '.claude'), 0o500);
  return home;
}

function runStandalone(home: string, mode: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, TMPDIR: join(home, 'temp'), CCGC_TEST_MODE: mode,
    CCGC_TEST_KEY: standaloneKey,
  };
  for (const name of Object.keys(env)) {
    if (name.startsWith('ANTHROPIC_') || name.startsWith('CLAUDE_CODE_')) delete env[name];
  }
  return exec('/bin/bash', ['-c', standaloneHarness, 'bash', script.pathname], { env, timeout: 30_000 });
}

test('standalone default enrollment opens GitHub and installs a verified direct key without Node or a checkout', {
  skip: process.platform !== 'darwin',
}, async () => {
  const home = await standaloneFixture('success');
  try {
    const result = await runStandalone(home, 'success');
    const profile = JSON.parse(await readFile(join(home, '.local/share/ccgc/enterprise/profile.json'), 'utf8'));
    const settings = JSON.parse(await readFile(join(home, '.claude/settings.json'), 'utf8'));
    const desktop = JSON.parse(await readFile(join(home, '.local/share/ccgc/enterprise/desktop-gateway.json'), 'utf8'));
    assert.equal(profile.authMethod, 'litellmKey');
    assert.equal(profile.inferenceAuthentication, 'directKey');
    assert.equal(profile.liteLLMUserId, standaloneUser);
    assert.equal(profile.githubLogin, 'example-user');
    assert.deepEqual(profile.models, ['claude-sonnet-5.5', 'claude-haiku-4.5']);
    assert.equal(settings.unrelatedSetting, true);
    assert.equal(settings.permissions.defaultMode, 'manual');
    assert.equal(settings.env.ANTHROPIC_BASE_URL, 'https://gateway.example');
    assert.equal(desktop.inferenceCredentialHelper, '/bin/bash');
    assert.deepEqual(desktop.inferenceCredentialHelperArgs, [
      join(home, '.local/share/ccgc/enterprise/ccgc-enterprise-macos.sh'), 'token',
    ]);
    assert.equal(await readFile(join(home, 'helper-token'), 'utf8'), `${standaloneKey}\n`);
    assert.equal(await readFile(join(home, 'keychain', `ccgc.remote.${profile.keychainId}`), 'utf8'), standaloneKey);
    const events = await readFile(join(home, 'events'), 'utf8');
    assert.equal(events.split('\n').filter(line => line === 'browser-opened').length, 1);
    assert.equal(events.split('\n').filter(line => line.endsWith('/user_connection/start')).length, 1);
    assert.equal(events.split('\n').filter(line => line.endsWith('/user_connection/poll')).length, 1);
    assert.doesNotMatch(events, /ccgc\/|admissions|enterprise\/info/);
    assert.match(result.stdout, /Enrollment complete for GitHub account example-user/);
    assert.match(result.stdout, /CCGC doctor passed/);
    for (const output of [result.stdout, result.stderr, JSON.stringify(profile), JSON.stringify(settings), JSON.stringify(desktop)]) {
      assert.equal(output.includes(standaloneKey), false);
    }
    assert.equal(await readFile(join(home, 'keychain/previous-key'), 'utf8'), 'previous-personal-key');
    assert.deepEqual(await readdir(join(home, 'temp')), []);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('standalone enrollment rejects identity, routing and authorization failures without replacing local credentials', {
  skip: process.platform !== 'darwin',
}, async t => {
  for (const [mode, message] of [
    ['wrong-account', /approving GitHub account does not match/],
    ['wrong-owner', /key and user information do not match/],
    ['wrong-connection', /connected to a different GitHub account/],
    ['duplicate-route', /conflicting provider/],
    ['unsafe-url', /unexpected GitHub authorization URL/],
    ['expired', /GitHub authorization expired/],
    ['no-seat', /no GitHub Copilot entitlement/],
    ['write-failure', /could not install/],
  ] as const) {
    await t.test(mode, async () => {
      const home = await standaloneFixture(mode);
      try {
        await assert.rejects(runStandalone(home, mode), error => {
          const stderr = String((error as { stderr?: string }).stderr);
          assert.match(stderr, message);
          assert.equal(stderr.includes(standaloneKey), false);
          return true;
        });
        assert.equal(await readFile(join(home, '.local/share/ccgc/enterprise/profile.json'), 'utf8'), '{"previousProfile":true}');
        assert.equal(await readFile(join(home, '.claude/settings.json'), 'utf8'), '{"unrelatedSetting":true,"permissions":{"defaultMode":"manual"}}');
        assert.equal(await readFile(join(home, 'keychain/previous-key'), 'utf8'), 'previous-personal-key');
        assert.deepEqual(await readdir(join(home, 'keychain')), ['previous-key']);
        assert.deepEqual(await readdir(join(home, 'temp')), []);
      } finally {
        await chmod(join(home, '.claude'), 0o700);
        await rm(home, { recursive: true, force: true });
      }
    });
  }
});

test('standalone enrollment key prompt hides terminal input', {
  skip: process.platform !== 'darwin', timeout: 10_000,
}, async () => {
  const harness = `
import errno, os, pty, select, signal, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execv('/bin/bash', ['bash', '-c',
        'source "$1"; key="$(read_litellm_key)"; validate_litellm_key "$key"; printf "prompt-ok\\\\n"',
        'bash', sys.argv[1]])
output = b''
sent = False
try:
    while True:
        if not select.select([fd], [], [], 5)[0]:
            raise TimeoutError('key prompt did not finish')
        try:
            data = os.read(fd, 4096)
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
        if not data:
            break
        output += data
        if not sent and b'input hidden):' in output:
            sent = True
            time.sleep(0.1)
            os.write(fd, (sys.argv[2] + '\\n').encode())
    _, status = os.waitpid(pid, 0)
    assert status == 0
    pid = None
    sys.stdout.buffer.write(output)
finally:
    os.close(fd)
    if pid is not None:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
`;
  const { stdout } = await exec('python3', ['-c', harness, script.pathname, standaloneKey], { timeout: 8_000 });
  assert.match(stdout, /prompt-ok/);
  assert.equal(stdout.includes(standaloneKey), false);
});

test('credential helper rejects retired enrollments before Keychain or network access', {
  skip: process.platform !== 'darwin',
}, async t => {
  const harness = `
source "$1"
keychain_get() { fail 'retired enrollment reached Keychain'; }
request_json_status() { fail 'retired enrollment reached the network'; }
token
`;
  for (const [name, profile] of [
    ['broker key', { authMethod: 'apiKey', controlPlane: 'https://broker.example', gateway: 'https://gateway.example' }],
    ['gateway admission', { authMethod: 'litellmKey', inferenceAuthentication: 'ccgcAdmission', gateway: 'https://gateway.example' }],
  ] as const) {
    await t.test(name, async () => {
      const home = await mkdtemp(join(tmpdir(), 'ccgc-retired-profile-'));
      try {
        await mkdir(join(home, '.local/share/ccgc/enterprise'), { recursive: true, mode: 0o700 });
        await writeFile(join(home, '.local/share/ccgc/enterprise/profile.json'), JSON.stringify(profile), { mode: 0o600 });
        await assert.rejects(exec('/bin/bash', ['-c', harness, 'bash', script.pathname], {
          env: { ...process.env, HOME: home },
        }), error => {
          const { stdout, stderr } = error as { stdout?: string; stderr?: string };
          assert.equal(stdout, '');
          assert.match(String(stderr), /no longer supported; ask Enterprise IT for a new personal LiteLLM key and run enroll again/);
          return true;
        });
      } finally { await rm(home, { recursive: true, force: true }); }
    });
  }
});
