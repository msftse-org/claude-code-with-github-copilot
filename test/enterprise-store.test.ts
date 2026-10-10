import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PostgresEnterpriseStore } from '../src/enterprise-store.ts';

const connection = process.env.CCGC_TEST_POSTGRES_URL;

test('PostgreSQL store atomically binds, reserves, fences, audits and revokes', { skip: !connection }, async () => {
  const store = new PostgresEnterpriseStore(connection!, undefined, true);
  await store.initialize();
  try {
    await store.pool.query('TRUNCATE enterprise_audit_outbox, enterprise_dispatches, enterprise_admissions, enterprise_account_bindings RESTART IDENTITY CASCADE');
    const principal = {
      tenantId: '11111111-1111-1111-1111-111111111111',
      objectId: '22222222-2222-2222-2222-222222222222',
      subject: 'subject',
    };
    const linked = await store.linkAccount({
      ...principal,
      githubAccountId: 1234,
      githubLogin: 'developer',
      workerSecretName: 'worker-developer',
      models: ['claude-sonnet-5.5'],
      evidenceDigest: 'a'.repeat(64),
    });
    assert.equal(linked.revision, 1);
    assert.equal((await store.binding(principal)).githubAccountId, 1234);
    const admission = await store.createAdmission(principal, 3600, 2);
    const tokenHash = Buffer.from(await crypto.subtle.digest('SHA-256', Buffer.from(admission.token))).toString('hex');
    const reserved = await store.reserveDispatch(tokenHash, 'b'.repeat(64), 'claude-sonnet-5.5');
    assert.equal(reserved.fence, 1);
    await assert.rejects(
      store.reserveDispatch(tokenHash, 'b'.repeat(64), 'claude-sonnet-5.5'),
      /already reserved/i,
    );
    await store.finishDispatch(reserved.id, 'completed');
    await store.revokeBinding(principal.tenantId, principal.objectId, 'c'.repeat(64));
    await assert.rejects(store.binding(principal), /no active same-user/i);
    await assert.rejects(
      store.reserveDispatch(tokenHash, 'd'.repeat(64), 'claude-sonnet-5.5'),
      /missing, expired, or revoked/i,
    );
    const audit = await store.pool.query('SELECT event_type FROM enterprise_audit_outbox ORDER BY id');
    assert.deepEqual(audit.rows.map(row => row.event_type), [
      'binding.linked',
      'admission.created',
      'dispatch.reserved',
      'dispatch.finished',
      'binding.revoked',
    ]);
  } finally {
    await store.close();
  }
});
