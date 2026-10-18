import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const authSource = await readFile(new URL('../web/admin/auth.js', import.meta.url), 'utf8');
const adminSource = await readFile(new URL('../web/admin/admin.js', import.meta.url), 'utf8');
const adminHtml = await readFile(new URL('../web/admin/index.html', import.meta.url), 'utf8');
const tenantId = '11111111-1111-1111-1111-111111111111';
const clientId = '33333333-3333-3333-3333-333333333333';
const scope = `api://${clientId}/CCGC.Invoke`;
const redirectUri = 'https://broker.example/ccgc/admin';

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
    keys() {
      return [...values.keys()].sort();
    },
  };
}

function unsignedJwt(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `eyJhbGciOiJub25lIn0.${encoded}.`;
}

test('employee enrollment asks only for email and GitHub username', () => {
  const form = adminHtml.match(/<form id="enrollment-form"[\s\S]*?<\/form>/u)?.[0];
  assert.ok(form);
  assert.deepEqual(
    [...form.matchAll(/<input\b[^>]*\bname="([^"]+)"/gu)].map(match => match[1]),
    ['userEmail', 'githubLogin'],
  );
  assert.doesNotMatch(form, /tenantId|userAlias|githubAccountId|additionalModels|name="models"/u);
});

test('employee enrollment submits only the minimal backend handoff', () => {
  const handler = adminSource.match(
    /async function submitEnrollment\(event\) \{[\s\S]*?\n  \}\n\n  async function submitRevocation/u,
  )?.[0];
  assert.ok(handler);
  assert.match(
    handler,
    /api\('\/ccgc\/admin\/enrollments', \{\s*userEmail:[\s\S]*?githubLogin:[\s\S]*?\}\)/u,
  );
  assert.doesNotMatch(handler, /tenantId|userAlias|githubAccountId|additionalModels|allModels|models:/u);
});

test('employee instructions use the tracked macOS enrollment script', () => {
  assert.match(adminSource, /bash ccgc-enterprise-macos\.sh enroll --gateway/u);
  assert.match(adminSource, /bash ccgc-enterprise-macos\.sh models/u);
  assert.doesNotMatch(adminSource, /\.\/ccgc-enterprise enroll/u);
});

test('browser auth exchanges a validated PKCE callback without persisting tokens', async () => {
  const verifier = 'v'.repeat(64);
  const sessionStorage = storage({
    'ccgc.admin.pkce.verifier': verifier,
    'ccgc.admin.pkce.state': 'expected-state',
    'ccgc.admin.pkce.return': JSON.stringify({
      path: '/ccgc/admin',
      createdAt: Date.now(),
    }),
  });
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let replaced = '';
  const window = {
    location: {
      href: `${redirectUri}?code=authorization-code&state=expected-state&session_state=opaque`,
      origin: 'https://broker.example',
      assign() { throw new Error('unexpected redirect'); },
    },
    history: {
      state: null,
      replaceState(_state: unknown, _title: string, url: string) {
        replaced = url;
      },
    },
    sessionStorage,
    crypto: webcrypto,
    btoa,
    atob,
    CCGC_ADMIN_AUTH: undefined as unknown,
  };
  const context = {
    window,
    document: { title: 'CCGC administration' },
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === '/ccgc/admin/config') {
        return Response.json({ tenantId, clientId, scope, redirectUri });
      }
      return Response.json({
        access_token: 'access-token-value-1234567890',
        expires_in: 3600,
        id_token: unsignedJwt({
          name: 'Avery Morgan',
          preferred_username: 'avery@example.com',
        }),
      });
    },
    URL,
    URLSearchParams,
    Uint8Array,
    TextEncoder,
    TextDecoder,
    JSON,
    Date,
    Object,
    Array,
    String,
    Number,
    RegExp,
    Error,
    Promise,
    Math,
    setTimeout,
  };
  vm.runInNewContext(authSource, context);
  const auth = window.CCGC_ADMIN_AUTH as {
    acquireToken(): Promise<string>;
    principal(): Promise<{ displayName?: string; username?: string } | undefined>;
    signOut(): Promise<void>;
  };
  assert.equal(await auth.acquireToken(), 'access-token-value-1234567890');
  assert.equal(replaced, '/ccgc/admin');
  assert.deepEqual(sessionStorage.keys(), []);
  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.url, `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`);
  const body = new URLSearchParams(String(requests[1]!.init?.body));
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code_verifier'), verifier);
  assert.equal(body.get('redirect_uri'), redirectUri);
  assert.equal(body.get('scope'), `openid profile ${scope}`);
  const principal = await auth.principal();
  assert.equal(principal?.displayName, 'Avery Morgan');
  assert.equal(principal?.username, 'avery@example.com');
  await auth.signOut();
  assert.equal(await auth.principal(), undefined);
});

test('browser auth creates an S256 request and stores only short-lived PKCE state', async () => {
  const sessionStorage = storage();
  let assigned = '';
  const window = {
    location: {
      href: redirectUri,
      origin: 'https://broker.example',
      assign(url: string) { assigned = url; },
    },
    history: { state: null, replaceState() {} },
    sessionStorage,
    crypto: webcrypto,
    btoa,
    atob,
    CCGC_ADMIN_AUTH: undefined as unknown,
  };
  const context = {
    window,
    document: { title: 'CCGC administration' },
    fetch: async () => Response.json({ tenantId, clientId, scope, redirectUri }),
    URL,
    URLSearchParams,
    Uint8Array,
    TextEncoder,
    TextDecoder,
    JSON,
    Date,
    Object,
    Array,
    String,
    Number,
    RegExp,
    Error,
    Promise,
    Math,
    setTimeout,
  };
  vm.runInNewContext(authSource, context);
  const auth = window.CCGC_ADMIN_AUTH as { acquireToken(): Promise<string> };
  void auth.acquireToken();
  await new Promise(resolve => setTimeout(resolve, 20));
  const authorize = new URL(assigned);
  assert.equal(
    authorize.origin + authorize.pathname,
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`,
  );
  assert.equal(authorize.searchParams.get('response_type'), 'code');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.get('redirect_uri'), redirectUri);
  assert.equal(authorize.searchParams.get('scope'), `openid profile ${scope}`);
  assert.deepEqual(sessionStorage.keys(), [
    'ccgc.admin.pkce.return',
    'ccgc.admin.pkce.state',
    'ccgc.admin.pkce.verifier',
  ]);
});
