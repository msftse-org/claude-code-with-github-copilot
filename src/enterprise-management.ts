import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DefaultAzureCredential } from '@azure/identity';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { BridgeError, object, parseJson, positive, text, type ObjectValue } from './protocol.ts';
import { PostgresEnterpriseStore, type EnterpriseEnrollment } from './enterprise-store.ts';

const exec = promisify(execFile);
const API_KEY_TTL_SECONDS = 30 * 24 * 60 * 60;
const ENROLLMENT_TTL_SECONDS = 60 * 60;
const ENROLLMENT_CREDENTIAL = 'github-copilot-user';
const EMPLOYEE_KEY_DURATION = '90d';
const PENDING_KEY_DURATION = '2h';
const EMPLOYEE_KEY_ROUTES = ['llm_api_routes', 'info_routes', '/credentials/user_connections'];
const PENDING_KEY_ROUTES = ['/credentials/user_connections', `/credentials/${ENROLLMENT_CREDENTIAL}/user_connection`];

export interface EnrollmentSecrets {
  set(name: string, value: string, expiresAt: Date): Promise<void>;
  get(name: string): Promise<string>;
  remove(name: string): Promise<void>;
}

function fixedOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/'
    || url.search || url.hash) {
    throw new BridgeError('INVALID_OPTIONS', 'LiteLLM must use a fixed HTTPS origin.');
  }
  return url.origin;
}

function userCredential(input: ObjectValue) {
  const apiKey = text(input.litellmApiKey, 'LiteLLM user key');
  const credentialName = text(input.litellmCredentialName, 'LiteLLM credential name');
  const githubLogin = text(input.githubLogin, 'GitHub login');
  if (!/^sk-[A-Za-z0-9._-]{16,}$/.test(apiKey)
    || !/^[A-Za-z0-9._-]{1,128}$/.test(credentialName)
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(githubLogin)) {
    throw new BridgeError('INVALID_REQUEST', 'Invalid LiteLLM user connection input.');
  }
  return { apiKey, credentialName, githubLogin };
}

export class EnterpriseManagement {
  readonly litellmUrl: string;
  readonly litellmMasterKey: string;
  readonly postgresUrl: string;
  readonly tenantId: string;
  readonly enrollmentModels: string[];
  readonly fetcher: typeof fetch;
  readonly credential: DefaultAzureCredential;
  readonly enrollmentSecrets?: EnrollmentSecrets;
  readonly storeFactory: () => PostgresEnterpriseStore;

  constructor(options: {
    litellmUrl: string;
    litellmMasterKey: string;
    postgresUrl: string;
    tenantId: string;
    enrollmentModels: string[];
    fetcher?: typeof fetch;
    credential?: DefaultAzureCredential;
    enrollmentSecrets?: EnrollmentSecrets;
    storeFactory?: () => PostgresEnterpriseStore;
  }) {
    this.litellmUrl = fixedOrigin(options.litellmUrl);
    this.litellmMasterKey = options.litellmMasterKey;
    this.postgresUrl = options.postgresUrl;
    this.tenantId = options.tenantId.toLowerCase();
    this.enrollmentModels = [...new Set(options.enrollmentModels)];
    this.fetcher = options.fetcher ?? fetch;
    this.credential = options.credential ?? new DefaultAzureCredential();
    this.enrollmentSecrets = options.enrollmentSecrets;
    this.storeFactory = options.storeFactory
      ?? (() => new PostgresEnterpriseStore(this.postgresUrl, this.credential, false, false));
    if (!/^sk-[A-Za-z0-9._-]{16,}$/.test(this.litellmMasterKey)
      || !/^[0-9a-f-]{36}$/i.test(this.tenantId)
      || this.enrollmentModels.length === 0
      || this.enrollmentModels.some(model => !/^claude-[a-z0-9.-]+$/.test(model))) {
      throw new BridgeError('INVALID_OPTIONS', 'Enterprise management configuration is invalid.');
    }
  }

  private request(path: string, apiKey: string, init?: RequestInit): Promise<ObjectValue>;
  private request(path: string, apiKey: string, init: RequestInit | undefined, missingIsEmpty: true): Promise<ObjectValue | undefined>;
  private async request(
    path: string,
    apiKey: string,
    init: RequestInit = {},
    missingIsEmpty = false,
  ): Promise<ObjectValue | undefined> {
    const response = await this.fetcher(`${this.litellmUrl}${path}`, {
      ...init,
      headers: {
        authorization: ['Bearer', apiKey].join(' '),
        'content-type': 'application/json',
        ...init.headers,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (missingIsEmpty && response.status === 404) return undefined;
    const raw = await response.text();
    if (!response.ok) {
      throw new BridgeError('GATEWAY_UNAVAILABLE', `LiteLLM returned HTTP ${response.status}.`, 502);
    }
    return parseJson(raw);
  }

  private async adminCommand(command: 'link' | 'revoke', input: ObjectValue): Promise<ObjectValue> {
    const flag = command === 'link' ? '--confirm-same-user' : '--confirm-revoke';
    const script = fileURLToPath(new URL('./enterprise-admin.ts', import.meta.url));
    const child = exec(process.execPath, [script, command, flag], {
      env: {
        ...process.env,
        CCGC_LITELLM_URL: this.litellmUrl,
        CCGC_LITELLM_MASTER_KEY: this.litellmMasterKey,
        CCGC_POSTGRES_URL: this.postgresUrl,
      },
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    child.child.stdin?.end(JSON.stringify(input));
    const result = await child;
    return parseJson(result.stdout);
  }

  private store(): PostgresEnterpriseStore {
    return this.storeFactory();
  }

  private secrets(): EnrollmentSecrets {
    if (!this.enrollmentSecrets) throw new BridgeError('STARTUP_FAILED', 'Enrollment secret storage is unavailable.', 503);
    return this.enrollmentSecrets;
  }

  private enrollmentCode(value: string): string {
    if (!/^CCGC-[A-Za-z0-9_-]{24}$/.test(value)) {
      throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'Enrollment code is invalid.', 401);
    }
    return createHash('sha256').update(value).digest('hex');
  }

  private async githubAccount(requestedLogin: string): Promise<{ login: string; accountId: number }> {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(requestedLogin)) {
      throw new BridgeError('INVALID_REQUEST', 'GitHub username is invalid.');
    }
    const response = await this.fetcher(
      `https://api.github.com/users/${encodeURIComponent(requestedLogin)}`,
      {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'ccgc-enterprise-broker',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (response.status === 404) {
      throw new BridgeError('INVALID_REQUEST', 'GitHub user was not found.');
    }
    if (!response.ok) {
      throw new BridgeError(
        'GATEWAY_UNAVAILABLE',
        `GitHub identity verification returned HTTP ${response.status}.`,
        502,
      );
    }
    const account = object(parseJson(await response.text()));
    const login = text(account.login, 'GitHub login');
    const accountId = positive(account.id, 'GitHub account ID');
    if (account.type !== 'User' || login.toLowerCase() !== requestedLogin.toLowerCase()) {
      throw new BridgeError('IDENTITY_CONFLICT', 'GitHub returned a different account identity.', 409);
    }
    return { login, accountId };
  }

  private async generateKey(body: ObjectValue): Promise<{ key: string; expiresAt: string }> {
    const generated = await this.request('/key/generate', this.litellmMasterKey, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const key = text(generated.key, 'LiteLLM key');
    const expiresAt = typeof generated.expires === 'string' ? Date.parse(generated.expires) : Number.NaN;
    if (!/^sk-[A-Za-z0-9._-]{16,}$/.test(key) || !Number.isFinite(expiresAt)) {
      throw new BridgeError('INVALID_RESPONSE', 'LiteLLM returned an invalid virtual key.', 502);
    }
    return { key, expiresAt: new Date(expiresAt).toISOString() };
  }

  private async employeeUser(userId: string): Promise<ObjectValue | undefined> {
    const info = await this.request(
      `/user/info?user_id=${encodeURIComponent(userId)}`,
      this.litellmMasterKey,
      undefined,
      true,
    );
    if (!info || info.user_info === null || info.user_info === undefined) return undefined;
    const user = object(info.user_info);
    if (user.user_role !== 'internal_user') {
      throw new BridgeError('IDENTITY_CONFLICT', 'The LiteLLM user is not a CCGC internal user.', 409);
    }
    return user;
  }

  private async ensureEmployeeUser(
    userId: string,
    github: { login: string; accountId: number },
    userEmail: string,
    models: string[],
  ): Promise<void> {
    if (await this.employeeUser(userId)) {
      await this.request('/user/update', this.litellmMasterKey, {
        method: 'POST',
        body: JSON.stringify({ user_id: userId, user_alias: github.login, models }),
      });
      return;
    }
    await this.request('/user/new', this.litellmMasterKey, {
      method: 'POST',
      body: JSON.stringify({
        user_id: userId,
        user_alias: github.login,
        user_role: 'internal_user',
        models,
        auto_create_key: false,
        send_invite_email: false,
        metadata: {
          ccgc_managed: true,
          github_login: github.login,
          github_account_id: github.accountId,
          ...(userEmail ? { ccgc_email: userEmail } : {}),
        },
      }),
    });
  }

  private async userKeys(userId: string): Promise<Array<{ token: string; alias: string }>> {
    const keys: Array<{ token: string; alias: string }> = [];
    for (let page = 1; page <= 20; page++) {
      const listed = await this.request(
        `/key/list?user_id=${encodeURIComponent(userId)}&page=${page}&size=100&return_full_object=true`,
        this.litellmMasterKey,
      );
      for (const value of Array.isArray(listed.keys) ? listed.keys : []) {
        const key = object(value);
        const token = text(key.token, 'LiteLLM key identifier');
        if (token.length > 512) throw new BridgeError('INVALID_RESPONSE', 'LiteLLM returned an invalid key identifier.', 502);
        keys.push({ token, alias: typeof key.key_alias === 'string' ? key.key_alias : '' });
      }
      const totalPages = listed.total_pages === null || listed.total_pages === undefined ? 1 : Number(listed.total_pages);
      if (!Number.isInteger(totalPages) || totalPages < 0 || totalPages > 20) {
        throw new BridgeError('INVALID_RESPONSE', 'LiteLLM returned invalid key pagination.', 502);
      }
      if (page >= totalPages) break;
    }
    return keys;
  }

  private async disconnectGitHub(apiKey: string): Promise<void> {
    await this.request(`/credentials/${ENROLLMENT_CREDENTIAL}/user_connection`, apiKey, { method: 'DELETE' });
  }

  private requireLiteLLMClient(input: ObjectValue): void {
    if (input.credentialType !== 'litellm') {
      throw new BridgeError(
        'CLIENT_UPGRADE_REQUIRED',
        'Update the repository and run ccgc-enterprise setup; this client cannot use LiteLLM enrollment.',
        400,
      );
    }
  }

  private async enrollmentOutput(
    enrollment: EnterpriseEnrollment,
    output?: { apiKey: string; apiKeyExpiresAt: string },
  ): Promise<ObjectValue> {
    if (enrollment.status !== 'completed' && !output) return { status: 'pending', interval: 5 };
    if (!output) {
      if (!enrollment.outputSecretName) throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'Enrollment output is unavailable.', 401);
      const stored = object(parseJson(await this.secrets().get(enrollment.outputSecretName)));
      output = {
        apiKey: text(stored.apiKey, 'LiteLLM virtual key'),
        apiKeyExpiresAt: text(stored.apiKeyExpiresAt, 'LiteLLM virtual key expiry'),
      };
    }
    return {
      status: 'completed',
      apiKey: output.apiKey,
      apiKeyExpiresAt: output.apiKeyExpiresAt,
      litellmUserId: enrollment.objectId,
      litellmCredentialName: ENROLLMENT_CREDENTIAL,
      githubLogin: enrollment.githubLogin,
      githubAccountId: enrollment.githubAccountId,
      models: enrollment.models,
    };
  }

  private async finishEnrollment(store: PostgresEnterpriseStore, enrollment: EnterpriseEnrollment): Promise<ObjectValue> {
    const keyAlias = `ccgc-claude-${randomUUID()}`;
    const issued = await this.generateKey({
      user_id: enrollment.objectId,
      key_alias: keyAlias,
      models: enrollment.models,
      duration: EMPLOYEE_KEY_DURATION,
      allowed_routes: EMPLOYEE_KEY_ROUTES,
      metadata: {
        ccgc_purpose: 'claude-code',
        ccgc_enrollment_id: enrollment.id,
        github_login: enrollment.githubLogin,
        github_account_id: enrollment.githubAccountId,
      },
    });
    const output = { apiKey: issued.key, apiKeyExpiresAt: issued.expiresAt };
    const outputSecretName = `ccgc-enrollment-output-${enrollment.id.replaceAll('-', '')}`;
    await this.secrets().set(outputSecretName, JSON.stringify({ ...output, keyAlias }), new Date(enrollment.expiresAt));
    await store.completeEnrollment(enrollment.id, outputSecretName);
    return this.enrollmentOutput({ ...enrollment, status: 'completed', outputSecretName }, output);
  }

  async createUser(input: ObjectValue): Promise<ObjectValue> {
    const userId = text(input.userId, 'LiteLLM user ID');
    const userEmail = text(input.userEmail, 'LiteLLM user email');
    const userAlias = text(input.userAlias, 'LiteLLM user alias');
    const models = Array.isArray(input.models) ? input.models.map(value => text(value, 'model ID')) : [];
    if (!/^[0-9a-f-]{36}$/i.test(userId) || !userEmail.includes('@') || models.length === 0
      || models.some(model => !/^claude-[a-z0-9.-]+$/.test(model))) {
      throw new BridgeError('INVALID_REQUEST', 'Invalid LiteLLM internal-user input.');
    }
    const created = await this.request('/user/new', this.litellmMasterKey, {
      method: 'POST',
      body: JSON.stringify({
        user_id: userId.toLowerCase(),
        user_email: userEmail,
        user_alias: userAlias,
        user_role: 'internal_user',
        models,
      }),
    });
    const key = text(created.key, 'LiteLLM user key');
    if (!/^sk-[A-Za-z0-9._-]{16,}$/.test(key)) {
      throw new BridgeError('INVALID_RESPONSE', 'LiteLLM returned an invalid user key.', 502);
    }
    return {
      status: 'created',
      userId: typeof created.user_id === 'string' ? created.user_id : userId.toLowerCase(),
      litellmApiKey: key,
    };
  }

  async startConnection(input: ObjectValue): Promise<ObjectValue> {
    const { apiKey, credentialName, githubLogin } = userCredential(input);
    const connections = await this.request('/credentials/user_connections', apiKey);
    if (!Array.isArray(connections.connections)) {
      throw new BridgeError('INVALID_RESPONSE', 'LiteLLM returned an invalid connection list.', 502);
    }
    const current = connections.connections.map(value => object(value))
      .find(value => value.credential_name === credentialName);
    if (current?.connected === true) {
      const connectedLogin = text(current.github_login, 'connected GitHub login');
      if (connectedLogin.toLowerCase() !== githubLogin.toLowerCase()) {
        throw new BridgeError('IDENTITY_CONFLICT', 'The LiteLLM user is connected to another GitHub account.', 409);
      }
      return { status: 'connected', githubLogin: connectedLogin, credentialName };
    }
    const flow = await this.request(
      `/credentials/${encodeURIComponent(credentialName)}/user_connection/start`,
      apiKey,
      { method: 'POST' },
    );
    const verificationUri = text(flow.verification_uri, 'verification URI');
    const userCode = text(flow.user_code, 'device code');
    const flowHandle = text(flow.flow_handle, 'flow handle');
    const expiresIn = positive(flow.expires_in, 'device flow expiry');
    const interval = positive(flow.interval, 'device flow interval');
    if (verificationUri !== 'https://github.com/login/device' || expiresIn > 1800 || interval > 60) {
      throw new BridgeError('ENDPOINT_REJECTED', 'Unexpected GitHub device-flow contract.', 502);
    }
    return {
      status: 'authorization_required',
      verificationUri,
      userCode,
      flowHandle,
      expiresIn,
      interval,
      expectedGithubLogin: githubLogin,
    };
  }

  async pollConnection(input: ObjectValue): Promise<ObjectValue> {
    const { apiKey, credentialName, githubLogin } = userCredential(input);
    const flowHandle = text(input.flowHandle, 'flow handle');
    const result = await this.request(
      `/credentials/${encodeURIComponent(credentialName)}/user_connection/poll`,
      apiKey,
      { method: 'POST', body: JSON.stringify({ flow_handle: flowHandle }) },
    );
    const status = text(result.status, 'device flow status');
    if (status === 'connected') {
      const connectedLogin = text(result.github_login, 'connected GitHub login');
      if (connectedLogin.toLowerCase() !== githubLogin.toLowerCase()) {
        throw new BridgeError('IDENTITY_CONFLICT', 'The authorized GitHub account does not match the employee.', 409);
      }
      return { status, githubLogin: connectedLogin, credentialName };
    }
    if (!['pending', 'slow_down', 'denied', 'expired', 'no_copilot_seat'].includes(status)) {
      throw new BridgeError('INVALID_RESPONSE', `Unsupported device-flow status ${status}.`, 502);
    }
    return {
      status,
      ...(typeof result.interval === 'number' ? { interval: result.interval } : {}),
    };
  }

  async link(input: ObjectValue): Promise<ObjectValue> {
    return this.adminCommand('link', input);
  }

  async revoke(input: ObjectValue): Promise<ObjectValue> {
    return this.adminCommand('revoke', input);
  }

  async createApiKey(input: ObjectValue): Promise<ObjectValue> {
    const tenantId = text(input.tenantId, 'tenant ID').toLowerCase();
    const objectId = text(input.objectId, 'object ID').toLowerCase();
    const label = text(input.label, 'API-key label');
    const store = this.store();
    try {
      const issued = await store.issueApiKey(tenantId, objectId, label, API_KEY_TTL_SECONDS);
      return {
        status: 'created',
        tenantId,
        objectId,
        id: issued.id,
        apiKey: issued.apiKey,
        expiresAt: issued.expiresAt,
      };
    } finally {
      await store.close();
    }
  }

  async revokeApiKey(input: ObjectValue): Promise<ObjectValue> {
    const id = text(input.id, 'API-key ID').toLowerCase();
    const evidence = text(input.evidence, 'revocation evidence');
    const evidenceDigest = createHash('sha256').update(evidence).digest('hex');
    const store = this.store();
    try {
      await store.revokeApiKey(id, evidenceDigest);
      return { status: 'revoked', id, evidenceDigest };
    } finally {
      await store.close();
    }
  }

  async listAccess(input: ObjectValue): Promise<ObjectValue> {
    const limit = input.limit === undefined ? 50 : Number(input.limit);
    const cursor = input.cursor === undefined ? undefined : text(input.cursor, 'access cursor').toLowerCase();
    if (!Number.isInteger(limit) || limit < 1 || limit > 100
      || (cursor !== undefined && !/^[0-9a-f-]{36}$/i.test(cursor))) {
      throw new BridgeError('INVALID_REQUEST', 'Access-list pagination is invalid.');
    }
    const store = this.store();
    try {
      const bindingsResult = await store.pool.query(
        `SELECT b.tenant_id, b.object_id, b.github_account_id, b.github_login, b.models,
                b.revision, b.revoked_at, b.updated_at,
                COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                    'id', k.id,
                    'label', k.label,
                    'createdAt', k.created_at,
                    'expiresAt', k.expires_at,
                    'lastUsedAt', k.last_used_at,
                    'revokedAt', k.revoked_at
                  ) ORDER BY k.created_at DESC)
                  FROM enterprise_api_keys k
                  WHERE k.tenant_id = b.tenant_id AND k.object_id = b.object_id
                ), '[]'::jsonb) AS api_keys
         FROM enterprise_account_bindings b
         WHERE ($1::uuid IS NULL OR b.object_id > $1::uuid)
         ORDER BY b.object_id
         LIMIT $2`,
        [cursor ?? null, limit + 1],
      );
      const rows = bindingsResult.rows as Array<Record<string, unknown>>;
      const page = rows.slice(0, limit);
      const enrollmentsResult = await store.pool.query(
        `SELECT id, tenant_id, object_id, user_email, user_alias, github_account_id,
                github_login, models, status, expires_at, consumed_at, created_at
         FROM enterprise_enrollments
         ORDER BY created_at DESC
         LIMIT 100`,
      );
      return {
        bindings: page.map(row => ({
          tenantId: String(row.tenant_id),
          objectId: String(row.object_id),
          githubAccountId: Number(row.github_account_id),
          githubLogin: String(row.github_login),
          models: Array.isArray(row.models) ? row.models.filter(value => typeof value === 'string') : [],
          revision: Number(row.revision),
          revokedAt: row.revoked_at ? new Date(row.revoked_at as string).toISOString() : null,
          updatedAt: new Date(row.updated_at as string).toISOString(),
          apiKeys: Array.isArray(row.api_keys) ? row.api_keys : [],
        })),
        enrollments: (enrollmentsResult.rows as Array<Record<string, unknown>>).map(row => ({
          id: String(row.id),
          tenantId: String(row.tenant_id),
          objectId: String(row.object_id),
          userEmail: String(row.user_email),
          userAlias: String(row.user_alias),
          githubAccountId: Number(row.github_account_id),
          githubLogin: String(row.github_login),
          models: Array.isArray(row.models) ? row.models.filter(value => typeof value === 'string') : [],
          status: String(row.status),
          expiresAt: new Date(row.expires_at as string).toISOString(),
          consumedAt: row.consumed_at ? new Date(row.consumed_at as string).toISOString() : null,
          createdAt: new Date(row.created_at as string).toISOString(),
        })),
        nextCursor: rows.length > limit ? String(page.at(-1)!.object_id) : null,
      };
    } finally {
      await store.close();
    }
  }

  async createEnrollment(input: ObjectValue): Promise<ObjectValue> {
    const requestedGithubLogin = text(input.githubLogin, 'GitHub login');
    const userEmail = input.userEmail === undefined || input.userEmail === ''
      ? ''
      : text(input.userEmail, 'employee email').trim();
    if (userEmail && (userEmail.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(userEmail))) {
      throw new BridgeError('INVALID_REQUEST', 'Employee email is invalid.');
    }
    if (input.objectId !== undefined || input.litellmApiKey !== undefined) {
      throw new BridgeError('INVALID_REQUEST', 'Enrollment no longer accepts existing LiteLLM user IDs or keys.');
    }
    const github = await this.githubAccount(requestedGithubLogin);
    if (input.githubAccountId !== undefined
      && positive(input.githubAccountId, 'GitHub account ID') !== github.accountId) {
      throw new BridgeError('IDENTITY_CONFLICT', 'The supplied GitHub account ID does not match the username.', 409);
    }
    if (input.tenantId !== undefined
      && text(input.tenantId, 'tenant ID').toLowerCase() !== this.tenantId) {
      throw new BridgeError('IDENTITY_CONFLICT', 'The supplied tenant does not match this deployment.', 409);
    }
    const models = this.enrollmentModels;
    const store = this.store();
    let pendingKey: string | undefined;
    let pendingSecretName: string | undefined;
    try {
      const objectId = await store.enrollmentUser(this.tenantId, github.accountId) ?? randomUUID();
      await this.ensureEmployeeUser(objectId, github, userEmail, models);
      pendingKey = (await this.generateKey({
        user_id: objectId,
        key_alias: `ccgc-enroll-${randomUUID()}`,
        models,
        duration: PENDING_KEY_DURATION,
        allowed_routes: PENDING_KEY_ROUTES,
        metadata: { ccgc_purpose: 'enrollment', github_login: github.login, github_account_id: github.accountId },
      })).key;
      const code = `CCGC-${randomBytes(18).toString('base64url')}`;
      const expiresAt = new Date(Date.now() + ENROLLMENT_TTL_SECONDS * 1000);
      pendingSecretName = `ccgc-enrollment-pending-${randomUUID().replaceAll('-', '')}`;
      await this.secrets().set(pendingSecretName, pendingKey, expiresAt);
      const enrollment = await store.createEnrollment({
        codeHash: this.enrollmentCode(code),
        tenantId: this.tenantId,
        objectId,
        userEmail,
        userAlias: github.login,
        githubAccountId: github.accountId,
        githubLogin: github.login,
        credentialSecretName: `ccgc-user-${objectId.replaceAll('-', '')}`,
        pendingSecretName,
        models,
        ttlSeconds: ENROLLMENT_TTL_SECONDS,
      });
      return {
        status: 'created',
        code,
        expiresAt: enrollment.expiresAt,
        objectId,
        githubLogin: github.login,
        githubAccountId: github.accountId,
      };
    } catch (error) {
      const cleanup = await Promise.allSettled([
        pendingSecretName ? this.secrets().remove(pendingSecretName) : Promise.resolve(),
        pendingKey
          ? this.request('/key/delete', this.litellmMasterKey, { method: 'POST', body: JSON.stringify({ keys: [pendingKey] }) })
          : Promise.resolve(),
      ]);
      const failures = cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) {
        throw new AggregateError([error, ...failures], 'Enrollment creation failed and its temporary key could not be removed.');
      }
      throw error;
    } finally {
      await store.close();
    }
  }

  async startEnrollment(input: ObjectValue): Promise<ObjectValue> {
    const code = text(input.code, 'enrollment code');
    this.requireLiteLLMClient(input);
    const store = this.store();
    try {
      const enrollment = await store.enrollment(this.enrollmentCode(code));
      if (enrollment.status === 'completed' || enrollment.status === 'finalizing') {
        return this.enrollmentOutput(enrollment);
      }
      const pendingKey = await this.secrets().get(enrollment.pendingSecretName);
      const flow = await this.request(
        `/credentials/${ENROLLMENT_CREDENTIAL}/user_connection/start`,
        pendingKey,
        { method: 'POST' },
      );
      const verificationUri = text(flow.verification_uri, 'verification URI');
      const userCode = text(flow.user_code, 'device code');
      const flowHandle = text(flow.flow_handle, 'flow handle');
      const expiresIn = positive(flow.expires_in, 'device flow expiry');
      const interval = positive(flow.interval, 'device flow interval');
      if (verificationUri !== 'https://github.com/login/device' || expiresIn > 1800 || interval > 60) {
        throw new BridgeError('ENDPOINT_REJECTED', 'Unexpected GitHub device-flow contract.', 502);
      }
      await store.setEnrollmentFlow(enrollment.id, flowHandle, expiresIn);
      return {
        status: 'authorization_required',
        verificationUri,
        userCode,
        expiresIn,
        interval,
        githubLogin: enrollment.githubLogin,
      };
    } finally {
      await store.close();
    }
  }

  async pollEnrollment(input: ObjectValue): Promise<ObjectValue> {
    const code = text(input.code, 'enrollment code');
    this.requireLiteLLMClient(input);
    const store = this.store();
    try {
      const enrollment = await store.enrollment(this.enrollmentCode(code));
      if (enrollment.status === 'completed' || enrollment.status === 'finalizing') {
        return this.enrollmentOutput(enrollment);
      }
      if (!enrollment.flowHandle || !enrollment.flowExpiresAt || Date.parse(enrollment.flowExpiresAt) <= Date.now()) {
        throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'Enrollment authorization flow expired; restart enrollment.', 401);
      }
      const pendingKey = await this.secrets().get(enrollment.pendingSecretName);
      let result: ObjectValue;
      try {
        result = await this.pollConnection({
          litellmApiKey: pendingKey,
          litellmCredentialName: ENROLLMENT_CREDENTIAL,
          githubLogin: enrollment.githubLogin,
          flowHandle: enrollment.flowHandle,
        });
      } catch (error) {
        if (error instanceof BridgeError && error.code === 'IDENTITY_CONFLICT') {
          await this.disconnectGitHub(pendingKey).catch(() => undefined);
        }
        throw error;
      }
      if (result.status !== 'connected') return result;
      if (!await store.beginEnrollmentCompletion(enrollment.id)) {
        return this.enrollmentOutput(await store.enrollment(this.enrollmentCode(code)));
      }
      return await this.finishEnrollment(store, enrollment);
    } finally {
      await store.close();
    }
  }

  async completeEnrollment(input: ObjectValue): Promise<ObjectValue> {
    const code = text(input.code, 'enrollment code');
    const store = this.store();
    try {
      const enrollment = await store.enrollment(this.enrollmentCode(code));
      if (enrollment.status !== 'completed' || !enrollment.outputSecretName) {
        throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'Enrollment is not ready to complete.', 401);
      }
      const output = object(parseJson(await this.secrets().get(enrollment.outputSecretName)));
      const keyAlias = text(output.keyAlias, 'LiteLLM virtual key alias');
      const replaced = (await this.userKeys(enrollment.objectId))
        .filter(key => key.alias !== keyAlias)
        .map(key => key.token);
      if (replaced.length) {
        await this.request('/key/delete', this.litellmMasterKey, {
          method: 'POST',
          body: JSON.stringify({ keys: replaced }),
        });
      }
      await this.secrets().remove(enrollment.outputSecretName);
      await this.secrets().remove(enrollment.pendingSecretName);
      await store.consumeEnrollment(enrollment.id);
      return { status: 'completed', replacedKeys: replaced.length };
    } finally {
      await store.close();
    }
  }

  async revokeGitHubUser(input: ObjectValue): Promise<ObjectValue> {
    const github = await this.githubAccount(text(input.githubLogin, 'GitHub login'));
    const store = this.store();
    try {
      const revoked = await store.revokeGitHubAccount(this.tenantId, github.accountId);
      if (!revoked.objectIds.length) {
        throw new BridgeError('NOT_FOUND', 'No CCGC enrollment exists for that GitHub account.', 404);
      }
      const users: string[] = [];
      for (const userId of revoked.objectIds) {
        if (!await this.employeeUser(userId)) continue;
        const cleanupKey = await this.generateKey({
          user_id: userId,
          key_alias: `ccgc-offboard-${randomUUID()}`,
          duration: '10m',
          allowed_routes: [`/credentials/${ENROLLMENT_CREDENTIAL}/user_connection`],
          metadata: { ccgc_purpose: 'offboarding' },
        });
        await this.disconnectGitHub(cleanupKey.key);
        users.push(userId);
      }
      if (users.length) {
        await this.request('/user/delete', this.litellmMasterKey, {
          method: 'POST',
          body: JSON.stringify({ user_ids: users }),
        });
      }
      await Promise.allSettled(revoked.secretNames.map(name => this.secrets().remove(name)));
      return {
        status: 'revoked',
        githubLogin: github.login,
        githubAccountId: github.accountId,
        deletedLiteLLMUsers: users.length,
        revokedEnrollments: revoked.revokedEnrollments,
      };
    } finally {
      await store.close();
    }
  }

  async status(): Promise<ObjectValue> {
    await this.request('/health/readiness', this.litellmMasterKey);
    const store = this.store();
    try {
      const result = await store.pool.query(
        `SELECT to_regclass('public.enterprise_account_bindings') IS NOT NULL AS initialized`,
      );
      return {
        status: 'ready',
        litellm: 'ready',
        enterpriseDatabase: result.rows[0]?.initialized === true ? 'initialized' : 'uninitialized',
      };
    } finally {
      await store.close();
    }
  }
}
