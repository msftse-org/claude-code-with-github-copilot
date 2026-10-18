import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { bearerToken, type EnterpriseAuthenticator } from './enterprise-auth.ts';
import { BridgeError, envelope, object, parseJson, safeError, type ObjectValue } from './protocol.ts';

const MAX_BODY = 64 * 1024;

export interface OperatorActions {
  bootstrap(input: ObjectValue): Promise<ObjectValue>;
  createUser(input: ObjectValue): Promise<ObjectValue>;
  startConnection(input: ObjectValue): Promise<ObjectValue>;
  pollConnection(input: ObjectValue): Promise<ObjectValue>;
  bootstrapDatabase(): Promise<ObjectValue>;
  link(input: ObjectValue): Promise<ObjectValue>;
  revoke(input: ObjectValue): Promise<ObjectValue>;
  status(): Promise<ObjectValue>;
}

async function body(request: IncomingMessage): Promise<ObjectValue> {
  if (!request.headers['content-type']?.startsWith('application/json')) {
    throw new BridgeError('INVALID_REQUEST', 'Expected an application/json request.', 415);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > MAX_BODY) throw new BridgeError('REQUEST_TOO_LARGE', 'Operator request exceeds 64 KiB.', 413);
    chunks.push(value);
  }
  return object(parseJson(Buffer.concat(chunks).toString('utf8')));
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

export async function startEnterpriseOperatorServer(options: {
  authenticator: EnterpriseAuthenticator;
  actions: OperatorActions;
  host?: string;
  port?: number;
  onError?: (error: BridgeError) => void;
}) {
  const routes: Record<string, (input: ObjectValue) => Promise<ObjectValue>> = {
    '/ccgc/operator/bootstrap': input => options.actions.bootstrap(input),
    '/ccgc/operator/users': input => options.actions.createUser(input),
    '/ccgc/operator/connections/start': input => options.actions.startConnection(input),
    '/ccgc/operator/connections/poll': input => options.actions.pollConnection(input),
    '/ccgc/operator/database/bootstrap': () => options.actions.bootstrapDatabase(),
    '/ccgc/operator/link': input => options.actions.link(input),
    '/ccgc/operator/revoke': input => options.actions.revoke(input),
    '/ccgc/operator/status': () => options.actions.status(),
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch(error => {
      const failure = safeError(error);
      options.onError?.(failure);
      if (!response.headersSent) send(response, failure.status, envelope(failure));
      else if (!response.writableEnded) response.destroy();
    });
  });
  server.requestTimeout = 35_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 64;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.origin || !request.url?.startsWith('/') || request.url.startsWith('//')) {
      throw new BridgeError('ORIGIN_REJECTED', 'Browser origins and malformed paths are not accepted.', 403);
    }
    const url = new URL(request.url, 'https://operator.invalid');
    if (url.pathname === '/healthz' && request.method === 'GET') {
      send(response, 200, { status: 'listening' });
      return;
    }
    if (request.method !== 'POST' || !routes[url.pathname]) {
      throw new BridgeError('ROUTE_UNSUPPORTED', 'Unsupported operator route.', 404);
    }
    await options.authenticator.authenticate(bearerToken(request.headers.authorization));
    send(response, 200, await routes[url.pathname]!(await body(request)));
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new BridgeError('STARTUP_FAILED', 'Operator server did not bind.');
  return {
    port: address.port,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
