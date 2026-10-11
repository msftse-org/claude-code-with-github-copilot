import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeError, claudeModels, object, parseJson, positive, text, toolResults } from './protocol.ts';
import type { Model, ObjectValue } from './protocol.ts';

export const CLIENT_ID = 'Iv1.b507a08c87ecfe98';
export const STATE_DIR = join(homedir(), '.local', 'share', 'ccgc');
const hosts = new Set(['api.githubcopilot.com', 'api.individual.githubcopilot.com', 'api.business.githubcopilot.com', 'api.enterprise.githubcopilot.com']);

export interface Credential {
  login: string;
  accessToken: string;
}

export interface CredentialSource {
  load(): Promise<Credential>;
  save?(credential: Credential): Promise<void>;
}

export interface Backend {
  send(body: ObjectValue, headers: Headers, signal: AbortSignal): Promise<Response>;
  countTokens?(body: ObjectValue, headers: Headers, signal: AbortSignal): Promise<Response>;
}

export class CredentialStore {
  readonly directory: string;
  constructor(directory = STATE_DIR) { this.directory = directory; }

  async secureDirectory(create: boolean): Promise<void> {
    if (create) await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
      || (process.getuid && info.uid !== process.getuid())) {
      throw new BridgeError('CREDENTIAL_STORE_UNSAFE', 'Credential directory must be private, owned by you, and not a symlink.');
    }
  }

  async load(): Promise<Credential> {
    try {
      await this.secureDirectory(false);
      const file = await open(join(this.directory, 'credentials.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        if (!info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
          throw new BridgeError('CREDENTIAL_STORE_UNSAFE', 'Credential file must be private and owned by you.');
        }
        const data = parseJson(await file.readFile('utf8'));
        return { login: text(data.login, 'stored login'), accessToken: text(data.accessToken, 'stored credential') };
      } finally { await file.close(); }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new BridgeError('AUTH_REQUIRED', 'Run ccgc login --accept-unofficial to authorize your own Copilot seat.', 401);
      }
      throw error;
    }
  }

  async save(credential: Credential): Promise<void> {
    await this.secureDirectory(true);
    const temporary = join(this.directory, `credentials-${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(credential));
      await file.sync();
    } finally { await file.close(); }
    try { await rename(temporary, join(this.directory, 'credentials.json')); }
    finally {
      try { await unlink(temporary); }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
  }

  async logout(): Promise<void> {
    await this.secureDirectory(false);
    await unlink(join(this.directory, 'credentials.json'));
  }
}

export function copilotEndpoint(value: unknown): string {
  const source = text(value, 'authenticated Copilot endpoint');
  let url: URL;
  try { url = new URL(source); }
  catch { throw new BridgeError('ENDPOINT_REJECTED', 'Invalid authenticated Copilot endpoint.'); }
  if (url.protocol !== 'https:' || !hosts.has(url.hostname) || url.username || url.password || url.port
    || url.search || url.hash || url.pathname !== '/') {
    throw new BridgeError('ENDPOINT_REJECTED', 'Copilot endpoint is outside the reviewed github.com profile.');
  }
  return url.origin;
}

export function statusError(status: number): BridgeError {
  if (status === 401) return new BridgeError('AUTH_REQUIRED', 'Upstream rejected authentication; sign in again.', 401);
  if (status === 403) return new BridgeError('ACCESS_DENIED', 'Upstream denied this account, model, or integration. Do not bypass the restriction.', 403);
  if (status === 429) return new BridgeError('LIMIT_REACHED', 'Upstream rate or usage limit reached; consult your Copilot controls.', 429);
  return new BridgeError('UPSTREAM_FAILURE', `Upstream returned HTTP ${status}; no fallback or retry was attempted.`, 502);
}

const compatibilityHeaders = {
  'editor-version': 'vscode/1.95.0',
  'editor-plugin-version': 'copilot-chat/0.26.7',
  'copilot-integration-id': 'vscode-chat',
  'user-agent': 'ccgc/0.1.0-alpha.1',
};

export class CopilotBackend implements Backend {
  readonly store: CredentialSource;
  readonly fetcher: typeof fetch;
  private credential: Credential | undefined;
  private session: { token: string; endpoint: string; expires: number } | undefined;
  private refreshing: Promise<void> | undefined;

  constructor(store: CredentialSource = new CredentialStore(), fetcher: typeof fetch = fetch) {
    this.store = store;
    this.fetcher = fetcher;
  }

  private async json(url: string, init: RequestInit = {}): Promise<ObjectValue> {
    const response = await this.fetcher(url, {
      ...init, redirect: 'error', signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'ccgc/0.1.0-alpha.1', ...init.headers },
    });
    if (!response.ok) throw statusError(response.status);
    return parseJson(await response.text());
  }

  async login(announce: (url: string, code: string) => void): Promise<string> {
    const device = await this.json('https://github.com/login/device/code', {
      method: 'POST', body: JSON.stringify({ client_id: CLIENT_ID, scope: 'read:user' }),
    });
    const verification = text(device.verification_uri, 'verification URI');
    if (verification !== 'https://github.com/login/device') throw new BridgeError('ENDPOINT_REJECTED', 'Unexpected device verification URL.');
    const code = text(device.device_code, 'device code');
    const deadline = Date.now() + positive(device.expires_in, 'device code expiry') * 1000;
    let interval = positive(device.interval, 'polling interval') * 1000;
    announce(verification, text(device.user_code, 'user code'));
    while (Date.now() < deadline) {
      await delay(interval);
      if (Date.now() >= deadline) break;
      const result = await this.json('https://github.com/login/oauth/access_token', {
        method: 'POST',
        body: JSON.stringify({ client_id: CLIENT_ID, device_code: code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
      });
      if (typeof result.access_token === 'string') {
        const accessToken = text(result.access_token, 'access token');
        const user = await this.json('https://api.github.com/user', { headers: { authorization: `Bearer ${accessToken}` } });
        this.credential = { login: text(user.login, 'GitHub login'), accessToken };
        await this.refresh();
        if (!this.store.save) throw new BridgeError('INVALID_OPTIONS', 'This credential source cannot persist device authorization.');
        await this.store.save(this.credential);
        return this.credential.login;
      }
      if (result.error === 'authorization_pending') continue;
      if (result.error === 'slow_down') { interval += 5000; continue; }
      throw new BridgeError('AUTH_REQUIRED', 'Device authorization was denied, expired, or rejected. Start a new login.', 401);
    }
    throw new BridgeError('AUTH_REQUIRED', 'Device authorization expired; start a new login.', 401);
  }

  async initialize(): Promise<string> {
    this.credential = await this.store.load();
    const user = await this.json('https://api.github.com/user', { headers: { authorization: `Bearer ${this.credential.accessToken}` } });
    if (user.login !== this.credential.login) throw new BridgeError('IDENTITY_CONFLICT', 'Effective GitHub identity differs from the saved login.', 403);
    await this.refresh();
    return this.credential.login;
  }

  private async refresh(signal?: AbortSignal): Promise<void> {
    if (this.session && this.session.expires > Date.now() + 60_000) return;
    if (!this.credential) throw new BridgeError('AUTH_REQUIRED', 'Initialize the selected account first.', 401);
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const data = await this.json('https://api.github.com/copilot_internal/v2/token', {
        signal,
        headers: { ...compatibilityHeaders, authorization: `token ${this.credential?.accessToken}` },
      });
      const expires = positive(data.expires_at, 'Copilot token expiry') * 1000;
      if (expires <= Date.now()) throw new BridgeError('AUTH_REQUIRED', 'Copilot returned an expired credential.', 401);
      this.session = { token: text(data.token, 'Copilot token'), endpoint: copilotEndpoint(object(data.endpoints).api), expires };
    })();
    try { await this.refreshing; } finally { this.refreshing = undefined; }
  }

  async models(): Promise<Model[]> {
    await this.refresh();
    if (!this.session) throw new BridgeError('AUTH_REQUIRED', 'No authenticated Copilot session.', 401);
    return claudeModels(await this.json(`${this.session.endpoint}/models`, {
      headers: { ...compatibilityHeaders, authorization: `Bearer ${this.session.token}` },
    }));
  }

  async send(body: ObjectValue, headers: Headers, signal: AbortSignal): Promise<Response> {
    return this.messages('/v1/messages', body, headers, signal);
  }

  async countTokens(body: ObjectValue, headers: Headers, signal: AbortSignal): Promise<Response> {
    return this.messages('/v1/messages/count_tokens', body, headers, signal);
  }

  private async messages(path: string, body: ObjectValue, headers: Headers, signal: AbortSignal): Promise<Response> {
    await this.refresh(signal);
    if (!this.session) throw new BridgeError('AUTH_REQUIRED', 'No authenticated Copilot session.', 401);
    const upstream = new Headers(compatibilityHeaders);
    upstream.set('authorization', `Bearer ${this.session.token}`);
    upstream.set('content-type', 'application/json');
    upstream.set('anthropic-version', headers.get('anthropic-version') ?? '2023-06-01');
    const beta = headers.get('anthropic-beta');
    if (beta) upstream.set('anthropic-beta', beta);
    upstream.set('openai-intent', 'messages-proxy');
    upstream.set('x-interaction-type', 'messages-proxy');
    upstream.set('x-github-api-version', '2026-06-01');
    upstream.set('x-request-id', randomUUID());
    upstream.set('x-initiator', toolResults(body).length ? 'agent' : 'user');
    return this.fetcher(`${this.session.endpoint}${path}`, {
      method: 'POST', headers: upstream, body: JSON.stringify(body), redirect: 'error', signal,
    });
  }
}

export async function installedPackageVersion(): Promise<string> {
  return text(parseJson(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version, 'package version');
}
