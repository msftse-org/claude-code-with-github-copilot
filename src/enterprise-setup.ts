import { decodeJwt } from 'jose';
import { setTimeout as delay } from 'node:timers/promises';
import { EnterpriseClient, responseJson, type EnterpriseProfile, type LiteLLMIdentity } from './enterprise-client.ts';
import { BridgeError, object, positive, text, type ObjectValue } from './protocol.ts';
import { gatewayUrl } from './remote.ts';

export interface SetupCallbacks {
  confirmIdentity(identity: LiteLLMIdentity & { githubLogin?: string }): Promise<boolean>;
  authorizeDevice(device: { verificationUri: string; userCode: string; expiresIn: number }): Promise<void>;
  credentialName?: string;
  signal?: AbortSignal;
}

export type SetupCredentials = { username: string; password: string } | { apiKey: string };

export async function setupEnterprise(
  client: EnterpriseClient,
  gateway: string,
  credentials: SetupCredentials,
  callbacks: SetupCallbacks,
): Promise<EnterpriseProfile> {
  const origin = gatewayUrl(gateway);
  const signal = AbortSignal.any([AbortSignal.timeout(15 * 60_000), ...(callbacks.signal ? [callbacks.signal] : [])]);
  const request = async (path: string, key?: string, body?: ObjectValue, requestSignal = signal): Promise<ObjectValue> =>
    responseJson(await client.fetcher(`${origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(key ? { authorization: ['Bearer', key].join(' ') } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: AbortSignal.any([requestSignal, AbortSignal.timeout(30_000)]),
    }));

  let sessionKey: string;
  let loginUserId: string | undefined;
  if ('apiKey' in credentials) {
    if (!/^sk-[A-Za-z0-9._-]{16,}$/.test(credentials.apiKey)) {
      throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'Supply your own LiteLLM virtual key through protected input.', 401);
    }
    sessionKey = credentials.apiKey;
  } else {
    if (!credentials.username.trim() || !credentials.password || credentials.username.length > 320 || credentials.password.length > 8192) {
      throw new BridgeError('INVALID_OPTIONS', 'A bounded LiteLLM username and password are required.');
    }
    const login = await request('/v2/login', undefined, { username: credentials.username.trim(), password: credentials.password });
    const encoded = text(login.token, 'LiteLLM UI session');
    if (encoded.length > 65_536) throw new BridgeError('INVALID_RESPONSE', 'Invalid LiteLLM UI session.');
    let claims: ObjectValue;
    try { claims = object(decodeJwt(encoded)); }
    catch { throw new BridgeError('INVALID_RESPONSE', 'Invalid LiteLLM UI session.'); }
    if (claims.password_reset_required === true) {
      throw new BridgeError('PASSWORD_CHANGE_REQUIRED', `Complete your password change at ${origin}/ui before running setup.`);
    }
    sessionKey = text(claims.key, 'LiteLLM session key');
    if (!/^(?:sk-[A-Za-z0-9._-]{16,}|[a-f0-9]{64})$/.test(sessionKey)) {
      throw new BridgeError('INVALID_RESPONSE', 'Invalid LiteLLM session credential.');
    }
    loginUserId = text(claims.user_id, 'LiteLLM login user ID');
  }

  const identity = await client.identifyLiteLLMKey(origin, sessionKey, signal);
  if (loginUserId && loginUserId !== identity.userId) {
    throw new BridgeError('IDENTITY_CONFLICT', 'The authenticated LiteLLM session and user record disagree.', 403);
  }
  if (!('apiKey' in credentials) && identity.role !== 'internal_user') {
    throw new BridgeError('ACCESS_DENIED', 'This account cannot create a personal key. Ask your administrator for your own permitted key.', 403);
  }
  const catalog = await request('/v1/model/info', sessionKey);
  const routes = (Array.isArray(catalog.data) ? catalog.data : []).map(object);
  const names = [...new Set(routes
    .filter(route => /^claude-[a-z0-9.-]+$/.test(String(route.model_name))
      && object(route.litellm_params).model === `github_copilot/${String(route.model_name)}`)
    .map(route => text(object(route.litellm_params).litellm_credential_name, 'per-user credential name')))];
  const credentialName = callbacks.credentialName ?? (names.length === 1 ? names[0] : undefined);
  if (!credentialName || !names.includes(credentialName)) {
    throw new BridgeError('CREDENTIAL_SELECTION_REQUIRED', `Select a GitHub Copilot credential with --credential NAME. Available credentials: ${names.map(name => JSON.stringify(name)).join(', ') || 'none'}.`);
  }
  const allowedModels = routes.filter(route => object(route.litellm_params).litellm_credential_name === credentialName
    && object(route.litellm_params).model === `github_copilot/${String(route.model_name)}`)
    .map(route => text(route.model_name, 'model name'));
  if (routes.some(route => allowedModels.includes(String(route.model_name))
    && (object(route.litellm_params).litellm_credential_name !== credentialName
      || object(route.litellm_params).model !== `github_copilot/${String(route.model_name)}`))) {
    throw new BridgeError('IDENTITY_CONFLICT', 'A Claude model name has conflicting provider or credential routes. Resolve the gateway mapping before setup.', 403);
  }
  const discovery = await request('/v1/models', sessionKey);
  const visibleModels = (Array.isArray(discovery.data) ? discovery.data : []).map(object)
    .map(item => text(item.id, 'model ID')).filter(id => /^claude-[a-z0-9.-]+$/.test(id));
  const models = [...new Set(visibleModels.filter(model => allowedModels.includes(model)))];
  if (!models.length) throw new BridgeError('ACCESS_DENIED', 'This LiteLLM user has no approved Claude models on the selected GitHub credential.', 403);
  if ('apiKey' in credentials && visibleModels.some(model => !allowedModels.includes(model))) {
    throw new BridgeError('IDENTITY_CONFLICT', 'Use a key scoped to the selected GitHub credential; this key also exposes other Claude routes.', 403);
  }
  const connectionPath = `/credentials/${encodeURIComponent(credentialName)}/user_connection`;
  const state = await request('/credentials/user_connections', sessionKey);
  const connections = (Array.isArray(state.connections) ? state.connections : []).map(object);
  const connection = connections.find(item => item.credential_name === credentialName && item.provider === 'github_copilot');
  if (!connection) throw new BridgeError('INVALID_RESPONSE', 'The selected model credential has no native per-user GitHub connection entry.');
  if (typeof connection.connected !== 'boolean') throw new BridgeError('INVALID_RESPONSE', 'Invalid per-user GitHub connection state.');
  let githubLogin = connection.connected === true ? text(connection.github_login, 'connected GitHub login') : undefined;
  if (!await callbacks.confirmIdentity({ ...identity, ...(githubLogin ? { githubLogin } : {}) })) {
    throw new BridgeError('CANCELLED', 'Setup cancelled without replacing the local profile.');
  }

  if (!githubLogin) {
    const started = await request(`${connectionPath}/start`, sessionKey, {});
    let uri: URL;
    try { uri = new URL(text(started.verification_uri, 'GitHub verification URL')); }
    catch { throw new BridgeError('INVALID_RESPONSE', 'Invalid GitHub verification URL.'); }
    if (uri.protocol !== 'https:' || uri.username || uri.password || uri.port || uri.search || uri.hash
      || (uri.hostname !== 'github.com' && !/^[a-z0-9][a-z0-9-]*\.ghe\.com$/.test(uri.hostname))
      || uri.pathname !== '/login/device') {
      throw new BridgeError('INVALID_RESPONSE', 'The gateway returned an unexpected GitHub verification URL.');
    }
    const userCode = text(started.user_code, 'GitHub verification code');
    if (!/^[A-Z0-9-]{4,32}$/.test(userCode)) throw new BridgeError('INVALID_RESPONSE', 'Invalid GitHub verification code.');
    const flowHandle = text(started.flow_handle, 'OAuth flow handle');
    if (flowHandle.length > 16_384) throw new BridgeError('INVALID_RESPONSE', 'Invalid OAuth flow handle.');
    const expiresIn = Math.min(positive(started.expires_in, 'OAuth expiry'), 900);
    const deadline = Date.now() + expiresIn * 1000;
    let interval = positive(started.interval, 'OAuth polling interval');
    await callbacks.authorizeDevice({ verificationUri: uri.href, userCode, expiresIn });
    while (!githubLogin) {
      if (interval > 900 || Date.now() + interval * 1000 >= deadline) {
        throw new BridgeError('OAUTH_EXPIRED', 'GitHub authorization expired. Run setup again; no local credential was replaced.');
      }
      await delay(interval * 1000, undefined, { signal });
      if (Date.now() >= deadline) throw new BridgeError('OAUTH_EXPIRED', 'GitHub authorization expired. Run setup again.');
      const result = await request(`${connectionPath}/poll`, sessionKey, { flow_handle: flowHandle });
      if (result.status === 'connected') {
        githubLogin = text(result.github_login, 'connected GitHub login');
      } else if (result.status === 'pending' || result.status === 'slow_down') {
        interval = Math.max(interval + (result.status === 'slow_down' ? 5 : 0),
          result.interval === undefined || result.interval === null ? interval : positive(result.interval, 'OAuth polling interval'));
      } else if (result.status === 'denied' || result.status === 'expired' || result.status === 'no_copilot_seat') {
        throw new BridgeError('GITHUB_CONNECTION_REQUIRED', `GitHub authorization ended with ${result.status}; no fallback or local credential replacement was attempted.`, 401);
      } else {
        throw new BridgeError('INVALID_RESPONSE', 'Unexpected GitHub authorization status.');
      }
    }
  }

  let generatedKey: string | undefined;
  try {
    let key = sessionKey;
    if (!('apiKey' in credentials)) {
      const created = await request('/key/generate', sessionKey, {
        user_id: identity.userId,
        key_alias: 'ccgc-claude',
        models,
      });
      key = text(created.key, 'generated LiteLLM virtual key');
      if (!/^sk-[A-Za-z0-9._-]{16,}$/.test(key)) throw new BridgeError('INVALID_RESPONSE', 'The gateway did not return a valid virtual key.');
      generatedKey = key;
    }
    return await client.loginLiteLLMKey(origin, key, { userId: identity.userId, credentialName, githubLogin, models }, signal);
  } catch (error) {
    if (generatedKey) {
      try { await request('/key/delete', sessionKey, { keys: [generatedKey] }, AbortSignal.timeout(30_000)); }
      catch { throw new BridgeError('KEY_CLEANUP_REQUIRED', 'Setup failed and its new key could not be revoked. Review your ccgc-claude keys in LiteLLM; the previous local profile was preserved.'); }
    }
    throw error;
  }
}
