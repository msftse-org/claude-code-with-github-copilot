import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { bearerToken, type EnterpriseAuthenticator } from './enterprise-auth.ts';
import { BridgeError, envelope, object, parseJson, safeError, text, type ObjectValue } from './protocol.ts';
import type { EnterpriseStore } from './enterprise-store.ts';
import type { WorkerResolver } from './enterprise-worker.ts';
import type { DispatchSigner } from './enterprise-dispatch.ts';

const MAX_BODY = 16 * 1024 * 1024;
const MAX_ADMIN_BODY = 64 * 1024;

export interface EnterpriseAdministrationActions {
  createUser(input: ObjectValue): Promise<ObjectValue>;
  startConnection(input: ObjectValue): Promise<ObjectValue>;
  pollConnection(input: ObjectValue): Promise<ObjectValue>;
  link(input: ObjectValue): Promise<ObjectValue>;
  revoke(input: ObjectValue): Promise<ObjectValue>;
  createApiKey(input: ObjectValue): Promise<ObjectValue>;
  revokeApiKey(input: ObjectValue): Promise<ObjectValue>;
  createEnrollment(input: ObjectValue): Promise<ObjectValue>;
  startEnrollment(input: ObjectValue): Promise<ObjectValue>;
  pollEnrollment(input: ObjectValue): Promise<ObjectValue>;
  completeEnrollment(input: ObjectValue): Promise<ObjectValue>;
  status(): Promise<ObjectValue>;
}

export interface EnterpriseServerOptions {
  authenticator: EnterpriseAuthenticator;
  store: EnterpriseStore;
  workers: WorkerResolver;
  dispatchSigner: DispatchSigner;
  adminAuthenticator?: EnterpriseAuthenticator;
  adminActions?: EnterpriseAdministrationActions;
  host?: string;
  port?: number;
  fetcher?: typeof fetch;
  onError?: (error: BridgeError) => void;
}

async function requestBody(request: IncomingMessage, maximum = MAX_BODY): Promise<Buffer> {
  if (!request.headers['content-type']?.startsWith('application/json')) {
    throw new BridgeError('INVALID_REQUEST', 'Expected an application/json request.', 415);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > maximum) throw new BridgeError(
      'REQUEST_TOO_LARGE',
      maximum === MAX_ADMIN_BODY
        ? 'Administration request exceeds 64 KiB.'
        : 'Enterprise request exceeds 16 MiB.',
      413,
    );
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
    if (url.pathname.startsWith('/ccgc/admin/')) {
      if (!options.adminAuthenticator || !options.adminActions || request.method !== 'POST') {
        throw new BridgeError('ROUTE_UNSUPPORTED', 'Unsupported administration route.', 404);
      }
      const routes: Record<string, (input: ObjectValue) => Promise<ObjectValue>> = {
        '/ccgc/admin/users': input => options.adminActions!.createUser(input),
        '/ccgc/admin/connections/start': input => options.adminActions!.startConnection(input),
        '/ccgc/admin/connections/poll': input => options.adminActions!.pollConnection(input),
        '/ccgc/admin/link': input => options.adminActions!.link(input),
        '/ccgc/admin/revoke': input => options.adminActions!.revoke(input),
        '/ccgc/admin/api-keys': input => options.adminActions!.createApiKey(input),
        '/ccgc/admin/api-keys/revoke': input => options.adminActions!.revokeApiKey(input),
        '/ccgc/admin/enrollments': input => options.adminActions!.createEnrollment(input),
        '/ccgc/admin/status': () => options.adminActions!.status(),
      };
      const route = routes[url.pathname];
      if (!route) throw new BridgeError('ROUTE_UNSUPPORTED', 'Unsupported administration route.', 404);
      await options.adminAuthenticator.authenticate(bearerToken(request.headers.authorization));
      const input = object(parseJson((await requestBody(request, MAX_ADMIN_BODY)).toString('utf8')));
      send(response, 200, await route(input));
      return;
    }
    if (url.pathname.startsWith('/ccgc/enroll/') && request.method === 'POST') {
      if (!options.adminActions) throw new BridgeError('ROUTE_UNSUPPORTED', 'Self-service enrollment is unavailable.', 404);
      const routes: Record<string, (input: ObjectValue) => Promise<ObjectValue>> = {
        '/ccgc/enroll/start': input => options.adminActions!.startEnrollment(input),
        '/ccgc/enroll/poll': input => options.adminActions!.pollEnrollment(input),
        '/ccgc/enroll/complete': input => options.adminActions!.completeEnrollment(input),
      };
      const route = routes[url.pathname];
      if (!route) throw new BridgeError('ROUTE_UNSUPPORTED', 'Unsupported enrollment route.', 404);
      const input = object(parseJson((await requestBody(request, MAX_ADMIN_BODY)).toString('utf8')));
      send(response, 200, await route(input));
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
        authentication: principal.authentication ?? 'entra',
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
    const branchHeader = request.headers['x-claude-code-agent-id'];
    const branchId = typeof branchHeader === 'string' ? branchHeader : 'main';
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(branchId)) {
      throw new BridgeError('INVALID_REQUEST', 'Invalid Claude agent identifier.');
    }
    const requestHash = createHash('sha256').update(raw).digest('hex');
    const tokenHash = createHash('sha256').update(admissionToken).digest('hex');
    const reservation = await options.store.reserveDispatch(tokenHash, requestHash, model, branchId);
    const worker = await options.workers.resolve(reservation.binding);
    const assertion = await options.dispatchSigner.sign({
      dispatchId: reservation.id,
      tenantId: reservation.binding.tenantId,
      objectId: reservation.binding.objectId,
      admissionId: reservation.admissionId,
      branchId: reservation.branchId,
      bindingRevision: reservation.binding.revision,
      githubAccountId: reservation.binding.githubAccountId,
      githubLogin: reservation.binding.githubLogin,
      credentialSecretName: worker.credentialSecretName,
      fence: reservation.fence,
      model,
    });
    const controller = new AbortController();
    request.once('close', () => controller.abort());
    let outcome: 'completed' | 'failed' | 'cancelled' = 'failed';
    try {
      const headers = new Headers({
        authorization: `Bearer ${assertion}`,
        'content-type': 'application/json',
      });
      for (const name of ['anthropic-version', 'anthropic-beta', 'x-claude-code-session-id', 'x-claude-code-agent-id']) {
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
