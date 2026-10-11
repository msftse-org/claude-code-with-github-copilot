import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createMessageSession } from './gateway.ts';
import type { Backend } from './copilot.ts';
import { BridgeError, envelope, object, parseJson, safeError } from './protocol.ts';
import { clientHistory, clientModelId, credential, gatewayUrl, isModelCheck, PROBE_PROMPT, REMOTE_PROFILE, remoteInfo, resolveModel } from './remote.ts';
import type { RemoteInfo } from './remote.ts';

const HOUR = 60 * 60_000;
const key = () => randomBytes(32).toString('hex');
type Session = ReturnType<typeof createMessageSession>;
const probeDateContext = /^<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# currentDate\nToday's date is \d{4}-\d{2}-\d{2}\.\n\n {6}IMPORTANT: this context may or may not be relevant to your tasks\. You should not respond to this context unless it is highly relevant to your task\.\n<\/system-reminder>\n\n$/;

export interface RemoteServerOptions {
  publicUrl: string;
  ownerKey: string;
  backend: Backend;
  verify: () => Promise<Omit<RemoteInfo, 'instance' | 'profile'>>;
  ownerIsRevoked: () => Promise<boolean>;
  revokeOwner: () => Promise<void>;
  host?: string;
  port?: number;
  now?: () => number;
  onError?: (error: BridgeError) => void;
}

function equal(left: string, right: string): boolean {
  return Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function bearer(request: IncomingMessage): string {
  const auth = request.headers.authorization;
  const apiKey = request.headers['x-api-key'];
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : apiKey;
  if (typeof token !== 'string' || (auth !== undefined && auth !== `Bearer ${token}`)
    || (apiKey !== undefined && apiKey !== token)) throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'Conflicting or missing gateway credentials.', 401);
  return credential(token);
}

function send(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-should-retry': 'false' });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new BridgeError('INVALID_REQUEST', 'Expected JSON.', 415);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const data: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > 16_384) throw new BridgeError('REQUEST_TOO_LARGE', 'Control request exceeds 16 KiB.', 413);
    chunks.push(data);
  }
  return parseJson(Buffer.concat(chunks).toString('utf8'));
}

export async function startRemoteServer(options: RemoteServerOptions) {
  const publicUrl = gatewayUrl(options.publicUrl);
  const origin = new URL(publicUrl).origin;
  const prefix = new URL(publicUrl).pathname.replace(/\/$/, '');
  const ownerKey = credential(options.ownerKey);
  const now = options.now ?? Date.now;
  const instance = randomUUID();
  const initial = await options.verify();
  const info = remoteInfo({ ...initial, instance, profile: REMOTE_PROFILE });
  let revoked = await options.ownerIsRevoked();
  if (revoked) throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'Gateway owner access was revoked.', 401);
  let controlBusy = false;
  let probe: { id: string; token: string; expires: number; session: Session; attempts: number } | undefined;
  let grant: {
    id: string; token: string; tokenExpires: number; expires: number; lastAt: number;
    session: Session; internalKey: string; attempts: number; sessionId?: string;
  } | undefined;

  async function verifyBinding() {
    const current = await options.verify();
    if (current.accountId !== info.accountId || current.login !== info.login
      || JSON.stringify(current.model) !== JSON.stringify(info.model)
      || JSON.stringify(current.models) !== JSON.stringify(info.models) || current.maxTurns !== info.maxTurns) {
      clear();
      throw new BridgeError('IDENTITY_CONFLICT', 'Account or model profile changed; restart and verify the deployment.', 403);
    }
  }
  function clear() {
    probe?.session.close(); probe = undefined;
    grant?.session.close(); grant = undefined;
  }
  function expire() {
    if (probe && now() >= probe.expires) { probe.session.close(); probe = undefined; }
    if (grant && (now() >= grant.expires || now() - grant.lastAt >= 15 * 60_000)) {
      grant.session.close(); grant = undefined;
    }
  }
  const timer = setInterval(expire, 1000);
  timer.unref();
  const server = createServer((request, response) => {
    void handle(request, response).catch(error => {
      const failure = safeError(error);
      options.onError?.(failure);
      if (!response.headersSent) send(response, failure.status, envelope(failure));
      else if (!response.writableEnded) response.end(`event: error\ndata: ${JSON.stringify(envelope(failure))}\n\n`);
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 64;
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));

  async function handle(request: IncomingMessage, response: ServerResponse) {
    expire();
    if (request.headers.origin || request.headers.host !== new URL(origin).host
      || !request.url?.startsWith('/') || request.url.startsWith('//')) {
      throw new BridgeError('ORIGIN_REJECTED', 'Unrecognized gateway host/origin.', 403);
    }
    const url = new URL(request.url, origin);
    if (!url.pathname.startsWith(`${prefix}/`)) throw new BridgeError('ROUTE_UNSUPPORTED', 'Unknown path prefix.', 404);
    const path = url.pathname.slice(prefix.length);
    if (path === '/healthz' && request.method === 'GET') { send(response, 200, { status: 'listening', inference: 'not-verified' }); return; }
    if (path === '/api/hello' && request.method === 'HEAD') { response.writeHead(204); response.end(); return; }
    const token = bearer(request);
    if (revoked || await options.ownerIsRevoked()) {
      revoked = true; clear();
      throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'Gateway owner credential was revoked.', 401);
    }
    if (path.startsWith('/ccgc/')) {
      if (!equal(token, ownerKey)) throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'An owner renewal credential is required for this operation.', 401);
      if (path === '/ccgc/info' && request.method === 'GET') { await verifyBinding(); send(response, 200, info); return; }
      if (request.method !== 'POST') throw new BridgeError('METHOD_UNSUPPORTED', 'Control operation requires POST.', 405);
      const input = await body(request);
      if (controlBusy) throw new BridgeError('CONTEXT_CONFLICT', 'Another control operation is in progress.', 409);
      controlBusy = true;
      try {
        if (path === '/ccgc/logout') {
          clear();
          await options.revokeOwner();
          revoked = true;
          send(response, 200, { status: 'revoked', copilotGrant: 'unchanged; operator must unlink/revoke separately' });
          return;
        }
        if (path === '/ccgc/probe') {
          if (input.profile !== REMOTE_PROFILE || input.model !== info.model.id) throw new BridgeError('VERSION_UNSUPPORTED', 'Probe profile/model mismatch.');
          if (grant) throw new BridgeError('CONTEXT_CONFLICT', 'Close the existing admission before starting another probe.', 409);
          if (probe) throw new BridgeError('CONTEXT_CONFLICT', 'A probe is already active; cancel it before retrying.', 409);
          await verifyBinding();
          const probeKey = key();
          const record = {
            id: randomUUID(), token: probeKey, expires: now() + 120_000, attempts: 0,
            session: createMessageSession({
              backend: options.backend, model: info.model, maxTurns: Math.min(info.maxTurns, 3),
              onError: options.onError,
              resolveModel: id => resolveModel([info.model], id),
              admit() { record.attempts++; },
              validate(payload) {
                const messages = Array.isArray(payload.messages) ? clientHistory(payload.messages) : undefined;
                if (payload.max_tokens !== 128 || (Array.isArray(payload.tools) && payload.tools.length)
                  || !Array.isArray(messages) || messages.length !== 1) throw new BridgeError('INVALID_REQUEST', 'Only the isolated probe is permitted.');
                const content = object(messages[0]).content;
                const context = object(messages[0]).clientContext;
                const isolatedContext = /^# Environment\nYou have been invoked in the following environment: \n - Primary working directory: \/[^\n]*\/ccgc-probe-[A-Za-z0-9]+\n - Is a git repository: false\n - Platform: darwin\n - Shell: [^\n]+\n - OS Version: [^\n]+(?=[\s\S]*<ccgc-model-(?:context|identity)>)(?=[\s\S]*Today's date is \d{4}-\d{2}-\d{2}\.$)(?:\n\n(?:<ccgc-model-(?:context|identity)>|<total_tokens>MODEL_BUDGET tokens left<\/total_tokens>|Today's date is \d{4}-\d{2}-\d{2}\.))*$/;
                if (context !== undefined && (typeof context !== 'string' || !isolatedContext.test(context))) {
                  throw new BridgeError('INVALID_REQUEST', 'Probe environment must be isolated and contain only client-generated context.');
                }
                const prompt = typeof content === 'string' ? content
                  : Array.isArray(content) && (content.length === 1 || (content.length === 2
                    && typeof object(content[0]).text === 'string' && probeDateContext.test(String(object(content[0]).text))))
                    ? object(content.at(-1)).text : undefined;
                if (prompt !== PROBE_PROMPT) throw new BridgeError('INVALID_REQUEST', 'Probe content does not match the fixed synthetic prompt.');
              },
            }, probeKey, origin),
          };
          probe = record;
          send(response, 200, { id: record.id, token: probeKey, expires: record.expires, info });
          return;
        }
        if (path === '/ccgc/admit') {
          if (!probe || input.probeId !== probe.id || probe.session.stats.completed < 1 || probe.session.stats.failed) {
            throw new BridgeError('ADMISSION_REQUIRED', 'A completed, unexpired isolated probe is required.', 409);
          }
          if (probe.attempts >= info.maxTurns) throw new BridgeError('LIMIT_REACHED', 'Probe consumed the available turn budget.', 429);
          await verifyBinding();
          expire();
          if (!probe || input.probeId !== probe.id) throw new BridgeError('ADMISSION_REQUIRED', 'Probe expired during verification.', 410);
          const internalKey = key();
          const attempts = probe.attempts;
          const record = {
            id: randomUUID(), token: key(), tokenExpires: now() + HOUR, expires: now() + 8 * HOUR, lastAt: now(),
            internalKey, attempts,
            session: createMessageSession({
              backend: options.backend, model: info.model, maxTurns: info.maxTurns,
              onError: options.onError,
              resolveModel: id => resolveModel(info.models, id), history: clientHistory, isModelCheck,
              admit() {
                if (now() >= record.expires || record.attempts >= info.maxTurns) throw new BridgeError('LIMIT_REACHED', 'Admission expired or turn limit reached.', 429);
                record.attempts++;
              },
            }, internalKey, origin),
          };
          probe.session.close(); probe = undefined; grant = record;
          send(response, 200, { id: record.id, expires: record.expires, profile: REMOTE_PROFILE });
          return;
        }
        if (path === '/ccgc/cancel') {
          if (input.id !== probe?.id && input.id !== grant?.id) throw new BridgeError('ADMISSION_REQUIRED', 'Admission no longer exists.', 410);
          clear();
          send(response, 200, { status: 'closed' });
          return;
        }
        if (path === '/ccgc/token') {
          if (!grant || input.id !== grant.id) throw new BridgeError('ADMISSION_REQUIRED', 'Admission expired or was lost; run an explicit live probe.', 410);
          await verifyBinding();
          expire();
          if (!grant || input.id !== grant.id) throw new BridgeError('ADMISSION_REQUIRED', 'Admission expired during verification.', 410);
          if (now() >= grant.tokenExpires - 5 * 60_000) { grant.token = key(); grant.tokenExpires = Math.min(now() + HOUR, grant.expires); }
          send(response, 200, { token: grant.token, expires: grant.tokenExpires, attempts: grant.attempts, maxTurns: info.maxTurns });
          return;
        }
        throw new BridgeError('ROUTE_UNSUPPORTED', 'Unknown control operation.', 404);
      } finally { controlBusy = false; }
    }
    if (path === '/v1/models' && request.method === 'GET') {
      if (!grant || now() >= grant.tokenExpires || !equal(token, grant.token)) throw new BridgeError('ADMISSION_REQUIRED', 'A valid session credential is required.', 401);
      const data = info.models.map(model => ({
        id: clientModelId(model), type: 'model', display_name: model.name,
        description: `GitHub Copilot: ${model.id}. No model fallback.`,
      }));
      send(response, 200, { data, has_more: false, first_id: data[0]!.id, last_id: data.at(-1)!.id });
      return;
    }
    if (!['/v1/messages', '/v1/messages/count_tokens'].includes(path)) throw new BridgeError('ROUTE_UNSUPPORTED', 'Route not exposed.', 404);
    request.url = path + url.search;
    if (probe && equal(token, probe.token)) { probe.session.handle(request, response); return; }
    if (!grant || now() >= grant.tokenExpires || !equal(token, grant.token)) throw new BridgeError('ADMISSION_REQUIRED', 'An admitted session credential is required.', 401);
    const sessionId = request.headers['x-claude-code-session-id'];
    if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId.length > 128)) throw new BridgeError('INVALID_REQUEST', 'Invalid session identifier.');
    if (grant.sessionId && sessionId !== grant.sessionId) throw new BridgeError('CONTEXT_CONFLICT', 'One foreground client session per admission is supported.', 409);
    if (typeof sessionId === 'string') grant.sessionId = sessionId;
    const current = grant;
    current.lastAt = now();
    const keep = setInterval(() => { current.lastAt = now(); }, 1000);
    keep.unref();
    response.once('close', () => { clearInterval(keep); current.lastAt = now(); });
    request.headers.authorization = `Bearer ${current.internalKey}`;
    delete request.headers['x-api-key'];
    current.session.handle(request, response);
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
  } catch (error) { clearInterval(timer); throw error; }
  const address = server.address();
  if (!address || typeof address === 'string') throw new BridgeError('STARTUP_FAILED', 'No gateway server address.');
  return { port: address.port, info, async close() {
    clearInterval(timer); clear(); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
