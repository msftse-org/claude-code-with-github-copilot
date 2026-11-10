import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const script = new URL('../scripts/ccgc-enterprise-macos.sh', import.meta.url).pathname;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ccgc-gh-install-'));
  const root = join(directory, 'gh_2.103.3_macOS_arm64');
  await mkdir(join(root, 'bin'), { recursive: true });
  await writeFile(join(root, 'bin/gh'), '#!/bin/bash\nprintf "gh version 2.103.3 (test fixture)\\n"\n');
  await writeFile(join(root, 'LICENSE'), 'Synthetic fixture license');
  await exec('/usr/bin/zip', ['-q', '-r', 'fixture.zip', 'gh_2.103.3_macOS_arm64'], { cwd: directory });
  const digest = createHash('sha256').update(await readFile(join(directory, 'fixture.zip'))).digest('hex');
  return { directory, digest };
}

const pathStub = `github_cli_path() { [ -x "$GH_INSTALL_PATH" ] && printf '%s' "$GH_INSTALL_PATH"; }`;
const base = `source "$1"; ${pathStub}
github_cli_archive() { printf 'gh_2.103.3_macOS_arm64.zip %s' "$TEST_DIGEST"; }
download_github_cli() {
  [ "$1" = https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_macOS_arm64.zip ] || return 1
  printf 'download\\n' >> "$HOME/downloads"
  if [ "\${TEST_INTERRUPT-}" = 1 ]; then printf partial > "$2"; return 130; fi
  /bin/cp "$HOME/fixture.zip" "$2"
}
ensure_github_cli
`;

test('missing gh is verified and installed atomically; interrupted installation can be rerun and then reused', {
  skip: process.platform !== 'darwin',
}, async () => {
  const { directory, digest } = await fixture();
  const env = { ...process.env, HOME: directory, TEST_DIGEST: digest };
  const binDir = join(directory, '.local/share/ccgc/enterprise/bin');
  try {
    await assert.rejects(exec('/bin/bash', ['-c', base, 'bash', script], { env: { ...env, TEST_INTERRUPT: '1' } }),
      error => /rerun the same setup file/.test(String((error as { stderr?: string }).stderr)));
    assert.deepEqual(await readdir(binDir), []);
    await exec('/bin/bash', ['-c', base + '\ngithub_cli --version', 'bash', script], { env });
    assert.deepEqual((await readdir(binDir)).sort(), ['gh', 'gh-LICENSE']);
    const result = await exec('/bin/bash', ['-c', base + '\ngithub_cli --version', 'bash', script], { env });
    assert.match(result.stdout, /gh version 2.103.3/);
    assert.equal((await readFile(join(directory, 'downloads'), 'utf8')).trim().split('\n').length, 2,
      'one interrupted download, one successful download, no download on third run');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('checksum mismatch installs no executable and a successful rerun can recover', {
  skip: process.platform !== 'darwin',
}, async () => {
  const { directory, digest } = await fixture();
  const env = { ...process.env, HOME: directory, TEST_DIGEST: '0'.repeat(64) };
  try {
    await assert.rejects(exec('/bin/bash', ['-c', base, 'bash', script], { env }),
      error => /checksum mismatch/.test(String((error as { stderr?: string }).stderr)));
    assert.deepEqual(await readdir(join(directory, '.local/share/ccgc/enterprise/bin')), []);
    await exec('/bin/bash', ['-c', base, 'bash', script], { env: { ...env, TEST_DIGEST: digest } });
    assert.match((await exec(join(directory, '.local/share/ccgc/enterprise/bin/gh'), ['--version'])).stdout, /2.103.3/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('existing gh is reused without installation', async () => {
  const result = await exec('/bin/bash', ['-c', `source "$1"; github_cli_path() { printf /existing/gh; }; install_github_cli() { exit 99; }; ensure_github_cli; printf reused`, 'bash', script]);
  assert.equal(result.stdout, 'reused');
});

test('GitHub login interrupted after authorization is reused on rerun without another browser flow', {
  skip: process.platform !== 'darwin',
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ccgc-gh-login-'));
  const harness = `source "$1"
ensure_github_cli() { return 0; }
github_cli_path() { printf gh; }
github_cli() {
  case "$1 $2" in
    'auth token') [ -f "$HOME/signed-in" ] || return 1; printf gho_synthetic_github_token_12345 ;;
    'auth login') printf login >> "$HOME/logins"; : > "$HOME/signed-in"; return 130 ;;
    'api --hostname') printf employee ;;
    *) return 1 ;;
  esac
}
ensure_github_cli_login employee
`;
  try {
    await assert.rejects(exec('/bin/bash', ['-c', harness, 'bash', script], { env: { ...process.env, HOME: directory } }),
      error => /rerun the same setup file/.test(String((error as { stderr?: string }).stderr)));
    const result = await exec('/bin/bash', ['-c', harness, 'bash', script], { env: { ...process.env, HOME: directory } });
    assert.equal(result.stdout, '');
    assert.equal(await readFile(join(directory, 'logins'), 'utf8'), 'login');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
