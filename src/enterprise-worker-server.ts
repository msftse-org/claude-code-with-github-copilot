import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createMessageSession, type MessageSessionCheckpoint } from './gateway.ts';
import type { AccountConnectorFactory } from './enterprise-connector.ts';
import type { CheckpointIdentity, ConversationCheckpointStore } from './enterprise-checkpoint.ts';
import type { DispatchClaims, DispatchVerifier } from './enterprise-dispatch.ts';
import { BridgeError, envelope, object, safeError } from './protocol.ts';
import type { Model } from './protocol.ts';
import { clientHistory, isModelCheck, resolveModel } from './remote.ts';

interface WorkerSession {
  session: ReturnType<typeof createMessageSession>;
  claims: DispatchClaims;
  identity: CheckpointIdentity;
  version?: string;
  lastFence: number;
  createdAt: number;
  lastAt: number;
  save: Promise<void>;
}

export interface EnterpriseWorkerServerOptions {
  verifier: DispatchVerifier;
  connectors: AccountConnectorFactory;
  checkpoints: ConversationCheckpointStore;
  models: Model[];
  expectedHost: string;
  maxTurns?: number;
  maxActiveBranches?: number;
  maxActiveBranchesPerUser?: number;
  host?: string;
  port?: number;
  now?: () => number;
  onError?: (error: BridgeError) => void;
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-should-retry': 'false',
  });
  response.end(JSON.stringify(value));
}

function bearer(value: string | undefined): string {
  if (!value?.startsWith('Bearer ') || value.length < 8) {
    throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'A broker dispatch assertion is required.', 401);
  }
  return value.slice(7);
}

function messageCheckpoint(value: unknown): MessageSessionCheckpoint {
  const checkpoint = object(value);
  const stats = object(checkpoint.stats);
  const usage = object(stats.usage);
  const nonnegative = (candidate: unknown) => typeof candidate === 'number'
    && Number.isSafeInteger(candidate) && candidate >= 0;
  if (checkpoint.version !== 1
    || !Array.isArray(checkpoint.prefix) || checkpoint.prefix.some(value => typeof value !== 'string')
    || !Array.isArray(checkpoint.prefixFields) || checkpoint.prefixFields.some(value => {
      const fields = object(value);
      return Object.values(fields).some(field => typeof field !== 'string');
    })
    || !Array.isArray(checkpoint.prefixShapes)
    || !Array.isArray(checkpoint.pending) || checkpoint.pending.some(value => typeof value !== 'string')
    || !Array.isArray(checkpoint.seen) || checkpoint.seen.some(value => typeof value !== 'string')
    || !nonnegative(checkpoint.pendingSince)
    || !nonnegative(stats.attempts) || !nonnegative(stats.completed) || !nonnegative(stats.failed)
    || Object.values(usage).some(value => !nonnegative(value))
    || (checkpoint.semantics !== undefined && typeof checkpoint.semantics !== 'string')
    || (checkpoint.compactionSummary !== undefined && typeof checkpoint.compactionSummary !== 'string')
    || (checkpoint.selectedModel !== undefined && typeof checkpoint.selectedModel !== 'string')) {
    throw new BridgeError('CREDENTIAL_STORE_UNSAFE', 'Durable conversation checkpoint is malformed.');
  }
  if (checkpoint.pendingAssistant !== undefined) object(checkpoint.pendingAssistant);
  return structuredClone(checkpoint) as unknown as MessageSessionCheckpoint;
}

function identity(claims: DispatchClaims): CheckpointIdentity {
  return {
    tenantId: claims.tenantId,
    objectId: claims.objectId,
    bindingRevision: claims.bindingRevision,
    admissionId: claims.admissionId,
    branchId: claims.branchId,
    githubAccountId: claims.githubAccountId,
  };
}

function sessionId(claims: DispatchClaims): string {
  return [
    claims.tenantId, claims.objectId, claims.bindingRevision,
    claims.admissionId, claims.branchId,
  ].join(':');
}

function sameAccount(left: DispatchClaims, right: DispatchClaims): boolean {
  return left.tenantId === right.tenantId && left.objectId === right.objectId
    && left.bindingRevision === right.bindingRevision && left.githubAccountId === right.githubAccountId
    && left.githubLogin === right.githubLogin && left.credentialSecretName === right.credentialSecretName;
}

export async function startEnterpriseWorkerServer(options: EnterpriseWorkerServerOptions) {
  if (!options.models.length || options.models.length > 100
    || !/^[a-z0-9.-]+(?::\d+)?$/i.test(options.expectedHost)) {
    throw new BridgeError('INVALID_OPTIONS', 'Enterprise worker host or model catalog is invalid.');
  }
  const now = options.now ?? Date.now;
  const maxTurns = options.maxTurns ?? 50;
  const maxActiveBranches = options.maxActiveBranches ?? 500;
  const maxActiveBranchesPerUser = options.maxActiveBranchesPerUser ?? 4;
  if (!Number.isSafeInteger(maxActiveBranches) || maxActiveBranches < 1
    || !Number.isSafeInteger(maxActiveBranchesPerUser) || maxActiveBranchesPerUser < 1) {
    throw new BridgeError('INVALID_OPTIONS', 'Enterprise worker branch capacity is invalid.');
  }
  const sessions = new Map<string, WorkerSession>();
  const seenDispatches = new Map<string, number>();
  const expire = () => {
    for (const [id, record] of sessions) {
      if (now() - record.lastAt >= 15 * 60_000 || now() - record.createdAt >= 8 * 60 * 60_000) {
        record.session.close();
        sessions.delete(id);
      }
    }
    for (const [id, seenAt] of seenDispatches) {
      if (now() - seenAt >= 2 * 60_000) seenDispatches.delete(id);
    }
  };
  const timer = setInterval(expire, 30_000);
  timer.unref();
  const server = createServer((request, response) => {
    void handle(request, response).catch(error => {
      const failure = safeError(error);
      options.onError?.(failure);
      if (!response.headersSent) send(response, failure.status, envelope(failure));
      else if (!response.writableEnded) response.destroy();
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 64;

  async function createSession(claims: DispatchClaims): Promise<WorkerSession> {
    if (sessions.size >= maxActiveBranches) {
      throw new BridgeError('LIMIT_REACHED', 'Shared worker branch capacity is exhausted.', 429);
    }
    const activeForUser = [...sessions.values()].filter(record =>
      record.claims.tenantId === claims.tenantId && record.claims.objectId === claims.objectId).length;
    if (activeForUser >= maxActiveBranchesPerUser) {
      throw new BridgeError('LIMIT_REACHED', 'Per-user active branch capacity is exhausted.', 429);
    }
    const checkpointIdentity = identity(claims);
    const stored = await options.checkpoints.load(checkpointIdentity);
    const backend = await options.connectors.connector(claims);
    const createdAt = now();
    const record: WorkerSession = {
      claims,
      identity: checkpointIdentity,
      version: stored?.version,
      lastFence: 0,
      createdAt,
      lastAt: createdAt,
      save: Promise.resolve(),
      session: undefined as never,
    };
    record.session = createMessageSession({
      backend,
      model: resolveModel(options.models, claims.model),
      maxTurns,
      resolveModel: id => resolveModel(options.models, id),
      history: clientHistory,
      isModelCheck,
      onError: options.onError,
      restoredBranches: stored ? { main: messageCheckpoint(stored.checkpoint) } : {},
      checkpoint(id, value) {
        if (id !== 'main') {
          return Promise.reject(new BridgeError('CONTEXT_CONFLICT', 'Worker branch routing escaped its signed dispatch scope.', 409));
        }
        record.save = record.save.then(async () => {
          if (!value) {
            if (record.version) await options.checkpoints.delete(record.identity, record.version);
            record.version = undefined;
            return;
          }
          record.version = await options.checkpoints.save(
            record.identity,
            messageCheckpoint(value),
            record.version,
          );
        });
        return record.save;
      },
    }, claims.dispatchId, `https://${options.expectedHost}`);
    sessions.set(sessionId(claims), record);
    return record;
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    expire();
    if (request.url === '/healthz' && request.method === 'GET') {
      send(response, 200, {
        status: 'listening',
        activeBranches: sessions.size,
        cachedDispatches: seenDispatches.size,
        inference: 'not-verified',
      });
      return;
    }
    if (request.headers.origin || request.headers.host !== options.expectedHost) {
      throw new BridgeError('ORIGIN_REJECTED', 'Worker host or origin is not approved.', 403);
    }
    if (request.url !== '/v1/messages' || request.method !== 'POST') {
      throw new BridgeError('ROUTE_UNSUPPORTED', 'Only worker health and native Messages routes are exposed.', 404);
    }
    const claims = await options.verifier.verify(bearer(request.headers.authorization));
    if (seenDispatches.has(claims.dispatchId)) {
      throw new BridgeError('CONTEXT_CONFLICT', 'Duplicate broker dispatch rejected before inference.', 409);
    }
    seenDispatches.set(claims.dispatchId, now());
    let record = sessions.get(sessionId(claims));
    if (!record) record = await createSession(claims);
    if (!sameAccount(record.claims, claims)) {
      throw new BridgeError('IDENTITY_CONFLICT', 'Dispatch account differs from the active branch binding.', 403);
    }
    if (claims.fence <= record.lastFence) {
      throw new BridgeError('CONTEXT_CONFLICT', 'Stale dispatch fence rejected before inference.', 409);
    }
    record.lastFence = claims.fence;
    record.lastAt = now();
    request.headers.authorization = `Bearer ${record.claims.dispatchId}`;
    delete request.headers['x-api-key'];
    delete request.headers['x-claude-code-agent-id'];
    let released = false;
    const release = () => {
      if (released || !record) return;
      released = true;
      record.lastAt = now();
      record.session.close();
      sessions.delete(sessionId(record.claims));
      void record.save.catch(error => options.onError?.(safeError(error)));
    };
    response.once('finish', release);
    response.once('close', release);
    record.session.handle(request, response);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new BridgeError('STARTUP_FAILED', 'Enterprise worker did not bind.');
  return {
    port: address.port,
    async close() {
      clearInterval(timer);
      for (const record of sessions.values()) {
        record.session.close();
        await record.save;
      }
      sessions.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
