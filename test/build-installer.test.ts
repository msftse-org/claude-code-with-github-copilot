import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { buildInstaller, parseOptions, stampGateway } from '../scripts/build-installer.mjs';

const exec = promisify(execFile);
const employeeScript = new URL('../scripts/ccgc-enterprise-macos.sh', import.meta.url);

test('setup file changes only the empty gateway line of the tracked employee script', async () => {
  const source = await readFile(employeeScript, 'utf8');
  const stamped = stampGateway(source, 'https://LiteLLM.Example:8443/');
  const original = source.split('\n');
  assert.deepEqual(stamped.split('\n').filter((line, index) => line !== original[index]),
    ["DEFAULT_GATEWAY='https://litellm.example:8443'"]);
  assert.equal(stampGateway(source.replaceAll('\n', '\r\n'), 'https://litellm.example').includes('\r'), false);
  assert.throws(() => stampGateway(stamped, 'https://other.example'), /exactly one empty DEFAULT_GATEWAY line/);

  const directory = await mkdtemp(join(tmpdir(), 'ccgc-installer-'));
  try {
    const file = join(directory, 'setup.command');
    await writeFile(file, stamped);
    await exec('/bin/bash', ['-n', file]);
    const { stdout } = await exec('/bin/bash', ['-c', 'source "$1"; printf %s "$DEFAULT_GATEWAY"', 'bash', file]);
    assert.equal(stdout, 'https://litellm.example:8443');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('setup file accepts only plain HTTPS origins because the URL becomes shell code', () => {
  for (const gateway of [
    'not a url', 'http://litellm.example', 'https://litellm.example/v1', 'https://user:secret@litellm.example',
    'https://litellm.example/?debug=1', "https://a'b.example", 'https://a$(id).example', 'https://a;b.example',
  ]) {
    assert.throws(() => stampGateway("DEFAULT_GATEWAY=''\n", gateway), /HTTPS origin/, gateway);
  }
});

test('setup file uses the deployed LITELLM_URL and is written privately with its checksum', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ccgc-installer-'));
  try {
    const commands: string[][] = [];
    let variable = 'https://litellm.example';
    const run = async (command: string, args: string[]) => {
      commands.push([command, ...args]);
      return args[0] === 'repo' ? 'example/repository' : variable;
    };
    const parsed = parseOptions(['--output', join(directory, 'nested', 'setup.command')]);
    assert.ok(!('help' in parsed));
    const installer = await buildInstaller(parsed, { run });
    assert.deepEqual(commands, [
      ['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
      ['gh', 'variable', 'get', 'LITELLM_URL', '--env', 'ccgc-admin', '--repo', 'example/repository'],
    ]);
    const content = await readFile(installer.path, 'utf8');
    assert.match(content, /^DEFAULT_GATEWAY='https:\/\/litellm\.example'$/m);
    assert.equal((await stat(installer.path)).mode & 0o777, 0o700);
    assert.equal(installer.sha256, createHash('sha256').update(content).digest('hex'));

    variable = 'https://litellm.example/$(id)';
    await assert.rejects(buildInstaller(parsed, { run }), /HTTPS origin/);
    assert.equal(await readFile(installer.path, 'utf8'), content);
    assert.deepEqual(await readdir(join(directory, 'nested')), ['setup.command']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
