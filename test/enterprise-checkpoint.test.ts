import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EncryptedAzureBlobCheckpointStore, type CheckpointIdentity } from '../src/enterprise-checkpoint.ts';
import type { MessageSessionCheckpoint } from '../src/gateway.ts';

const identity: CheckpointIdentity = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  objectId: '22222222-2222-2222-2222-222222222222',
  bindingRevision: 1,
  admissionId: '33333333-3333-3333-3333-333333333333',
  branchId: 'main',
  githubAccountId: 1234,
};
const checkpoint: MessageSessionCheckpoint = {
  version: 1,
  prefix: ['private-marker'],
  prefixFields: [{}],
  prefixShapes: [],
  pending: [],
  pendingSince: 0,
  seen: [],
  stats: { attempts: 1, completed: 1, failed: 0, usage: {} },
};

test('Azure Blob checkpoints are encrypted, identity bound, and conditionally versioned', async () => {
  const blobs = new Map<string, { body: Uint8Array; etag: string }>();
  let version = 0;
  const store = new EncryptedAzureBlobCheckpointStore(
    'https://ccgctest.blob.core.windows.net/',
    'checkpoints',
    Buffer.alloc(32, 7).toString('base64'),
    { async getToken(scope) {
      assert.equal(scope, 'https://storage.azure.com/.default');
      return { token: 'storage-token' };
    } },
    async (input, init = {}) => {
      const url = String(input);
      const headers = new Headers(init.headers);
      assert.equal(headers.get('authorization'), 'Bearer storage-token');
      const current = blobs.get(url);
      if (init.method === 'GET') {
        return current
          ? new Response(current.body.buffer as ArrayBuffer, { status: 200, headers: { etag: current.etag } })
          : new Response(null, { status: 404 });
      }
      if (init.method === 'PUT') {
        const expected = headers.get('if-match');
        if ((expected && current?.etag !== expected) || (headers.get('if-none-match') === '*' && current)) {
          return new Response(null, { status: 412 });
        }
        const body = new Uint8Array(await new Response(init.body).arrayBuffer());
        const etag = `"${++version}"`;
        blobs.set(url, { body, etag });
        return new Response(null, { status: 201, headers: { etag } });
      }
      if (init.method === 'DELETE') {
        if (current?.etag !== headers.get('if-match')) return new Response(null, { status: 412 });
        blobs.delete(url);
        return new Response(null, { status: 202 });
      }
      return new Response(null, { status: 405 });
    },
  );

  const firstVersion = await store.save(identity, checkpoint);
  const encrypted = [...blobs.values()][0]?.body;
  assert.ok(encrypted);
  assert.doesNotMatch(Buffer.from(encrypted).toString('utf8'), /private-marker/);
  assert.deepEqual(await store.load(identity), { checkpoint, version: firstVersion });
  await assert.rejects(store.save(identity, checkpoint), /changed on another worker/i);
  const secondVersion = await store.save(identity, checkpoint, firstVersion);
  await assert.rejects(
    store.load({ ...identity, githubAccountId: 9999 }),
    /identity does not match/i,
  );
  await store.delete(identity, secondVersion);
  assert.equal(await store.load(identity), undefined);
});
