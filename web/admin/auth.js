(function configureEntraAuth(global) {
  'use strict';

  if (global.CCGC_ADMIN_AUTH) return;

  const storageKeys = Object.freeze({
    verifier: 'ccgc.admin.pkce.verifier',
    state: 'ccgc.admin.pkce.state',
    returnMarker: 'ccgc.admin.pkce.return',
  });
  const callbackParameters = [
    'code',
    'state',
    'session_state',
    'error',
    'error_description',
    'error_subcode',
  ];
  const callbackUrl = new URL(global.location.href);
  let pendingCallback = callbackUrl.searchParams.has('code')
    || callbackUrl.searchParams.has('error');

  let accessToken = '';
  let tokenExpiresAt = 0;
  let principalClaims;
  let configPromise;
  let callbackPromise;
  let redirectStarted = false;

  function base64Url(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return global.btoa(binary)
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/u, '');
  }

  function randomValue(length) {
    const bytes = new Uint8Array(length);
    global.crypto.getRandomValues(bytes);
    return base64Url(bytes);
  }

  async function sha256(value) {
    const digest = await global.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(value),
    );
    return base64Url(new Uint8Array(digest));
  }

  function parseClaims(token) {
    if (typeof token !== 'string') return undefined;
    const part = token.split('.')[1];
    if (!part) return undefined;
    try {
      const padded = part.replaceAll('-', '+').replaceAll('_', '/')
        .padEnd(Math.ceil(part.length / 4) * 4, '=');
      const bytes = Uint8Array.from(global.atob(padded), character => character.charCodeAt(0));
      const claims = JSON.parse(new TextDecoder().decode(bytes));
      return claims && typeof claims === 'object' && !Array.isArray(claims)
        ? claims
        : undefined;
    } catch {
      return undefined;
    }
  }

  function cleanCallbackUrl() {
    const clean = new URL(global.location.href);
    for (const name of callbackParameters) clean.searchParams.delete(name);
    global.history.replaceState(
      global.history.state,
      document.title,
      `${clean.pathname}${clean.search}${clean.hash}`,
    );
  }

  function clearPkceState() {
    for (const key of Object.values(storageKeys)) {
      global.sessionStorage.removeItem(key);
    }
  }

  async function configuration() {
    if (!configPromise) {
      configPromise = fetch('/ccgc/admin/config', {
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'error',
      }).then(async response => {
        if (!response.ok) {
          throw new Error(`Administrator browser configuration returned HTTP ${response.status}.`);
        }
        const config = await response.json();
        if (!config || typeof config !== 'object'
          || !/^[0-9a-f-]{36}$/iu.test(config.tenantId)
          || !/^[0-9a-f-]{36}$/iu.test(config.clientId)
          || typeof config.scope !== 'string'
          || !config.scope.trim()
          || /[\s\r\n]/u.test(config.scope)
          || typeof config.redirectUri !== 'string') {
          throw new Error('Administrator browser configuration is invalid.');
        }
        const redirect = new URL(config.redirectUri);
        if (redirect.protocol !== 'https:'
          || redirect.origin !== global.location.origin
          || redirect.pathname !== '/ccgc/admin'
          || redirect.search
          || redirect.hash) {
          throw new Error('Administrator redirect URI does not match this broker.');
        }
        return Object.freeze({
          tenantId: config.tenantId.toLowerCase(),
          clientId: config.clientId.toLowerCase(),
          scope: config.scope,
          redirectUri: redirect.href,
        });
      });
    }
    return configPromise;
  }

  function tokenEndpoint(config) {
    return `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`;
  }

  function authorizeEndpoint(config) {
    return `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/authorize`;
  }

  function applyTokenResponse(payload) {
    if (!payload || typeof payload !== 'object'
      || typeof payload.access_token !== 'string'
      || payload.access_token.length < 20
      || /[\r\n]/u.test(payload.access_token)
      || typeof payload.expires_in !== 'number'
      || !Number.isFinite(payload.expires_in)
      || payload.expires_in <= 0) {
      throw new Error('Microsoft Entra returned an invalid token response.');
    }
    accessToken = payload.access_token;
    tokenExpiresAt = Date.now() + Math.max(0, payload.expires_in - 60) * 1000;
    principalClaims = parseClaims(payload.id_token) ?? parseClaims(payload.access_token);
    return accessToken;
  }

  async function exchangeCallback() {
    pendingCallback = false;
    const url = new URL(global.location.href);
    const error = url.searchParams.get('error');
    const description = url.searchParams.get('error_description');
    if (error) {
      clearPkceState();
      cleanCallbackUrl();
      throw new Error(description
        ? `Microsoft Entra sign-in failed: ${description}`
        : `Microsoft Entra sign-in failed: ${error}`);
    }

    const code = url.searchParams.get('code');
    if (!code) return undefined;
    const returnedState = url.searchParams.get('state');
    const expectedState = global.sessionStorage.getItem(storageKeys.state);
    const verifier = global.sessionStorage.getItem(storageKeys.verifier);
    const returnMarker = global.sessionStorage.getItem(storageKeys.returnMarker);
    clearPkceState();
    cleanCallbackUrl();
    if (!returnedState || !expectedState || returnedState !== expectedState
      || !verifier || !/^[A-Za-z0-9_-]{43,128}$/u.test(verifier)
      || !returnMarker) {
      throw new Error('Microsoft Entra sign-in state validation failed.');
    }
    let marker;
    try {
      marker = JSON.parse(returnMarker);
    } catch {
      throw new Error('Microsoft Entra sign-in return state is invalid.');
    }
    if (!marker || marker.path !== '/ccgc/admin'
      || typeof marker.createdAt !== 'number'
      || Date.now() - marker.createdAt > 10 * 60 * 1000
      || marker.createdAt > Date.now() + 60 * 1000) {
      throw new Error('Microsoft Entra sign-in request expired.');
    }

    const config = await configuration();
    const response = await fetch(tokenEndpoint(config), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: config.redirectUri,
        scope: `openid profile ${config.scope}`,
      }),
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
    });
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) {
      const reason = payload && typeof payload.error_description === 'string'
        ? payload.error_description
        : `HTTP ${response.status}`;
      throw new Error(`Microsoft Entra token exchange failed: ${reason}`);
    }
    return applyTokenResponse(payload);
  }

  async function beginLogin() {
    if (redirectStarted) return new Promise(() => {});
    const config = await configuration();
    const verifier = randomValue(64);
    const state = randomValue(32);
    const challenge = await sha256(verifier);
    global.sessionStorage.setItem(storageKeys.verifier, verifier);
    global.sessionStorage.setItem(storageKeys.state, state);
    global.sessionStorage.setItem(storageKeys.returnMarker, JSON.stringify({
      path: '/ccgc/admin',
      createdAt: Date.now(),
    }));
    const authorize = new URL(authorizeEndpoint(config));
    authorize.search = new URLSearchParams({
      client_id: config.clientId,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      redirect_uri: config.redirectUri,
      response_type: 'code',
      response_mode: 'query',
      scope: `openid profile ${config.scope}`,
      state,
    }).toString();
    redirectStarted = true;
    global.location.assign(authorize.href);
    return new Promise(() => {});
  }

  async function acquireToken() {
    if (accessToken && Date.now() < tokenExpiresAt) return accessToken;
    accessToken = '';
    tokenExpiresAt = 0;
    principalClaims = undefined;
    if (pendingCallback) {
      if (!callbackPromise) callbackPromise = exchangeCallback();
      const callbackToken = await callbackPromise;
      if (callbackToken) return callbackToken;
    }
    return beginLogin();
  }

  global.CCGC_ADMIN_AUTH = Object.freeze({
    isConfigured: true,
    hasPendingCallback: pendingCallback,
    acquireToken,
    async signOut() {
      accessToken = '';
      tokenExpiresAt = 0;
      principalClaims = undefined;
      callbackPromise = undefined;
      redirectStarted = false;
      pendingCallback = false;
      clearPkceState();
    },
    async principal() {
      if (!principalClaims) return undefined;
      const displayName = typeof principalClaims.name === 'string'
        ? principalClaims.name
        : undefined;
      const username = typeof principalClaims.preferred_username === 'string'
        ? principalClaims.preferred_username
        : typeof principalClaims.upn === 'string'
          ? principalClaims.upn
          : undefined;
      return { displayName, username };
    },
  });
})(window);
