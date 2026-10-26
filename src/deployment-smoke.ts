import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RemoteClient, configure } from './remote-client.ts';
import { clientModelId, REMOTE_PROFILE } from './remote.ts';
import { clientVersion, runClaude, supportedClaudeVersion } from './claude.ts';
import { BridgeError, object, parseJson, safeError } from './protocol.ts';
import type { Model, ObjectValue } from './protocol.ts';

async function inSessionSwitchingSmoke(models: Model[], project: string, environment: NodeJS.ProcessEnv, timeout: number) {
  const sequence = [...models, models[0]!];
  const terminalModelChecks = supportedClaudeVersion(await clientVersion(), '2.1.297');
  for (let index = 0; index < sequence.length; index++) await writeFile(join(project, `fixture-${index}.txt`), 'alpha\n');
  const results: { model: string; tools: string[] }[] = [];
  await new Promise<void>((resolve, reject) => {
    const child = spawn('claude', [
      '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-chrome',
      '--permission-mode', 'manual', '--tools', 'Read,Edit,Bash', '--allowedTools', 'Read,Edit,Bash',
      '--model', clientModelId(sequence[0]!),
    ], { cwd: project, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    let bytes = 0;
    let index = 0;
    let failure: Error | undefined;
    let force: NodeJS.Timeout | undefined;
    let pendingSwitch: string | undefined;
    let awaitingModelCheckResult = false;
    const tools = new Map<string, { name: string; completed: boolean }>();
    const fail = (message: string) => {
      failure ??= new BridgeError('LIVE_WORKFLOW_FAILED', message);
      child.kill('SIGTERM');
      force ??= setTimeout(() => child.kill('SIGKILL'), 5000);
      force.unref();
    };
    const timer = setTimeout(() => fail('Synthetic live model-switch workflow timed out; no inference retry.'), timeout);
    const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + '\n');
    const user = () => send({ type: 'user', message: { role: 'user', content:
      `Synthetic deployment check ${index}. Use Read on fixture-${index}.txt, then Edit to replace alpha with beta, ` +
      `then Bash to run exactly this command: \`test "$(cat fixture-${index}.txt)" = beta\`. ` +
      'Do not access any other files or network. After all three tools succeed, reply exactly CCGC_SMOKE_OK.',
    } });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdin.on('error', () => fail('Claude input stream closed before the workflow completed.'));
    child.stderr.on('data', data => {
      bytes += Buffer.byteLength(data);
      if (bytes > 4 * 1024 * 1024) fail('Synthetic client output exceeded the bounded capture limit.');
    });
    child.stdout.on('data', data => {
      bytes += Buffer.byteLength(data);
      if (bytes > 4 * 1024 * 1024) { fail('Synthetic client output exceeded the bounded capture limit.'); return; }
      buffer += String(data);
      let end: number;
      while (!failure && (end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const event = parseJson(line);
          if (event.type === 'assistant' || event.type === 'user') {
            const content = object(event.message).content;
            if (Array.isArray(content)) for (const item of content) {
              const block = object(item);
              if (block.type === 'tool_use') {
                if (typeof block.id !== 'string' || typeof block.name !== 'string' || !['Read', 'Edit', 'Bash'].includes(block.name)) {
                  fail('Unexpected tool in synthetic workflow.'); break;
                }
                tools.set(block.id, { name: block.name, completed: false });
              } else if (block.type === 'tool_result') {
                const tool = tools.get(String(block.tool_use_id));
                if (!tool || block.is_error === true) { fail('Missing or failed synthetic tool result.'); break; }
                tool.completed = true;
              }
            }
          } else if (event.type === 'result') {
            if (awaitingModelCheckResult && tools.size === 0) {
              awaitingModelCheckResult = false;
              if (event.is_error === true) {
                fail('Claude rejected an exact catalog model validation.');
                continue;
              }
              results.push({ model: sequence[index]!.id, tools: [] });
              index++;
              if (index === sequence.length) child.stdin.end();
              else {
                pendingSwitch = `switch-${index}`;
                send({ type: 'control_request', request_id: pendingSwitch,
                  request: { subtype: 'set_model', model: clientModelId(sequence[index]!) } });
              }
              continue;
            }
            const names = new Set([...tools.values()].filter(tool => tool.completed).map(tool => tool.name));
            if (event.is_error === true || typeof event.result !== 'string' || event.result.trim() !== 'CCGC_SMOKE_OK'
              || !['Read', 'Edit', 'Bash'].every(name => names.has(name)) || [...tools.values()].some(tool => !tool.completed)) {
              fail('Synthetic workflow did not complete Read, Edit and Bash successfully.'); continue;
            }
            results.push({ model: sequence[index]!.id, tools: [...names].sort() });
            tools.clear();
            index++;
            if (index === sequence.length) child.stdin.end();
            else {
              pendingSwitch = `switch-${index}`;
              send({ type: 'control_request', request_id: pendingSwitch,
                request: { subtype: 'set_model', model: clientModelId(sequence[index]!) } });
            }
          } else if (event.type === 'control_response') {
            const response = object(event.response);
            if (response.request_id !== pendingSwitch || response.subtype !== 'success') {
              fail(`Claude rejected the exact requested model switch (subtype=${String(response.subtype)}, request=${String(response.request_id)}).`); continue;
            }
            pendingSwitch = undefined;
            if (terminalModelChecks) awaitingModelCheckResult = true;
            else user();
          }
        } catch (error) {
          if (!(error instanceof Error)) { fail('Invalid synthetic client event.'); continue; }
          fail('Synthetic client returned an invalid event; no raw payload was logged.');
        }
      }
    });
    child.on('close', code => {
      clearTimeout(timer);
      clearTimeout(force);
      if (failure) reject(failure);
      else if (code !== 0 || results.length !== sequence.length) reject(new BridgeError('LIVE_WORKFLOW_FAILED', 'Client exited before completing the model-switch workflow.'));
      else resolve();
    });
    user();
  });
  for (let index = 0; index < sequence.length; index++) {
    if (await readFile(join(project, `fixture-${index}.txt`), 'utf8') !== 'beta\n') {
      throw new BridgeError('LIVE_WORKFLOW_FAILED', 'A synthetic file did not contain the verified edit.');
    }
  }
  return results;
}

interface SmokeCredentials {
  gateway: string;
  token(): Promise<string>;
  renew(): Promise<void>;
}

async function catalogWorkflowSmoke(
  models: Model[],
  project: string,
  environment: NodeJS.ProcessEnv,
  timeout: number,
  credentials: SmokeCredentials,
) {
  const sequence = [...models, models[0]!];
  const results: { model: string; tools: string[] }[] = [];
  for (let index = 0; index < sequence.length; index += 1) {
    if (index > 0) await credentials.renew();
    const current = sequence[index]!;
    const fixture = join(project, `fixture-${index}.txt`);
    const isolatedHome = join(project, `.ccgc-smoke-home-${index}`);
    await mkdir(isolatedHome);
    await writeFile(fixture, 'alpha\n');
    const result = await runClaude({
      url: credentials.gateway,
      token: await credentials.token(),
      model: { ...current, id: clientModelId(current) },
      project,
      prompt: `Use Read on fixture-${index}.txt, then Edit to replace alpha with beta, `
        + `then Bash to run exactly this command: \`test "$(cat fixture-${index}.txt)" = beta\`. `
        + 'Do not access any other files or network. After all three tools succeed, reply exactly CCGC_SMOKE_OK.',
      capture: true,
      permissionMode: 'manual',
      tools: ['Read', 'Edit', 'Bash'],
      allowedTools: ['Read', 'Edit', 'Bash'],
      environment: { ...environment, HOME: isolatedHome },
      signal: AbortSignal.timeout(timeout),
    });
    const outcome = result.stdout ? parseJson(result.stdout).result : undefined;
    if (result.code !== 0 || outcome !== 'CCGC_SMOKE_OK') {
      throw new BridgeError(
        'LIVE_WORKFLOW_FAILED',
        `Synthetic catalog workflow did not complete successfully (exit=${result.code}, expected outcome missing).`,
      );
    }
    if (await readFile(fixture, 'utf8') !== 'beta\n') {
      throw new BridgeError('LIVE_WORKFLOW_FAILED', 'A synthetic file did not contain the verified edit.');
    }
    results.push({ model: current.id, tools: ['Bash', 'Edit', 'Read'] });
  }
  return results;
}

export async function switchingSmoke(
  models: Model[],
  project: string,
  environment: NodeJS.ProcessEnv,
  timeout = 600_000,
  credentials?: SmokeCredentials,
) {
  if (supportedClaudeVersion(await clientVersion(), '2.1.297')) {
    if (!credentials) throw new BridgeError('INVALID_OPTIONS', 'Newer Claude clients require renewable smoke-test admissions.');
    return catalogWorkflowSmoke(models, project, environment, timeout, credentials);
  }
  return inSessionSwitchingSmoke(models, project, environment, timeout);
}

async function prepareAdmission(real: RemoteClient, preserveActive = false) {
  const profile = await real.load();
  if (profile.info.profile !== REMOTE_PROFILE) throw new BridgeError('VERSION_UNSUPPORTED', 'Upgrade the protected catalog before running the deployment smoke.');
  if (profile.grant) {
    let valid = true;
    try { await real.request(profile, 'token', { id: profile.grant.id }); }
    catch (error) {
      if (!(error instanceof BridgeError) || error.code !== 'ADMISSION_REQUIRED') throw error;
      valid = false;
    }
    if (valid) {
      if (preserveActive) return false;
      throw new BridgeError('CONTEXT_CONFLICT', 'Existing admission is active. Close it explicitly after finishing Claude; verification will not interrupt it.', 409);
    }
  }
  // This updates only an absent/expired grant; it never cancels a live user conversation.
  await real.close();
  return true;
}

export async function admitOnly() {
  const real = new RemoteClient();
  if (!await prepareAdmission(real, true)) return { status: 'existing-admission-preserved', inference: 'not-run' };
  await real.probe(process.cwd());
  await real.token();
  return { status: 'fresh-admission-ready', idleLeaseMinutes: 15 };
}

export async function deploymentSmoke() {
  const real = new RemoteClient();
  await prepareAdmission(real);
  const current = await real.load();
  const directory = await mkdtemp(join(tmpdir(), 'ccgc-deployment-smoke-'));
  const home = join(directory, 'home');
  const project = join(directory, 'project');
  await mkdir(home); await mkdir(project);
  const client = new RemoteClient(home);
  let admitted = false;
  const startedAt = new Date().toISOString();
  let report: ObjectValue;
  try {
    await client.save({ gateway: current.gateway, info: current.info });
    const environment = { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR, NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS };
    await configure(current, project, true, home);
    await client.probe(project, environment);
    admitted = true;
    const models = [current.info.model, ...current.info.models.filter(model => model.id !== current.info.model.id)];
    const workflows = await switchingSmoke(models, project, environment, 600_000, {
      gateway: current.gateway,
      token: () => client.token(),
      renew: async () => {
        await client.close();
        await client.probe(project, environment);
      },
    });
    const isolated = await client.load();
    const usage = await client.request(isolated, 'token', { id: isolated.grant!.id });
    report = { status: 'passed', startedAt, finishedAt: new Date().toISOString(), gateway: current.gateway,
      profile: current.info.profile, workflows, attempts: usage.attempts, maxTurns: usage.maxTurns,
      scope: 'isolated synthetic live Read/Edit/Bash plus exact catalog model validation and switch back; not production certification' };
  } finally {
    try { if (admitted) await client.close(); }
    finally { await rm(directory, { recursive: true }); }
  }
  // A separate empty probe supplies a clean foreground admission, not the diagnostic conversation.
  await real.probe(process.cwd());
  await real.token();
  return { ...report, diagnosticAdmission: 'closed', userAdmission: 'ready; fifteen-minute idle lease' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (!args.includes('--accept-unofficial') || args.some(arg => !['--accept-unofficial', '--admit-only'].includes(arg))) {
    console.error('Explicit --accept-unofficial required; this live synthetic check consumes Copilot allowance.');
    process.exitCode = 1;
  } else {
    console.error('Running isolated synthetic live inference across the approved catalog; no repository content is intended.');
    (args.includes('--admit-only') ? admitOnly() : deploymentSmoke()).then(report => console.log(JSON.stringify(report, null, 2))).catch(error => {
      const failure = safeError(error);
      console.error(`${failure.code}: ${failure.message}`);
      process.exitCode = 1;
    });
  }
}
