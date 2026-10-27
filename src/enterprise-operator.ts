import { execFile } from 'node:child_process';
import { DefaultAzureCredential } from '@azure/identity';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { BridgeError, object, parseJson, positive, text, type ObjectValue } from './protocol.ts';
import { PostgresEnterpriseStore } from './enterprise-store.ts';

const exec = promisify(execFile);

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

export class EnterpriseOperator {
  readonly litellmUrl: string;
  readonly litellmMasterKey: string;
  readonly postgresUrl: string;
  readonly brokerDatabasePrincipal: string;
  readonly fetcher: typeof fetch;
  readonly credential: DefaultAzureCredential;

  constructor(options: {
    litellmUrl: string;
    litellmMasterKey: string;
    postgresUrl: string;
    brokerDatabasePrincipal: string;
    fetcher?: typeof fetch;
    credential?: DefaultAzureCredential;
  }) {
    this.litellmUrl = fixedOrigin(options.litellmUrl);
    this.litellmMasterKey = options.litellmMasterKey;
    this.postgresUrl = options.postgresUrl;
    this.brokerDatabasePrincipal = options.brokerDatabasePrincipal;
    this.fetcher = options.fetcher ?? fetch;
    this.credential = options.credential ?? new DefaultAzureCredential();
    if (!/^sk-[A-Za-z0-9._-]{16,}$/.test(this.litellmMasterKey)
      || !/^[A-Za-z0-9-]{1,128}$/.test(this.brokerDatabasePrincipal)) {
      throw new BridgeError('INVALID_OPTIONS', 'Operator master key or broker database principal is invalid.');
    }
  }

  private async request(path: string, apiKey: string, init: RequestInit = {}): Promise<ObjectValue> {
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
    const raw = await response.text();
    if (!response.ok) {
      throw new BridgeError('GATEWAY_UNAVAILABLE', `LiteLLM returned HTTP ${response.status}.`, 502);
    }
    return parseJson(raw);
  }

  private async adminCommand(command: 'bootstrap' | 'link' | 'revoke', input: ObjectValue): Promise<ObjectValue> {
    const flag = command === 'bootstrap' ? '--confirm-bootstrap'
      : command === 'link' ? '--confirm-same-user' : '--confirm-revoke';
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

  async bootstrap(input: ObjectValue): Promise<ObjectValue> {
    return this.adminCommand('bootstrap', input);
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

  async bootstrapDatabase(): Promise<ObjectValue> {
    const store = new PostgresEnterpriseStore(this.postgresUrl, this.credential);
    try {
      await store.initialize();
      const schema = `"${store.schemaName}"`;
      const principal = this.brokerDatabasePrincipal;
      const identifier = `"${principal.replaceAll('"', '""')}"`;
      const existing = await store.pool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [principal]);
      if (existing.rowCount === 0) {
        await store.pool.query('SELECT * FROM pgaadauth_create_principal($1, false, false)', [principal]);
      }
      await store.pool.query(`GRANT CONNECT ON DATABASE postgres TO ${identifier}`);
      await store.pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${identifier}`);
      await store.pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${identifier}`);
      await store.pool.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${schema} TO ${identifier}`);
      await store.pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${identifier}`);
      await store.pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${identifier}`);
      return { status: 'bootstrapped', brokerDatabasePrincipal: principal };
    } finally {
      await store.close();
    }
  }

  async link(input: ObjectValue): Promise<ObjectValue> {
    return this.adminCommand('link', input);
  }

  async revoke(input: ObjectValue): Promise<ObjectValue> {
    return this.adminCommand('revoke', input);
  }

  async status(): Promise<ObjectValue> {
    await this.request('/health/readiness', this.litellmMasterKey);
    const store = new PostgresEnterpriseStore(this.postgresUrl, this.credential);
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
