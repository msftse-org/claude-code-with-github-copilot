import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Backend } from './copilot.ts';
import { statusError } from './copilot.ts';
import { BridgeError, MessageTracker, canonical, envelope, object, parseJson, safeError, toolResults, validateRequest } from './protocol.ts';
import type { Model, ObjectValue, Usage } from './protocol.ts';

const MAX_BODY = 8 * 1024 * 1024;

export interface GatewayOptions {
  backend: Backend;
  model: Model;
  maxTurns?: number;
  inactivityMs?: number;
  toolWaitMs?: number;
  onError?: (error: BridgeError) => void;
  admit?: () => void;
  validate?: (body: ObjectValue) => void;
  resolveModel?: (id: unknown) => Model;
  history?: (messages: unknown[]) => ObjectValue[];
  isModelCheck?: (body: ObjectValue) => boolean;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function historyDigest(value: unknown): string {
  const message = object(value);
  if (!Array.isArray(message.content)) return digest(message);
  const content = message.content.map((value: unknown) => {
    const block = { ...object(value) };
    delete block.cache_control;
    return block;
  });
  return digest({ ...message, content });
}

async function requestBody(request: IncomingMessage): Promise<ObjectValue> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY) throw new BridgeError('REQUEST_TOO_LARGE', 'Request exceeds 8 MiB.', 413);
    chunks.push(buffer);
  }
  return parseJson(Buffer.concat(chunks).toString('utf8'));
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-should-retry': 'false' });
  response.end(JSON.stringify(value));
}

async function write(response: ServerResponse, data: string): Promise<void> {
  if (response.destroyed) throw new BridgeError('CANCELLED_OR_TIMEOUT', 'Client disconnected.', 499);
  await new Promise<void>((resolve, reject) => {
    response.write(data, error => error ? reject(error) : resolve());
  });
}

async function streamResponse(upstream: Response, downstream: ServerResponse, tracker: MessageTracker, progress: () => void): Promise<void> {
  if (!upstream.body) throw new BridgeError('PROTOCOL_ERROR', 'Upstream stream has no body.', 502);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let terminal = false;
  for await (const bytes of upstream.body) {
    buffer = (buffer + decoder.decode(bytes, { stream: true })).replaceAll('\r\n', '\n');
    if (buffer.length > MAX_BODY) throw new BridgeError('LIMIT_REACHED', 'Upstream event exceeds 8 MiB.', 502);
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (data) {
        const event = frame.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim();
        if (terminal) throw new BridgeError('PROTOCOL_ERROR', 'Data after upstream stream termination.', 502);
        if (data === '[DONE]' && !event) {
          if (!tracker.stopped) throw new BridgeError('PROTOCOL_ERROR', 'Upstream terminated before message_stop.', 502);
          // Some native-compatible providers append this transport-only sentinel.
          terminal = true;
          continue;
        }
        const value = parseJson(data);
        if (event && event !== value.type) throw new BridgeError('PROTOCOL_ERROR', 'SSE event and payload type disagree.', 502);
        if (tracker.event(value)) progress();
      }
      if (frame) await write(downstream, `${frame}\n\n`);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) throw new BridgeError('PROTOCOL_ERROR', 'Truncated upstream SSE frame.', 502);
  if (!tracker.stopped) throw new BridgeError('PROTOCOL_ERROR', 'Upstream ended before message_stop.', 502);
  tracker.finish();
}

export function createMessageSession(options: GatewayOptions, token: string, origin: string) {
  const maxTurns = options.maxTurns ?? 50;
  if (!Number.isSafeInteger(maxTurns) || maxTurns <= 0) throw new BridgeError('INVALID_OPTIONS', 'max-upstream-turns must be a positive integer.');
  const stats: { attempts: number; completed: number; failed: number; usage: Usage } = { attempts: 0, completed: 0, failed: 0, usage: {} };
  const seen = new Set<string>();
  let prefix: string[] = [];
  let semantics: string | undefined;
  let selectedModel: string | undefined;
  let pending: Set<string> = new Set();
  let pendingSince = 0;
  let retired = false;
  let active: AbortController | undefined;
  const handle = (request: IncomingMessage, response: ServerResponse) => {
    void processRequest(request, response).catch(error => {
      const failure = safeError(error);
      options.onError?.(failure);
      if (!response.headersSent) json(response, failure.status, envelope(failure));
      else if (!response.destroyed && !response.writableEnded) response.end(`event: error\ndata: ${JSON.stringify(envelope(failure))}\n\n`);
    });
  };

  async function processRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.origin || request.headers.host !== new URL(origin).host) {
      throw new BridgeError('ORIGIN_REJECTED', 'Request origin or host is not allowed.', 403);
    }
    if (!request.url?.startsWith('/')) throw new BridgeError('INVALID_REQUEST', 'Invalid request path.');
    const path = new URL(request.url, origin).pathname;
    if (path === '/healthz' && request.method === 'GET') { json(response, 200, { status: 'listening', inference: 'not-verified' }); return; }
    if (path === '/api/hello' && request.method === 'HEAD') { response.writeHead(204); response.end(); return; }
    const authorization = request.headers.authorization;
    const apiKey = request.headers['x-api-key'];
    const supplied = authorization?.startsWith('Bearer ') ? authorization.slice(7) : apiKey;
    if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(token)
      || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
      || (apiKey !== undefined && apiKey !== token)
      || (authorization !== undefined && authorization !== `Bearer ${token}`)) {
      throw new BridgeError('LOCAL_AUTH_REQUIRED', 'A valid per-launch gateway credential is required.', 401);
    }
    if (path === '/v1/messages/count_tokens') throw new BridgeError('FEATURE_UNSUPPORTED', 'Token counting is unavailable; use the client estimate.', 404);
    if (path !== '/v1/messages') throw new BridgeError('ROUTE_UNSUPPORTED', 'This gateway only serves Messages inference.', 404);
    if (request.method !== 'POST') throw new BridgeError('METHOD_UNSUPPORTED', 'Messages requires POST.', 405);
    if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new BridgeError('INVALID_REQUEST', 'Expected application/json.', 415);
    if (Number(request.headers['content-length']) > MAX_BODY) throw new BridgeError('REQUEST_TOO_LARGE', 'Request exceeds 8 MiB.', 413);
    const body = await requestBody(request);
    const model = options.resolveModel?.(body.model) ?? options.model;
    body.model = options.resolveModel ? model.id : body.model;
    validateRequest(body, model);
    options.validate?.(body);
    const modelCheck = options.isModelCheck?.(body) === true;
    if (request.headers['x-claude-code-agent-id']) throw new BridgeError('FEATURE_UNSUPPORTED', 'Subagents are not enabled in this profile.');
    if (retired) throw new BridgeError('CONTEXT_CONFLICT', 'This session has uncertain or cancelled upstream state; start a new session.', 409);
    if (active) throw new BridgeError('CONTEXT_CONFLICT', 'Concurrent main-branch generation is not allowed.', 409);
    const switching = selectedModel !== undefined && selectedModel !== model.id;
    if (pending.size && (switching || modelCheck)) throw new BridgeError('CONTEXT_CONFLICT', 'Finish the current model tool batch before selecting another model.', 409);
    if (pending.size && Date.now() - pendingSince > (options.toolWaitMs ?? 15 * 60_000)) {
      retired = true;
      throw new BridgeError('CANCELLED_OR_TIMEOUT', 'Tool-result wait expired; start a new session.', 409);
    }
    const results = toolResults(body);
    if (new Set(results).size !== results.length || results.length !== pending.size || results.some(id => !pending.has(id))) {
      throw new BridgeError('CONTEXT_CONFLICT', `Tool-result batch mismatch: expected ${pending.size}, received ${results.length}, matched ${results.filter(id => pending.has(id)).length}.`, 409);
    }
    if (!Array.isArray(body.messages)) throw new BridgeError('INVALID_REQUEST', 'Invalid messages.');
    const history = (options.history?.(body.messages) ?? body.messages).map(historyDigest);
    if (!modelCheck && prefix.some((hash, index) => history[index] !== hash)) throw new BridgeError('CONTEXT_CONFLICT', 'Conversation history diverged or was compacted.', 409);
    if (!modelCheck && switching && history.length <= prefix.length) throw new BridgeError('CONTEXT_CONFLICT', 'A model switch requires a new user turn, not a retry of the previous turn.', 409);
    const currentSemantics = digest({ system: body.system, tools: body.tools, tool_choice: body.tool_choice });
    if (!modelCheck && semantics !== undefined && semantics !== currentSemantics) throw new BridgeError('CONTEXT_CONFLICT', 'System prompt or tool semantics changed.', 409);
    const fingerprint = digest({ ...body, metadata: undefined });
    if (!modelCheck && seen.has(fingerprint)) throw new BridgeError('CONTEXT_CONFLICT', 'A repeated request will not be submitted again.', 409);
    if (stats.attempts >= maxTurns) throw new BridgeError('LIMIT_REACHED', 'Session upstream-turn limit reached.', 429);
    options.admit?.();
    if (!modelCheck) seen.add(fingerprint);
    stats.attempts++;
    const controller = new AbortController();
    active = controller;
    let deadline: NodeJS.Timeout;
    const progress = () => {
      clearTimeout(deadline);
      deadline = setTimeout(() => controller.abort(), options.inactivityMs ?? 5 * 60_000);
      deadline.unref();
    };
    progress();
    const disconnect = () => { if (!response.writableEnded) controller.abort(); };
    response.on('close', disconnect);
    let heartbeat: NodeJS.Timeout | undefined;
    try {
      const headers = new Headers();
      for (const name of ['anthropic-version', 'anthropic-beta']) {
        const value = request.headers[name];
        if (typeof value === 'string') headers.set(name, value);
      }
      const upstream = await options.backend.send(body, headers, controller.signal);
      if (!upstream.ok) {
        const retry = upstream.headers.get('retry-after');
        if (retry) response.setHeader('retry-after', retry);
        await upstream.body?.cancel();
        throw statusError(upstream.status);
      }
      const tracker = new MessageTracker(model, body);
      if (body.stream === true) {
        if (!upstream.headers.get('content-type')?.includes('text/event-stream')) {
          await upstream.body?.cancel();
          throw new BridgeError('PROTOCOL_ERROR', 'Expected upstream SSE response.', 502);
        }
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no', 'x-should-retry': 'false' });
        response.flushHeaders();
        heartbeat = setInterval(() => {
          if (!response.destroyed && !response.writableEnded && response.writableLength === 0) response.write('event: ping\ndata: {"type":"ping"}\n\n');
        }, 15_000);
        heartbeat.unref();
        await streamResponse(upstream, response, tracker, progress);
        response.end();
      } else {
        if (!upstream.body) throw new BridgeError('PROTOCOL_ERROR', 'Empty upstream response.', 502);
        let size = 0;
        const chunks: Uint8Array[] = [];
        for await (const chunk of upstream.body) {
          size += chunk.byteLength;
          if (size > MAX_BODY) throw new BridgeError('LIMIT_REACHED', 'Upstream response exceeds 8 MiB.', 502);
          chunks.push(chunk);
          progress();
        }
        const value = parseJson(Buffer.concat(chunks).toString('utf8'));
        tracker.complete(value);
        json(response, 200, value);
      }
      if (!modelCheck) {
        prefix = history;
        semantics = currentSemantics;
        selectedModel = model.id;
        pending = tracker.pending;
        pendingSince = Date.now();
      }
      for (const [key, count] of Object.entries(tracker.usage)) stats.usage[key] = (stats.usage[key] ?? 0) + count;
      stats.completed++;
    } catch (error) {
      stats.failed++;
      retired = true;
      controller.abort();
      throw error;
    } finally {
      clearTimeout(deadline!);
      clearInterval(heartbeat);
      response.off('close', disconnect);
      active = undefined;
    }
  }

  return { handle, stats, close() { retired = true; active?.abort(); } };
}

export async function startGateway(options: GatewayOptions) {
  const token = randomBytes(32).toString('hex');
  let session: ReturnType<typeof createMessageSession>;
  const server = createServer((request, response) => session.handle(request, response));
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 64;
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new BridgeError('STARTUP_FAILED', 'No loopback listener address.');
  const origin = `http://127.0.0.1:${address.port}`;
  session = createMessageSession(options, token, origin);
  return {
    url: origin, token, stats: session.stats,
    async close() {
      session.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
