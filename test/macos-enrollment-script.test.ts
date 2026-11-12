import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
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
  assert.match(stdout, /configures installed Claude Desktop's local Gateway profile/);
  const source = await readFile(script, 'utf8');
  assert.match(source, /Claude Desktop gateway configuration updated automatically/);
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

test('macOS enrollment script without a built-in gateway stops before asking for the key', async () => {
  await assert.rejects(exec('/bin/bash', [script.pathname]), error => {
    const stderr = String((error as { stderr?: string }).stderr);
    assert.match(stderr, /no LiteLLM gateway built in; use the setup file from your administrator/);
    assert.doesNotMatch(stderr, /LiteLLM key/i);
    return true;
  });
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

test('macOS enrollment script asks once before backing up and replacing configuration', async () => {
  const source = await readFile(script, 'utf8');
  assert.match(source, /Choose an action before the LiteLLM key is used:/);
  assert.match(source, /After gateway verification, back up this configuration and start from scratch/);
  assert.match(source, /Cancel without using the LiteLLM key or changing Claude configuration/);
  assert.match(source, /Cancel without changing Claude configuration/);
  assert.match(source, /ccgc-backup\./);
  assert.match(source, /preflight_fresh_start "\$gateway" routing configure/);
  assert.match(source, /prepare_settings "\$gateway" "\$default_model" "\$tmp_dir\/settings\.json" "\$enrollment_mode"/);
  assert.match(source, /ANTHROPIC_BASE_URL=\$gateway/);
});

test('macOS fresh-start preflight detects leftovers without prompting for clean configuration', {
  skip: process.platform !== 'darwin',
}, async () => {
  const harness = `
source "$1"
desktop_installed() { [ "\${CCGC_TEST_DESKTOP-}" = 1 ]; }
preflight_fresh_start 'https://gateway.example' "\${CCGC_TEST_PREFLIGHT_MODE:-full}" enroll <<< "\${CCGC_TEST_CHOICE-}"
printf 'preflight-ok\\n'
`;
  const home = await mkdtemp(join(tmpdir(), 'ccgc-preflight-'));
  const run = (env: Record<string, string> = {}) => exec('/bin/bash', ['-c', harness, 'bash', script.pathname], {
    env: { ...process.env, HOME: home, TMPDIR: home, ...env },
  });
  const expectPrompt = async (env: Record<string, string>, item: RegExp) => {
    await assert.rejects(run(env), error => {
      assert.match(String((error as { stderr?: string }).stderr), item);
      assert.match(String((error as { stderr?: string }).stderr), /invalid choice/);
      return true;
    });
    const approved = await run({ ...env, CCGC_TEST_CHOICE: '1' });
    assert.equal(approved.stdout.trim(), 'preflight-ok');
    assert.match(approved.stderr, item);
  };
  try {
    assert.equal((await run()).stdout.trim(), 'preflight-ok');

    const settings = join(home, '.claude/settings.json');
    await mkdir(join(home, '.claude'), { recursive: true });
    const helper = `'/bin/bash' '${join(home, '.local/share/ccgc/enterprise/ccgc-enterprise-macos.sh')}' token`;
    const managed = {
      env: { ANTHROPIC_BASE_URL: 'https://gateway.example', ANTHROPIC_DEFAULT_MODEL: 'claude-sonnet-5.5' },
      permissions: { defaultMode: 'acceptEdits' }, model: 'claude-sonnet-5.5', apiKeyHelper: helper,
    };
    for (const clean of ['{}', JSON.stringify(managed)]) {
      await writeFile(settings, clean, { mode: 0o600 });
      assert.equal((await run()).stdout.trim(), 'preflight-ok');
    }
    for (const leftover of [
      '{"apiKeyHelper":"/bin/unrelated-helper"}',
      '{"env":{"ANTHROPIC_CUSTOM_HEADERS":"x-litellm-api-key: Bearer old-virtual-key"}}',
      '{"env":{"ANTHROPIC_BASE_URL":"https://retired.example"}}',
      '{"theme":"dark"}',
      '{invalid',
      '[]',
    ]) {
      await writeFile(settings, leftover, { mode: 0o600 });
      await expectPrompt({}, /Claude Code settings/);
    }
    await writeFile(settings, JSON.stringify({ ...managed, enabledPlugins: { 'example@market': true } }), { mode: 0o600 });
    await expectPrompt({}, /Claude Code settings/);
    assert.equal((await run({ CCGC_TEST_PREFLIGHT_MODE: 'routing' })).stdout.trim(), 'preflight-ok');
    await writeFile(settings, JSON.stringify({ ...managed, env: { ...managed.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1' } }), { mode: 0o600 });
    await expectPrompt({ CCGC_TEST_PREFLIGHT_MODE: 'routing' }, /Claude Code settings/);
    await writeFile(settings, JSON.stringify(managed), { mode: 0o600 });

    const library = join(home, 'Library/Application Support/Claude-3p/configLibrary');
    await mkdir(library, { recursive: true, mode: 0o700 });
    const activeId = '11111111-2222-4333-8444-555555555555';
    const defaultId = '22222222-2222-4333-8444-555555555555';
    const desired = {
      inferenceProvider: 'gateway', inferenceGatewayAuthScheme: 'bearer', inferenceCredentialKind: 'helper-script',
      modelDiscoveryEnabled: true, inferenceGatewayBaseUrl: 'https://gateway.example', inferenceCredentialHelper: '/bin/bash',
      inferenceCredentialHelperArgs: [join(home, '.local/share/ccgc/enterprise/ccgc-enterprise-macos.sh'), 'token'],
    };
    await writeFile(join(library, '_meta.json'), JSON.stringify({ appliedId: activeId, entries: [{ id: activeId, name: 'x' }] }), { mode: 0o600 });
    await writeFile(join(library, `${activeId}.json`), JSON.stringify(desired), { mode: 0o600 });
    await writeFile(join(library, `${activeId}.json`), '{}', { mode: 0o600 });
    await writeFile(join(library, `${defaultId}.json`), '{}', { mode: 0o600 });
    assert.equal((await run({ CCGC_TEST_DESKTOP: '1' })).stdout.trim(), 'preflight-ok');
    await writeFile(join(library, `${activeId}.json`), JSON.stringify(desired), { mode: 0o600 });
    assert.equal((await run({ CCGC_TEST_DESKTOP: '1' })).stdout.trim(), 'preflight-ok');
    await writeFile(join(library, `${defaultId}.json`), '{"inferenceGatewayApiKey":"old-virtual-key"}', { mode: 0o600 });
    await expectPrompt({ CCGC_TEST_DESKTOP: '1' }, /Claude Desktop gateway profiles/);
    assert.equal((await run({ CCGC_TEST_DESKTOP: '1', CCGC_TEST_PREFLIGHT_MODE: 'routing' })).stdout.trim(), 'preflight-ok');
    await writeFile(join(library, `${defaultId}.json`), '{}', { mode: 0o600 });
    await writeFile(join(library, `${activeId}.json`), JSON.stringify({ ...desired, chatTabEnabled: true }), { mode: 0o600 });
    await expectPrompt({ CCGC_TEST_DESKTOP: '1' }, /Claude Desktop gateway profiles/);
    assert.equal((await run({ CCGC_TEST_DESKTOP: '1', CCGC_TEST_PREFLIGHT_MODE: 'routing' })).stdout.trim(), 'preflight-ok');
    await writeFile(join(library, `${activeId}.json`), JSON.stringify({ ...desired, inferenceGatewayBaseUrl: 'https://retired.example' }), { mode: 0o600 });
    await expectPrompt({ CCGC_TEST_DESKTOP: '1', CCGC_TEST_PREFLIGHT_MODE: 'routing' }, /Claude Desktop gateway profiles/);
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
  assert.match(source, /verify_desktop_config "\$gateway"/);
  assert.match(source, /CCGC doctor passed/);
});

test('macOS gateway failures include safe server-side error messages', async () => {
  const source = await readFile(script, 'utf8');
  assert.match(source, /json_raw "\$2" error\.message/);
  assert.match(source, /enterprise gateway returned HTTP \$1: \$message/);
});

const standaloneKey = `sk-${'k'.repeat(32)}`;
const standaloneUser = '11111111-2222-4333-8444-555555555555';
const standaloneCredential = 'github-copilot-user';
const standaloneStubs = `
source "$1"
ensure_github_cli() { return 0; }
ensure_github_cli_login() { [ "$1" = example-user ]; }
verify_github_mcp() { [ "$1" = https://gateway.example ] && [ "$2" = "$CCGC_TEST_KEY" ]; }
claude() { printf '2.1.319 (Claude Code)\\n'; }
desktop_installed() { [ "$CCGC_TEST_MODE" != no-desktop ]; }
claude_desktop_version() { printf '4.23118.0'; }
if [ "$CCGC_TEST_MODE" = managed-desktop ]; then
  require_local_desktop_policy() { fail 'Claude Desktop has managed policy'; }
fi
read_litellm_key() { printf '%s' "$CCGC_TEST_KEY"; }
open_github() { printf 'browser-opened\\n' >> "$HOME/events"; }
keychain_get() { /bin/cat "$HOME/keychain/$1" 2>/dev/null; }
keychain_set() { printf '%s' "$2" > "$HOME/keychain/$1"; }
keychain_delete() { /bin/rm -f "$HOME/keychain/$1"; }
request_json_status() {
  local method="$1" url="$2" bearer="$3" body="$4" output="$5"
  local fixture='' status=200 events
  printf '%s %s\\n' "$method" "$url" >> "$HOME/events"
  case "$url" in
    https://gateway.example/health/liveliness|https://gateway.example/health/readiness)
      [ -z "$bearer" ] || fail 'health check must not send a credential'
      ;;
    *) [ "$bearer" = "$CCGC_TEST_KEY" ] || fail 'wrong LiteLLM credential' ;;
  esac
  case "$method $url" in
    'GET https://gateway.example/health/liveliness') fixture=liveness ;;
    'GET https://gateway.example/health/readiness')
      fixture=health
      [ "$CCGC_TEST_MODE" != health-unavailable ] || status=503
      ;;
    'GET https://gateway.example/key/info')
      fixture=key
      case "$CCGC_TEST_MODE" in
        gateway-expired-key) fixture=expired-key-error; status=401 ;;
        revoked-key) fixture=revoked-key-error; status=401 ;;
        admin-key) fixture=admin-key-error; status=404 ;;
        key-info-unavailable) fixture=server-error; status=500 ;;
      esac
      ;;
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
`;
const standaloneHarness = `${standaloneStubs}
main <<< "\${CCGC_TEST_CHOICE-1}"
cleanup_temp
token > "$HOME/helper-token"
if [ "$CCGC_TEST_MODE" = success ]; then
  models
  cleanup_temp
  configure < /dev/null
  cleanup_temp
  doctor
fi
`;
const configureHarness = `${standaloneStubs}
if [ "\${CCGC_TEST_COMMAND-}" = doctor ]; then doctor; else configure <<< "\${CCGC_TEST_CHOICE-}"; fi
cleanup_temp
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
  // LiteLLM 1.108 /key/info serializes expiry with microseconds and a +00:00 offset.
  const liteLLMExpiry = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString().replace(/Z$/, '000+00:00');
  const key: { info: { user_id: string; expires: string | null } } = {
    info: { user_id: standaloneUser, expires: liteLLMExpiry(90 * 86_400_000) },
  };
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
  if (mode === 'key-expired') key.info.expires = liteLLMExpiry(-60_000);
  if (mode === 'key-invalid-expiry') key.info.expires = '2027-02-07 sometime';
  if (mode === 'key-impossible-expiry') key.info.expires = '2027-02-31T06:19:09.232000+00:00';
  if (mode === 'key-invalid-offset') key.info.expires = '2027-02-07T06:19:09+00:60';
  if (mode === 'key-no-expiry') key.info.expires = null;
  if (mode === 'unsafe-url') start.verification_uri = 'https://example.net/login/device';
  if (mode === 'expired') poll.status = 'expired';
  if (mode === 'no-seat') poll.status = 'no_copilot_seat';
  if (mode === 'duplicate-route') routes.data.push({
    model_name: 'claude-sonnet-5.5',
    litellm_params: { model: 'anthropic/claude-sonnet-5.5', litellm_credential_name: standaloneCredential },
  });
  const fixtures = {
    start, poll, key, connection, routes,
    liveness: "I'm alive!",
    health: { status: 'healthy', db: mode === 'database-disconnected' ? 'disconnected' : 'connected' },
    disconnected: { status: 'disconnected' },
    'empty-connection': { connections: [] },
    // Error bodies captured from LiteLLM 1.108.3.
    'expired-key-error': { error: {
      message: 'Authentication Error - Expired Key. Key Expiry time 2026-11-09 06:26:18.546000+00:00',
      type: 'expired_key', param: 'sk-...15c4', code: '401',
    } },
    'revoked-key-error': { error: {
      message: 'Authentication Error, Invalid API key provided.', type: 'auth_error', param: 'None', code: '401',
    } },
    'admin-key-error': { error: { message: 'Key not found in database', type: 'not_found', code: '404' } },
    'server-error': { error: { message: 'Internal Server Error', type: 'internal_server_error', code: '500' } },
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
  if (mode === 'invalid-health') {
    await writeFile(join(home, 'fixtures/health.json'), '<html>Proxy error</html>', { mode: 0o600 });
  }
  await writeFile(join(home, '.local/share/ccgc/enterprise/profile.json'), '{"previousProfile":true}', { mode: 0o600 });
  await writeFile(join(home, '.claude/settings.json'), '{"unrelatedSetting":true,"permissions":{"defaultMode":"manual"}}', { mode: 0o600 });
  await writeFile(join(home, 'keychain', 'previous-key'), 'previous-personal-key', { mode: 0o600 });
  if (!['fresh-desktop', 'no-desktop'].includes(mode)) {
    const library = join(home, 'Library/Application Support/Claude-3p/configLibrary');
    await mkdir(library, { recursive: true, mode: 0o700 });
    await writeFile(join(library, '_meta.json'), JSON.stringify({
      appliedId: mode === 'desktop-invalid-id' ? '../escape' : standaloneUser,
      entries: [{ id: standaloneUser, name: 'Existing gateway' }],
      ...(mode === 'desktop-remote' ? { hybridPointer: 'https://config.example' } : {}),
    }), { mode: 0o600 });
    await writeFile(join(library, `${standaloneUser}.json`), JSON.stringify({
      inferenceProvider: 'gateway', inferenceGatewayBaseUrl: 'https://retired.example',
      inferenceCredentialHelper: '/old/node', inferenceCredentialHelperArgs: ['/old/enterprise-cli.ts', 'token'],
      inferenceGatewayApiKey: 'old-key', inferenceModels: [{ id: 'old-model' }],
      chatTabEnabled: true,
    }), { mode: 0o600 });
    await writeFile(join(library, '../claude_desktop_config.json'), JSON.stringify({
      deploymentMode: '3p', preferences: { keepThis: true },
    }), { mode: 0o600 });
    if (mode === 'desktop-default-profile') await writeFile(join(library, `${standaloneUser}.json`), '{}');
    if (mode === 'desktop-invalid-json') await writeFile(join(library, '_meta.json'), '{invalid');
    if (mode === 'desktop-symlink') {
      await rename(join(library, `${standaloneUser}.json`), join(library, 'original.json'));
      await symlink('original.json', join(library, `${standaloneUser}.json`));
    }
    if (mode === 'desktop-write-failure') await chmod(library, 0o500);
  }
  if (mode === 'write-failure') await chmod(join(home, '.claude'), 0o500);
  return home;
}

function runStandalone(home: string, mode: string, extra: Record<string, string> = {}, harness = standaloneHarness) {
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, TMPDIR: join(home, 'temp'), CCGC_TEST_MODE: mode,
    CCGC_TEST_KEY: standaloneKey,
  };
  for (const name of Object.keys(env)) {
    if (name.startsWith('ANTHROPIC_') || name.startsWith('CLAUDE_CODE_')) delete env[name];
  }
  return exec('/bin/bash', ['-c', harness, 'bash', script.pathname], { env: { ...env, ...extra }, timeout: 30_000 });
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
    assert.equal(settings.unrelatedSetting, undefined);
    assert.deepEqual(Object.keys(settings).sort(), ['apiKeyHelper', 'env', 'model', 'permissions']);
    assert.equal(settings.permissions.defaultMode, 'manual');
    const settingsBackups = (await readdir(join(home, '.claude'))).filter(name => name.startsWith('settings.json.ccgc-backup.'));
    assert.equal(settingsBackups.length, 1, 'configure should not back up clean settings again');
    assert.equal(
      await readFile(join(home, '.claude', settingsBackups[0]!), 'utf8'),
      '{"unrelatedSetting":true,"permissions":{"defaultMode":"manual"}}',
    );
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
    assert.match(result.stdout, /Previous Claude Code settings backed up to /);
    assert.match(result.stdout, /Previous Claude Desktop gateway profiles backed up to /);
    assert.match(result.stderr, /Existing Claude configuration from another setup was found/);
    assert.equal(result.stderr.split('Enter 1 or 2').length, 2, 'enrollment should ask exactly once');
    assert.match(result.stdout, /CCGC doctor passed/);
    const library = join(home, 'Library/Application Support/Claude-3p/configLibrary');
    const meta = JSON.parse(await readFile(join(library, '_meta.json'), 'utf8'));
    assert.notEqual(meta.appliedId, standaloneUser);
    assert.deepEqual(meta.entries, [{ id: meta.appliedId, name: 'GitHub Copilot via LiteLLM' }]);
    assert.deepEqual((await readdir(library)).sort(), [`${meta.appliedId}.json`, '_meta.json'].sort());
    const active = JSON.parse(await readFile(join(library, `${meta.appliedId}.json`), 'utf8'));
    assert.deepEqual(active, desktop);
    assert.deepEqual(JSON.parse(await readFile(join(library, '../claude_desktop_config.json'), 'utf8')).preferences, { keepThis: true });
    const desktopBackups = (await readdir(join(library, '..'))).filter(name => name.startsWith('configLibrary.ccgc-backup.'));
    assert.equal(desktopBackups.length, 1, 'configure should not back up clean Desktop profiles again');
    const desktopBackup = join(library, '..', desktopBackups[0]!);
    assert.deepEqual((await readdir(desktopBackup)).sort(), [`${standaloneUser}.json`, '_meta.json'].sort());
    const previousActive = JSON.parse(await readFile(join(desktopBackup, `${standaloneUser}.json`), 'utf8'));
    assert.equal(previousActive.inferenceCredentialHelper, '/old/node');
    assert.equal(previousActive.inferenceGatewayApiKey, 'old-key');
    for (const output of [result.stdout, result.stderr, JSON.stringify(profile), JSON.stringify(settings), JSON.stringify(desktop)]) {
      assert.equal(output.includes(standaloneKey), false);
    }
    assert.equal(await readFile(join(home, 'keychain/previous-key'), 'utf8'), 'previous-personal-key');
    assert.deepEqual(await readdir(join(home, 'temp')), []);
    active.inferenceCredentialHelper = '/old/node';
    await writeFile(join(library, `${meta.appliedId}.json`), JSON.stringify(active));
    await assert.rejects(exec('/bin/bash', ['-c', `
source "$1"
desktop_installed() { return 0; }
verify_desktop_config https://gateway.example
`, 'bash', script.pathname], { env: { ...process.env, HOME: home } }), error => {
      assert.match(String((error as { stderr?: string }).stderr), /Desktop gateway or credential helper is outdated/);
      return true;
    });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('standalone enrollment cancellation changes nothing and never uses the key', {
  skip: process.platform !== 'darwin',
}, async () => {
  for (const choice of ['2', '']) {
    const home = await standaloneFixture('success');
    try {
      await assert.rejects(runStandalone(home, 'success', { CCGC_TEST_CHOICE: choice }), error => {
        const stderr = String((error as { stderr?: string }).stderr);
        assert.match(stderr, choice === '2' ? /setup cancelled/ : /invalid choice/);
        assert.equal(stderr.split('\n').filter(line => line.startsWith('ERROR:')).length, 1);
        return true;
      });
      await assert.rejects(readFile(join(home, 'events')), { code: 'ENOENT' });
      assert.equal(await readFile(join(home, '.claude/settings.json'), 'utf8'), '{"unrelatedSetting":true,"permissions":{"defaultMode":"manual"}}');
      assert.deepEqual(await readdir(join(home, '.claude')), ['settings.json']);
      const library = join(home, 'Library/Application Support/Claude-3p/configLibrary');
      assert.deepEqual((await readdir(library)).sort(), [`${standaloneUser}.json`, '_meta.json'].sort());
      assert.deepEqual(await readdir(join(home, 'keychain')), ['previous-key']);
      assert.deepEqual(await readdir(join(home, 'temp')), []);
    } finally { await rm(home, { recursive: true, force: true }); }
  }
});

test('configure keeps later personal settings but resets configuration from another setup', {
  skip: process.platform !== 'darwin',
}, async () => {
  const home = await standaloneFixture('success');
  const settingsPath = join(home, '.claude/settings.json');
  const backups = async () => (await readdir(join(home, '.claude'))).filter(name => name.includes('.ccgc-backup.'));
  try {
    await runStandalone(home, 'success');
    const enrolled = JSON.parse(await readFile(settingsPath, 'utf8'));
    const personal = {
      ...enrolled, enabledPlugins: { 'example@market': true },
      permissions: { ...enrolled.permissions, defaultMode: 'acceptEdits', allow: ['Bash(npm test)', 'mcp__github__github-web_search'] },
    };
    await writeFile(settingsPath, JSON.stringify(personal), { mode: 0o600 });
    const kept = await runStandalone(home, 'success', {}, configureHarness);
    assert.doesNotMatch(kept.stderr, /Enter 1 or 2/);
    assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), personal);
    assert.equal((await backups()).length, 1);

    const leftover = { ...personal, env: { ...personal.env, ANTHROPIC_CUSTOM_HEADERS: 'x-litellm-api-key: Bearer old-virtual-key' } };
    await writeFile(settingsPath, JSON.stringify(leftover), { mode: 0o600 });
    await assert.rejects(runStandalone(home, 'success', { CCGC_TEST_COMMAND: 'doctor' }, configureHarness), error => {
      assert.match(String((error as { stderr?: string }).stderr), /Claude settings contain ANTHROPIC_CUSTOM_HEADERS from another setup; run configure/);
      return true;
    });
    await assert.rejects(runStandalone(home, 'success', { CCGC_TEST_CHOICE: '2' }, configureHarness), /setup cancelled/);
    assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), leftover);

    const reset = await runStandalone(home, 'success', { CCGC_TEST_CHOICE: '1' }, configureHarness);
    assert.match(reset.stdout, /Previous Claude Code settings backed up to /);
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    assert.equal(settings.env.ANTHROPIC_CUSTOM_HEADERS, undefined);
    assert.equal(settings.enabledPlugins, undefined);
    assert.equal(settings.permissions.defaultMode, 'manual');
    assert.equal(settings.env.ANTHROPIC_BASE_URL, 'https://gateway.example');
    const allBackups = await backups();
    assert.equal(allBackups.length, 2);
    const restored = await Promise.all(allBackups.map(name => readFile(join(home, '.claude', name), 'utf8')));
    assert.ok(restored.some(content => content.includes('old-virtual-key')));
    await runStandalone(home, 'success', { CCGC_TEST_COMMAND: 'doctor' }, configureHarness);
    assert.deepEqual(await readdir(join(home, 'temp')), []);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('standalone enrollment rejects health, identity, routing and authorization failures without replacing local credentials', {
  skip: process.platform !== 'darwin',
}, async t => {
  for (const [mode, message] of [
    ['database-disconnected', /LiteLLM is not ready or its database is disconnected/],
    ['health-unavailable', /LiteLLM health check returned HTTP 503/],
    ['invalid-health', /LiteLLM returned invalid health JSON/],
    ['wrong-account', /approving GitHub account does not match/],
    ['wrong-owner', /key and user information do not match/],
    ['wrong-connection', /connected to a different GitHub account/],
    ['duplicate-route', /conflicting provider/],
    ['unsafe-url', /unexpected GitHub authorization URL/],
    ['expired', /GitHub authorization expired/],
    ['no-seat', /no GitHub Copilot entitlement/],
    ['write-failure', /could not install/],
    ['key-expired', /supplied LiteLLM key has expired/],
    ['key-invalid-expiry', /gateway returned an invalid credential expiry/],
    ['key-impossible-expiry', /gateway returned an invalid credential expiry/],
    ['key-invalid-offset', /gateway returned an invalid credential expiry/],
    ['key-no-expiry', /LiteLLM key has no expiry/],
    ['gateway-expired-key', /supplied LiteLLM key has expired; ask your administrator for a new key/],
    ['revoked-key', /supplied LiteLLM key was rejected \(revoked, blocked, or mistyped\)/],
    ['admin-key', /not a personal employee key; .*never the administrator key/],
    ['key-info-unavailable', /enterprise gateway returned HTTP 500: Internal Server Error/],
    ['desktop-invalid-id', /Desktop active configuration ID is invalid/],
    ['desktop-remote', /Desktop uses remote configuration/],
    ['managed-desktop', /Desktop has managed policy/],
    ['desktop-write-failure', /could not install/],
    ['desktop-invalid-json', /Desktop configuration is invalid JSON/],
    ['desktop-symlink', /Desktop active configuration must be a non-symlink regular file/],
  ] as const) {
    await t.test(mode, async () => {
      const home = await standaloneFixture(mode);
      try {
        await assert.rejects(runStandalone(home, mode), error => {
          const stderr = String((error as { stderr?: string }).stderr);
          assert.match(stderr, message);
          assert.doesNotMatch(stderr, /integer expression|unbound variable|syntax error|command not found/);
          assert.equal(stderr.split('\n').filter(line => line.startsWith('ERROR:')).length, 1);
          assert.equal(stderr.includes(standaloneKey), false);
          return true;
        });
        assert.equal(await readFile(join(home, '.local/share/ccgc/enterprise/profile.json'), 'utf8'), '{"previousProfile":true}');
        assert.equal(await readFile(join(home, '.claude/settings.json'), 'utf8'), '{"unrelatedSetting":true,"permissions":{"defaultMode":"manual"}}');
        assert.equal(await readFile(join(home, 'keychain/previous-key'), 'utf8'), 'previous-personal-key');
        assert.deepEqual(await readdir(join(home, 'keychain')), ['previous-key']);
        assert.deepEqual(await readdir(join(home, 'temp')), []);
        const active = JSON.parse(await readFile(join(home, `Library/Application Support/Claude-3p/configLibrary/${standaloneUser}.json`), 'utf8'));
        assert.equal(active.inferenceCredentialHelper, '/old/node');
        assert.equal(active.inferenceGatewayBaseUrl, 'https://retired.example');
      } finally {
        await chmod(join(home, '.claude'), 0o700);
        await chmod(join(home, 'Library/Application Support/Claude-3p/configLibrary'), 0o700);
        await rm(home, { recursive: true, force: true });
      }
    });
  }
});

test('Desktop configuration is created for a fresh install and skipped when Desktop is absent', {
  skip: process.platform !== 'darwin',
}, async () => {
  for (const mode of ['fresh-desktop', 'no-desktop', 'desktop-default-profile']) {
    const home = await standaloneFixture(mode);
    try {
      const result = await runStandalone(home, mode);
      const metaPath = join(home, 'Library/Application Support/Claude-3p/configLibrary/_meta.json');
      assert.doesNotMatch(result.stderr, /Claude Desktop gateway profiles/);
      assert.equal((await readdir(join(home, 'Library/Application Support'), { recursive: true }).catch(() => []))
        .filter(name => String(name).includes('ccgc-backup')).length, 0);
      if (mode === 'no-desktop') {
        await assert.rejects(readFile(metaPath), { code: 'ENOENT' });
      } else {
        const meta = JSON.parse(await readFile(metaPath, 'utf8'));
        const active = JSON.parse(await readFile(join(home, `Library/Application Support/Claude-3p/configLibrary/${meta.appliedId}.json`), 'utf8'));
        assert.equal(active.inferenceCredentialHelper, '/bin/bash');
        assert.equal(active.inferenceGatewayBaseUrl, 'https://gateway.example');
        assert.deepEqual(meta.entries, mode === 'fresh-desktop'
          ? [{ id: meta.appliedId, name: 'GitHub Copilot via LiteLLM' }]
          : [{ id: standaloneUser, name: 'Existing gateway' }]);
      }
    } finally { await rm(home, { recursive: true, force: true }); }
  }
});

test('expiry parser handles LiteLLM timestamp formats independently of the local timezone', {
  skip: process.platform !== 'darwin',
}, async () => {
  const epoch = 1801981149;
  const accepted = [
    '2027-02-07T06:19:09Z', '2027-02-07T06:19:09.232Z', '2027-02-07T06:19:09.232000Z',
    '2027-02-07T06:19:09.232000+00:00', '2027-02-07T06:19:09+00:00', '2027-02-07T06:19:09+0000',
    '2027-02-07T08:19:09.5+02:00', '2027-02-06T22:19:09-08:00', '2027-02-07 06:19:09.232000+00:00',
    '2027-02-07T12:04:09+05:45', '2027-02-07T02:49:09-03:30', '2027-02-07T06:19:09-00:00',
    '2027-02-07T06:19:09', '2027-02-07T06:19:09.123456789Z',
  ];
  const rejected = [
    '', 'never', '1801981149', '2027-02-07', '2027-02-07T06:19', '2027-13-45T06:19:09Z',
    '2027-02-07T06:19:09+00:00 trailing', '2027-02-07T06:19:09+2', '2027-02-07T06:19:09.Z', '\n2027-02-07T06:19:09Z',
    '2027-02-31T06:19:09Z', '2027-02-29T06:19:09Z', '2028-04-31T06:19:09Z',
    '2027-02-07T06:19:09+24:00', '2027-02-07T06:19:09+00:60', '2027-02-07T06:19:09-08:99',
    '2027-02-07T24:19:09Z', '2027-02-07T06:60:09Z', '2027-02-07T06:19:60Z',
  ];
  const harness = `source "$1"; shift; for value in "$@"; do printf '%s\\n' "$(expiry_epoch "$value" || printf rejected)"; done`;
  for (const timezone of ['UTC', 'Asia/Jerusalem', 'America/Los_Angeles']) {
    const run = (values: string[]) => exec('/bin/bash', ['-c', harness, 'bash', script.pathname, ...values], {
      env: { ...process.env, TZ: timezone },
    });
    assert.deepEqual((await run(accepted)).stdout.trim().split('\n'), accepted.map(() => String(epoch)), timezone);
    assert.deepEqual((await run(rejected)).stdout.trim().split('\n'), rejected.map(() => 'rejected'), timezone);
    const leapDay = '2028-02-29T23:59:59Z';
    assert.equal((await run([leapDay])).stdout.trim(), String(Date.parse(leapDay) / 1000), timezone);
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

test('GitHub MCP configuration preserves other servers and settings, is idempotent, and stores no credentials', {
  skip: process.platform !== 'darwin',
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccgc-mcp-config-'));
  try {
    await mkdir(join(home, '.claude'));
    const original = { projects: { '/test': { hasTrustDialogAccepted: false } }, mcpServers: { existing: { type: 'http', url: 'https://other.example' } } };
    await writeFile(join(home, '.claude.json'), JSON.stringify(original), { mode: 0o600 });
    const settings = { env: { ANTHROPIC_BASE_URL: 'https://gateway.example' }, apiKeyHelper: 'existing helper', permissions: { allow: ['Read'], deny: ['Bash(rm *)'], defaultMode: 'manual' } };
    await writeFile(join(home, 'settings.json'), JSON.stringify(settings));
    const harness = `source "$1"; prepare_github_mcp https://gateway.example "$HOME"; prepare_github_mcp https://gateway.example "$HOME"`;
    await exec('/bin/bash', ['-c', harness, 'bash', script.pathname], { env: { ...process.env, HOME: home } });
    const state = JSON.parse(await readFile(join(home, 'mcp-state.json'), 'utf8'));
    assert.deepEqual(state.projects, original.projects);
    assert.deepEqual(state.mcpServers.existing, original.mcpServers.existing);
    assert.equal(state.mcpServers.github.url, 'https://gateway.example/github/mcp');
    assert.equal(state.mcpServers.github.headers, undefined);
    assert.match(state.mcpServers.github.headersHelper, /mcp-headers$/);
    assert.equal(state.hasSeenAutoModeOutsideReadPrompt, undefined);
    const actual = JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'));
    assert.equal(actual.apiKeyHelper, settings.apiKeyHelper);
    assert.deepEqual(actual.env, settings.env);
    assert.deepEqual(actual.permissions.allow, ['Read', 'mcp__github__github-web_search']);
    assert.deepEqual(actual.permissions.deny, ['Bash(rm *)', 'WebSearch']);
    assert.deepEqual(JSON.parse(await readFile(join(home, '.claude.json'), 'utf8')), original);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('MCP headers are generated per connection and never sent for another gateway or account', {
  skip: process.platform !== 'darwin',
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccgc-mcp-auth-'));
  try {
    await mkdir(join(home, '.local/share/ccgc/enterprise'), { recursive: true });
    await writeFile(join(home, '.local/share/ccgc/enterprise/profile.json'), JSON.stringify({
      authMethod: 'litellmKey', inferenceAuthentication: 'directKey', githubMcpEnabled: true,
      githubLogin: 'employee', gateway: 'https://gateway.example',
    }), { mode: 0o600 });
    const harness = `source "$1"; token() { printf 'sk-synthetic-personal-key'; }; gh() {
      if [ "$1 $2" = 'auth token' ]; then printf 'gho_synthetic_github_token_12345';
      else printf '%s' "\${TEST_LOGIN:-employee}"; fi
    }; mcp_headers`;
    const env = { ...process.env, HOME: home, CLAUDE_CODE_MCP_SERVER_NAME: 'github', CLAUDE_CODE_MCP_SERVER_URL: 'https://gateway.example/github/mcp' };
    const result = await exec('/bin/bash', ['-c', harness, 'bash', script.pathname], { env });
    assert.deepEqual(JSON.parse(result.stdout), { 'x-litellm-api-key': 'Bearer sk-synthetic-personal-key', 'x-mcp-github-authorization': 'Bearer gho_synthetic_github_token_12345' });
    for (const change of [{ CLAUDE_CODE_MCP_SERVER_URL: 'https://evil.example/github/mcp' }, { TEST_LOGIN: 'another' }, { CLAUDE_CODE_MCP_SERVER_NAME: 'other' }]) {
      await assert.rejects(exec('/bin/bash', ['-c', harness, 'bash', script.pathname], { env: { ...env, ...change } }), error => {
        assert.equal((error as { stdout?: string }).stdout, '');
        assert.doesNotMatch(String((error as { stderr?: string }).stderr), /synthetic-personal|synthetic_github/);
        return true;
      });
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('enrollment always installs MCP state and preserves it through configure and doctor', {
  skip: process.platform !== 'darwin',
}, async () => {
  const home = await standaloneFixture('success');
  try {
    await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { other: { type: 'http', url: 'https://other.example' } }, personalState: true, optionalState: null }), { mode: 0o600 });
    const result = await runStandalone(home, 'success');
    assert.match(result.stdout, /CCGC doctor passed/);
    const profile = JSON.parse(await readFile(join(home, '.local/share/ccgc/enterprise/profile.json'), 'utf8'));
    assert.equal(profile.githubMcpEnabled, true);
    const state = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8'));
    assert.equal(state.personalState, true);
    assert.equal(state.mcpServers.other.url, 'https://other.example');
    assert.equal(state.mcpServers.github.url, 'https://gateway.example/github/mcp');
    const backups = (await readdir(home)).filter(n => n.startsWith('.claude.json.ccgc-backup.'));
    assert.ok(backups.length >= 1 && backups.length <= 2);
    assert.deepEqual(await readdir(join(home, 'temp')), []);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('enrollment stopped at MCP verification resumes with completed Copilot login and preserves state on later reruns', {
  skip: process.platform !== 'darwin',
}, async () => {
  const home = await standaloneFixture('success');
  const harness = `${standaloneStubs}
verify_github_mcp() {
  [ "\${CCGC_TEST_STOP_AT_MCP-}" != 1 ] || fail 'MCP verification interrupted; rerun setup'
  [ "$1" = https://gateway.example ] && [ "$2" = "$CCGC_TEST_KEY" ]
}
main <<< "\${CCGC_TEST_CHOICE-1}"
cleanup_temp
`;
  try {
    await assert.rejects(runStandalone(home, 'success', { CCGC_TEST_STOP_AT_MCP: '1' }, harness),
      error => /MCP verification interrupted/.test(String((error as { stderr?: string }).stderr)));
    assert.deepEqual(JSON.parse(await readFile(join(home, '.local/share/ccgc/enterprise/profile.json'), 'utf8')), { previousProfile: true });
    assert.equal(await readFile(join(home, 'keychain/previous-key'), 'utf8'), 'previous-personal-key');
    assert.deepEqual(await readdir(join(home, 'temp')), []);
    const resumed = await runStandalone(home, 'success', {}, harness);
    assert.match(resumed.stdout, /Enrollment complete/);
    const statePath = join(home, '.claude/settings.json');
    const settings = JSON.parse(await readFile(statePath, 'utf8'));
    settings.theme = 'dark';
    settings.permissions.defaultMode = 'acceptEdits';
    await writeFile(statePath, JSON.stringify(settings));
    await runStandalone(home, 'success', { CCGC_TEST_CHOICE: '' }, harness);
    const repeated = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(repeated.theme, 'dark');
    assert.equal(repeated.permissions.defaultMode, 'acceptEdits');
    assert.deepEqual(repeated.permissions.allow, ['mcp__github__github-web_search']);
    assert.deepEqual(repeated.permissions.deny, ['WebSearch']);
    const events = await readFile(join(home, 'events'), 'utf8');
    assert.equal(events.split('browser-opened').length - 1, 1);
    assert.equal(events.split('POST https://gateway.example/credentials/github-copilot-user/user_connection/start').length - 1, 1);
    assert.equal(events.split('POST https://gateway.example/credentials/github-copilot-user/user_connection/poll').length - 1, 1);
    assert.equal(JSON.parse(await readFile(join(home, '.local/share/ccgc/enterprise/profile.json'), 'utf8')).githubMcpEnabled, true);
    assert.deepEqual(await readdir(join(home, 'temp')), []);
  } finally { await rm(home, { recursive: true, force: true }); }
});
