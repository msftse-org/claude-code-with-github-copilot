import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { bearerToken, type EnterpriseAuthenticator } from './enterprise-auth.ts';
import { BridgeError, envelope, object, parseJson, safeError, text } from './protocol.ts';
import type { EnterpriseStore } from './enterprise-store.ts';
import type { WorkerResolver } from './enterprise-worker.ts';

const MAX_BODY = 16 * 1024 * 1024;

export interface EnterpriseServerOptions {
  authenticator: EnterpriseAuthenticator;
  store: EnterpriseStore;
  workers: WorkerResolver;
  host?: string;
  port?: number;
  fetcher?: typeof fetch;
  onError?: (error: BridgeError) => void;
}

async function requestBody(request: IncomingMessage): Promise<Buffer> {
  if (!request.headers['content-type']?.startsWith('application/json')) {
    throw new BridgeError('INVALID_REQUEST', 'Expected an application/json request.', 415);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > MAX_BODY) throw new BridgeError('REQUEST_TOO_LARGE', 'Enterprise request exceeds 16 MiB.', 413);
    chunks.push(value);
  }
  return Buffer.concat(chunks);
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

export async function startEnterpriseServer(options: EnterpriseServerOptions) {
  await options.store.initialize();
  const fetcher = options.fetcher ?? fetch;
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
    if (request.headers.origin || !request.url?.startsWith('/') || request.url.startsWith('//')) {
      throw new BridgeError('ORIGIN_REJECTED', 'Browser origins and malformed paths are not accepted.', 403);
    }
    const url = new URL(request.url, 'https://enterprise.invalid');
    if (url.pathname === '/healthz' && request.method === 'GET') {
      send(response, 200, { status: 'listening', inference: 'not-verified' });
      return;
    }
    if (url.pathname === '/ccgc/enterprise/info' && request.method === 'GET') {
      const principal = await options.authenticator.authenticate(bearerToken(request.headers.authorization));
      const binding = await options.store.binding(principal);
      send(response, 200, {
        tenantId: principal.tenantId,
        objectId: principal.objectId,
        githubLogin: binding.githubLogin,
        githubAccountId: binding.githubAccountId,
        models: binding.models,
        bindingRevision: binding.revision,
      });
      return;
    }
    if (url.pathname === '/ccgc/enterprise/admissions' && request.method === 'POST') {
      const principal = await options.authenticator.authenticate(bearerToken(request.headers.authorization));
      const value = object(parseJson((await requestBody(request)).toString('utf8')));
      const ttlSeconds = value.ttlSeconds === undefined ? 28_800 : Number(value.ttlSeconds);
      const maxAttempts = value.maxAttempts === undefined ? 50 : Number(value.maxAttempts);
      send(response, 201, await options.store.createAdmission(principal, ttlSeconds, maxAttempts));
      return;
    }
    if (url.pathname === '/v1/models' && request.method === 'GET') {
      const admissionToken = bearerToken(request.headers.authorization);
      if (!/^[a-f0-9]{64}$/.test(admissionToken)) throw new BridgeError('ADMISSION_REQUIRED', 'A valid admission token is required.', 401);
      const tokenHash = createHash('sha256').update(admissionToken).digest('hex');
      const { binding } = await options.store.admissionBinding(tokenHash);
      const data = binding.models.map(id => ({
        id: id === 'claude-haiku-4.5' ? 'claude-haiku-4-5-20251001' : id.replaceAll('.', '-'),
        type: 'model',
        display_name: id,
        description: `GitHub Copilot isolated worker: ${id}. No provider fallback.`,
      }));
      send(response, 200, { data, has_more: false, first_id: data[0]?.id, last_id: data.at(-1)?.id });
      return;
    }
    if (url.pathname !== '/v1/messages' || request.method !== 'POST') {
      throw new BridgeError('ROUTE_UNSUPPORTED', 'Only enterprise metadata, admission, health, and native Messages routes are exposed.', 404);
    }
    const admissionToken = bearerToken(request.headers.authorization);
    if (!/^[a-f0-9]{64}$/.test(admissionToken)) throw new BridgeError('ADMISSION_REQUIRED', 'A valid admission token is required.', 401);
    const raw = await requestBody(request);
    const payload = object(parseJson(raw.toString('utf8')));
    const model = text(payload.model, 'model');
    const requestHash = createHash('sha256').update(raw).digest('hex');
    const tokenHash = createHash('sha256').update(admissionToken).digest('hex');
    const reservation = await options.store.reserveDispatch(tokenHash, requestHash, model);
    const worker = await options.workers.resolve(reservation.binding);
    const controller = new AbortController();
    request.once('close', () => controller.abort());
    let outcome: 'completed' | 'failed' | 'cancelled' = 'failed';
    try {
      const headers = new Headers({
        authorization: `Bearer ${worker.token}`,
        'content-type': 'application/json',
        'x-ccgc-dispatch-id': reservation.id,
        'x-ccgc-dispatch-fence': String(reservation.fence),
        'x-ccgc-admission-id': reservation.admissionId,
        'x-ccgc-principal-id': reservation.binding.objectId,
      });
      for (const name of ['anthropic-version', 'anthropic-beta', 'x-claude-code-session-id']) {
        const value = request.headers[name];
        if (typeof value === 'string' && !/[\r\n]/.test(value)) headers.set(name, value);
      }
      const upstream = await fetcher(`${worker.url}/v1/messages`, {
        method: 'POST',
        headers,
        body: new Uint8Array(raw),
        redirect: 'error',
        signal: controller.signal,
      });
      const responseHeaders: Record<string, string> = {
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-should-retry': 'false',
      };
      const contentType = upstream.headers.get('content-type');
      if (contentType) responseHeaders['content-type'] = contentType;
      response.writeHead(upstream.status, responseHeaders);
      if (!upstream.body) throw new BridgeError('UPSTREAM_FAILURE', 'The isolated worker returned no response body.', 502);
      for await (const chunk of upstream.body) {
        if (!response.write(chunk)) await new Promise<void>(resolve => response.once('drain', resolve));
      }
      response.end();
      outcome = upstream.ok ? 'completed' : 'failed';
    } catch (error) {
      outcome = controller.signal.aborted ? 'cancelled' : 'failed';
      throw error;
    } finally {
      await options.store.finishDispatch(reservation.id, outcome);
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new BridgeError('STARTUP_FAILED', 'Enterprise server did not bind.');
  return {
    port: address.port,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await options.store.close();
    },
  };
}
