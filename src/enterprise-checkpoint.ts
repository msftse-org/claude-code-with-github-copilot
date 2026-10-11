import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { MessageSessionCheckpoint } from './gateway.ts';
import { BridgeError, object, parseJson, positive, text } from './protocol.ts';

const MAX_CHECKPOINT_BYTES = 32 * 1024 * 1024;

export interface CheckpointIdentity {
  tenantId: string;
  objectId: string;
  bindingRevision: number;
  admissionId: string;
  branchId: string;
  githubAccountId: number;
}

export interface StoredCheckpoint {
  checkpoint: MessageSessionCheckpoint;
  version: string;
}

export interface ConversationCheckpointStore {
  load(identity: CheckpointIdentity): Promise<StoredCheckpoint | undefined>;
  save(identity: CheckpointIdentity, checkpoint: MessageSessionCheckpoint, expectedVersion?: string): Promise<string>;
  delete(identity: CheckpointIdentity, expectedVersion: string): Promise<void>;
}

export interface StorageTokenProvider {
  getToken(scope: string): Promise<{ token: string } | null>;
}

function segment(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new BridgeError('CREDENTIAL_STORE_UNSAFE', 'Checkpoint identity is invalid.');
  }
  return encodeURIComponent(value);
}

function path(identity: CheckpointIdentity): string {
  return [
    segment(identity.tenantId),
    segment(identity.objectId),
    String(positive(identity.bindingRevision, 'binding revision')),
    segment(identity.admissionId),
    `${segment(identity.branchId)}.bin`,
  ].join('/');
}

function sameIdentity(left: CheckpointIdentity, right: CheckpointIdentity): boolean {
  return left.tenantId === right.tenantId && left.objectId === right.objectId
    && left.bindingRevision === right.bindingRevision && left.admissionId === right.admissionId
    && left.branchId === right.branchId && left.githubAccountId === right.githubAccountId;
}

function encryptionKey(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new BridgeError('INVALID_OPTIONS', 'Checkpoint encryption key must be a base64-encoded 32-byte key.');
  }
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new BridgeError('INVALID_OPTIONS', 'Checkpoint encryption key must contain 32 bytes.');
  return key;
}

interface Envelope {
  version: 1;
  identity: CheckpointIdentity;
  checkpoint: MessageSessionCheckpoint;
}

export class EncryptedAzureBlobCheckpointStore implements ConversationCheckpointStore {
  readonly container: URL;
  readonly key: Buffer;
  readonly credential: StorageTokenProvider;
  readonly fetcher: typeof fetch;

  constructor(
    accountUrl: string,
    containerName: string,
    encryptionKeyBase64: string,
    credential: StorageTokenProvider,
    fetcher: typeof fetch = fetch,
  ) {
    const url = new URL(accountUrl);
    if (url.protocol !== 'https:' || !/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(url.hostname)
      || url.pathname !== '/' || !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(containerName)) {
      throw new BridgeError('INVALID_OPTIONS', 'Azure checkpoint storage endpoint or container is invalid.');
    }
    this.container = new URL(`${containerName}/`, url);
    this.key = encryptionKey(encryptionKeyBase64);
    this.credential = credential;
    this.fetcher = fetcher;
  }

  private async request(identity: CheckpointIdentity, init: RequestInit): Promise<Response> {
    const access = await this.credential.getToken('https://storage.azure.com/.default');
    if (!access?.token) throw new BridgeError('GATEWAY_UNAVAILABLE', 'Azure Storage token acquisition failed.', 503);
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${access.token}`);
    headers.set('x-ms-version', '2023-11-03');
    headers.set('x-ms-date', new Date().toUTCString());
    return this.fetcher(new URL(path(identity), this.container), { ...init, headers, redirect: 'error' });
  }

  private encrypt(identity: CheckpointIdentity, checkpoint: MessageSessionCheckpoint): Buffer {
    const nonce = randomBytes(12);
    const aad = Buffer.from(path(identity));
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(aad);
    const body = Buffer.concat([
      cipher.update(JSON.stringify({ version: 1, identity, checkpoint } satisfies Envelope)),
      cipher.final(),
    ]);
    return Buffer.concat([nonce, cipher.getAuthTag(), body]);
  }

  private decrypt(identity: CheckpointIdentity, value: Uint8Array): MessageSessionCheckpoint {
    const encrypted = Buffer.from(value);
    if (encrypted.length < 29) throw new BridgeError('CREDENTIAL_STORE_UNSAFE', 'Encrypted checkpoint is malformed.');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, encrypted.subarray(0, 12));
      decipher.setAAD(Buffer.from(path(identity)));
      decipher.setAuthTag(encrypted.subarray(12, 28));
      const decoded = object(parseJson(Buffer.concat([
        decipher.update(encrypted.subarray(28)), decipher.final(),
      ]).toString('utf8')));
      const storedIdentity = object(decoded.identity);
      const restored: CheckpointIdentity = {
        tenantId: text(storedIdentity.tenantId, 'checkpoint tenant'),
        objectId: text(storedIdentity.objectId, 'checkpoint principal'),
        bindingRevision: positive(storedIdentity.bindingRevision, 'checkpoint binding revision'),
        admissionId: text(storedIdentity.admissionId, 'checkpoint admission'),
        branchId: text(storedIdentity.branchId, 'checkpoint branch'),
        githubAccountId: positive(storedIdentity.githubAccountId, 'checkpoint GitHub account'),
      };
      if (decoded.version !== 1 || !sameIdentity(identity, restored)) {
        throw new BridgeError('CREDENTIAL_STORE_UNSAFE', 'Checkpoint identity does not match the admitted account.');
      }
      return structuredClone(object(decoded.checkpoint)) as unknown as MessageSessionCheckpoint;
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('CREDENTIAL_STORE_UNSAFE', 'Encrypted checkpoint authentication failed.');
    }
  }

  async load(identity: CheckpointIdentity): Promise<StoredCheckpoint | undefined> {
    const response = await this.request(identity, { method: 'GET' });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new BridgeError('GATEWAY_UNAVAILABLE', `Checkpoint load failed with HTTP ${response.status}.`, 503);
    const version = response.headers.get('etag');
    if (!version) throw new BridgeError('CREDENTIAL_STORE_UNSAFE', 'Checkpoint version is missing.');
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > MAX_CHECKPOINT_BYTES) throw new BridgeError('CREDENTIAL_STORE_UNSAFE', 'Encrypted checkpoint exceeds the reviewed size limit.');
    const encrypted = new Uint8Array(await response.arrayBuffer());
    if (encrypted.length > MAX_CHECKPOINT_BYTES) throw new BridgeError('CREDENTIAL_STORE_UNSAFE', 'Encrypted checkpoint exceeds the reviewed size limit.');
    return { checkpoint: this.decrypt(identity, encrypted), version };
  }

  async save(identity: CheckpointIdentity, checkpoint: MessageSessionCheckpoint, expectedVersion?: string): Promise<string> {
    const encrypted = this.encrypt(identity, checkpoint);
    if (encrypted.length > MAX_CHECKPOINT_BYTES) {
      throw new BridgeError('REQUEST_TOO_LARGE', 'Conversation checkpoint exceeds the reviewed size limit.', 413);
    }
    const response = await this.request(identity, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'x-ms-blob-type': 'BlockBlob',
        [expectedVersion ? 'if-match' : 'if-none-match']: expectedVersion ?? '*',
      },
      body: new Uint8Array(encrypted),
    });
    if (response.status === 409 || response.status === 412) {
      throw new BridgeError('CONTEXT_CONFLICT', 'Conversation checkpoint changed on another worker replica.', 409);
    }
    if (!response.ok) throw new BridgeError('GATEWAY_UNAVAILABLE', `Checkpoint save failed with HTTP ${response.status}.`, 503);
    const version = response.headers.get('etag');
    if (!version) throw new BridgeError('CREDENTIAL_STORE_UNSAFE', 'Checkpoint version is missing.');
    return version;
  }

  async delete(identity: CheckpointIdentity, expectedVersion: string): Promise<void> {
    const response = await this.request(identity, { method: 'DELETE', headers: { 'if-match': expectedVersion } });
    if (response.status === 404) return;
    if (response.status === 409 || response.status === 412) {
      throw new BridgeError('CONTEXT_CONFLICT', 'Conversation checkpoint changed on another worker replica.', 409);
    }
    if (!response.ok) throw new BridgeError('GATEWAY_UNAVAILABLE', `Checkpoint deletion failed with HTTP ${response.status}.`, 503);
  }
}

export class MemoryCheckpointStore implements ConversationCheckpointStore {
  readonly values = new Map<string, StoredCheckpoint>();
  private version = 0;

  async load(identity: CheckpointIdentity): Promise<StoredCheckpoint | undefined> {
    const value = this.values.get(path(identity));
    return value ? structuredClone(value) : undefined;
  }

  async save(identity: CheckpointIdentity, checkpoint: MessageSessionCheckpoint, expectedVersion?: string): Promise<string> {
    const id = path(identity);
    const current = this.values.get(id);
    if (current?.version !== expectedVersion || (!current && expectedVersion !== undefined)) {
      throw new BridgeError('CONTEXT_CONFLICT', 'Conversation checkpoint changed on another worker replica.', 409);
    }
    const version = String(++this.version);
    this.values.set(id, { checkpoint: structuredClone(checkpoint), version });
    return version;
  }

  async delete(identity: CheckpointIdentity, expectedVersion: string): Promise<void> {
    const id = path(identity);
    const current = this.values.get(id);
    if (current && current.version !== expectedVersion) {
      throw new BridgeError('CONTEXT_CONFLICT', 'Conversation checkpoint changed on another worker replica.', 409);
    }
    this.values.delete(id);
  }
}
