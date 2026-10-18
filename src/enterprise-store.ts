import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { BridgeError } from './protocol.ts';
import type { EnterprisePrincipal } from './enterprise-auth.ts';

const DISPATCH_LEASE_SECONDS = 5 * 60;

export interface AccountBinding {
  tenantId: string;
  objectId: string;
  githubAccountId: number;
  githubLogin: string;
  credentialSecretName: string;
  models: string[];
  revision: number;
}

export interface DispatchReservation {
  id: string;
  admissionId: string;
  fence: number;
  requestHash: string;
  branchId: string;
  binding: AccountBinding;
}

export interface EnterpriseEnrollment {
  id: string;
  tenantId: string;
  objectId: string;
  userEmail: string;
  userAlias: string;
  githubAccountId: number;
  githubLogin: string;
  credentialSecretName: string;
  pendingSecretName: string;
  outputSecretName?: string;
  models: string[];
  flowHandle?: string;
  flowExpiresAt?: string;
  status: 'pending' | 'authorizing' | 'finalizing' | 'completed';
  expiresAt: string;
}

export interface EnterpriseStore {
  initialize(): Promise<void>;
  binding(principal: EnterprisePrincipal): Promise<AccountBinding>;
  authenticateApiKey(token: string): Promise<EnterprisePrincipal>;
  issueApiKey(tenantId: string, objectId: string, label: string, ttlSeconds: number): Promise<{
    id: string;
    apiKey: string;
    expiresAt: string;
  }>;
  revokeApiKey(id: string, evidenceDigest: string): Promise<void>;
  createEnrollment(input: {
    codeHash: string;
    tenantId: string;
    objectId: string;
    userEmail: string;
    userAlias: string;
    githubAccountId: number;
    githubLogin: string;
    credentialSecretName: string;
    pendingSecretName: string;
    models: string[];
    ttlSeconds: number;
  }): Promise<{ id: string; expiresAt: string }>;
  reusableEnrollmentUser(tenantId: string, githubAccountId: number): Promise<{
    objectId: string;
    pendingSecretName: string;
  } | null>;
  enrollment(codeHash: string): Promise<EnterpriseEnrollment>;
  setEnrollmentFlow(id: string, flowHandle: string, expiresIn: number): Promise<void>;
  beginEnrollmentCompletion(id: string): Promise<boolean>;
  completeEnrollment(id: string, outputSecretName: string): Promise<void>;
  consumeEnrollment(id: string): Promise<void>;
  createAdmission(principal: EnterprisePrincipal, ttlSeconds: number, maxAttempts: number): Promise<{ id: string; token: string; expiresAt: string }>;
  admissionBinding(tokenHash: string): Promise<{ admissionId: string; binding: AccountBinding }>;
  reserveDispatch(tokenHash: string, requestHash: string, model: string, branchId: string): Promise<DispatchReservation>;
  finishDispatch(id: string, outcome: 'completed' | 'failed' | 'cancelled'): Promise<void>;
  close(): Promise<void>;
}

export interface DatabaseTokenProvider {
  getToken(scope: string): Promise<{ token: string } | null>;
}

export interface LinkAccountInput {
  tenantId: string;
  objectId: string;
  githubAccountId: number;
  githubLogin: string;
  credentialSecretName: string;
  models: string[];
  evidenceDigest: string;
}

export interface CatalogReconciliation {
  objectIds: string[];
  changedBindings: number;
  changedEnrollments: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS enterprise_account_bindings (
  tenant_id uuid NOT NULL,
  object_id uuid NOT NULL,
  github_account_id bigint NOT NULL,
  github_login text NOT NULL,
  credential_secret_name text NOT NULL,
  models jsonb NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, object_id),
  CHECK (github_account_id > 0),
  CHECK (jsonb_typeof(models) = 'array')
);
ALTER TABLE enterprise_account_bindings ADD COLUMN IF NOT EXISTS credential_secret_name text;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'enterprise_account_bindings' AND column_name = 'worker_secret_name'
  ) THEN
    EXECUTE 'UPDATE enterprise_account_bindings
             SET credential_secret_name = worker_secret_name
             WHERE credential_secret_name IS NULL';
  END IF;
END $$;
ALTER TABLE enterprise_account_bindings ALTER COLUMN credential_secret_name SET NOT NULL;
CREATE TABLE IF NOT EXISTS enterprise_api_keys (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  object_id uuid NOT NULL,
  key_hash text NOT NULL UNIQUE,
  label text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  CHECK (length(key_hash) = 64),
  CHECK (length(label) BETWEEN 1 AND 64)
);
CREATE INDEX IF NOT EXISTS enterprise_api_keys_principal
  ON enterprise_api_keys (tenant_id, object_id, expires_at);
CREATE TABLE IF NOT EXISTS enterprise_enrollments (
  id uuid PRIMARY KEY,
  code_hash text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL,
  object_id uuid NOT NULL,
  user_email text NOT NULL,
  user_alias text NOT NULL,
  github_account_id bigint NOT NULL,
  github_login text NOT NULL,
  credential_secret_name text NOT NULL,
  pending_secret_name text NOT NULL,
  output_secret_name text,
  models jsonb NOT NULL,
  flow_handle text,
  flow_expires_at timestamptz,
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(code_hash) = 64),
  CHECK (github_account_id > 0),
  CHECK (jsonb_typeof(models) = 'array'),
  CHECK (status IN ('pending', 'authorizing', 'completed'))
);
CREATE INDEX IF NOT EXISTS enterprise_enrollments_expiry
  ON enterprise_enrollments (expires_at) WHERE consumed_at IS NULL;
ALTER TABLE enterprise_enrollments DROP CONSTRAINT IF EXISTS enterprise_enrollments_status_check;
ALTER TABLE enterprise_enrollments ADD CONSTRAINT enterprise_enrollments_status_check
  CHECK (status IN ('pending', 'authorizing', 'finalizing', 'completed'));
CREATE TABLE IF NOT EXISTS enterprise_admissions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  object_id uuid NOT NULL,
  binding_revision bigint NOT NULL,
  token_hash text,
  expires_at timestamptz NOT NULL,
  max_attempts integer NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  fence bigint NOT NULL DEFAULT 0,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (max_attempts > 0 AND attempts >= 0 AND attempts <= max_attempts)
);
ALTER TABLE enterprise_admissions ADD COLUMN IF NOT EXISTS token_hash text;
ALTER TABLE enterprise_admissions ADD COLUMN IF NOT EXISTS auth_subject text NOT NULL DEFAULT 'entra';
CREATE UNIQUE INDEX IF NOT EXISTS enterprise_admissions_token_hash ON enterprise_admissions (token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS enterprise_admissions_principal ON enterprise_admissions (tenant_id, object_id, expires_at);
CREATE TABLE IF NOT EXISTS enterprise_dispatches (
  id uuid PRIMARY KEY,
  admission_id uuid NOT NULL REFERENCES enterprise_admissions(id),
  request_hash text NOT NULL,
  model text NOT NULL,
  branch_id text NOT NULL DEFAULT 'main',
  fence bigint NOT NULL,
  status text NOT NULL,
  reserved_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (admission_id, request_hash),
  CHECK (status IN ('reserved', 'completed', 'failed', 'cancelled'))
);
ALTER TABLE enterprise_dispatches ADD COLUMN IF NOT EXISTS branch_id text NOT NULL DEFAULT 'main';
CREATE UNIQUE INDEX IF NOT EXISTS enterprise_dispatches_active_branch
  ON enterprise_dispatches (admission_id, branch_id) WHERE status = 'reserved';
CREATE INDEX IF NOT EXISTS enterprise_dispatches_active_principal
  ON enterprise_dispatches (status, admission_id) WHERE status = 'reserved';
CREATE TABLE IF NOT EXISTS enterprise_audit_outbox (
  id bigserial PRIMARY KEY,
  event_type text NOT NULL,
  tenant_id uuid NOT NULL,
  object_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  exported_at timestamptz
);`;

function bindingRow(row: Record<string, unknown>): AccountBinding {
  const models = Array.isArray(row.models) ? row.models.filter(value => typeof value === 'string') : [];
  if (!models.length) throw new BridgeError('IDENTITY_CONFLICT', 'The linked account has no approved Claude model catalog.', 403);
  return {
    tenantId: String(row.tenant_id), objectId: String(row.object_id),
    githubAccountId: Number(row.github_account_id), githubLogin: String(row.github_login),
    credentialSecretName: String(row.credential_secret_name), models, revision: Number(row.revision),
  };
}

async function rollback(client: PoolClient): Promise<void> {
  try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ }
}

export class PostgresEnterpriseStore implements EnterpriseStore {
  readonly pool: Pool;
  readonly manageSchema: boolean;

  constructor(
    connectionString: string,
    tokenProvider?: DatabaseTokenProvider,
    allowInsecureLocalhost = false,
    manageSchema = true,
  ) {
    if (!connectionString.startsWith('postgresql://') || /[\r\n]/.test(connectionString)) {
      throw new BridgeError('INVALID_OPTIONS', 'A PostgreSQL TLS connection string is required.');
    }
    const endpoint = new URL(connectionString);
    const localTest = allowInsecureLocalhost && ['127.0.0.1', 'localhost'].includes(endpoint.hostname);
    if (allowInsecureLocalhost && !localTest) {
      throw new BridgeError('INVALID_OPTIONS', 'Insecure PostgreSQL is permitted only for explicit localhost tests.');
    }
    const username = decodeURIComponent(endpoint.username);
    const password = decodeURIComponent(endpoint.password);
    const database = decodeURIComponent(endpoint.pathname.replace(/^\//, ''));
    if (!username || !database || (tokenProvider && password)) {
      throw new BridgeError('INVALID_OPTIONS', 'The PostgreSQL user and database are required, and Entra connections must not embed a password.');
    }
    this.pool = new Pool({
      host: endpoint.hostname,
      port: endpoint.port ? Number(endpoint.port) : 5432,
      user: username,
      database,
      ...(tokenProvider ? {
        password: async () => {
          const access = await tokenProvider.getToken('https://ossrdbms-aad.database.windows.net/.default');
          if (!access?.token) throw new BridgeError('GATEWAY_UNAVAILABLE', 'PostgreSQL Entra token acquisition failed.', 503);
          return access.token;
        },
      } : { password }),
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: localTest ? false : { rejectUnauthorized: true },
    });
    this.manageSchema = manageSchema;
  }

  async initialize(): Promise<void> {
    if (this.manageSchema) {
      await this.pool.query(SCHEMA);
      return;
    }
    const result = await this.pool.query(`
      SELECT
        to_regclass('public.enterprise_account_bindings') IS NOT NULL
        AND to_regclass('public.enterprise_api_keys') IS NOT NULL
        AND to_regclass('public.enterprise_enrollments') IS NOT NULL
        AND to_regclass('public.enterprise_admissions') IS NOT NULL
        AND to_regclass('public.enterprise_dispatches') IS NOT NULL
        AND to_regclass('public.enterprise_audit_outbox') IS NOT NULL
        AS initialized
    `);
    if (result.rows[0]?.initialized !== true) {
      throw new BridgeError('STARTUP_FAILED', 'Enterprise PostgreSQL schema has not been bootstrapped.', 503);
    }
  }

  async binding(principal: EnterprisePrincipal): Promise<AccountBinding> {
    const result = await this.pool.query(
      `SELECT tenant_id, object_id, github_account_id, github_login, credential_secret_name, models, revision
       FROM enterprise_account_bindings
       WHERE tenant_id = $1 AND object_id = $2 AND revoked_at IS NULL`,
      [principal.tenantId, principal.objectId],
    );
    if (result.rowCount !== 1) throw new BridgeError('ACCESS_DENIED', 'This Entra principal has no active same-user GitHub account binding.', 403);
    return bindingRow(result.rows[0] as Record<string, unknown>);
  }

  async authenticateApiKey(token: string): Promise<EnterprisePrincipal> {
    if (!/^ccgc_sk_[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'A valid enterprise API key is required.', 401);
    }
    const keyHash = createHash('sha256').update(token).digest('hex');
    const result = await this.pool.query(
      `UPDATE enterprise_api_keys k
       SET last_used_at = now()
       FROM enterprise_account_bindings b
       WHERE k.key_hash = $1
         AND k.revoked_at IS NULL
         AND k.expires_at > now()
         AND b.tenant_id = k.tenant_id
         AND b.object_id = k.object_id
         AND b.revoked_at IS NULL
       RETURNING k.id, k.tenant_id, k.object_id`,
      [keyHash],
    );
    if (result.rowCount !== 1) {
      throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'Enterprise API key is missing, expired, or revoked.', 401);
    }
    const row = result.rows[0] as Record<string, unknown>;
    return {
      tenantId: String(row.tenant_id),
      objectId: String(row.object_id),
      subject: `api-key:${String(row.id)}`,
      authentication: 'apiKey',
    };
  }

  async issueApiKey(tenantId: string, objectId: string, label: string, ttlSeconds: number): Promise<{
    id: string;
    apiKey: string;
    expiresAt: string;
  }> {
    if (!/^[0-9a-f-]{36}$/i.test(tenantId) || !/^[0-9a-f-]{36}$/i.test(objectId)
      || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(label)
      || !Number.isInteger(ttlSeconds) || ttlSeconds < 3600 || ttlSeconds > 7_776_000) {
      throw new BridgeError('INVALID_REQUEST', 'Enterprise API-key input is invalid.');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const binding = await client.query(
        `SELECT 1 FROM enterprise_account_bindings
         WHERE tenant_id = $1 AND object_id = $2 AND revoked_at IS NULL FOR SHARE`,
        [tenantId, objectId],
      );
      if (binding.rowCount !== 1) {
        throw new BridgeError('ACCESS_DENIED', 'An active account binding is required before issuing an API key.', 403);
      }
      const id = randomUUID();
      const apiKey = `ccgc_sk_${randomBytes(32).toString('base64url')}`;
      const keyHash = createHash('sha256').update(apiKey).digest('hex');
      const result = await client.query(
        `INSERT INTO enterprise_api_keys (id, tenant_id, object_id, key_hash, label, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + ($6 * interval '1 second'))
         RETURNING expires_at`,
        [id, tenantId.toLowerCase(), objectId.toLowerCase(), keyHash, label, ttlSeconds],
      );
      await client.query(
        `INSERT INTO enterprise_audit_outbox (event_type, tenant_id, object_id, subject_id, metadata)
         VALUES ('api_key.created', $1, $2, $3, $4::jsonb)`,
        [tenantId, objectId, id, JSON.stringify({ label, ttlSeconds })],
      );
      await client.query('COMMIT');
      return { id, apiKey, expiresAt: new Date(result.rows[0].expires_at as string).toISOString() };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeApiKey(id: string, evidenceDigest: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[a-f0-9]{64}$/.test(evidenceDigest)) {
      throw new BridgeError('INVALID_REQUEST', 'Enterprise API-key revocation input is invalid.');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE enterprise_api_keys
         SET revoked_at = now()
         WHERE id = $1 AND revoked_at IS NULL
         RETURNING tenant_id, object_id`,
        [id],
      );
      if (result.rowCount !== 1) throw new BridgeError('ACCESS_DENIED', 'Active enterprise API key was not found.', 404);
      const row = result.rows[0] as Record<string, unknown>;
      await client.query(
        `UPDATE enterprise_admissions SET revoked_at = now()
         WHERE tenant_id = $1 AND object_id = $2 AND auth_subject = $3 AND revoked_at IS NULL`,
        [row.tenant_id, row.object_id, `api-key:${id}`],
      );
      await client.query(
        `INSERT INTO enterprise_audit_outbox (event_type, tenant_id, object_id, subject_id, metadata)
         VALUES ('api_key.revoked', $1, $2, $3, $4::jsonb)`,
        [row.tenant_id, row.object_id, id, JSON.stringify({ evidenceDigest })],
      );
      await client.query('COMMIT');
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async createEnrollment(input: {
    codeHash: string;
    tenantId: string;
    objectId: string;
    userEmail: string;
    userAlias: string;
    githubAccountId: number;
    githubLogin: string;
    credentialSecretName: string;
    pendingSecretName: string;
    models: string[];
    ttlSeconds: number;
  }): Promise<{ id: string; expiresAt: string }> {
    if (!/^[a-f0-9]{64}$/.test(input.codeHash)
      || !/^[0-9a-f-]{36}$/i.test(input.tenantId)
      || !/^[0-9a-f-]{36}$/i.test(input.objectId)
      || !input.userEmail.includes('@')
      || !/^[A-Za-z0-9._-]{1,64}$/.test(input.userAlias)
      || !Number.isSafeInteger(input.githubAccountId) || input.githubAccountId <= 0
      || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(input.githubLogin)
      || !/^[0-9A-Za-z-]{1,127}$/.test(input.credentialSecretName)
      || !/^[0-9A-Za-z-]{1,127}$/.test(input.pendingSecretName)
      || !input.models.length || input.models.some(model => !/^claude-[a-z0-9.-]+$/.test(model))
      || !Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 300 || input.ttlSeconds > 3600) {
      throw new BridgeError('INVALID_REQUEST', 'Enterprise enrollment input is invalid.');
    }
    const id = randomUUID();
    const result = await this.pool.query(
      `WITH enrolled AS (
         INSERT INTO enterprise_enrollments
           (id, code_hash, tenant_id, object_id, user_email, user_alias, github_account_id,
            github_login, credential_secret_name, pending_secret_name, models, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb,
                 now() + ($12 * interval '1 second'))
         RETURNING id, tenant_id, object_id, expires_at
       ), audited AS (
         INSERT INTO enterprise_audit_outbox (event_type, tenant_id, object_id, subject_id, metadata)
         SELECT 'enrollment.created', tenant_id, object_id, id,
                jsonb_build_object('githubLogin', $8::text, 'githubAccountId', $7::bigint)
         FROM enrolled
       )
       SELECT expires_at FROM enrolled`,
      [
        id,
        input.codeHash,
        input.tenantId.toLowerCase(),
        input.objectId.toLowerCase(),
        input.userEmail,
        input.userAlias,
        input.githubAccountId,
        input.githubLogin,
        input.credentialSecretName,
        input.pendingSecretName,
        JSON.stringify([...new Set(input.models)]),
        input.ttlSeconds,
      ],
    );
    return { id, expiresAt: new Date(result.rows[0].expires_at as string).toISOString() };
  }

  async enrollment(codeHash: string): Promise<EnterpriseEnrollment> {
    if (!/^[a-f0-9]{64}$/.test(codeHash)) throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'Enrollment code is invalid.', 401);
    const result = await this.pool.query(
      `SELECT id, tenant_id, object_id, user_email, user_alias, github_account_id, github_login,
              credential_secret_name, pending_secret_name, output_secret_name, models,
              flow_handle, flow_expires_at, status, expires_at
       FROM enterprise_enrollments
       WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > now()`,
      [codeHash],
    );
    if (result.rowCount !== 1) {
      throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'Enrollment code is missing, expired, or already used.', 401);
    }
    const row = result.rows[0] as Record<string, unknown>;
    const models = Array.isArray(row.models) ? row.models.filter(value => typeof value === 'string') : [];
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      objectId: String(row.object_id),
      userEmail: String(row.user_email),
      userAlias: String(row.user_alias),
      githubAccountId: Number(row.github_account_id),
      githubLogin: String(row.github_login),
      credentialSecretName: String(row.credential_secret_name),
      pendingSecretName: String(row.pending_secret_name),
      ...(row.output_secret_name ? { outputSecretName: String(row.output_secret_name) } : {}),
      models,
      ...(row.flow_handle ? { flowHandle: String(row.flow_handle) } : {}),
      ...(row.flow_expires_at ? { flowExpiresAt: new Date(row.flow_expires_at as string).toISOString() } : {}),
      status: String(row.status) as EnterpriseEnrollment['status'],
      expiresAt: new Date(row.expires_at as string).toISOString(),
    };
  }

  async reusableEnrollmentUser(tenantId: string, githubAccountId: number): Promise<{
    objectId: string;
    pendingSecretName: string;
  } | null> {
    if (!/^[0-9a-f-]{36}$/i.test(tenantId)
      || !Number.isSafeInteger(githubAccountId) || githubAccountId <= 0) {
      throw new BridgeError('INVALID_REQUEST', 'Reusable enrollment identity is invalid.');
    }
    const result = await this.pool.query(
      `SELECT object_id, pending_secret_name
       FROM enterprise_enrollments
       WHERE tenant_id = $1
         AND github_account_id = $2
         AND consumed_at IS NULL
         AND status IN ('pending', 'authorizing')
       ORDER BY created_at DESC
       LIMIT 1`,
      [tenantId.toLowerCase(), githubAccountId],
    );
    if (result.rowCount !== 1) return null;
    return {
      objectId: String(result.rows[0].object_id),
      pendingSecretName: String(result.rows[0].pending_secret_name),
    };
  }

  async setEnrollmentFlow(id: string, flowHandle: string, expiresIn: number): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[A-Za-z0-9._-]{8,512}$/.test(flowHandle)
      || !Number.isInteger(expiresIn) || expiresIn < 60 || expiresIn > 1800) {
      throw new BridgeError('INVALID_REQUEST', 'Enrollment authorization flow is invalid.');
    }
    const result = await this.pool.query(
      `WITH updated AS (
         UPDATE enterprise_enrollments
         SET flow_handle = $2, flow_expires_at = now() + ($3 * interval '1 second'), status = 'authorizing'
         WHERE id = $1 AND consumed_at IS NULL AND expires_at > now() AND status IN ('pending', 'authorizing')
         RETURNING id, tenant_id, object_id
       )
       INSERT INTO enterprise_audit_outbox (event_type, tenant_id, object_id, subject_id, metadata)
       SELECT 'enrollment.authorization_started', tenant_id, object_id, id, '{}'::jsonb FROM updated
       RETURNING id`,
      [id, flowHandle, expiresIn],
    );
    if (result.rowCount !== 1) throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'Enrollment is no longer active.', 401);
  }

  async beginEnrollmentCompletion(id: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new BridgeError('INVALID_REQUEST', 'Enrollment ID is invalid.');
    const result = await this.pool.query(
      `WITH updated AS (
         UPDATE enterprise_enrollments
         SET status = 'finalizing'
         WHERE id = $1 AND consumed_at IS NULL AND expires_at > now()
           AND status IN ('pending', 'authorizing')
         RETURNING id, tenant_id, object_id
       )
       INSERT INTO enterprise_audit_outbox (event_type, tenant_id, object_id, subject_id, metadata)
       SELECT 'enrollment.authorization_verified', tenant_id, object_id, id, '{}'::jsonb FROM updated
       RETURNING id`,
      [id],
    );
    return result.rowCount === 1;
  }

  async completeEnrollment(id: string, outputSecretName: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9A-Za-z-]{1,127}$/.test(outputSecretName)) {
      throw new BridgeError('INVALID_REQUEST', 'Enrollment completion input is invalid.');
    }
    const result = await this.pool.query(
      `WITH updated AS (
         UPDATE enterprise_enrollments
         SET output_secret_name = $2, status = 'completed'
         WHERE id = $1 AND consumed_at IS NULL AND expires_at > now() AND status = 'finalizing'
         RETURNING id, tenant_id, object_id
       )
       INSERT INTO enterprise_audit_outbox (event_type, tenant_id, object_id, subject_id, metadata)
       SELECT 'enrollment.completed', tenant_id, object_id, id, '{}'::jsonb FROM updated
       RETURNING id`,
      [id, outputSecretName],
    );
    if (result.rowCount !== 1) throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'Enrollment is no longer active.', 401);
  }

  async consumeEnrollment(id: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new BridgeError('INVALID_REQUEST', 'Enrollment ID is invalid.');
    const result = await this.pool.query(
      `WITH updated AS (
         UPDATE enterprise_enrollments
         SET consumed_at = now()
         WHERE id = $1 AND consumed_at IS NULL AND status = 'completed'
         RETURNING id, tenant_id, object_id
       )
       INSERT INTO enterprise_audit_outbox (event_type, tenant_id, object_id, subject_id, metadata)
       SELECT 'enrollment.consumed', tenant_id, object_id, id, '{}'::jsonb FROM updated
       RETURNING id`,
      [id],
    );
    if (result.rowCount !== 1) throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'Enrollment is not ready to complete.', 401);
  }

  async linkAccount(input: LinkAccountInput): Promise<AccountBinding> {
    if (!/^[0-9a-f-]{36}$/i.test(input.tenantId) || !/^[0-9a-f-]{36}$/i.test(input.objectId)
      || !Number.isSafeInteger(input.githubAccountId) || input.githubAccountId <= 0
      || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(input.githubLogin)
      || !/^[0-9A-Za-z-]{1,127}$/.test(input.credentialSecretName)
      || !/^[a-f0-9]{64}$/.test(input.evidenceDigest)
      || !input.models.length || input.models.length > 100
      || input.models.some(model => !/^claude-[a-z0-9.-]+$/.test(model))) {
      throw new BridgeError('INVALID_REQUEST', 'Enterprise account binding input is invalid.');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO enterprise_account_bindings
           (tenant_id, object_id, github_account_id, github_login, credential_secret_name, models, revision, revoked_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 1, NULL)
         ON CONFLICT (tenant_id, object_id) DO UPDATE SET
           github_account_id = EXCLUDED.github_account_id,
           github_login = EXCLUDED.github_login,
           credential_secret_name = EXCLUDED.credential_secret_name,
           models = EXCLUDED.models,
           revision = enterprise_account_bindings.revision + 1,
           revoked_at = NULL,
           updated_at = now()
         RETURNING tenant_id, object_id, github_account_id, github_login, credential_secret_name, models, revision`,
        [
          input.tenantId.toLowerCase(), input.objectId.toLowerCase(), input.githubAccountId,
          input.githubLogin, input.credentialSecretName, JSON.stringify([...new Set(input.models)]),
        ],
      );
      await client.query(
        `UPDATE enterprise_admissions SET revoked_at = now()
         WHERE tenant_id = $1 AND object_id = $2 AND revoked_at IS NULL`,
        [input.tenantId, input.objectId],
      );
      await client.query(
        `UPDATE enterprise_api_keys SET revoked_at = now()
         WHERE tenant_id = $1 AND object_id = $2 AND revoked_at IS NULL`,
        [input.tenantId, input.objectId],
      );
      await client.query(
        `INSERT INTO enterprise_audit_outbox (event_type, tenant_id, object_id, subject_id, metadata)
         VALUES ('binding.linked', $1, $2, $2, $3::jsonb)`,
        [
          input.tenantId, input.objectId,
          JSON.stringify({
            githubAccountId: input.githubAccountId,
            githubLogin: input.githubLogin,
            credentialSecretName: input.credentialSecretName,
            evidenceDigest: input.evidenceDigest,
          }),
        ],
      );
      await client.query('COMMIT');
      return bindingRow(result.rows[0] as Record<string, unknown>);
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeBinding(tenantId: string, objectId: string, evidenceDigest: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(tenantId) || !/^[0-9a-f-]{36}$/i.test(objectId)
      || !/^[a-f0-9]{64}$/.test(evidenceDigest)) {
      throw new BridgeError('INVALID_REQUEST', 'Enterprise revocation input is invalid.');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE enterprise_account_bindings
         SET revoked_at = now(), revision = revision + 1, updated_at = now()
         WHERE tenant_id = $1 AND object_id = $2 AND revoked_at IS NULL`,
        [tenantId, objectId],
      );
      if (result.rowCount !== 1) throw new BridgeError('ACCESS_DENIED', 'Active enterprise binding was not found.', 404);
      await client.query(
        `UPDATE enterprise_admissions SET revoked_at = now()
         WHERE tenant_id = $1 AND object_id = $2 AND revoked_at IS NULL`,
        [tenantId, objectId],
      );
      await client.query(
        `UPDATE enterprise_api_keys SET revoked_at = now()
         WHERE tenant_id = $1 AND object_id = $2 AND revoked_at IS NULL`,
        [tenantId, objectId],
      );
      await client.query(
        `INSERT INTO enterprise_audit_outbox (event_type, tenant_id, object_id, subject_id, metadata)
         VALUES ('binding.revoked', $1, $2, $2, $3::jsonb)`,
        [tenantId, objectId, JSON.stringify({ evidenceDigest })],
      );
      await client.query('COMMIT');
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async reconcileModelCatalog(tenantId: string, models: string[]): Promise<CatalogReconciliation> {
    const uniqueModels = [...new Set(models)];
    if (!/^[0-9a-f-]{36}$/i.test(tenantId)
      || !uniqueModels.length || uniqueModels.length > 100
      || uniqueModels.some(model => !/^claude-[a-z0-9.-]+$/.test(model))) {
      throw new BridgeError('INVALID_REQUEST', 'Enterprise model catalog reconciliation input is invalid.');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const bindings = await client.query(
        `UPDATE enterprise_account_bindings
         SET models = $2::jsonb, revision = revision + 1, updated_at = now()
         WHERE tenant_id = $1 AND revoked_at IS NULL AND models IS DISTINCT FROM $2::jsonb
         RETURNING object_id`,
        [tenantId.toLowerCase(), JSON.stringify(uniqueModels)],
      );
      const changedObjectIds = bindings.rows.map(row => String(row.object_id));
      if (changedObjectIds.length) {
        await client.query(
          `UPDATE enterprise_admissions
           SET revoked_at = now()
           WHERE tenant_id = $1 AND object_id = ANY($2::uuid[]) AND revoked_at IS NULL`,
          [tenantId, changedObjectIds],
        );
        await client.query(
          `INSERT INTO enterprise_audit_outbox (event_type, tenant_id, object_id, subject_id, metadata)
           SELECT 'binding.catalog_updated', tenant_id, object_id, object_id,
                  jsonb_build_object('models', models, 'revision', revision)
           FROM enterprise_account_bindings
           WHERE tenant_id = $1 AND object_id = ANY($2::uuid[])`,
          [tenantId, changedObjectIds],
        );
      }
      const enrollments = await client.query(
        `WITH updated AS (
           UPDATE enterprise_enrollments
           SET models = $2::jsonb
           WHERE tenant_id = $1
             AND consumed_at IS NULL
             AND expires_at > now()
             AND status IN ('pending', 'authorizing')
             AND models IS DISTINCT FROM $2::jsonb
           RETURNING id, tenant_id, object_id, models
         )
         INSERT INTO enterprise_audit_outbox (event_type, tenant_id, object_id, subject_id, metadata)
         SELECT 'enrollment.catalog_updated', tenant_id, object_id, id,
                jsonb_build_object('models', models)
         FROM updated
         RETURNING subject_id`,
        [tenantId.toLowerCase(), JSON.stringify(uniqueModels)],
      );
      const active = await client.query(
        `SELECT object_id FROM (
           SELECT object_id
           FROM enterprise_account_bindings
           WHERE tenant_id = $1 AND revoked_at IS NULL
           UNION
           SELECT object_id
           FROM enterprise_enrollments
           WHERE tenant_id = $1
             AND consumed_at IS NULL
             AND expires_at > now()
             AND status IN ('pending', 'authorizing')
         ) principals
         ORDER BY object_id`,
        [tenantId.toLowerCase()],
      );
      await client.query('COMMIT');
      return {
        objectIds: active.rows.map(row => String(row.object_id)),
        changedBindings: bindings.rowCount ?? 0,
        changedEnrollments: enrollments.rowCount ?? 0,
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async createAdmission(principal: EnterprisePrincipal, ttlSeconds: number, maxAttempts: number): Promise<{ id: string; token: string; expiresAt: string }> {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 28_800
      || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
      throw new BridgeError('INVALID_REQUEST', 'Admission lifetime or attempt limit is outside the reviewed bounds.');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const bindingResult = await client.query(
        `SELECT revision FROM enterprise_account_bindings
         WHERE tenant_id = $1 AND object_id = $2 AND revoked_at IS NULL FOR SHARE`,
        [principal.tenantId, principal.objectId],
      );
      if (bindingResult.rowCount !== 1) throw new BridgeError('ACCESS_DENIED', 'This principal has no active account binding.', 403);
      const revision = Number(bindingResult.rows[0].revision);
      const id = randomUUID();
      const token = randomBytes(32).toString('hex');
      const tokenHash = await crypto.subtle.digest('SHA-256', Buffer.from(token));
      const encodedHash = Buffer.from(tokenHash).toString('hex');
      const result = await client.query(
        `INSERT INTO enterprise_admissions
           (id, tenant_id, object_id, binding_revision, token_hash, auth_subject, expires_at, max_attempts)
         VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 * interval '1 second'), $8)
         RETURNING expires_at`,
        [id, principal.tenantId, principal.objectId, revision, encodedHash, principal.subject, ttlSeconds, maxAttempts],
      );
      await client.query(
        `INSERT INTO enterprise_audit_outbox (event_type, tenant_id, object_id, subject_id, metadata)
         VALUES ('admission.created', $1, $2, $3, $4::jsonb)`,
        [
          principal.tenantId,
          principal.objectId,
          id,
          JSON.stringify({
            maxAttempts,
            ttlSeconds,
            bindingRevision: revision,
            authentication: principal.authentication ?? 'entra',
          }),
        ],
      );
      await client.query('COMMIT');
      return { id, token, expiresAt: new Date(result.rows[0].expires_at as string).toISOString() };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async admissionBinding(tokenHash: string): Promise<{ admissionId: string; binding: AccountBinding }> {
    if (!/^[a-f0-9]{64}$/.test(tokenHash)) throw new BridgeError('ADMISSION_REQUIRED', 'Invalid admission token digest.', 401);
    const result = await this.pool.query(
      `SELECT a.id, a.binding_revision,
              b.tenant_id, b.object_id, b.github_account_id, b.github_login, b.credential_secret_name, b.models, b.revision
       FROM enterprise_admissions a
       JOIN enterprise_account_bindings b ON b.tenant_id = a.tenant_id AND b.object_id = a.object_id
       WHERE a.token_hash = $1 AND a.revoked_at IS NULL AND a.expires_at > now() AND b.revoked_at IS NULL`,
      [tokenHash],
    );
    if (result.rowCount !== 1) throw new BridgeError('ADMISSION_REQUIRED', 'Admission token is missing, expired, or revoked.', 401);
    const row = result.rows[0] as Record<string, unknown>;
    const binding = bindingRow(row);
    if (Number(row.binding_revision) !== binding.revision) throw new BridgeError('IDENTITY_CONFLICT', 'The account binding changed after admission.', 409);
    return { admissionId: String(row.id), binding };
  }

  async reserveDispatch(tokenHash: string, requestHash: string, model: string, branchId: string): Promise<DispatchReservation> {
    if (!/^[a-f0-9]{64}$/.test(tokenHash) || !/^[a-f0-9]{64}$/.test(requestHash)
      || !/^claude-[a-z0-9.-]+$/.test(model) || !/^[A-Za-z0-9._:-]{1,128}$/.test(branchId)) {
      throw new BridgeError('INVALID_REQUEST', 'Invalid admission token digest, request digest, model, or branch.');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const admission = await client.query(
        `SELECT id, tenant_id, object_id, binding_revision, max_attempts, attempts
         FROM enterprise_admissions
         WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
         FOR UPDATE`,
        [tokenHash],
      );
      if (admission.rowCount !== 1) throw new BridgeError('ADMISSION_REQUIRED', 'Admission token is missing, expired, or revoked.', 401);
      const row = admission.rows[0] as Record<string, unknown>;
      const admissionId = String(row.id);
      const bindingResult = await client.query(
        `SELECT tenant_id, object_id, github_account_id, github_login, credential_secret_name, models, revision
         FROM enterprise_account_bindings
         WHERE tenant_id = $1 AND object_id = $2 AND revoked_at IS NULL
         FOR SHARE`,
        [row.tenant_id, row.object_id],
      );
      if (bindingResult.rowCount !== 1) throw new BridgeError('ACCESS_DENIED', 'The account binding is missing or revoked.', 403);
      const binding = bindingRow(bindingResult.rows[0] as Record<string, unknown>);
      if (!binding.models.includes(model)) throw new BridgeError('MODEL_UNAVAILABLE', 'This model is not approved for the linked Copilot account.', 403);
      if (Number(row.binding_revision) !== binding.revision) throw new BridgeError('IDENTITY_CONFLICT', 'The account binding changed after admission.', 409);
      if (Number(row.attempts) >= Number(row.max_attempts)) throw new BridgeError('LIMIT_REACHED', 'Admission attempt budget is exhausted.', 429);
      const expired = await client.query(
        `UPDATE enterprise_dispatches d SET status = 'cancelled', finished_at = now()
         FROM enterprise_admissions stale_admission
         WHERE d.admission_id = stale_admission.id
           AND stale_admission.tenant_id = $1 AND stale_admission.object_id = $2
           AND d.status = 'reserved'
           AND d.reserved_at <= now() - ($3 * interval '1 second')
         RETURNING d.id`,
        [binding.tenantId, binding.objectId, DISPATCH_LEASE_SECONDS],
      );
      for (const expiredRow of expired.rows as Array<Record<string, unknown>>) {
        await client.query(
          `INSERT INTO enterprise_audit_outbox (event_type, tenant_id, object_id, subject_id, metadata)
           VALUES ('dispatch.finished', $1, $2, $3, $4::jsonb)`,
          [binding.tenantId, binding.objectId, expiredRow.id, JSON.stringify({ outcome: 'cancelled', reason: 'lease_expired' })],
        );
      }
      const active = await client.query(
        `SELECT
           count(*) FILTER (WHERE d.admission_id = $1 AND d.branch_id = $2) AS branch_count,
           count(*) AS principal_count
         FROM enterprise_dispatches d
         JOIN enterprise_admissions active_admission ON active_admission.id = d.admission_id
         WHERE active_admission.tenant_id = $3 AND active_admission.object_id = $4 AND d.status = 'reserved'`,
        [admissionId, branchId, binding.tenantId, binding.objectId],
      );
      if (Number(active.rows[0].branch_count) > 0) {
        throw new BridgeError('CONTEXT_CONFLICT', 'This conversation branch already has an active dispatch.', 409);
      }
      if (Number(active.rows[0].principal_count) >= 4) {
        throw new BridgeError('LIMIT_REACHED', 'Per-user active dispatch capacity is exhausted.', 429);
      }
      const dispatchId = randomUUID();
      const updated = await client.query(
        `UPDATE enterprise_admissions SET attempts = attempts + 1, fence = fence + 1
         WHERE id = $1 RETURNING fence`,
        [admissionId],
      );
      const fence = Number(updated.rows[0].fence);
      try {
        await client.query(
          `INSERT INTO enterprise_dispatches (id, admission_id, request_hash, model, branch_id, fence, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'reserved')`,
          [dispatchId, admissionId, requestHash, model, branchId, fence],
        );
      } catch (error) {
        if (typeof error === 'object' && error && 'code' in error && error.code === '23505') {
          throw new BridgeError('CONTEXT_CONFLICT', 'This request was already reserved; inference is never replayed.', 409);
        }
        throw error;
      }
      await client.query(
        `INSERT INTO enterprise_audit_outbox (event_type, tenant_id, object_id, subject_id, metadata)
         VALUES ('dispatch.reserved', $1, $2, $3, $4::jsonb)`,
        [binding.tenantId, binding.objectId, dispatchId, JSON.stringify({ admissionId, requestHash, model, branchId, fence })],
      );
      await client.query('COMMIT');
      return { id: dispatchId, admissionId, fence, requestHash, branchId, binding };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async finishDispatch(id: string, outcome: 'completed' | 'failed' | 'cancelled'): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE enterprise_dispatches d SET status = $2, finished_at = now()
         FROM enterprise_admissions a
         WHERE d.id = $1 AND d.status = 'reserved' AND a.id = d.admission_id
         RETURNING a.tenant_id, a.object_id`,
        [id, outcome],
      );
      if (result.rowCount !== 1) throw new BridgeError('CONTEXT_CONFLICT', 'Dispatch completion was stale or duplicated.', 409);
      const row = result.rows[0] as Record<string, unknown>;
      await client.query(
        `INSERT INTO enterprise_audit_outbox (event_type, tenant_id, object_id, subject_id, metadata)
         VALUES ('dispatch.finished', $1, $2, $3, $4::jsonb)`,
        [row.tenant_id, row.object_id, id, JSON.stringify({ outcome })],
      );
      await client.query('COMMIT');
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
