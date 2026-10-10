import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createMessageSession } from './gateway.ts';
import { LiteLLMBackend } from './litellm.ts';
import { BridgeError, envelope, safeError } from './protocol.ts';
import type { Model } from './protocol.ts';
import { clientHistory, isModelCheck, resolveModel } from './remote.ts';

interface WorkerSession {
  session: ReturnType<typeof createMessageSession>;
  lastFence: number;
  createdAt: number;
  lastAt: number;
}

export interface EnterpriseWorkerServerOptions {
  token: string;
  principalId: string;
  githubAccountId: number;
  models: Model[];
  litellmUrl: string;
  litellmToken: string;
  expectedHost: string;
  maxTurns?: number;
  host?: string;
  port?: number;
  now?: () => number;
  fetcher?: typeof fetch;
  onError?: (error: BridgeError) => void;
}

function equal(left: string, right: string): boolean {
  return Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
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

export async function startEnterpriseWorkerServer(options: EnterpriseWorkerServerOptions) {
  if (options.token.length < 32 || /[\r\n]/.test(options.token)
    || !/^[0-9a-f-]{36}$/i.test(options.principalId) || !Number.isSafeInteger(options.githubAccountId)
    || options.githubAccountId <= 0 || !options.models.length || options.models.length > 100
    || !/^[a-z0-9.-]+(?::\d+)?$/i.test(options.expectedHost)) {
    throw new BridgeError('INVALID_OPTIONS', 'Enterprise worker identity, token, host, or model catalog is invalid.');
  }
  const now = options.now ?? Date.now;
  const maxTurns = options.maxTurns ?? 50;
  const backend = new LiteLLMBackend(options.litellmUrl, options.litellmToken, options.fetcher);
  const sessions = new Map<string, WorkerSession>();
  const expire = () => {
    for (const [id, record] of sessions) {
      if (now() - record.lastAt >= 15 * 60_000 || now() - record.createdAt >= 8 * 60 * 60_000) {
        record.session.close();
        sessions.delete(id);
      }
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

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    expire();
    if (request.url === '/healthz' && request.method === 'GET') {
      send(response, 200, {
        status: 'listening',
        activeAdmissions: sessions.size,
        inference: 'not-verified',
      });
      return;
    }
    if (request.headers.origin || request.headers.host !== options.expectedHost) {
      throw new BridgeError('ORIGIN_REJECTED', 'Worker host or origin is not approved.', 403);
    }
    const authorization = request.headers.authorization;
    const supplied = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    const principalId = request.headers['x-ccgc-principal-id'];
    const admissionId = request.headers['x-ccgc-admission-id'];
    const fenceValue = request.headers['x-ccgc-dispatch-fence'];
    if (!supplied || !equal(supplied, options.token) || principalId !== options.principalId
      || typeof admissionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(admissionId)
      || typeof fenceValue !== 'string' || !/^\d+$/.test(fenceValue)) {
      throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'Broker authentication, principal binding, admission, or fence is invalid.', 401);
    }
    const fence = Number(fenceValue);
    let record = sessions.get(admissionId);
    if (!record) {
      if (sessions.size >= 4) throw new BridgeError('CONTEXT_CONFLICT', 'Worker admission capacity is exhausted.', 409);
      const createdAt = now();
      const workerSession: WorkerSession = {
        lastFence: 0,
        createdAt,
        lastAt: createdAt,
        session: undefined as never,
      };
      workerSession.session = createMessageSession({
        backend,
        model: options.models[0]!,
        maxTurns,
        resolveModel: id => resolveModel(options.models, id),
        history: clientHistory,
        isModelCheck,
        onError: options.onError,
      }, options.token, `https://${options.expectedHost}`);
      sessions.set(admissionId, workerSession);
      record = workerSession;
    }
    if (!Number.isSafeInteger(fence) || fence <= record.lastFence) {
      throw new BridgeError('CONTEXT_CONFLICT', 'Stale or duplicate dispatch fence rejected before inference.', 409);
    }
    record.lastFence = fence;
    record.lastAt = now();
    request.headers.authorization = `Bearer ${options.token}`;
    delete request.headers['x-api-key'];
    response.once('close', () => { if (record) record.lastAt = now(); });
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
      for (const record of sessions.values()) record.session.close();
      sessions.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
