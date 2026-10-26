import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, rename, rm, unlink } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { BridgeError, object, parseJson, positive, text } from './protocol.ts';
import type { ObjectValue } from './protocol.ts';
import { childEnvironment, clientVersion, runClaude, supportedClaudeVersion } from './claude.ts';
import { clientModelId, credential, gatewayUrl, LEGACY_REMOTE_PROFILE, profileKey, PROBE_PROMPT, REMOTE_CLAUDE_VERSION, remoteInfo, remoteRequest, resolveModel } from './remote.ts';
import type { RemoteInfo } from './remote.ts';
import { readState, writePrivate } from './private-state.ts';

const exec = promisify(execFile);
export interface Secrets {
  get(id: string): Promise<string>;
  set(id: string, value: string): Promise<void>;
  remove(id: string): Promise<void>;
}

export class Keychain implements Secrets {
  private environment() {
    // Keychain belongs to the OS user, even when a client uses an isolated HOME.
    return { ...process.env, HOME: userInfo().homedir };
  }
  private service(id: string) {
    if (process.platform !== 'darwin') throw new BridgeError('CLIENT_UNSUPPORTED', 'This profile uses the macOS Keychain; other credential stores are not implemented.');
    if (!/^[a-f0-9]{64}$/.test(id)) throw new BridgeError('INVALID_OPTIONS', 'Invalid Keychain identifier.');
    return `ccgc.remote.${id}`;
  }
  async get(id: string) {
    try {
      const { stdout } = await exec('/usr/bin/security', ['find-generic-password', '-a', 'owner', '-s', this.service(id), '-w'], { timeout: 15000, env: this.environment() });
      return credential(stdout.trim());
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'Gateway renewal credential is unavailable in the macOS Keychain.', 401);
    }
  }
  async set(id: string, value: string) {
    const service = this.service(id);
    const token = credential(value);
    await new Promise<void>((resolve, reject) => {
      const child = spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'ignore'], env: this.environment() });
      const timer = setTimeout(() => child.kill('SIGTERM'), 15000);
      child.on('error', () => { clearTimeout(timer); reject(new BridgeError('KEYCHAIN_FAILED', 'Could not invoke macOS Keychain.')); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new BridgeError('KEYCHAIN_FAILED', 'Could not save gateway credential to macOS Keychain.'));
      });
      child.stdin.on('error', () => reject(new BridgeError('KEYCHAIN_FAILED', 'Keychain input failed.')));
      // Both interpolated values use a strict hex-only alphabet; no secret in process arguments.
      child.stdin.end(`add-generic-password -U -a owner -s ${service} -w ${token}\n`);
    });
    if (credential(await this.get(id)) !== token) throw new BridgeError('KEYCHAIN_FAILED', 'Keychain did not persist the supplied credential.');
  }
  async remove(id: string) {
    try { await exec('/usr/bin/security', ['delete-generic-password', '-a', 'owner', '-s', this.service(id)], { timeout: 15000, env: this.environment() }); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 44) return;
      throw new BridgeError('KEYCHAIN_FAILED', 'Gateway was revoked, but local Keychain removal failed; retry ccgc logout or remove the ccgc entry manually.');
    }
  }
}

export interface ClientProfile {
  gateway: string;
  info: RemoteInfo;
  grant?: { id: string; expires: number };
  revoked?: true;
}

function checkBinding(expected: RemoteInfo, current: RemoteInfo) {
  if (current.accountId !== expected.accountId || current.login !== expected.login
    || JSON.stringify(current.model) !== JSON.stringify(expected.model)
    || JSON.stringify(current.models) !== JSON.stringify(expected.models) || current.maxTurns !== expected.maxTurns) {
    throw new BridgeError('IDENTITY_CONFLICT', 'The linked account/model profile changed; operator review and explicit re-enrollment are required.', 403);
  }
}

export function requiredClientVersion(info: RemoteInfo) {
  return info.profile === LEGACY_REMOTE_PROFILE ? '2.1.220' : REMOTE_CLAUDE_VERSION;
}

async function requireSupportedClient(info: RemoteInfo) {
  const minimum = requiredClientVersion(info);
  const installed = await clientVersion();
  if (!supportedClaudeVersion(installed, minimum)) {
    throw new BridgeError('VERSION_UNSUPPORTED', `Remote client profile requires Claude Code ${minimum} or newer; installed ${installed}.`);
  }
}

export class RemoteClient {
  readonly statePath: string;
  readonly home: string;
  readonly secrets: Secrets;
  readonly fetcher: typeof fetch;
  constructor(home = homedir(), secrets: Secrets = new Keychain(), fetcher: typeof fetch = fetch) {
    this.home = home; this.secrets = secrets; this.fetcher = fetcher;
    this.statePath = join(home, '.local', 'share', 'ccgc', 'remote', 'profile.json');
  }
  async load(): Promise<ClientProfile> {
    const value = await readState(this.statePath);
    if (!value) throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'Run ccgc login --gateway URL --accept-unofficial with the operator-issued renewal key on stdin.', 401);
    const profile: ClientProfile = { gateway: gatewayUrl(text(value.gateway, 'gateway URL')), info: remoteInfo(object(value.info), true) };
    if (value.revoked === true) profile.revoked = true;
    if (value.grant !== undefined) {
      const grant = object(value.grant);
      profile.grant = { id: text(grant.id, 'admission ID'), expires: positive(grant.expires, 'admission expiry') };
    }
    return profile;
  }
  async save(profile: ClientProfile) {
    await writePrivate(this.statePath, { ...profile });
  }
  async request(profile: ClientProfile, path: string, body?: ObjectValue) {
    if (profile.revoked) throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'Gateway access was revoked; finish local cleanup with ccgc logout.', 401);
    return remoteRequest(profile.gateway, await this.secrets.get(profileKey(profile.gateway)), path, body, this.fetcher);
  }
  async login(url: string, supplied: string) {
    if (await readState(this.statePath)) throw new BridgeError('ROUTING_CONFLICT', 'A gateway profile already exists; logout before replacing it.');
    const gateway = gatewayUrl(url);
    const token = credential(supplied.trim());
    const info = remoteInfo(await remoteRequest(gateway, token, 'info', undefined, this.fetcher));
    await this.secrets.set(profileKey(gateway), token);
    const profile = { gateway, info };
    try { await this.save(profile); }
    catch (error) { await this.secrets.remove(profileKey(gateway)); throw error; }
    return profile;
  }
  async info() {
    const profile = await this.load();
    const current = remoteInfo(await this.request(profile, 'info'), profile.info.profile === LEGACY_REMOTE_PROFILE);
    checkBinding(profile.info, current);
    if (current.instance !== profile.info.instance) {
      throw new BridgeError('ADMISSION_REQUIRED', 'Remote instance/account/model changed. Close stale admission and explicitly reconnect to the deployment.', 409);
    }
    return current;
  }
  async refresh() {
    const profile = await this.load();
    const current = remoteInfo(await this.request(profile, 'info'));
    if (profile.grant && profile.grant.expires > Date.now() && profile.info.instance === current.instance) {
      throw new BridgeError('CONTEXT_CONFLICT', 'Close the active admission before approving a catalog change.', 409);
    }
    checkBinding({ ...profile.info, models: current.models }, current);
    delete profile.grant;
    profile.info = current;
    await this.save(profile);
    return profile;
  }
  async token() {
    const profile = await this.load();
    if (!profile.grant || profile.grant.expires <= Date.now()) throw new BridgeError('ADMISSION_REQUIRED', 'Run ccgc doctor --live --accept-unofficial before starting Claude.', 409);
    await requireSupportedClient(profile.info);
    await inspectRemoteSettings(process.cwd(), profile, this.home);
    return credential((await this.request(profile, 'token', { id: profile.grant.id })).token);
  }
  async close() {
    const profile = await this.load();
    if (profile.grant) {
      try { await this.request(profile, 'cancel', { id: profile.grant.id }); }
      catch (error) { if (!(error instanceof BridgeError && error.code === 'ADMISSION_REQUIRED')) throw error; }
    }
    delete profile.grant;
    const current = remoteInfo(await this.request(profile, 'info'), profile.info.profile === LEGACY_REMOTE_PROFILE);
    checkBinding(profile.info, current);
    profile.info = current;
    await this.save(profile);
  }
  async logout() {
    const profile = await this.load();
    if (!profile.revoked) {
      await this.request(profile, 'logout', {});
      profile.revoked = true;
      delete profile.grant;
      await this.save(profile);
    }
    await this.secrets.remove(profileKey(profile.gateway));
    await unlink(this.statePath);
  }
  async probe(project: string, environment?: NodeJS.ProcessEnv, managed?: string) {
    const profile = await this.load();
    await requireSupportedClient(profile.info);
    await inspectRemoteSettings(project, profile, this.home, managed, environment);
    await this.info();
    const isolated = await mkdtemp(join(tmpdir(), 'ccgc-probe-'));
    let id: string | undefined;
    try {
      const pending = await this.request(profile, 'probe', { profile: profile.info.profile, model: profile.info.model.id });
      id = text(pending.id, 'probe ID');
      const result = await runClaude({
        url: profile.gateway, token: credential(pending.token),
        model: { ...profile.info.model, id: profile.info.profile === LEGACY_REMOTE_PROFILE ? profile.info.model.id : clientModelId(profile.info.model) }, project: isolated,
        prompt: PROBE_PROMPT, probe: true, capture: true, signal: AbortSignal.timeout(90_000),
        environment: { ...(environment ?? process.env), HOME: isolated },
      });
      if (result.code !== 0 || parseJson(result.stdout).result !== 'CCGC_READY') throw new BridgeError('ROUTE_PROBE_FAILED', 'Actual Claude did not complete the isolated gateway probe.');
      const grant = await this.request(profile, 'admit', { probeId: id });
      profile.grant = { id: text(grant.id, 'admission ID'), expires: positive(grant.expires, 'admission expiry') };
      await this.save(profile);
      return profile;
    } catch (error) {
      try { if (id) await this.request(profile, 'cancel', { id: profile.grant?.id ?? id }); }
      catch (cleanup) {
        if (!(cleanup instanceof BridgeError && cleanup.code === 'ADMISSION_REQUIRED')) {
          throw new BridgeError('GATEWAY_UNAVAILABLE', 'Probe failed and remote cancellation could not be confirmed; admission remains bounded by server expiry.', 502);
        }
      }
      throw error;
    } finally { await rm(isolated, { recursive: true }); }
  }
}

const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
export function helperCommand() {
  return `${quote(process.execPath)} ${quote(fileURLToPath(new URL('./cli.ts', import.meta.url)))} token`;
}

export function settingsPatch(profile: ClientProfile): ObjectValue {
  const env = childEnvironment(profile.gateway, 'unused', profile.info.model, {});
  delete env.ANTHROPIC_AUTH_TOKEN;
  if (profile.info.profile !== LEGACY_REMOTE_PROFILE) {
    for (const key of legacyPins) delete env[key];
    env.ANTHROPIC_DEFAULT_MODEL = clientModelId(profile.info.model);
    env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = '1';
  }
  Object.assign(env, {
    CLAUDE_CODE_API_KEY_HELPER_TTL_MS: '60000',
    CLAUDE_CODE_AUTO_MODE_SERVER: '0',
  });
  return {
    env,
    apiKeyHelper: helperCommand(),
    permissions: { defaultMode: 'manual' },
  };
}

const legacyPins = ['ANTHROPIC_MODEL', ...['SONNET', 'OPUS', 'HAIKU', 'FABLE'].map(family => `ANTHROPIC_DEFAULT_${family}_MODEL`)];
const featurePins = [
  'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
  'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
  'CLAUDE_CODE_DISABLE_CRON',
  'CLAUDE_CODE_DISABLE_ADVISOR_TOOL',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING',
  'CLAUDE_CODE_DISABLE_1M_CONTEXT',
  'MAX_THINKING_TOKENS',
];

async function readSettings(path: string): Promise<ObjectValue> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024 || (process.getuid && stat.uid !== process.getuid())) throw new BridgeError('CONFIG_UNREADABLE', 'Settings must be a bounded regular file owned by you.');
      return parseJson(await file.readFile('utf8'));
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {};
    if (error instanceof BridgeError) throw error;
    throw new BridgeError('CONFIG_UNREADABLE', 'Settings cannot be safely inspected.');
  }
}

export async function inspectRemoteSettings(project: string, profile: ClientProfile, home = homedir(), managed = '/Library/Application Support/ClaudeCode/managed-settings.json', environment = process.env, migratePins = false, migrateUnavailableModel = false) {
  const expected = object(settingsPatch(profile).env);
  const controlsRouting = (key: string) => key in expected || /^(ANTHROPIC_|CLAUDE_CODE_(USE_|OAUTH|PROVIDER|API_KEY|CUSTOM|MODEL)|CLAUDE_CONFIG_DIR)/.test(key);
  for (const [key, value] of Object.entries(environment)) {
    if (value && controlsRouting(key) && expected[key] !== value) {
      throw new BridgeError('ROUTING_CONFLICT', 'Shell environment contains a conflicting provider, credential, or compatibility override; unset it explicitly.');
    }
  }
  for (const path of [join(home, '.claude', 'settings.json'), join(project, '.claude', 'settings.json'), join(project, '.claude', 'settings.local.json'), managed]) {
    const settings = await readSettings(path);
    const env = settings.env === undefined ? {} : object(settings.env);
    for (const [key, value] of Object.entries(env)) {
      if (migratePins && path === join(home, '.claude', 'settings.json') && settings.apiKeyHelper === helperCommand()
        && ((legacyPins.includes(key) && value === profile.info.model.id) || (featurePins.includes(key) && value === '1'))) continue;
      if (controlsRouting(key) && expected[key] !== value) {
        throw new BridgeError('ROUTING_CONFLICT', 'Settings contain a conflicting provider, model, or credential override; no settings were changed.');
      }
    }
    if (settings.model !== undefined && !['sonnet', 'opus', 'haiku', 'default'].includes(String(settings.model))) {
      try {
        resolveModel(profile.info.models, settings.model);
      } catch (error) {
        if (!(migrateUnavailableModel && path === join(home, '.claude', 'settings.json')
          && settings.apiKeyHelper === helperCommand())) throw error;
      }
    }
    if ((settings.apiKeyHelper !== undefined && settings.apiKeyHelper !== helperCommand())
      || ['forceLoginMethod', 'forceLoginOrgUUID', 'modelOverrides', 'allowedProviders'].some(key => settings[key] !== undefined)) {
      throw new BridgeError('ROUTING_CONFLICT', 'Unverified credential helper or managed provider setting; resolve it explicitly.');
    }
  }
}

export async function configure(profile: ClientProfile, project: string, apply: boolean, home = homedir(), managed?: string, resetUnavailableModel = false) {
  if (profile.revoked) throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'Finish revoked profile cleanup with ccgc logout before configuring another deployment.', 401);
  if (profile.info.profile === LEGACY_REMOTE_PROFILE) throw new BridgeError('VERSION_UNSUPPORTED', 'Upgrade the gateway catalog, then run ccgc refresh --accept-unofficial before configuring.');
  await inspectRemoteSettings(project, profile, home, managed, process.env, true, resetUnavailableModel);
  const path = join(home, '.claude', 'settings.json');
  const current = await readSettings(path);
  const patch = settingsPatch(profile);
  const currentEnv = { ...(current.env === undefined ? {} : object(current.env)) };
  const currentPermissions = current.permissions === undefined ? {} : object(current.permissions);
  const patchPermissions = object(patch.permissions);
  for (const key of legacyPins) delete currentEnv[key];
  for (const key of featurePins) delete currentEnv[key];
  const next: ObjectValue = {
    ...current,
    ...patch,
    env: { ...currentEnv, ...object(patch.env) },
    permissions: { ...currentPermissions, ...patchPermissions },
  };
  if (current.apiKeyHelper === helperCommand() && current.disableAllHooks === true) delete next.disableAllHooks;
  if (resetUnavailableModel && current.model !== undefined && !['sonnet', 'opus', 'haiku', 'default'].includes(String(current.model))) {
    try { resolveModel(profile.info.models, current.model); }
    catch { next.model = profile.info.model.id; }
  }
  if (apply) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const dir = await lstat(dirname(path));
    if (!dir.isDirectory() || dir.isSymbolicLink() || (process.getuid && dir.uid !== process.getuid())) throw new BridgeError('CONFIG_UNREADABLE', 'Claude configuration directory must be owned by you and not a symlink.');
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(next, null, 2) + '\n'); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, path);
    }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  return { path, applied: apply, settings: next };
}
