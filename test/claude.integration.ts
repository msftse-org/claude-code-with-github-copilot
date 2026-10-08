import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGateway } from '../src/gateway.ts';
import { CLAUDE_VERSION, clientVersion, inspectSettings, runClaude } from '../src/claude.ts';
import type { ClaudeOptions } from '../src/claude.ts';
import { object, parseJson } from '../src/protocol.ts';
import type { ObjectValue } from '../src/protocol.ts';
import { model, stream } from './fixtures.ts';

async function checkedRun(options: ClaudeOptions, errors: string[]) {
  try { return await runClaude({ ...options, signal: AbortSignal.timeout(15000) }); }
  catch (error) { throw new Error(`${error instanceof Error ? error.message : 'Client failed'}; gateway errors: ${errors.join('; ')}`); }
}

async function fixture() {
  assert.equal(await clientVersion(), CLAUDE_VERSION, 'Integration test requires the exact client profile.');
  const directory = await mkdtemp(join(tmpdir(), 'ccgc-client-'));
  const home = join(directory, 'home');
  const project = join(directory, 'project');
  await mkdir(home);
  await mkdir(join(project, '.claude'), { recursive: true });
  await writeFile(join(project, 'CLAUDE.md'), 'REPOSITORY_INSTRUCTION_CANARY_DO_NOT_SEND');
  await writeFile(join(project, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'touch hook-ran' }] }] } }));
  await inspectSettings(project, home);
  return { directory, project, environment: { ...process.env, HOME: home } };
}

test('actual Claude CLI routes a context-isolated probe through the local Messages gateway', { timeout: 90000 }, async () => {
  const files = await fixture();
  const calls: ObjectValue[] = [];
  const errors: string[] = [];
  const gateway = await startGateway({ model, onError: error => errors.push(`${error.code}: ${error.message}`), backend: { async send(body) {
    calls.push(body);
    return stream([{ type: 'text', text: 'CCGC_READY' }]);
  } } });
  try {
    const result = await checkedRun({
      ...files, url: gateway.url, token: gateway.token, model, prompt: 'Reply exactly CCGC_READY.',
      probe: true, capture: true, signal: AbortSignal.timeout(60000),
    }, errors);
    assert.equal(result.code, 0, `Client failed: ${result.stdout}\n${result.stderr}`);
    assert.equal(parseJson(result.stdout).result, 'CCGC_READY');
    assert.equal(calls.length, 1);
    assert.doesNotMatch(JSON.stringify(calls), /REPOSITORY_INSTRUCTION_CANARY_DO_NOT_SEND|touch hook-ran/);
    await assert.rejects(access(join(files.project, 'hook-ran')));
  } finally { await gateway.close(); await rm(files.directory, { recursive: true }); }
});

test('actual Claude CLI executes Read, approved Edit and approved Bash then returns their results', { timeout: 90000 }, async () => {
  const files = await fixture();
  const source = join(files.project, 'fixture.txt');
  await writeFile(source, 'before\n');
  await writeFile(join(files.project, 'fixture.test.mjs'), "import assert from 'node:assert/strict'; import {readFileSync,writeFileSync} from 'node:fs'; assert.equal(readFileSync('fixture.txt','utf8'),'after\\n'); writeFileSync('test-ran','yes');\n");
  const calls: ObjectValue[] = [];
  const errors: string[] = [];
  const steps = [
    { type: 'tool_use', id: 'read-fixture', name: 'Read', input: { file_path: source } },
    { type: 'tool_use', id: 'edit-fixture', name: 'Edit', input: { file_path: source, old_string: 'before', new_string: 'after' } },
    { type: 'tool_use', id: 'test-fixture', name: 'Bash', input: { command: 'node --test fixture.test.mjs', description: 'Run the synthetic fixture test' } },
  ];
  const gateway = await startGateway({ model, onError: error => errors.push(`${error.code}: ${error.message}`), backend: { async send(body) {
    calls.push(structuredClone(body));
    const step = steps[calls.length - 1];
    return step ? stream([step], 'tool_use', `msg_fixture_${calls.length}`) : stream([{ type: 'text', text: 'WORKFLOW_OK' }], 'end_turn', `msg_fixture_${calls.length}`);
  } } });
  try {
    const result = await checkedRun({
      ...files, url: gateway.url, token: gateway.token, model, prompt: 'Read fixture.txt, replace before with after, and run node --test fixture.test.mjs.',
      capture: true, allowedTools: ['Read', 'Edit', 'Bash'], signal: AbortSignal.timeout(60000),
    }, errors);
    assert.equal(result.code, 0, `Client failed: ${result.stdout}\n${result.stderr}`);
    assert.equal(parseJson(result.stdout).result, 'WORKFLOW_OK');
    assert.equal(calls.length, 4);
    assert.equal(await readFile(source, 'utf8'), 'after\n');
    assert.equal(await readFile(join(files.project, 'test-ran'), 'utf8'), 'yes');
    for (const call of calls.slice(1)) {
      const messages = call.messages;
      assert.ok(Array.isArray(messages));
      const content = object(messages.at(-1)).content;
      assert.ok(Array.isArray(content));
      assert.ok(content.some(block => object(block).type === 'tool_result'));
      assert.ok(!content.some(block => object(block).is_error === true));
    }
  } finally { await gateway.close(); await rm(files.directory, { recursive: true }); }
});

test('actual Claude CLI reports denied edit and shell calls without executing them', { timeout: 90000 }, async () => {
  const files = await fixture();
  const source = join(files.project, 'denied.txt');
  await writeFile(source, 'untouched\n');
  const calls: ObjectValue[] = [];
  const errors: string[] = [];
  const steps = [
    { type: 'tool_use', id: 'read-before-denial', name: 'Read', input: { file_path: source } },
    { type: 'tool_use', id: 'denied-edit', name: 'Edit', input: { file_path: source, old_string: 'untouched', new_string: 'changed' } },
    { type: 'tool_use', id: 'denied-shell', name: 'Bash', input: { command: 'touch must-not-exist', description: 'A command that must be denied' } },
  ];
  const gateway = await startGateway({ model, onError: error => errors.push(`${error.code}: ${error.message}`), backend: { async send(body) {
    calls.push(structuredClone(body));
    const step = steps[calls.length - 1];
    return step ? stream([step], 'tool_use', `msg_fixture_${calls.length}`) : stream([{ type: 'text', text: 'DENIAL_OK' }], 'end_turn', `msg_fixture_${calls.length}`);
  } } });
  try {
    const result = await checkedRun({
      ...files, url: gateway.url, token: gateway.token, model, prompt: 'This is a denied-tools fixture. Do not grant additional tool permissions.',
      capture: true, signal: AbortSignal.timeout(60000),
    }, errors);
    assert.equal(result.code, 0, `Client failed: ${result.stdout}\n${result.stderr}`);
    assert.equal(parseJson(result.stdout).result, 'DENIAL_OK');
    assert.equal(await readFile(source, 'utf8'), 'untouched\n');
    await assert.rejects(access(join(files.project, 'must-not-exist')));
    assert.equal(calls.length, 4);
    for (const call of calls.slice(2)) {
      assert.ok(Array.isArray(call.messages));
      const content = object(call.messages.at(-1)).content;
      assert.match(JSON.stringify(content), /"is_error":true/);
      assert.match(JSON.stringify(content), /permission|denied|requested permissions/i);
    }
  } finally { await gateway.close(); await rm(files.directory, { recursive: true }); }
});

test('cancelling the actual Claude CLI stops its active synthetic shell tool', { timeout: 20000 }, async () => {
  const files = await fixture();
  await writeFile(join(files.project, 'long.mjs'), "import {writeFileSync} from 'node:fs'; writeFileSync('child.pid',String(process.pid)); setInterval(()=>{},1000);\n");
  const controller = new AbortController();
  const gateway = await startGateway({ model, backend: { async send() {
    return stream([{ type: 'tool_use', id: 'long-shell', name: 'Bash', input: { command: 'node long.mjs', description: 'Run a cancellable synthetic command', timeout: 120000 } }], 'tool_use');
  } } });
  let toolPid: number | undefined;
  const work = runClaude({
    ...files, url: gateway.url, token: gateway.token, model, prompt: 'Run the synthetic long.mjs command.',
    capture: true, allowedTools: ['Bash'], signal: controller.signal,
  });
  const stopped = assert.rejects(work, /cancelled/);
  try {
    for (let i = 0; i < 100 && toolPid === undefined; i++) {
      try { toolPid = Number(await readFile(join(files.project, 'child.pid'), 'utf8')); }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    assert.ok(toolPid && Number.isSafeInteger(toolPid), 'Synthetic shell tool did not start.');
    controller.abort();
    await stopped;
    for (let i = 0; i < 50; i++) {
      try { process.kill(toolPid, 0); }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return;
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail('Claude Code left its synthetic shell child running after cancellation.');
  } finally {
    controller.abort();
    if (toolPid) {
      try { process.kill(toolPid, 'SIGKILL'); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
    }
    await stopped;
    await gateway.close();
    await rm(files.directory, { recursive: true });
  }
});
