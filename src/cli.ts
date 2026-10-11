#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { main as localMain } from './local-cli.ts';
import { BridgeError, safeError } from './protocol.ts';
import { RemoteClient, configure, inspectRemoteSettings, requiredClientVersion, settingsPatch } from './remote-client.ts';
import { clientVersion } from './claude.ts';
import { REMOTE_CLAUDE_VERSION as CLAUDE_VERSION } from './remote.ts';
import { installedPackageVersion } from './copilot.ts';

const help = `ccgc - remote LiteLLM / Copilot configuration (experimental)

  ccgc login --gateway https://gateway.example --accept-unofficial < owner-key
  ccgc configure [--apply] [--reset-unavailable-model] [--project PATH]
  ccgc refresh --accept-unofficial  Approve same-account gateway catalog migration
  ccgc doctor [--remote | --live --accept-unofficial] [--project PATH]
  ccgc models
  ccgc token                 Credential helper; stdout contains only gateway token
  ccgc close                 Close the admitted session, retain gateway login
  ccgc logout                Revoke remote owner access; unlink Copilot separately
  ccgc version
  ccgc local --help          Retained local development harness

After configure --apply and a successful live probe, run ordinary claude.
No local inference listener or persistent launcher. One CLI session per admission.
CLI ${CLAUDE_VERSION} only; Desktop is not implemented. GitHub credentials stay
server-side; the operator-issued gateway renewal key is stored in macOS Keychain.
--apply is explicit consent to merge non-secret user-level Claude settings.
Live operations can consume Copilot allowance. --accept-unofficial is not permission.
`;

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] === 'local') return localMain(argv.slice(1));
  const { positionals, values } = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: {
      help: { type: 'boolean', short: 'h' }, gateway: { type: 'string' },
      apply: { type: 'boolean' }, remote: { type: 'boolean' }, live: { type: 'boolean' },
      project: { type: 'string' }, 'accept-unofficial': { type: 'boolean' },
      'reset-unavailable-model': { type: 'boolean' },
    },
  });
  if (values.help || !positionals.length) { console.log(help); return; }
  const command = positionals[0];
  const allowed: Record<string, string[]> = {
    login: ['gateway', 'accept-unofficial'], configure: ['apply', 'project', 'reset-unavailable-model'],
    doctor: ['remote', 'live', 'project', 'accept-unofficial'], refresh: ['accept-unofficial'], models: [], token: [], close: [], logout: [], version: [],
  };
  if (!command || positionals.length !== 1 || !allowed[command]
    || Object.keys(values).some(key => !allowed[command]?.includes(key))
    || (values.live && values.remote)) throw new BridgeError('INVALID_OPTIONS', 'Unknown command or incompatible options. Run ccgc --help.');
  if (command === 'version') {
    console.log(JSON.stringify({ ccgc: await installedPackageVersion(), claude: await clientVersion(), supported: CLAUDE_VERSION, mode: 'remote-litellm', liveCopilot: 'not-tested' }, null, 2));
    return;
  }
  const client = new RemoteClient();
  if (command === 'refresh') {
    if (!values['accept-unofficial']) throw new BridgeError('ACCESS_UNVERIFIED', 'Review the gateway catalog and supply --accept-unofficial to approve the same-account migration.');
    console.log(JSON.stringify({ status: 'catalog-approved', info: (await client.refresh()).info, next: 'Run ccgc configure --apply.' }, null, 2));
    return;
  }
  if (command === 'login') {
    if (!values.gateway || !values['accept-unofficial']) throw new BridgeError('ACCESS_UNVERIFIED', 'Supply --gateway and --accept-unofficial after confirming authorized use.');
    if (process.stdin.isTTY) throw new BridgeError('INVALID_OPTIONS', 'Supply the operator-issued gateway renewal key on stdin, not in arguments.');
    let input = '';
    for await (const chunk of process.stdin) {
      input += String(chunk);
      if (input.length > 256) throw new BridgeError('INVALID_OPTIONS', 'Gateway key input is too large.');
    }
    const profile = await client.login(values.gateway, input);
    console.log(JSON.stringify({ status: 'gateway-authenticated', gateway: profile.gateway, linkedAccount: profile.info.login, model: profile.info.model.id, liveAccess: 'not-tested' }, null, 2));
    return;
  }
  if (command === 'token') { console.log(await client.token()); return; }
  if (command === 'close') { await client.close(); console.log('Closed admission. Run an explicit live probe before another Claude session.'); return; }
  if (command === 'logout') {
    await client.logout();
    console.log('Remote owner access revoked and local Keychain credential removed. Claude settings remain; Copilot unlink/revocation is an operator action.');
    return;
  }
  if (command === 'models') { console.log(JSON.stringify(await client.info(), null, 2)); return; }
  const project = await realpath(values.project ?? process.cwd());
  if (command === 'configure') {
    const profile = await client.load();
    if (values['reset-unavailable-model'] && !values.apply) throw new BridgeError('INVALID_OPTIONS', '--reset-unavailable-model requires --apply.');
    const result = await configure(profile, project, values.apply ?? false, undefined, undefined, values['reset-unavailable-model'] ?? false);
    // Print only our patch, not unrelated settings that might contain user secrets.
    console.log(JSON.stringify({ path: result.path, applied: result.applied, patch: settingsPatch(profile), next: result.applied ? 'Run ccgc doctor --live --accept-unofficial, then claude.' : 'Use --apply to enable gateway model discovery, remove old gateway-owned pins, and disable hooks.' }, null, 2));
    return;
  }
  if (values.live) {
    if (!values['accept-unofficial']) throw new BridgeError('ACCESS_UNVERIFIED', 'Live inference requires --accept-unofficial and authorized use.');
    console.error('Running an actual-client synthetic probe; it may consume Copilot allowance. No repository content is intended.');
    const profile = await client.probe(project);
    console.log(JSON.stringify({ status: 'actual-client-route-verified', gateway: profile.gateway, account: profile.info.login, model: profile.info.model.id, admission: profile.grant, remainingLimitIncludesProbe: true }, null, 2));
    return;
  }
  const profile = await client.load();
  await inspectRemoteSettings(project, profile);
  const version = await clientVersion();
  const expected = requiredClientVersion(profile.info);
  if (version !== expected) throw new BridgeError('VERSION_UNSUPPORTED', `Expected Claude ${expected}; installed ${version}.`);
  console.log(JSON.stringify({
    client: version, gateway: profile.gateway, model: profile.info.model.id,
    metadata: values.remote ? await client.info() : 'cached; not checked online',
    liveAccess: 'not-tested-by-this-command', admission: profile.grant ?? 'required', localProxy: false,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  main().catch(error => { const failure = safeError(error); console.error(`${failure.code}: ${failure.message}`); process.exitCode = 1; });
}
