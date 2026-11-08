import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CREDENTIAL_NAME = 'github-copilot-user';
const EMPLOYEE_KEY_ROUTES = [
  'llm_api_routes',
  'info_routes',
  '/credentials/user_connections',
  `/credentials/${CREDENTIAL_NAME}/user_connection`,
];

function fail(message) {
  throw new Error(message);
}

function validateLogin(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value)) {
    fail('github_username is not a valid GitHub username.');
  }
  return value;
}

function validateOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('LITELLM_URL must be an HTTPS origin.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/'
    || url.search || url.hash) {
    fail('LITELLM_URL must be an HTTPS origin without credentials, path, query, or fragment.');
  }
  return url.origin;
}

function validateMasterKey(value) {
  if (typeof value !== 'string' || !/^sk-[A-Za-z0-9._-]{16,}$/.test(value) || value.length > 515) {
    fail('LITELLM_MASTER_KEY is missing or invalid.');
  }
  return value;
}

async function jsonRequest(fetcher, url, { masterKey, body, method = 'GET', allowNotFound = false } = {}) {
  const headers = { accept: 'application/json', 'user-agent': 'ccgc-employee-access' };
  if (masterKey) headers.authorization = `Bearer ${masterKey}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let response;
  try {
    response = await fetcher(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    fail('A required GitHub or LiteLLM request failed.');
  }
  if (allowNotFound && response.status === 404) return undefined;
  let value;
  try {
    value = await response.json();
  } catch {
    fail(`A required service returned invalid JSON (HTTP ${response.status}).`);
  }
  if (!response.ok) fail(`A required service returned HTTP ${response.status}.`);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('A required service returned an invalid response.');
  }
  return value;
}

async function githubAccount(fetcher, requestedLogin) {
  const account = await jsonRequest(fetcher, `https://api.github.com/users/${encodeURIComponent(requestedLogin)}`);
  const login = validateLogin(account.login);
  if (account.type !== 'User' || login.toLowerCase() !== requestedLogin.toLowerCase()
    || !Number.isSafeInteger(account.id) || account.id <= 0) {
    fail('GitHub returned an account that does not match the requested user.');
  }
  return { login, accountId: account.id };
}

async function findUser(fetcher, origin, masterKey, accountId) {
  let totalPages = 1;
  const matches = [];
  for (let page = 1; page <= totalPages; page += 1) {
    const url = new URL('/user/list', origin);
    url.searchParams.set('role', 'internal_user');
    url.searchParams.set('page', String(page));
    url.searchParams.set('page_size', '100');
    const result = await jsonRequest(fetcher, url, { masterKey });
    if (!Array.isArray(result.users) || !Number.isInteger(result.total_pages)
      || result.total_pages < 0 || result.total_pages > 100) {
      fail('LiteLLM returned an invalid user-list response.');
    }
    totalPages = Math.max(1, result.total_pages);
    for (const user of result.users) {
      if (String(user.metadata?.github_account_id ?? '') === String(accountId)) matches.push(user);
    }
  }
  if (matches.length > 1) fail('Multiple LiteLLM users are linked to this GitHub account; contact IT.');
  if (!matches.length) return undefined;
  const user = matches[0];
  if (typeof user.user_id !== 'string' || user.user_role !== 'internal_user') {
    fail('LiteLLM returned an invalid employee user record.');
  }
  return user;
}

async function modelsForUser(fetcher, origin, masterKey) {
  const result = await jsonRequest(fetcher, new URL('/v1/models', origin), { masterKey });
  if (!Array.isArray(result.data)) fail('LiteLLM returned an invalid model list.');
  const models = [...new Set(result.data
    .map(model => model?.id)
    .filter(model => typeof model === 'string' && /^claude-[a-z0-9.-]+$/.test(model)))];
  if (!models.length) fail('LiteLLM has no approved Claude models available.');
  return models;
}

async function ensureUser(fetcher, origin, masterKey, account, models, existing) {
  if (existing) {
    await jsonRequest(fetcher, new URL('/user/update', origin), {
      masterKey,
      method: 'POST',
      body: { user_id: existing.user_id, user_alias: account.login, models },
    });
    return existing.user_id;
  }
  const userId = randomUUID();
  await jsonRequest(fetcher, new URL('/user/new', origin), {
    masterKey,
    method: 'POST',
    body: {
      user_id: userId,
      user_alias: account.login,
      user_role: 'internal_user',
      models,
      auto_create_key: false,
      send_invite_email: false,
      metadata: {
        ccgc_managed: true,
        github_login: account.login,
        github_account_id: account.accountId,
      },
    },
  });
  return userId;
}

async function revokeUser(fetcher, origin, masterKey, userId) {
  const cleanup = await jsonRequest(fetcher, new URL('/key/generate', origin), {
    masterKey,
    method: 'POST',
    body: {
      user_id: userId,
      key_alias: `ccgc-offboard-${randomUUID()}`,
      duration: '10m',
      allowed_routes: [`/credentials/${CREDENTIAL_NAME}/user_connection`],
      metadata: { ccgc_purpose: 'offboarding' },
    },
  });
  if (typeof cleanup.key !== 'string' || !/^sk-[A-Za-z0-9._-]{16,}$/.test(cleanup.key)) {
    fail('LiteLLM returned an invalid temporary offboarding key.');
  }
  await jsonRequest(fetcher, new URL(`/credentials/${CREDENTIAL_NAME}/user_connection`, origin), {
    masterKey: cleanup.key,
    method: 'DELETE',
    allowNotFound: true,
  });
  await jsonRequest(fetcher, new URL('/user/delete', origin), {
    masterKey,
    method: 'POST',
    body: { user_ids: [userId] },
  });
}

export async function manageEmployeeAccess({
  action,
  githubLogin,
  litellmUrl,
  masterKey,
  fetcher = fetch,
}) {
  if (action !== 'enroll' && action !== 'revoke') fail('Unsupported action.');
  const requestedLogin = validateLogin(githubLogin);
  const origin = validateOrigin(litellmUrl);
  const adminKey = validateMasterKey(masterKey);
  const account = await githubAccount(fetcher, requestedLogin);
  const existing = await findUser(fetcher, origin, adminKey, account.accountId);

  if (action === 'revoke') {
    if (existing) await revokeUser(fetcher, origin, adminKey, existing.user_id);
    return { action, githubLogin: account.login, deleted: existing ? 1 : 0 };
  }

  const models = await modelsForUser(fetcher, origin, adminKey);
  const userId = await ensureUser(fetcher, origin, adminKey, account, models, existing);
  const keyAlias = `ccgc-claude-${randomUUID()}`;
  const generated = await jsonRequest(fetcher, new URL('/key/generate', origin), {
    masterKey: adminKey,
    method: 'POST',
    body: {
      user_id: userId,
      key_alias: keyAlias,
      models,
      duration: '90d',
      allowed_routes: EMPLOYEE_KEY_ROUTES,
      metadata: {
        ccgc_purpose: 'claude-code',
        github_login: account.login,
        github_account_id: account.accountId,
      },
    },
  });
  const expiresAt = typeof generated.expires === 'string' ? Date.parse(generated.expires) : NaN;
  if (typeof generated.key !== 'string' || !/^sk-[A-Za-z0-9._-]{16,}$/.test(generated.key)
    || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    fail('LiteLLM returned an invalid employee key.');
  }
  return {
    action,
    githubLogin: account.login,
    userId,
    key: generated.key,
    expiresAt: new Date(expiresAt).toISOString(),
    models,
    reusedUser: Boolean(existing),
    gateway: origin,
  };
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) fail(`Required workflow setting ${name} is missing.`);
  return value;
}

async function main() {
  const action = requiredEnvironment('ACTION');
  const result = await manageEmployeeAccess({
    action,
    githubLogin: requiredEnvironment('GITHUB_USERNAME'),
    litellmUrl: requiredEnvironment('LITELLM_URL'),
    masterKey: requiredEnvironment('LITELLM_MASTER_KEY'),
  });
  if (action === 'revoke') {
    process.stdout.write(`Revoked LiteLLM access for ${result.githubLogin}; deleted user: ${result.deleted}.\n`);
    process.stdout.write(`## CCGC access revoked for \`${result.githubLogin}\`\n\n`);
    process.stdout.write(`- Deleted LiteLLM users (with their keys and Copilot connection): ${result.deleted}\n`);
    process.stdout.write('\nClaude Code stops working on its next request.\n');
    return;
  }
  const summary = [
    `## CCGC enrollment for \`${result.githubLogin}\``,
    '',
    `LiteLLM key (expires **${result.expiresAt}**):`,
    '',
    '```text',
    result.key,
    '```',
    '',
    'Send this key to the employee through a private channel. Anyone who can read this workflow run can use it until it expires or is revoked.',
    '',
    'Save the current `ccgc-enterprise-macos.sh` supplied by IT in Downloads, then run:',
    '',
    '```sh',
    `bash "$HOME/Downloads/ccgc-enterprise-macos.sh" enroll --gateway ${result.gateway}`,
    '```',
    '',
    'Paste the key when prompted. GitHub opens automatically; approve with the Copilot account for this employee. Then run `claude`.',
    '',
    'The key lasts 90 days. Ask IT to issue another key to renew it. Never share the key.',
    '',
    `Approved models: ${result.models.join(', ')}`,
  ].join('\n');
  process.stdout.write(`Created a 90-day LiteLLM key for ${result.githubLogin}. The key is in the protected run summary.\n`);
  process.stdout.write(`${summary}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Employee access workflow failed.');
    process.exitCode = 1;
  });
}
