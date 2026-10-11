import { randomBytes, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { BridgeError } from './protocol.ts';
import type { EnterprisePrincipal } from './enterprise-auth.ts';

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

export interface EnterpriseStore {
  initialize(): Promise<void>;
  binding(principal: EnterprisePrincipal): Promise<AccountBinding>;
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

  constructor(connectionString: string, tokenProvider?: DatabaseTokenProvider, allowInsecureLocalhost = false) {
    if (!connectionString.startsWith('postgresql://') || /[\r\n]/.test(connectionString)) {
      throw new BridgeError('INVALID_OPTIONS', 'A PostgreSQL TLS connection string is required.');
    }
    const endpoint = new URL(connectionString);
    const localTest = allowInsecureLocalhost && ['127.0.0.1', 'localhost'].includes(endpoint.hostname);
    if (allowInsecureLocalhost && !localTest) {
      throw new BridgeError('INVALID_OPTIONS', 'Insecure PostgreSQL is permitted only for explicit localhost tests.');
    }
    this.pool = new Pool({
      connectionString,
      ...(tokenProvider ? {
        password: async () => {
          const access = await tokenProvider.getToken('https://ossrdbms-aad.database.windows.net/.default');
          if (!access?.token) throw new BridgeError('GATEWAY_UNAVAILABLE', 'PostgreSQL Entra token acquisition failed.', 503);
          return access.token;
        },
      } : {}),
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: localTest ? false : { rejectUnauthorized: true },
    });
  }

  async initialize(): Promise<void> {
    await this.pool.query(SCHEMA);
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
        `INSERT INTO enterprise_admissions (id, tenant_id, object_id, binding_revision, token_hash, expires_at, max_attempts)
         VALUES ($1, $2, $3, $4, $5, now() + ($6 * interval '1 second'), $7)
         RETURNING expires_at`,
        [id, principal.tenantId, principal.objectId, revision, encodedHash, ttlSeconds, maxAttempts],
      );
      await client.query(
        `INSERT INTO enterprise_audit_outbox (event_type, tenant_id, object_id, subject_id, metadata)
         VALUES ('admission.created', $1, $2, $3, $4::jsonb)`,
        [principal.tenantId, principal.objectId, id, JSON.stringify({ maxAttempts, ttlSeconds, bindingRevision: revision })],
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
