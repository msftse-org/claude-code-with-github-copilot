import { setTimeout as delay } from 'node:timers/promises';
import { EnterpriseClient, responseJson, type EnterpriseProfile, type LiteLLMIdentity } from './enterprise-client.ts';
import { BridgeError, object, positive, text, type ObjectValue } from './protocol.ts';
import { gatewayUrl } from './remote.ts';

export interface SetupCallbacks {
  confirmIdentity(identity: LiteLLMIdentity & { githubLogin?: string }): Promise<boolean>;
  authorizeDevice(device: { verificationUri: string; userCode: string; expiresIn: number }): Promise<void>;
  credentialName?: string;
  verifiedGithubLogin?: string;
  signal?: AbortSignal;
}

export type SetupCredentials = { apiKey: string };

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

  if (!/^sk-[A-Za-z0-9._-]{16,}$/.test(credentials.apiKey)) {
    throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'A broker-provisioned LiteLLM virtual key is required.', 401);
  }
  const sessionKey = credentials.apiKey;
  const identity = await client.identifyLiteLLMKey(origin, sessionKey, signal);
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
  if (visibleModels.some(model => !allowedModels.includes(model))) {
    throw new BridgeError('IDENTITY_CONFLICT', 'Use a key scoped to the selected GitHub credential; this key also exposes other Claude routes.', 403);
  }
  const connectionPath = `/credentials/${encodeURIComponent(credentialName)}/user_connection`;
  const state = await request('/credentials/user_connections', sessionKey);
  const connections = (Array.isArray(state.connections) ? state.connections : []).map(object);
  const connection = connections.find(item => item.credential_name === credentialName && item.provider === 'github_copilot');
  if (!connection) throw new BridgeError('INVALID_RESPONSE', 'The selected model credential has no native per-user GitHub connection entry.');
  if (typeof connection.connected !== 'boolean') throw new BridgeError('INVALID_RESPONSE', 'Invalid per-user GitHub connection state.');
  let githubLogin = connection.connected === true ? text(connection.github_login, 'connected GitHub login') : undefined;
  if (callbacks.verifiedGithubLogin !== undefined) {
    if (!githubLogin) {
      throw new BridgeError('GITHUB_CONNECTION_REQUIRED', 'The enrolled GitHub connection is missing. Ask your administrator for a new enrollment code.', 401);
    }
    if (githubLogin.toLowerCase() !== callbacks.verifiedGithubLogin.toLowerCase()) {
      throw new BridgeError('IDENTITY_CONFLICT', 'The LiteLLM connection belongs to a different GitHub account than the enrollment.', 409);
    }
  }
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

  return client.loginLiteLLMKey(
    origin,
    sessionKey,
    { userId: identity.userId, credentialName, githubLogin, models },
    signal,
  );
}
