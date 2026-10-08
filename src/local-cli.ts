#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { realpath } from 'node:fs/promises';
import { CopilotBackend, CredentialStore, STATE_DIR, installedPackageVersion } from './copilot.ts';
import { CLAUDE_VERSION, clientVersion, preflight, runClaude } from './claude.ts';
import { startGateway } from './gateway.ts';
import { BridgeError, parseJson, safeError } from './protocol.ts';

const help = `ccgc local - development-only Copilot model-access bridge

  ccgc local doctor [--client cli] [--project PATH]
  ccgc local login --accept-unofficial
  ccgc local logout
  ccgc local models --accept-unofficial
  ccgc local doctor --live --model ID --accept-unofficial
  ccgc local start --model ID --accept-unofficial [--project PATH]
  ccgc local start --model ID --accept-unofficial --print "your prompt"
  ccgc local version

Options: --client cli|app (only cli implemented), --max-upstream-turns N (50).
No Azure resources, copied IDE credentials, or separate Anthropic inference key.
Login/native inference use unofficial Copilot endpoints and community integration
headers. Confirm your account/organization permits this use before acknowledging.
Live probes and coding can consume your Copilot allowance and incur extra usage.
`;

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      client: { type: 'string', default: 'cli' },
      project: { type: 'string', default: process.cwd() },
      model: { type: 'string' },
      live: { type: 'boolean' },
      print: { type: 'string' },
      'accept-unofficial': { type: 'boolean' },
      'max-upstream-turns': { type: 'string', default: '50' },
    },
  });
  if (values.help || positionals.length === 0) { console.log(help); return; }
  const command = positionals[0];
  if (positionals.length !== 1 || !['doctor', 'login', 'logout', 'models', 'start', 'version'].includes(command ?? '')) {
    throw new BridgeError('INVALID_OPTIONS', 'Unknown command or extra arguments. Run ccgc local --help.');
  }
  if ((values.live && command !== 'doctor') || (values.print !== undefined && command !== 'start')
    || (values.model !== undefined && command !== 'start' && command !== 'doctor')
    || (values.print !== undefined && !values.print.trim())) {
    throw new BridgeError('INVALID_OPTIONS', 'This command does not accept the supplied options or an empty prompt.');
  }
  const limit = Number(values['max-upstream-turns']);
  if (!/^[1-9]\d*$/.test(values['max-upstream-turns']) || !Number.isSafeInteger(limit)) throw new BridgeError('INVALID_OPTIONS', 'max-upstream-turns must be a positive integer.');
  if (values.client !== 'cli') throw new BridgeError('CLIENT_UNSUPPORTED', 'App routing is documented upstream but not implemented/verified here.');
  if (command === 'version') {
    console.log(JSON.stringify({ ccgc: await installedPackageVersion(), node: process.version, claude: await clientVersion(), profile: `cli-${CLAUDE_VERSION}-safe-native-experimental` }, null, 2));
    return;
  }
  const store = new CredentialStore();
  if (command === 'logout') {
    await store.logout();
    console.log('Removed only ccgc credentials. Revoke the OAuth grant in GitHub settings to revoke it server-side.');
    return;
  }
  if (command === 'doctor' && !values.live) {
    const checks: Record<string, unknown> = { client: 'not-tested', authentication: 'not-tested', seatModelAccess: 'not-tested', app: 'not-tested', backend: 'unofficial-native-messages', credentialDirectory: STATE_DIR };
    try {
      await preflight(values.project, values.client);
      checks.client = `local profile available: ${CLAUDE_VERSION}`;
      const credential = await store.load();
      checks.authentication = `stored login for ${credential.login}; not validated online`;
    } catch (error) { const failure = safeError(error); checks.blocker = `${failure.code}: ${failure.message}`; }
    console.log(JSON.stringify(checks, null, 2));
    if (checks.blocker) process.exitCode = 1;
    return;
  }
  if (!values['accept-unofficial']) throw new BridgeError('ACCESS_UNVERIFIED', 'Read the access warning and pass --accept-unofficial only if you are authorized to use this integration.');
  console.error('Experimental unofficial Copilot access. No vendor support claim; live inference may consume AI credits.');
  const backend = new CopilotBackend(store);
  if (command === 'login') {
    const login = await backend.login((url, code) => console.log(`Open ${url} and enter ${code}.`));
    console.log(`Signed in as ${login}. Copilot token exchange succeeded; selected-model access still requires a live probe.`);
    return;
  }
  let project: string | undefined;
  if (command === 'start' || (command === 'doctor' && values.live)) {
    if (!values.model?.startsWith('claude-')) throw new BridgeError('MODEL_UNAVAILABLE', 'Supply an exact Claude model ID from ccgc local models.');
    project = await preflight(values.project, values.client);
  }
  const login = await backend.initialize();
  const models = await backend.models();
  if (command === 'models') {
    console.log(JSON.stringify({ login, entitlement: 'catalog candidates; live model request not yet verified', models }, null, 2));
    return;
  }
  const model = models.find(candidate => candidate.id === values.model);
  if (!model || !project) throw new BridgeError('MODEL_UNAVAILABLE', 'The exact Claude model is unavailable, disabled, or lacks required catalog capabilities.');
  if (model.context < 200000) throw new BridgeError('CONTEXT_UNSUPPORTED', 'This profile requires a catalog context limit of at least 200K.');
  const cancellation = new AbortController();
  const stop = () => cancellation.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const probe = await startGateway({ backend, model, maxTurns: limit });
    try {
      console.error(`Checking actual Claude Code routing for ${login} / ${model.id} with synthetic input only.`);
      const result = await runClaude({
        url: probe.url, token: probe.token, model, project, prompt: 'Reply exactly CCGC_READY.',
        probe: true, capture: true, signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(90_000)]),
      });
      if (result.code !== 0 || probe.stats.completed < 1 || parseJson(result.stdout).result !== 'CCGC_READY') {
        throw new BridgeError('ROUTE_PROBE_FAILED', 'The actual client did not complete the synthetic Copilot route probe. No repository-content session was started.');
      }
    } finally { await probe.close(); }
    console.error(`Seat-backed route probe passed for ${login} / ${model.id}.`);
    if (command === 'doctor') {
      console.log(JSON.stringify({ status: 'live-route-verified', login, model: model.id, usage: probe.stats }));
      return;
    }
    const remaining = limit - probe.stats.attempts;
    if (remaining <= 0) throw new BridgeError('LIMIT_REACHED', 'The probe consumed the launch turn limit; no coding session was started.');
    const gateway = await startGateway({ backend, model, maxTurns: remaining });
    try {
      console.error(`Starting CLI safe-mode: built-in local tools only; no custom instructions/hooks/MCP, agents, thinking, or resume. Local generation limit: ${limit}, including probe.`);
      const result = await runClaude({ url: gateway.url, token: gateway.token, model, project, prompt: values.print, signal: cancellation.signal });
      process.exitCode = result.code;
    } finally {
      await gateway.close();
      console.error(JSON.stringify({ probe: probe.stats, coding: gateway.stats, usageSource: 'upstream token fields, not an authoritative bill' }));
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  main().catch(error => {
    const failure = safeError(error);
    console.error(`${failure.code}: ${failure.message}`);
    process.exitCode = 1;
  });
}
