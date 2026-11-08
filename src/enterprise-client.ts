import { createHash, randomUUID } from 'node:crypto';
import { DefaultAzureCredential } from '@azure/identity';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeError, object, parseJson, positive, text } from './protocol.ts';
import type { ObjectValue } from './protocol.ts';
import { gatewayUrl, profileKey } from './remote.ts';
import { Keychain, type Secrets } from './remote-client.ts';
import { readState, writePrivate } from './private-state.ts';

export interface EnterpriseProfile {
  controlPlane: string;
  gateway: string;
  authMethod: 'entra' | 'apiKey' | 'litellmKey';
  inferenceAuthentication: 'directKey' | 'ccgcAdmission';
  audience?: string;
  tenantId?: string;
  objectId?: string;
  githubLogin?: string;
  githubAccountId?: number;
  models: string[];
  bindingRevision?: number;
  grant?: { id: string; expires: number };
}

const apiKeyId = (gateway: string) => createHash('sha256')
  .update(`enterprise-api-key\n${gatewayUrl(gateway)}`)
  .digest('hex');

interface TokenCredential {
  getToken(scope: string): Promise<{ token: string } | null>;
}

function profile(value: ObjectValue): EnterpriseProfile {
  const models = Array.isArray(value.models) ? value.models.map(model => text(model, 'model ID')) : [];
  if (!models.length || models.some(model => !/^claude-[a-z0-9.-]+$/.test(model))) {
    throw new BridgeError('INVALID_RESPONSE', 'Enterprise profile has no valid Claude model catalog.');
  }
  const grant = value.grant === undefined ? undefined : object(value.grant);
  const authMethod = value.authMethod === 'litellmKey'
    ? 'litellmKey'
    : value.authMethod === 'apiKey'
    ? 'apiKey'
    : value.authMethod === 'entra' || (value.authMethod === undefined && value.audience !== undefined)
      ? 'entra'
      : undefined;
  if (!authMethod) throw new BridgeError('INVALID_RESPONSE', 'Enterprise profile authentication method is invalid.');
  const audience = value.audience === undefined ? undefined : text(value.audience, 'audience');
  if (authMethod === 'entra' && !audience) {
    throw new BridgeError('INVALID_RESPONSE', 'Enterprise Entra profile has no audience.');
  }
  const inferenceAuthentication = value.inferenceAuthentication === 'directKey'
    ? 'directKey'
    : value.inferenceAuthentication === 'ccgcAdmission' || value.inferenceAuthentication === undefined
      ? 'ccgcAdmission'
      : undefined;
  if (!inferenceAuthentication
    || (authMethod === 'litellmKey' && inferenceAuthentication !== 'directKey')
    || (authMethod !== 'litellmKey' && inferenceAuthentication === 'directKey')) {
    throw new BridgeError('INVALID_RESPONSE', 'Enterprise inference authentication mode is invalid.');
  }
  const legacyGateway = gatewayUrl(text(value.gateway, 'gateway'));
  const controlPlane = value.controlPlane === undefined
    ? legacyGateway
    : gatewayUrl(text(value.controlPlane, 'control plane'));
  const identity = authMethod === 'litellmKey'
    ? {}
    : {
        tenantId: text(value.tenantId, 'tenant ID'),
        objectId: text(value.objectId, 'object ID'),
        githubLogin: text(value.githubLogin, 'GitHub login'),
        githubAccountId: positive(value.githubAccountId, 'GitHub account ID'),
        bindingRevision: positive(value.bindingRevision, 'binding revision'),
      };
  return {
    controlPlane,
    gateway: legacyGateway,
    authMethod,
    inferenceAuthentication,
    ...(audience ? { audience } : {}),
    ...identity,
    models,
    ...(grant ? { grant: { id: text(grant.id, 'admission ID'), expires: Number(grant.expires) } } : {}),
  };
}

async function responseJson(response: Response): Promise<ObjectValue> {
  const raw = await response.text();
  if (!response.ok) throw new BridgeError(
    response.status === 401 ? 'GATEWAY_AUTH_REQUIRED' : response.status === 403 ? 'ACCESS_DENIED' : 'GATEWAY_UNAVAILABLE',
    `Enterprise gateway returned HTTP ${response.status}; no fallback was attempted.`,
    response.status,
  );
  return parseJson(raw);
}

export class EnterpriseClient {
  readonly home: string;
  readonly statePath: string;
  readonly secrets: Secrets;
  readonly credential: TokenCredential;
  readonly fetcher: typeof fetch;

  constructor(home = homedir(), secrets: Secrets = new Keychain(), credential: TokenCredential = new DefaultAzureCredential(), fetcher: typeof fetch = fetch) {
    this.home = home;
    this.secrets = secrets;
    this.credential = credential;
    this.fetcher = fetcher;
    this.statePath = join(home, '.local', 'share', 'ccgc', 'enterprise', 'profile.json');
  }

  async load(): Promise<EnterpriseProfile> {
    const value = await readState(this.statePath);
    if (!value) throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'Run ccgc enterprise login before configuring Claude.', 401);
    return profile(value);
  }

  private async entra(audience: string): Promise<string> {
    const access = await this.credential.getToken(`${audience.replace(/\/$/, '')}/.default`);
    if (!access?.token) throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'Microsoft Entra sign-in did not return an access token.', 401);
    return access.token;
  }

  async login(gateway: string, audience: string): Promise<EnterpriseProfile> {
    const controlPlane = gatewayUrl(gateway);
    const access = await this.entra(audience);
    const info = await responseJson(await this.fetcher(`${controlPlane}/ccgc/enterprise/info`, {
      headers: { authorization: `Bearer ${access}` },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    }));
    const inferenceGateway = info.inferenceGateway === undefined
      ? controlPlane
      : gatewayUrl(text(info.inferenceGateway, 'inference gateway'));
    const next = profile({
      controlPlane,
      gateway: inferenceGateway,
      authMethod: 'entra',
      audience,
      ...info,
    });
    await this.secrets.remove(profileKey(controlPlane));
    await this.secrets.remove(apiKeyId(controlPlane));
    await writePrivate(this.statePath, { ...next });
    return next;
  }

  async loginApiKey(gateway: string, apiKey: string): Promise<EnterpriseProfile> {
    if (!/^ccgc_sk_[A-Za-z0-9_-]{43}$/.test(apiKey)) {
      throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'Enterprise API key is invalid.', 401);
    }
    const controlPlane = gatewayUrl(gateway);
    const info = await responseJson(await this.fetcher(`${controlPlane}/ccgc/enterprise/info`, {
      headers: { authorization: ['Bearer', apiKey].join(' ') },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    }));
    const inferenceGateway = info.inferenceGateway === undefined
      ? controlPlane
      : gatewayUrl(text(info.inferenceGateway, 'inference gateway'));
    const next = profile({ controlPlane, gateway: inferenceGateway, authMethod: 'apiKey', ...info });
    const keyId = apiKeyId(controlPlane);
    await this.secrets.set(keyId, apiKey);
    try {
      await this.secrets.remove(profileKey(controlPlane));
      await writePrivate(this.statePath, { ...next });
    } catch (error) {
      await this.secrets.remove(keyId);
      throw error;
    }
    return next;
  }

  async loginLiteLLMKey(gateway: string, apiKey: string): Promise<EnterpriseProfile> {
    if (!/^sk-[A-Za-z0-9._-]{16,}$/.test(apiKey)) {
      throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'LiteLLM virtual key is invalid.', 401);
    }
    const inferenceGateway = gatewayUrl(gateway);
    const response = await responseJson(await this.fetcher(`${inferenceGateway}/v1/models`, {
      headers: { authorization: ['Bearer', apiKey].join(' ') },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    }));
    const data = Array.isArray(response.data) ? response.data : [];
    const models = [...new Set(data
      .map(item => object(item))
      .map(item => text(item.id, 'model ID'))
      .filter(model => /^claude-[a-z0-9.-]+$/.test(model)))];
    const next = profile({
      controlPlane: inferenceGateway,
      gateway: inferenceGateway,
      authMethod: 'litellmKey',
      inferenceAuthentication: 'directKey',
      models,
    });
    const keyId = apiKeyId(inferenceGateway);
    await this.secrets.set(keyId, apiKey);
    try {
      await this.secrets.remove(profileKey(inferenceGateway));
      await writePrivate(this.statePath, { ...next });
    } catch (error) {
      await this.secrets.remove(keyId);
      throw error;
    }
    return next;
  }

  async token(): Promise<string> {
    const current = await this.load();
    if (current.inferenceAuthentication === 'directKey') {
      return this.secrets.get(apiKeyId(current.gateway));
    }
    const id = profileKey(current.controlPlane);
    if (current.grant && current.grant.expires > Date.now() + 5 * 60_000) {
      try { return await this.secrets.get(id); } catch { /* acquire a replacement below */ }
    }
    const access = current.authMethod === 'apiKey'
      ? await this.secrets.get(apiKeyId(current.controlPlane))
      : await this.entra(current.audience!);
    const value = await responseJson(await this.fetcher(`${current.controlPlane}/ccgc/enterprise/admissions`, {
      method: 'POST',
      headers: { authorization: ['Bearer', access].join(' '), 'content-type': 'application/json' },
      body: JSON.stringify({ ttlSeconds: 28_800, maxAttempts: 50 }),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    }));
    const token = text(value.token, 'admission token');
    if (!/^[a-f0-9]{64}$/.test(token)) throw new BridgeError('INVALID_RESPONSE', 'Enterprise admission token is invalid.');
    const next = { ...current, grant: { id: text(value.id, 'admission ID'), expires: Date.parse(text(value.expiresAt, 'admission expiry')) } };
    if (!Number.isFinite(next.grant.expires)) throw new BridgeError('INVALID_RESPONSE', 'Enterprise admission expiry is invalid.');
    await this.secrets.set(id, token);
    await writePrivate(this.statePath, { ...next });
    return token;
  }
}

const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;

export function enterpriseHelperCommand(): string {
  return `${quote(process.execPath)} ${quote(fileURLToPath(new URL('./enterprise-cli.ts', import.meta.url)))} token`;
}

export function enterpriseSettingsPatch(value: EnterpriseProfile): ObjectValue {
  const defaultModel = value.models[0] === 'claude-haiku-4.5'
    ? 'claude-haiku-4-5-20251001'
    : value.models[0]!.replaceAll('.', '-');
  return {
    env: {
      ANTHROPIC_BASE_URL: value.gateway,
      ANTHROPIC_DEFAULT_MODEL: defaultModel,
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
      CLAUDE_CODE_API_KEY_HELPER_TTL_MS: '60000',
      CLAUDE_CODE_AUTO_MODE_SERVER: '0',
    },
    apiKeyHelper: enterpriseHelperCommand(),
    permissions: { defaultMode: 'manual' },
  };
}

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
      if (!stat.isFile() || stat.size > 1024 * 1024 || (process.getuid && stat.uid !== process.getuid())) {
        throw new BridgeError('CONFIG_UNREADABLE', 'Settings must be a bounded regular file owned by you.');
      }
      return parseJson(await file.readFile('utf8'));
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {};
    if (error instanceof BridgeError) throw error;
    throw new BridgeError('CONFIG_UNREADABLE', 'Settings cannot be safely inspected.');
  }
}

export async function configureEnterprise(value: EnterpriseProfile, apply: boolean, home = homedir()) {
  const path = join(home, '.claude', 'settings.json');
  const current = await readSettings(path);
  const expected = enterpriseSettingsPatch(value);
  const expectedEnv = object(expected.env);
  const env = current.env === undefined ? {} : object(current.env);
  const controlsRouting = (key: string) => key in expectedEnv
    || /^(ANTHROPIC_|CLAUDE_CODE_(USE_|OAUTH|PROVIDER|API_KEY|CUSTOM|MODEL)|CLAUDE_CONFIG_DIR)/.test(key);
  for (const [key, currentValue] of Object.entries(process.env)) {
    if (currentValue && controlsRouting(key) && expectedEnv[key] !== currentValue) {
      throw new BridgeError('ROUTING_CONFLICT', `Shell environment setting ${key} conflicts with the enterprise gateway.`);
    }
  }
  for (const [key, currentValue] of Object.entries(env)) {
    if (current.apiKeyHelper === enterpriseHelperCommand() && featurePins.includes(key) && currentValue === '1') continue;
    if (controlsRouting(key) && expectedEnv[key] !== currentValue) {
      throw new BridgeError('ROUTING_CONFLICT', `Existing Claude setting ${key} conflicts with the enterprise gateway.`);
    }
  }
  if (current.apiKeyHelper !== undefined && current.apiKeyHelper !== enterpriseHelperCommand()) {
    throw new BridgeError('ROUTING_CONFLICT', 'An unrelated Claude credential helper is already configured.');
  }
  const currentEnv = { ...env };
  const currentPermissions = current.permissions === undefined ? {} : object(current.permissions);
  const expectedPermissions = object(expected.permissions);
  for (const key of featurePins) delete currentEnv[key];
  const next: ObjectValue = {
    ...current,
    ...expected,
    env: { ...currentEnv, ...expectedEnv },
    permissions: { ...currentPermissions, ...expectedPermissions },
  };
  if (current.apiKeyHelper === enterpriseHelperCommand() && current.disableAllHooks === true) delete next.disableAllHooks;
  if (apply) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const directory = await lstat(dirname(path));
    if (!directory.isDirectory() || directory.isSymbolicLink() || (process.getuid && directory.uid !== process.getuid())) {
      throw new BridgeError('CONFIG_UNREADABLE', 'Claude configuration directory must be owned by you and not be a symlink.');
    }
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(next, null, 2) + '\n'); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  return { path, applied: apply, patch: expected };
}

export function enterpriseProfileId(value: EnterpriseProfile): string {
  return createHash('sha256').update(`${value.controlPlane}\n${value.objectId}`).digest('hex');
}
