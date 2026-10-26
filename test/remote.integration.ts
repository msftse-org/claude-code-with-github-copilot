import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createTLS, request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { startRemoteServer } from '../src/remote-server.ts';
import { Keychain, RemoteClient, configure } from '../src/remote-client.ts';
import { profileKey, REMOTE_CLAUDE_VERSION as CLAUDE_VERSION } from '../src/remote.ts';
import { clientVersion, supportedClaudeVersion } from '../src/claude.ts';
import { switchingSmoke } from '../src/deployment-smoke.ts';
import { object, parseJson } from '../src/protocol.ts';
import type { ObjectValue } from '../src/protocol.ts';
import { message, model as fixtureModel, stream } from './fixtures.ts';

const exec = promisify(execFile);

const catalog = [
  ['claude-sonnet-5.5', 'Claude Sonnet 5.5'], ['claude-opus-5.5', 'Claude Opus 5.5'],
  ['claude-opus-5', 'Claude Opus 5'], ['claude-opus-4.8', 'Claude Opus 4.8'],
  ['claude-sonnet-5', 'Claude Sonnet 5'], ['claude-haiku-4.5', 'Claude Haiku 4.5'],
].map(([id, name]) => ({ ...fixtureModel, id: id!, name: name!, context: id!.includes('haiku') ? 200000 : 1000000, responseIds: [id!] }));

for (const model of catalog) test(`ordinary configured Claude uses HTTPS and the real Keychain helper (${model.id})`, { timeout: 120000 }, async () => {
  assert.equal(supportedClaudeVersion(await clientVersion(), CLAUDE_VERSION), true);
  const directory = await mkdtemp(join(tmpdir(), 'ccgc-configured-client-'));
  const home = join(directory, 'home');
  const project = join(directory, 'project');
  await mkdir(home);
  await mkdir(join(home, '.claude'));
  await writeFile(join(home, '.claude', 'CLAUDE.md'), 'SYNTHETIC_USER_CANARY_ONLY_AFTER_ADMISSION');
  await mkdir(join(project, '.claude'), { recursive: true });
  await writeFile(join(project, 'CLAUDE.md'), 'SYNTHETIC_REPO_CANARY_ONLY_AFTER_ADMISSION');
  await writeFile(join(project, '.claude', 'settings.json'), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'touch hook-did-run' }] }] },
  }));
  const source = join(project, 'fixture.txt');
  await writeFile(source, 'before\n');
  const ca = join(directory, 'ca.pem');
  const key = join(directory, 'tls.key');
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes',
    '-keyout', key, '-out', ca, '-days', '1', '-subj', '/CN=ccgc-synthetic-test',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE']);
  const calls: ObjectValue[] = [];
  const diagnostics: string[] = [];
  let remote: Awaited<ReturnType<typeof startRemoteServer>> | undefined;
  const tls = createTLS({ key: await readFile(key), cert: await readFile(ca) }, (incoming, outgoing) => {
    if (!remote) { outgoing.writeHead(503); outgoing.end(); return; }
    if (incoming.method === 'POST' && incoming.url?.split('?')[0] === '/fixture/v1/messages') {
      const chunks: Buffer[] = [];
      incoming.on('data', data => chunks.push(Buffer.from(data)));
      incoming.on('end', () => {
        const payload = parseJson(Buffer.concat(chunks).toString('utf8'));
        diagnostics.push(JSON.stringify({
          roles: Array.isArray(payload.messages) ? payload.messages.map(value => object(value).role) : undefined,
          systemMessages: Array.isArray(payload.messages) ? payload.messages.map(object).filter(value => value.role === 'system').map(value => ({
            fields: Object.keys(value), clearAt: value.clear_at,
            blocks: Array.isArray(value.content) ? value.content.map(block => object(block).type) : typeof value.content,
          })) : undefined,
          thinking: payload.thinking, output_config: payload.output_config,
        }));
      });
    }
    const proxy = httpRequest({ host: '127.0.0.1', port: remote.port, path: incoming.url, method: incoming.method, headers: incoming.headers }, response => {
      diagnostics.push(`${incoming.method} ${incoming.url} ${response.statusCode}`);
      if ((response.statusCode ?? 0) >= 400) response.on('data', data => diagnostics.push(String(data)));
      outgoing.writeHead(response.statusCode!, response.headers);
      response.pipe(outgoing);
    });
    proxy.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
    outgoing.on('close', () => { if (!outgoing.writableFinished) proxy.destroy(); });
    incoming.pipe(proxy);
  });
  tls.on('tlsClientError', error => diagnostics.push(`TLS: ${error.message}`));
  await new Promise<void>(resolve => tls.listen(0, '127.0.0.1', resolve));
  const address = tls.address();
  assert.ok(address && typeof address !== 'string');
  const gateway = `https://127.0.0.1:${address.port}/fixture`;
  const rootCert = await readFile(ca);
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
    return new Promise<Response>((resolve, reject) => {
      const outgoing = httpsRequest(request.url, {
        method: request.method, ca: rootCert, headers: Object.fromEntries(request.headers), signal: request.signal,
      }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode })));
      });
      outgoing.on('error', reject); outgoing.end(body);
    });
  };
  const secrets = new Keychain();
  const owner = randomBytes(32).toString('hex');
  let revoked = false;
  let savedKey = false;
  let codingTurn = 0;
  let switching = false;
  let switchingTurn = 0;
  let feature: 'memory-write' | 'memory-read' | undefined;
  let featureTurn = 0;
  let memoryPath = '';
  const selected: string[] = [];
  const environment = { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR, NODE_EXTRA_CA_CERTS: ca };
  try {
    remote = await startRemoteServer({
      publicUrl: gateway, ownerKey: owner,
      verify: async () => ({ login: 'synthetic-account', accountId: 42, model, models: catalog, maxTurns: 50 }),
      ownerIsRevoked: async () => revoked, revokeOwner: async () => { revoked = true; },
      backend: { async send(body) {
        calls.push(structuredClone(body));
        if (body.max_tokens === 128 && Array.isArray(body.tools) && body.tools.length === 0) {
          return stream([{ type: 'text', text: 'CCGC_READY' }], 'end_turn', `msg_probe_${calls.length}`, model.id);
        }
        if (body.max_tokens === 1) return Response.json({ ...message(), model: body.model, stop_reason: 'max_tokens' });
        const selectedModel = catalog.find(model => model.id === body.model)!;
        const identities = JSON.stringify(body).match(/You are powered by the model named [^"\\]+/g);
        assert.ok(identities?.at(-1)?.startsWith(`You are powered by the model named ${selectedModel.name.replace('Claude ', '')}.`), JSON.stringify(identities));
        if (feature === 'memory-write') {
          if (featureTurn++ === 0) {
            return stream([{ type: 'tool_use', id: 'memory-write', name: 'Write', input: {
              file_path: memoryPath, content: '# Project memory\n\nCCGC_AUTO_MEMORY_RELOAD_OK\n',
            } }], 'tool_use', 'msg_memory_write', String(body.model));
          }
          return stream([{ type: 'text', text: 'MEMORY_WRITE_OK' }], 'end_turn', 'msg_memory_written', String(body.model));
        }
        if (feature === 'memory-read') {
          assert.match(JSON.stringify(body), /CCGC_AUTO_MEMORY_RELOAD_OK/);
          featureTurn++;
          return stream([{ type: 'text', text: 'MEMORY_RELOAD_OK' }], 'end_turn', 'msg_memory_reload', String(body.model));
        }
        if (switching) {
          const index = selected.length;
          const workingDirectory = /Primary working directory: ([^\\"]+)/.exec(JSON.stringify(body))?.[1];
          assert.ok(workingDirectory, 'Synthetic client context must identify its isolated working directory.');
          const path = join(workingDirectory, `fixture-${index}.txt`);
          const steps = [
            { type: 'tool_use', id: `switch-read-${index}`, name: 'Read', input: { file_path: path } },
            { type: 'tool_use', id: `switch-edit-${index}`, name: 'Edit', input: { file_path: path, old_string: 'alpha', new_string: 'beta' } },
            { type: 'tool_use', id: `switch-bash-${index}`, name: 'Bash', input: { command: `test "$(cat fixture-${index}.txt)" = beta`, description: 'Verify the synthetic model-switch edit' } },
          ];
          const step = steps[switchingTurn++ % 4];
          if (step) return stream([step], 'tool_use', `msg_switch_${switchingTurn}`, String(body.model));
          selected.push(String(body.model));
          return stream([{ type: 'text', text: 'CCGC_SMOKE_OK' }], 'end_turn', `msg_switch_${switchingTurn}`, String(body.model));
        }
        const steps = [
          { type: 'tool_use', id: 'configured-read', name: 'Read', input: { file_path: source } },
          { type: 'tool_use', id: 'configured-edit', name: 'Edit', input: { file_path: source, old_string: 'before', new_string: 'after' } },
          { type: 'tool_use', id: 'configured-shell', name: 'Bash', input: { command: 'test "$(cat fixture.txt)" = after && printf passed > test-ran', description: 'Check the synthetic edit' } },
        ];
        const step = steps[codingTurn++];
        return step ? stream([step], 'tool_use', `msg_coding_${codingTurn}`, model.id)
          : stream([{ type: 'text', text: 'CONFIGURED_WORKFLOW_OK' }], 'end_turn', `msg_coding_${codingTurn}`, model.id);
      } },
    });
    assert.equal((await fetcher(`${gateway}/healthz`)).status, 200);
    const client = new RemoteClient(home, secrets, fetcher);
    const profile = await client.login(gateway, owner);
    savedKey = true;
    await configure(profile, project, true, home, join(directory, 'no-managed-settings'));
    try { await client.probe(project, environment, join(directory, 'no-managed-settings')); }
    catch (error) { throw new Error(`${String(error)}; synthetic ingress: ${diagnostics.join('; ')}; upstream calls: ${calls.length}`); }
    assert.equal(calls.length, 1);
    if (model.id === 'claude-sonnet-5.5') assert.deepEqual(calls[0]?.output_config, { effort: 'medium' });
    assert.doesNotMatch(JSON.stringify(calls), /SYNTHETIC_(REPO|USER)_CANARY_ONLY_AFTER_ADMISSION|hook-did-run/);
    const result = await exec('claude', [
      '--print', 'Read fixture.txt, replace before with after, and check the edit with Bash.',
      '--output-format', 'json', '--no-session-persistence', '--allowedTools', 'Read,Edit,Bash',
    ], { cwd: project, env: environment, timeout: 45000, maxBuffer: 1024 * 1024 }).catch(error => {
      throw new Error(`${String(error)}; synthetic ingress: ${diagnostics.join('; ')}`, { cause: error });
    });
    assert.equal(parseJson(result.stdout).result, 'CONFIGURED_WORKFLOW_OK', result.stdout);
    if (model.id === 'claude-sonnet-5.5') {
      const names = (calls[1]?.tools as ObjectValue[]).map(tool => String(object(tool).name));
      for (const name of ['Read', 'Edit', 'Bash']) {
        assert.ok(names.includes(name), `Claude Code ${await clientVersion()} did not expose ${name}.`);
      }
      assert.ok(!names.includes('Advisor'), `Claude Code ${await clientVersion()} unexpectedly exposed Advisor.`);
    }
    assert.equal(await readFile(source, 'utf8'), 'after\n');
    assert.equal(await readFile(join(project, 'test-ran'), 'utf8'), 'passed');
    await access(join(project, 'hook-did-run'));
    assert.equal(codingTurn, 4);
    assert.equal(calls.length, 5);
    for (const body of calls.slice(2)) {
      assert.ok(Array.isArray(body.messages));
      assert.match(JSON.stringify(object(body.messages.findLast(value => object(value).role === 'user')).content), /tool_result/);
    }
    assert.ok(diagnostics.includes('GET /fixture/v1/models?limit=1000 200'), diagnostics.join('; '));
    if (model.id === 'claude-sonnet-5.5') {
      await client.close();
      await client.probe(project, environment, join(directory, 'no-managed-settings'));
      const projectHomes = await readdir(join(home, '.claude', 'projects'), { withFileTypes: true });
      const projectHome = projectHomes.find(entry => entry.isDirectory());
      assert.ok(projectHome, 'Claude Code did not create its per-project state directory.');
      memoryPath = join(home, '.claude', 'projects', projectHome.name, 'memory', 'MEMORY.md');
      feature = 'memory-write';
      featureTurn = 0;
      const memoryWrite = await exec('claude', [
        '--print', 'Persist the synthetic project memory marker.',
        '--output-format', 'json', '--no-session-persistence', '--allowedTools', 'Write',
      ], { cwd: project, env: environment, timeout: 45000, maxBuffer: 1024 * 1024 });
      assert.equal(parseJson(memoryWrite.stdout).result, 'MEMORY_WRITE_OK');
      assert.match(await readFile(memoryPath, 'utf8'), /CCGC_AUTO_MEMORY_RELOAD_OK/);
      feature = undefined;
      await client.close();
      await client.probe(project, environment, join(directory, 'no-managed-settings'));
      feature = 'memory-read';
      featureTurn = 0;
      const memoryRead = await exec('claude', [
        '--print', 'Confirm the project memory loaded.',
        '--output-format', 'json', '--no-session-persistence',
      ], { cwd: project, env: environment, timeout: 45000, maxBuffer: 1024 * 1024 });
      assert.equal(parseJson(memoryRead.stdout).result, 'MEMORY_RELOAD_OK');
      assert.equal(featureTurn, 1);
      feature = undefined;
      await client.close();
      await client.probe(project, environment, join(directory, 'no-managed-settings'));
      switching = true;
      const results = await switchingSmoke(catalog, project, environment, 45000, {
        gateway,
        token: () => client.token(),
        renew: async () => {
          await client.close();
          await client.probe(project, environment, join(directory, 'no-managed-settings'));
        },
      });
      assert.equal(results.length, catalog.length + 1);
      assert.deepEqual(selected, [...catalog.map(model => model.id), model.id]);
      const command = fileURLToPath(new URL('../src/deployment-smoke.ts', import.meta.url));
      await assert.rejects(exec(process.execPath, [command, '--accept-unofficial'], { cwd: project, env: environment }), /CONTEXT_CONFLICT/);
      await client.close();
      selected.length = 0;
      switchingTurn = 0;
      const proof = await exec(process.execPath, [command, '--accept-unofficial'], { cwd: project, env: environment, timeout: 60000 });
      const report = parseJson(proof.stdout);
      assert.equal(report.status, 'passed');
      assert.equal(report.diagnosticAdmission, 'closed');
      assert.equal(report.userAdmission, 'ready; fifteen-minute idle lease');
      assert.deepEqual(selected, [...catalog.map(model => model.id), model.id]);
      const admission = await exec(process.execPath, [command, '--accept-unofficial', '--admit-only'], { cwd: project, env: environment });
      assert.equal(parseJson(admission.stdout).status, 'existing-admission-preserved');
    }
    assert.doesNotMatch(await readFile(client.statePath, 'utf8'), new RegExp(owner));
    await client.logout();
    savedKey = false;
    assert.equal(revoked, true);
  } finally {
    if (savedKey) await secrets.remove(profileKey(gateway));
    await remote?.close();
    tls.closeAllConnections();
    await new Promise<void>((resolve, reject) => tls.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true });
  }
});
