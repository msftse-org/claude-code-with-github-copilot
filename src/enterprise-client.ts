import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
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
  liteLLMUserId?: string;
  liteLLMUserAlias?: string;
  keychainId?: string;
  copilotCredentialName?: string;
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

export interface LiteLLMIdentity {
  userId: string;
  userAlias?: string;
  role: string;
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
  const directIdentity: ObjectValue = {};
  if (authMethod === 'litellmKey' && (value.liteLLMUserId !== undefined || value.keychainId !== undefined)) {
    directIdentity.liteLLMUserId = text(value.liteLLMUserId, 'LiteLLM user ID');
    const keychainId = text(value.keychainId, 'Keychain identifier');
    if (!/^[a-f0-9]{64}$/.test(keychainId)) throw new BridgeError('INVALID_RESPONSE', 'Invalid Keychain identifier.');
    directIdentity.keychainId = keychainId;
    if (value.liteLLMUserAlias !== undefined) directIdentity.liteLLMUserAlias = text(value.liteLLMUserAlias, 'LiteLLM user alias');
    if (value.copilotCredentialName !== undefined || value.githubLogin !== undefined) {
      directIdentity.copilotCredentialName = text(value.copilotCredentialName, 'Copilot credential name');
      directIdentity.githubLogin = text(value.githubLogin, 'GitHub login');
    }
  }
  const identity = authMethod === 'litellmKey'
    ? directIdentity
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

export async function responseJson(response: Response): Promise<ObjectValue> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new BridgeError(
      response.status === 401 ? 'GATEWAY_AUTH_REQUIRED' : response.status === 403 ? 'ACCESS_DENIED' : 'GATEWAY_UNAVAILABLE',
      `Enterprise gateway returned HTTP ${response.status}; no fallback was attempted.`,
      response.status,
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new BridgeError('INVALID_RESPONSE', 'Enterprise gateway returned an empty response.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) {
        await reader.cancel();
        throw new BridgeError('LIMIT_REACHED', 'Enterprise metadata response exceeds 1 MiB.', 502);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return parseJson(Buffer.concat(chunks).toString('utf8'));
}

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

export interface EnrollmentDevice {
  verificationUri: string;
  userCode: string;
  expiresIn: number;
  githubLogin: string;
}

export interface EnrollmentResult {
  controlPlane: string;
  inferenceGateway: string;
  apiKey: string;
  apiKeyExpiresAt: string;
  userId: string;
  githubLogin: string;
  credentialName: string;
  models: string[];
}

async function brokerJson(response: Response): Promise<ObjectValue> {
  if (response.ok) return responseJson(response);
  let message = '';
  try {
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader && size <= 64 * 1024) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      chunks.push(value);
    }
    await reader?.cancel();
    if (size <= 64 * 1024) {
      message = text(object(object(parseJson(Buffer.concat(chunks).toString('utf8'))).error).message, 'broker error');
    }
  } catch { /* fall through to the generic status error */ }
  const match = /^([A-Z][A-Z0-9_]{1,63}): ([^\u0000-\u001f\u007f]{1,300})$/.exec(message);
  if (!match) {
    throw new BridgeError(
      response.status === 401 ? 'GATEWAY_AUTH_REQUIRED' : response.status === 403 ? 'ACCESS_DENIED' : 'GATEWAY_UNAVAILABLE',
      `Enterprise broker returned HTTP ${response.status}; no fallback was attempted.`,
      response.status,
    );
  }
  throw new BridgeError(match[1]!, match[2]!, response.status);
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

  async enrollWithCode(broker: string, code: string, callbacks: {
    authorizeDevice(device: EnrollmentDevice): Promise<void>;
    signal?: AbortSignal;
  }): Promise<EnrollmentResult> {
    if (!/^CCGC-[A-Za-z0-9_-]{24}$/.test(code)) {
      throw new BridgeError('INVALID_REQUEST', 'The enrollment code format is invalid. Copy the full CCGC-… code from your administrator.');
    }
    const controlPlane = gatewayUrl(broker);
    const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(callbacks.signal ? [callbacks.signal] : [])]);
    const timed = () => AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
    const post = async (path: string, body: ObjectValue): Promise<ObjectValue> => brokerJson(await this.fetcher(`${controlPlane}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: timed(),
    }));
    const config = await brokerJson(await this.fetcher(`${controlPlane}/ccgc/enterprise/config`, {
      redirect: 'error',
      signal: timed(),
    }));
    const inferenceGateway = gatewayUrl(text(config.inferenceGateway, 'inference gateway'));
    let result = await post('/ccgc/enroll/start', { code, credentialType: 'litellm' });
    let expectedLogin: string | undefined;
    let interval = 5;
    let deadline = Date.now() + 10 * 60_000;
    if (result.status === 'authorization_required') {
      const verificationUri = text(result.verificationUri, 'GitHub verification URL');
      const userCode = text(result.userCode, 'GitHub verification code');
      const expiresIn = positive(result.expiresIn, 'GitHub authorization expiry');
      interval = positive(result.interval, 'GitHub polling interval');
      expectedLogin = text(result.githubLogin, 'enrolled GitHub login');
      if (verificationUri !== 'https://github.com/login/device' || !/^[A-Z0-9-]{4,32}$/.test(userCode)
        || expiresIn > 1800 || interval > 60 || !GITHUB_LOGIN.test(expectedLogin)) {
        throw new BridgeError('INVALID_RESPONSE', 'The broker returned an unexpected GitHub authorization request.');
      }
      deadline = Date.now() + expiresIn * 1000;
      await callbacks.authorizeDevice({ verificationUri, userCode, expiresIn, githubLogin: expectedLogin });
    }
    while (result.status !== 'completed') {
      if (result.status === 'denied' || result.status === 'expired' || result.status === 'no_copilot_seat') {
        throw new BridgeError(
          'GITHUB_CONNECTION_REQUIRED',
          result.status === 'no_copilot_seat'
            ? 'The approving GitHub account has no GitHub Copilot seat. Ask your administrator to assign one, then rerun setup with the same code.'
            : `GitHub authorization ended with ${result.status}. Rerun setup with the same code while it is still valid.`,
          401,
        );
      }
      if (!['authorization_required', 'pending', 'slow_down'].includes(String(result.status))) {
        throw new BridgeError('INVALID_RESPONSE', 'The broker returned an unexpected enrollment status.');
      }
      if (result.status === 'slow_down') interval += 5;
      if (typeof result.interval === 'number') interval = Math.max(interval, positive(result.interval, 'GitHub polling interval'));
      if (interval > 60 || Date.now() + interval * 1000 >= deadline) {
        throw new BridgeError('OAUTH_EXPIRED', 'GitHub authorization expired. Rerun setup with the same code while it is still valid.');
      }
      await delay(interval * 1000, undefined, { signal });
      result = await post('/ccgc/enroll/poll', { code, credentialType: 'litellm' });
    }
    const apiKey = text(result.apiKey, 'LiteLLM virtual key');
    const apiKeyExpiresAt = text(result.apiKeyExpiresAt, 'LiteLLM virtual key expiry');
    const userId = text(result.litellmUserId, 'LiteLLM user ID').toLowerCase();
    const githubLogin = text(result.githubLogin, 'GitHub login');
    const credentialName = text(result.litellmCredentialName, 'LiteLLM credential name');
    const models = Array.isArray(result.models) ? result.models.map(value => text(value, 'model ID')) : [];
    if (!/^sk-[A-Za-z0-9._-]{16,}$/.test(apiKey) || !Number.isFinite(Date.parse(apiKeyExpiresAt))
      || !/^[0-9a-f-]{36}$/.test(userId) || !GITHUB_LOGIN.test(githubLogin)
      || (expectedLogin !== undefined && githubLogin.toLowerCase() !== expectedLogin.toLowerCase())
      || !/^[A-Za-z0-9._-]{1,128}$/.test(credentialName)
      || !models.length || models.some(model => !/^claude-[a-z0-9.-]+$/.test(model))) {
      throw new BridgeError('IDENTITY_CONFLICT', 'The broker returned an unexpected enrollment result.', 403);
    }
    return {
      controlPlane,
      inferenceGateway,
      apiKey,
      apiKeyExpiresAt: new Date(apiKeyExpiresAt).toISOString(),
      userId,
      githubLogin,
      credentialName,
      models: [...new Set(models)],
    };
  }

  async acknowledgeEnrollment(broker: string, code: string): Promise<void> {
    const controlPlane = gatewayUrl(broker);
    await brokerJson(await this.fetcher(`${controlPlane}/ccgc/enroll/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    }));
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

  async identifyLiteLLMKey(gateway: string, apiKey: string, signal?: AbortSignal): Promise<LiteLLMIdentity> {
    const origin = gatewayUrl(gateway);
    const headers = { authorization: ['Bearer', apiKey].join(' ') };
    const keyResponse = await responseJson(await this.fetcher(`${origin}/key/info`, {
      headers, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    }));
    const userResponse = await responseJson(await this.fetcher(`${origin}/user/info`, {
      headers, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    }));
    const keyInfo = object(keyResponse.info);
    const userInfo = object(userResponse.user_info);
    const userId = text(userInfo.user_id, 'LiteLLM user ID');
    if (keyInfo.user_id !== userId) {
      throw new BridgeError('IDENTITY_CONFLICT', 'The key must belong to the authenticated LiteLLM user, not a shared team or another user.', 403);
    }
    const role = text(userInfo.user_role, 'LiteLLM user role');
    if (!['internal_user', 'internal_user_viewer'].includes(role)) {
      throw new BridgeError('USER_ACCOUNT_REQUIRED', 'Use your own LiteLLM internal-user account or key, not the shared admin login or a proxy-admin key.', 403);
    }
    return {
      userId,
      role,
      ...(typeof userInfo.user_alias === 'string' && userInfo.user_alias.trim() ? { userAlias: userInfo.user_alias } : {}),
    };
  }

  async loginLiteLLMKey(gateway: string, apiKey: string, connection?: {
    userId: string;
    credentialName: string;
    githubLogin: string;
    models: string[];
  }, signal?: AbortSignal): Promise<EnterpriseProfile> {
    if (!/^sk-[A-Za-z0-9._-]{16,}$/.test(apiKey)) {
      throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'LiteLLM virtual key is invalid.', 401);
    }
    const inferenceGateway = gatewayUrl(gateway);
    const identity = await this.identifyLiteLLMKey(inferenceGateway, apiKey, signal);
    if (connection && connection.userId !== identity.userId) {
      throw new BridgeError('IDENTITY_CONFLICT', 'The new key does not belong to the user who connected GitHub.', 403);
    }
    if (connection) {
      const state = await responseJson(await this.fetcher(`${inferenceGateway}/credentials/user_connections`, {
        headers: { authorization: ['Bearer', apiKey].join(' ') },
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      }));
      const connections = Array.isArray(state.connections) ? state.connections.map(object) : [];
      if (!connections.some(item => item.credential_name === connection.credentialName
        && item.provider === 'github_copilot' && item.connected === true && item.github_login === connection.githubLogin)) {
        throw new BridgeError('IDENTITY_CONFLICT', 'The new key does not resolve to the verified per-user GitHub connection.', 403);
      }
    }
    const response = await responseJson(await this.fetcher(`${inferenceGateway}/v1/models`, {
      headers: { authorization: ['Bearer', apiKey].join(' ') },
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    }));
    const data = Array.isArray(response.data) ? response.data : [];
    const models = [...new Set(data
      .map(item => object(item))
      .map(item => text(item.id, 'model ID'))
      .filter(model => /^claude-[a-z0-9.-]+$/.test(model)))];
    if (connection && models.some(model => !connection.models.includes(model))) {
      throw new BridgeError('IDENTITY_CONFLICT', 'The key exposes Claude routes outside the selected per-user GitHub credential. Use a key scoped to that credential.', 403);
    }
    const keyId = createHash('sha256')
      .update(`enterprise-verified-key\n${inferenceGateway}\n${identity.userId}\n${apiKey}`)
      .digest('hex');
    const next = profile({
      controlPlane: inferenceGateway,
      gateway: inferenceGateway,
      authMethod: 'litellmKey',
      inferenceAuthentication: 'directKey',
      liteLLMUserId: identity.userId,
      ...(identity.userAlias ? { liteLLMUserAlias: identity.userAlias } : {}),
      keychainId: keyId,
      ...(connection ? { copilotCredentialName: connection.credentialName, githubLogin: connection.githubLogin } : {}),
      models,
    });
    const previous = await readState(this.statePath);
    signal?.throwIfAborted();
    await this.secrets.set(keyId, apiKey);
    try {
      signal?.throwIfAborted();
      await writePrivate(this.statePath, { ...next });
    } catch (error) {
      if (previous?.keychainId !== keyId) await this.secrets.remove(keyId);
      throw error;
    }
    return next;
  }

  private verifiedDirectKey(current: EnterpriseProfile): Promise<string> {
    if (!current.liteLLMUserId || !current.keychainId) {
      throw new BridgeError('USER_SETUP_REQUIRED', 'This older profile has no verified LiteLLM owner. Run ccgc-enterprise setup with your own login or key; the cached credential will not be used.');
    }
    return this.secrets.get(current.keychainId);
  }

  async refreshModels(): Promise<EnterpriseProfile> {
    const current = await this.load();
    if (current.inferenceAuthentication !== 'directKey') return current;
    const apiKey = await this.verifiedDirectKey(current);
    const response = await responseJson(await this.fetcher(`${current.gateway}/v1/models`, {
      headers: { authorization: ['Bearer', apiKey].join(' ') },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    }));
    const data = Array.isArray(response.data) ? response.data : [];
    const models = [...new Set(data
      .map(item => object(item))
      .map(item => text(item.id, 'model ID'))
      .filter(model => /^claude-[a-z0-9.-]+$/.test(model)))];
    const next = profile({ ...current, models });
    await writePrivate(this.statePath, { ...next });
    return next;
  }

  async token(): Promise<string> {
    const current = await this.load();
    if (current.inferenceAuthentication === 'directKey') {
      return this.verifiedDirectKey(current);
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
  const defaultModel = value.models[0]!;
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

export function enterpriseDesktopConfig(value: EnterpriseProfile): ObjectValue {
  const entrypoint = fileURLToPath(new URL('./enterprise-cli.ts', import.meta.url));
  if (/["%\x00-\x1f\x7f]/.test(entrypoint)) {
    throw new BridgeError('CONFIG_UNREADABLE', 'Desktop helper arguments cannot contain quotes, percent signs, or control characters.');
  }
  return {
    inferenceProvider: 'gateway',
    inferenceGatewayBaseUrl: value.gateway,
    inferenceGatewayAuthScheme: 'bearer',
    inferenceCredentialKind: 'helper-script',
    inferenceCredentialHelper: process.execPath,
    inferenceCredentialHelperArgs: [entrypoint, 'token'],
    modelDiscoveryEnabled: true,
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
