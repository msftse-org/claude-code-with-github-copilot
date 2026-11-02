import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { PostgresEnterpriseStore } from '../src/enterprise-store.ts';

test('PostgreSQL Entra configuration preserves the asynchronous token password', async () => {
  const store = new PostgresEnterpriseStore(
    'postgresql://managed-identity@example.postgres.database.azure.com:5432/postgres?schema=ccgc&sslmode=verify-full',
    { getToken: async () => ({ token: 'managed-identity-token' }) },
  );
  try {
    assert.equal(store.pool.options.host, 'example.postgres.database.azure.com');
    assert.equal(store.pool.options.user, 'managed-identity');
    assert.equal(store.pool.options.database, 'postgres');
    assert.equal(store.pool.options.options, '-c search_path=ccgc');
    assert.equal(store.schemaName, 'ccgc');
    const configuredPassword = store.pool.options.password;
    assert.equal(typeof configuredPassword, 'function');
    if (typeof configuredPassword !== 'function') assert.fail('Expected an asynchronous PostgreSQL password provider.');
    assert.equal(await configuredPassword(), 'managed-identity-token');
  } finally {
    await store.close();
  }
});

test('PostgreSQL schema routing rejects unsafe schema names', () => {
  assert.throws(
    () => new PostgresEnterpriseStore(
      'postgresql://managed-identity@example.postgres.database.azure.com:5432/postgres?schema=ccgc%3Bdrop',
      { getToken: async () => ({ token: 'managed-identity-token' }) },
    ),
    /schema name is invalid/,
  );
});

test('runtime PostgreSQL configuration does not own schema migrations', async () => {
  const store = new PostgresEnterpriseStore(
    'postgresql://managed-identity@example.postgres.database.azure.com:5432/postgres?sslmode=verify-full',
    { getToken: async () => ({ token: 'managed-identity-token' }) },
    false,
    false,
  );
  try {
    assert.equal(store.manageSchema, false);
  } finally {
    await store.close();
  }
});

test('enrollment completion accepts an already-connected pending enrollment', async () => {
  const store = new PostgresEnterpriseStore(
    'postgresql://managed-identity@example.postgres.database.azure.com:5432/postgres?sslmode=verify-full',
    { getToken: async () => ({ token: 'managed-identity-token' }) },
    false,
    false,
  );
  let query = '';
  const original = store.pool.query.bind(store.pool);
  store.pool.query = (async (text: string) => {
    query = text;
    return { rowCount: 1 };
  }) as typeof store.pool.query;
  try {
    assert.equal(await store.beginEnrollmentCompletion('11111111-1111-4111-8111-111111111111'), true);
    assert.match(query, /status IN \('pending', 'authorizing'\)/);
  } finally {
    store.pool.query = original;
    await store.close();
  }
});

test('expired pending enrollment users remain reusable for the same immutable GitHub account', async () => {
  const store = new PostgresEnterpriseStore(
    'postgresql://managed-identity@example.postgres.database.azure.com:5432/postgres?sslmode=verify-full',
    { getToken: async () => ({ token: 'managed-identity-token' }) },
    false,
    false,
  );
  let query = '';
  let values: unknown[] | undefined;
  const original = store.pool.query.bind(store.pool);
  store.pool.query = (async (text: string, parameters?: unknown[]) => {
    query = text;
    values = parameters;
    return {
      rowCount: 1,
      rows: [{
        object_id: '55555555-5555-4555-8555-555555555555',
        pending_secret_name: 'ccgc-enrollment-pending-expired',
      }],
    };
  }) as typeof store.pool.query;
  try {
    assert.deepEqual(
      await store.reusableEnrollmentUser('11111111-1111-4111-8111-111111111111', 97739755),
      {
        objectId: '55555555-5555-4555-8555-555555555555',
        pendingSecretName: 'ccgc-enrollment-pending-expired',
      },
    );
    assert.match(query, /status IN \('pending', 'authorizing'\)/);
    assert.doesNotMatch(query, /expires_at > now\(\)/);
    assert.deepEqual(values, ['11111111-1111-4111-8111-111111111111', 97739755]);
  } finally {
    store.pool.query = original;
    await store.close();
  }
});

test('dispatch reservation expires stale principal leases before enforcing concurrency', async () => {
  const store = new PostgresEnterpriseStore(
    'postgresql://managed-identity@example.postgres.database.azure.com:5432/postgres?sslmode=verify-full',
    { getToken: async () => ({ token: 'managed-identity-token' }) },
    false,
    false,
  );
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const client = {
    async query(text: string, values?: unknown[]) {
      queries.push({ text, values });
      if (text.includes('FROM enterprise_admissions\n         WHERE token_hash')) {
        return {
          rowCount: 1,
          rows: [{
            id: '33333333-3333-3333-3333-333333333333',
            tenant_id: '11111111-1111-1111-1111-111111111111',
            object_id: '22222222-2222-2222-2222-222222222222',
            binding_revision: 1,
            max_attempts: 10,
            attempts: 0,
          }],
        };
      }
      if (text.includes('FROM enterprise_account_bindings')) {
        return {
          rowCount: 1,
          rows: [{
            tenant_id: '11111111-1111-1111-1111-111111111111',
            object_id: '22222222-2222-2222-2222-222222222222',
            github_account_id: 1234,
            github_login: 'developer',
            credential_secret_name: 'copilot-developer',
            models: ['claude-sonnet-5.5'],
            revision: 1,
          }],
        };
      }
      if (text.startsWith('UPDATE enterprise_dispatches d SET status')) {
        return { rowCount: 1, rows: [{ id: '44444444-4444-4444-8444-444444444444' }] };
      }
      if (text.includes('AS branch_count')) return { rowCount: 1, rows: [{ branch_count: 0, principal_count: 0 }] };
      if (text.startsWith('UPDATE enterprise_admissions SET attempts')) return { rowCount: 1, rows: [{ fence: 2 }] };
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const originalConnect = store.pool.connect.bind(store.pool);
  store.pool.connect = (async () => client) as typeof store.pool.connect;
  try {
    const reservation = await store.reserveDispatch(
      'a'.repeat(64),
      'b'.repeat(64),
      'claude-sonnet-5.5',
      'main',
    );
    assert.equal(reservation.fence, 2);
    const expiry = queries.find(query => query.text.startsWith('UPDATE enterprise_dispatches d SET status'));
    assert.match(expiry?.text ?? '', /reserved_at <= now\(\) - \(\$3 \* interval '1 second'\)/);
    assert.equal(expiry?.values?.[2], 300);
    assert.ok(queries.some(query =>
      query.text.includes("VALUES ('dispatch.finished'")
      && String(query.values?.[3]).includes('"reason":"lease_expired"')));
  } finally {
    store.pool.connect = originalConnect;
    await store.close();
  }
});

test('catalog reconciliation updates bindings, pending enrollments, admissions and audit records atomically', async () => {
  const store = new PostgresEnterpriseStore(
    'postgresql://managed-identity@example.postgres.database.azure.com:5432/postgres?sslmode=verify-full',
    { getToken: async () => ({ token: 'managed-identity-token' }) },
    false,
    false,
  );
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const client = {
    async query(text: string, values?: unknown[]) {
      queries.push({ text, values });
      if (text.startsWith('UPDATE enterprise_account_bindings')) {
        return {
          rowCount: 1,
          rows: [{ object_id: '22222222-2222-4222-8222-222222222222' }],
        };
      }
      if (text.includes("SELECT 'enrollment.catalog_updated'")) {
        return {
          rowCount: 2,
          rows: [
            { subject_id: '33333333-3333-4333-8333-333333333333' },
            { subject_id: '44444444-4444-4444-8444-444444444444' },
          ],
        };
      }
      if (text.startsWith('SELECT object_id')) {
        return {
          rowCount: 2,
          rows: [
            { object_id: '22222222-2222-4222-8222-222222222222' },
            { object_id: '55555555-5555-4555-8555-555555555555' },
          ],
        };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const originalConnect = store.pool.connect.bind(store.pool);
  store.pool.connect = (async () => client) as typeof store.pool.connect;
  try {
    const result = await store.reconcileModelCatalog(
      '11111111-1111-4111-8111-111111111111',
      ['claude-sonnet-5.5', 'claude-opus-5.5', 'claude-sonnet-5.5'],
    );
    assert.deepEqual(result, {
      objectIds: [
        '22222222-2222-4222-8222-222222222222',
        '55555555-5555-4555-8555-555555555555',
      ],
      changedBindings: 1,
      changedEnrollments: 2,
    });
    assert.ok(queries.some(query =>
      query.text.includes('revision = revision + 1')
      && query.text.includes('models IS DISTINCT FROM $2::jsonb')));
    assert.ok(queries.some(query =>
      query.text.startsWith('UPDATE enterprise_admissions')
      && query.text.includes('object_id = ANY($2::uuid[])')));
    assert.ok(queries.some(query => query.text.includes("'binding.catalog_updated'")));
    assert.ok(queries.some(query =>
      query.text.includes("status IN ('pending', 'authorizing')")
      && query.text.includes("'enrollment.catalog_updated'")));
    assert.ok(queries.some(query =>
      query.text.startsWith('SELECT object_id FROM (')
      && query.text.includes('FROM enterprise_account_bindings')
      && query.text.includes('UNION')
      && query.text.includes('FROM enterprise_enrollments')));
    assert.deepEqual(JSON.parse(String(queries[1]?.values?.[1] ?? queries[0]?.values?.[1])), [
      'claude-sonnet-5.5',
      'claude-opus-5.5',
    ]);
    assert.equal(queries.at(-1)?.text, 'COMMIT');
  } finally {
    store.pool.connect = originalConnect;
    await store.close();
  }
});

const connection = process.env.CCGC_TEST_POSTGRES_URL;

test('PostgreSQL store atomically binds, reserves, fences, audits and revokes', { skip: !connection }, async () => {
  const store = new PostgresEnterpriseStore(connection!, undefined, true);
  await store.initialize();
  try {
    await store.pool.query('TRUNCATE enterprise_audit_outbox, enterprise_dispatches, enterprise_admissions, enterprise_api_keys, enterprise_account_bindings RESTART IDENTITY CASCADE');
    const principal = {
      tenantId: '11111111-1111-1111-1111-111111111111',
      objectId: '22222222-2222-2222-2222-222222222222',
      subject: 'subject',
    };
    const linked = await store.linkAccount({
      ...principal,
      githubAccountId: 1234,
      githubLogin: 'developer',
      credentialSecretName: 'copilot-developer',
      models: ['claude-sonnet-5.5'],
      evidenceDigest: 'a'.repeat(64),
    });
    assert.equal(linked.revision, 1);
    assert.equal((await store.binding(principal)).githubAccountId, 1234);
    const issued = await store.issueApiKey(principal.tenantId, principal.objectId, 'developer pilot', 3600);
    assert.match(issued.apiKey, /^ccgc_sk_[A-Za-z0-9_-]{43}$/);
    const storedKey = await store.pool.query('SELECT key_hash FROM enterprise_api_keys WHERE id = $1', [issued.id]);
    assert.equal(storedKey.rows[0]?.key_hash, createHash('sha256').update(issued.apiKey).digest('hex'));
    assert.equal(JSON.stringify(storedKey.rows).includes(issued.apiKey), false);
    const apiPrincipal = await store.authenticateApiKey(issued.apiKey);
    assert.equal(apiPrincipal.authentication, 'apiKey');
    const admission = await store.createAdmission(apiPrincipal, 3600, 2);
    const tokenHash = Buffer.from(await crypto.subtle.digest('SHA-256', Buffer.from(admission.token))).toString('hex');
    const reserved = await store.reserveDispatch(tokenHash, 'b'.repeat(64), 'claude-sonnet-5.5', 'main');
    assert.equal(reserved.fence, 1);
    await assert.rejects(
      store.reserveDispatch(tokenHash, 'b'.repeat(64), 'claude-sonnet-5.5', 'main'),
      error => {
        const conflict = error as { code?: string; message?: string; status?: number };
        assert.equal(conflict.code, 'CONTEXT_CONFLICT');
        assert.equal(conflict.status, 409);
        assert.match(conflict.message ?? '', /conversation branch already has an active dispatch/i);
        return true;
      },
    );
    await store.finishDispatch(reserved.id, 'completed');
    await store.revokeApiKey(issued.id, 'e'.repeat(64));
    await assert.rejects(store.authenticateApiKey(issued.apiKey), /expired, or revoked/i);
    await store.revokeBinding(principal.tenantId, principal.objectId, 'c'.repeat(64));
    await assert.rejects(store.binding(principal), /no active same-user/i);
    await assert.rejects(
      store.reserveDispatch(tokenHash, 'd'.repeat(64), 'claude-sonnet-5.5', 'main'),
      /missing, expired, or revoked/i,
    );
    const audit = await store.pool.query('SELECT event_type FROM enterprise_audit_outbox ORDER BY id');
    assert.deepEqual(audit.rows.map(row => row.event_type), [
      'binding.linked',
      'api_key.created',
      'admission.created',
      'dispatch.reserved',
      'dispatch.finished',
      'api_key.revoked',
      'binding.revoked',
    ]);
  } finally {
    await store.close();
  }
});
