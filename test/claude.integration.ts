import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGateway } from '../src/gateway.ts';
import { CLAUDE_VERSION, childEnvironment, clientVersion, inspectSettings, runClaude } from '../src/claude.ts';
import { clientHistory } from '../src/remote.ts';
import type { ClaudeOptions } from '../src/claude.ts';
import { object, parseJson } from '../src/protocol.ts';
import type { ObjectValue } from '../src/protocol.ts';
import { model, stream } from './fixtures.ts';

async function checkedRun(options: ClaudeOptions, errors: string[]) {
  try { return await runClaude({ ...options, signal: options.signal ?? AbortSignal.timeout(15000) }); }
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
    assert.equal(result.code, 0, `Client failed: ${result.stdout}\n${result.stderr}\nGateway errors: ${errors.join('; ')}`);
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
    assert.equal(result.code, 0, `Client failed: ${result.stdout}\n${result.stderr}\nGateway errors: ${errors.join('; ')}`);
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

test('actual Claude CLI coordinates two isolated Agent branches', { timeout: 90000 }, async () => {
  const files = await fixture();
  const errors: string[] = [];
  const mainCalls: ObjectValue[] = [];
  const agentCalls: ObjectValue[] = [];
  const gateway = await startGateway({ model, onError: error => errors.push(`${error.code}: ${error.message}`), backend: { async send(body) {
    const hasToolResult = JSON.stringify(body.messages).includes('"tool_result"');
    if (mainCalls.length === 0) {
      mainCalls.push(structuredClone(body));
      return stream([
        { type: 'tool_use', id: 'agent-one', name: 'Agent', input: {
          description: 'First synthetic branch', prompt: 'Reply with one short success marker.',
          subagent_type: 'general-purpose', run_in_background: false,
        } },
        { type: 'tool_use', id: 'agent-two', name: 'Agent', input: {
          description: 'Second synthetic branch', prompt: 'Reply with one short success marker.',
          subagent_type: 'general-purpose', run_in_background: false,
        } },
      ], 'tool_use', 'msg_team_start');
    }
    if (!hasToolResult) {
      agentCalls.push(structuredClone(body));
      const marker = `AGENT_${agentCalls.length}_OK`;
      return stream([{ type: 'text', text: marker }], 'end_turn', `msg_agent_${agentCalls.length}`);
    }
    mainCalls.push(structuredClone(body));
    const content = object((body.messages as ObjectValue[]).at(-1)).content;
    assert.match(JSON.stringify(content), /AGENT_1_OK/);
    assert.match(JSON.stringify(content), /AGENT_2_OK/);
    return stream([{ type: 'text', text: 'AGENT_TEAM_OK' }], 'end_turn', 'msg_team_done');
  } } });
  try {
    const result = await checkedRun({
      ...files, url: gateway.url, token: gateway.token, model,
      prompt: 'Run both synthetic agents and combine their results.',
      capture: true, tools: ['Agent'], allowedTools: ['Agent'], signal: AbortSignal.timeout(60000),
    }, errors);
    assert.equal(result.code, 0, `Client failed: ${result.stdout}\n${result.stderr}\nGateway errors: ${errors.join('; ')}`);
    assert.equal(parseJson(result.stdout).result, 'AGENT_TEAM_OK');
    assert.equal(mainCalls.length, 2);
    assert.equal(agentCalls.length, 2);
  } finally { await gateway.close(); await rm(files.directory, { recursive: true }); }
});

test('actual Claude CLI creates, lists, and deletes an in-memory Cron job', { timeout: 90000 }, async () => {
  const files = await fixture();
  const errors: string[] = [];
  const calls: ObjectValue[] = [];
  let cronId = '';
  const gateway = await startGateway({ model, onError: error => errors.push(`${error.code}: ${error.message}`), backend: { async send(body) {
    calls.push(structuredClone(body));
    if (calls.length === 1) {
      return stream([{ type: 'tool_use', id: 'cron-create', name: 'CronCreate', input: {
        cron: '0 0 1 1 *', prompt: 'Synthetic schedule that must not fire.', recurring: false, durable: false,
      } }], 'tool_use', 'msg_cron_create');
    }
    const content = JSON.stringify(object((body.messages as ObjectValue[]).at(-1)).content);
    if (calls.length === 2) {
      cronId = /Scheduled [^"]* (?:task|job) ([0-9a-f]{6,})/i.exec(content)?.[1] ?? '';
      assert.ok(cronId, `CronCreate did not return a job ID: ${content}`);
      return stream([{ type: 'tool_use', id: 'cron-list', name: 'CronList', input: {} }], 'tool_use', 'msg_cron_list');
    }
    if (calls.length === 3) {
      assert.match(content, new RegExp(cronId));
      return stream([{ type: 'tool_use', id: 'cron-delete', name: 'CronDelete', input: { id: cronId } }], 'tool_use', 'msg_cron_delete');
    }
    assert.match(content, /cancelled|deleted|removed|success/i);
    return stream([{ type: 'text', text: 'CRON_LIFECYCLE_OK' }], 'end_turn', 'msg_cron_done');
  } } });
  try {
    const result = await checkedRun({
      ...files, url: gateway.url, token: gateway.token, model,
      prompt: 'Create, list, and delete the synthetic in-memory schedule.',
      capture: true, tools: ['CronCreate', 'CronList', 'CronDelete'],
      allowedTools: ['CronCreate', 'CronList', 'CronDelete'], signal: AbortSignal.timeout(60000),
    }, errors);
    assert.equal(result.code, 0, `Client failed: ${result.stdout}\n${result.stderr}\nGateway errors: ${errors.join('; ')}`);
    assert.equal(parseJson(result.stdout).result, 'CRON_LIFECYCLE_OK');
    assert.equal(calls.length, 4);
  } finally { await gateway.close(); await rm(files.directory, { recursive: true }); }
});

test('actual Claude CLI reloads and deletes a durable Cron job after restart', { timeout: 90000 }, async () => {
  const files = await fixture();
  const errors: string[] = [];
  let cronId = '';
  const first = await startGateway({ model, onError: error => errors.push(`${error.code}: ${error.message}`), backend: { async send(body) {
    const content = JSON.stringify(body.messages);
    if (!content.includes('"tool_result"')) {
      return stream([{ type: 'tool_use', id: 'cron-durable-create', name: 'CronCreate', input: {
        cron: '0 0 1 1 *', prompt: 'Durable synthetic schedule.', recurring: true, durable: true,
      } }], 'tool_use', 'msg_cron_durable_create');
    }
    cronId = /Scheduled [^"]* (?:task|job) ([0-9a-f]{6,})/i.exec(content)?.[1] ?? '';
    assert.ok(cronId, `Durable CronCreate did not return a job ID: ${content}`);
    return stream([{ type: 'text', text: 'CRON_PERSISTED' }], 'end_turn', 'msg_cron_persisted');
  } } });
  try {
    const created = await checkedRun({
      ...files, url: first.url, token: first.token, model,
      prompt: 'Create the durable synthetic schedule.',
      capture: true, tools: ['CronCreate'], allowedTools: ['CronCreate'], signal: AbortSignal.timeout(60000),
    }, errors);
    assert.equal(created.code, 0, `Client failed: ${created.stdout}\n${created.stderr}\nGateway errors: ${errors.join('; ')}`);
    assert.equal(parseJson(created.stdout).result, 'CRON_PERSISTED');
  } finally { await first.close(); }
  const schedulePath = join(files.project, '.claude', 'scheduled_tasks.json');
  assert.match(await readFile(schedulePath, 'utf8'), new RegExp(cronId));
  let turn = 0;
  const second = await startGateway({ model, onError: error => errors.push(`${error.code}: ${error.message}`), backend: { async send(body) {
    const content = JSON.stringify(body.messages);
    if (turn++ === 0) return stream([{ type: 'tool_use', id: 'cron-durable-list', name: 'CronList', input: {} }], 'tool_use', 'msg_cron_durable_list');
    if (turn === 2) {
      assert.match(content, new RegExp(cronId));
      return stream([{ type: 'tool_use', id: 'cron-durable-delete', name: 'CronDelete', input: { id: cronId } }], 'tool_use', 'msg_cron_durable_delete');
    }
    assert.match(content, /cancelled|deleted|removed|success/i);
    return stream([{ type: 'text', text: 'CRON_RELOAD_OK' }], 'end_turn', 'msg_cron_reload_done');
  } } });
  try {
    const reloaded = await checkedRun({
      ...files, url: second.url, token: second.token, model,
      prompt: 'List and delete the durable synthetic schedule.',
      capture: true, tools: ['CronList', 'CronDelete'], allowedTools: ['CronList', 'CronDelete'],
      signal: AbortSignal.timeout(60000),
    }, errors);
    assert.equal(reloaded.code, 0, `Client failed: ${reloaded.stdout}\n${reloaded.stderr}\nGateway errors: ${errors.join('; ')}`);
    assert.equal(parseJson(reloaded.stdout).result, 'CRON_RELOAD_OK');
    assert.doesNotMatch(await readFile(schedulePath, 'utf8'), new RegExp(cronId));
  } finally { await second.close(); await rm(files.directory, { recursive: true }); }
});

test('actual Claude CLI fires a one-shot Cron job while the session remains active', { timeout: 120000 }, async () => {
  const files = await fixture();
  const errors: string[] = [];
  let fired = false;
  let child: ReturnType<typeof spawn> | undefined;
  let output = '';
  const gateway = await startGateway({ model, history: clientHistory,
    onError: error => errors.push(`${error.code}: ${error.message}`), backend: { async send(body) {
    const messages = body.messages as ObjectValue[];
    const last = object(messages.at(-1));
    const lastContent = JSON.stringify(last.content);
    if (last.role === 'user' && lastContent.includes('CCGC_SCHEDULED_FIRE') && !lastContent.includes('"tool_result"')) {
      fired = true;
      return stream([{ type: 'text', text: 'CRON_FIRE_OK' }], 'end_turn', 'msg_cron_fired');
    }
    if (lastContent.includes('Write the title in the predominant language of the session')) {
      return stream([{ type: 'text', text: 'Synthetic schedule' }], 'end_turn', 'msg_cron_title');
    }
    if (last.role === 'user' && lastContent.includes('Create the one-shot synthetic schedule.')) {
      return stream([{ type: 'tool_use', id: 'cron-fire-create', name: 'CronCreate', input: {
      cron: '* * * * *', prompt: 'CCGC_SCHEDULED_FIRE', recurring: false, durable: false,
    } }], 'tool_use', 'msg_cron_fire_create');
    }
    return stream([{ type: 'text', text: 'SCHEDULE_ARMED' }], 'end_turn', 'msg_cron_armed');
  } } });
  try {
    const trustedProject = await realpath(files.project);
    const configDirectory = join(files.directory, 'home', '.claude');
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(configDirectory, '.claude.json'), JSON.stringify({
      hasCompletedOnboarding: true,
      projects: { [trustedProject]: { hasTrustDialogAccepted: true } },
    }));
    const environment = childEnvironment(gateway.url, gateway.token, model, files.environment);
    environment.CLAUDE_CONFIG_DIR = configDirectory;
    const expectScript = `set timeout -1
spawn claude --safe-mode --permission-mode manual --disable-slash-commands --strict-mcp-config --mcp-config {{"mcpServers":{}}} --no-chrome --model ${model.id} --thinking disabled --tools CronCreate --allowedTools CronCreate
expect {manual mode on}
send -- {Create the one-shot synthetic schedule.\r}
expect eof`;
    child = spawn('/usr/bin/expect', ['-c', expectScript], {
      cwd: trustedProject, env: environment, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const collect = (chunk: Buffer) => {
      if (output.length < 1024 * 1024) output += chunk.toString('utf8');
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const deadline = Date.now() + 75000;
    while (!fired && errors.length === 0 && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(fired, true, `Scheduled prompt did not fire; gateway errors: ${errors.join('; ')}; client output: ${output}`);
  } finally {
    if (child?.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise<void>(resolve => child!.once('close', () => resolve())),
        new Promise<void>(resolve => setTimeout(() => {
          if (child?.exitCode === null) child.kill('SIGKILL');
          resolve();
        }, 5000)),
      ]);
    }
    await gateway.close();
    await rm(files.directory, { recursive: true });
  }
});

test('actual Claude CLI completes a real automatic compaction cycle', { timeout: 180000 }, async () => {
  const files = await fixture();
  const errors: string[] = [];
  const calls: ObjectValue[] = [];
  let round = 0;
  let compacted = false;
  const padding = 'compaction-fixture '.repeat(2600);
  const withUsage = async (response: Response, inputTokens: number, outputTokens: number) => new Response(
    (await response.text()).replace('"input_tokens":7', `"input_tokens":${inputTokens}`)
      .replace('"output_tokens":3', `"output_tokens":${outputTokens}`),
    { headers: { 'content-type': 'text/event-stream' } },
  );
  const gateway = await startGateway({ model, history: clientHistory, onError: error => errors.push(`${error.code}: ${error.message}`), backend: { async send(body) {
    calls.push(structuredClone(body));
    if (JSON.stringify(body.messages).includes('Your task is to create a detailed summary of the conversation so far')) {
      compacted = true;
      return withUsage(stream([{ type: 'text', text: 'CCGC_COMPACTION_SUMMARY' }], 'end_turn', 'msg_compact_summary'), 90000, 100);
    }
    if (compacted) return withUsage(stream([{ type: 'text', text: 'COMPACTION_OK' }], 'end_turn', 'msg_compact_done'), 8000, 3);
    round++;
    if (round <= 10) {
      return withUsage(stream([
        { type: 'text', text: `${padding}\nROUND_${round}` },
        { type: 'tool_use', id: `compact-bash-${round}`, name: 'Bash', input: {
          command: 'true', description: `Advance compaction round ${round}`,
        } },
      ], 'tool_use', `msg_compact_${round}`), Math.max(7, (round - 1) * 30000), 13000);
    }
    return withUsage(stream([{ type: 'text', text: 'COMPACTION_OK' }], 'end_turn', 'msg_compact_done'), 8000, 3);
  } } });
  try {
    const result = await checkedRun({
      ...files, url: gateway.url, token: gateway.token, model,
      prompt: 'Complete every synthetic compaction round.',
      capture: true, autocompact: '100k', tools: ['Bash'], allowedTools: ['Bash'],
      signal: AbortSignal.timeout(150000),
    }, errors);
    assert.equal(result.code, 0, `Client failed: ${result.stdout}\n${result.stderr}\nGateway errors: ${errors.join('; ')}`);
    assert.equal(parseJson(result.stdout).result, 'COMPACTION_OK');
    const messageCounts = calls.map(call => Array.isArray(call.messages) ? call.messages.length : 0);
    assert.ok(messageCounts.some((count, index) => index > 0 && count < messageCounts[index - 1]!), `Claude Code did not replace history during compaction: ${messageCounts.join(',')}`);
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
