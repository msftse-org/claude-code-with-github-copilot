import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Backend } from './copilot.ts';
import { statusError } from './copilot.ts';
import { BridgeError, MessageTracker, canonical, envelope, object, parseJson, safeError, toolResults, validateRequest, validateTokenCountRequest } from './protocol.ts';
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
  restoredBranches?: Record<string, MessageSessionCheckpoint>;
  checkpoint?: (branchId: string, value: MessageSessionCheckpoint | undefined) => Promise<void>;
}

export interface MessageSessionCheckpoint {
  version: 1;
  prefix: string[];
  prefixFields: Record<string, string>[];
  prefixShapes: unknown[];
  semantics?: string;
  compactionSummary?: string;
  pendingAssistant?: ObjectValue;
  selectedModel?: string;
  pending: string[];
  pendingSince: number;
  seen: string[];
  stats: { attempts: number; completed: number; failed: number; usage: Usage };
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

function historyFields(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(object(value)).map(([key, field]) => [key, digest(field)]));
}

function historyShape(value: unknown): unknown {
  const message = object(value);
  const classify = (text: string) => ({
    length: text.length,
    reminder: text.startsWith('<system-reminder>\n'),
    category: text.includes('# Environment') ? 'environment'
      : text.includes('You are powered by the model named') ? 'model-identity'
        : text.includes('<total_tokens>') ? 'token-budget'
          : text.includes("Today's date is") ? 'date'
            : 'other',
  });
  return {
    role: message.role,
    keys: Object.keys(message).sort(),
    content: Array.isArray(message.content)
      ? message.content.map(block => {
        const item = object(block);
        return { type: item.type, keys: Object.keys(item).sort(), ...(typeof item.text === 'string' ? classify(item.text) : {}) };
      })
      : typeof message.content === 'string' ? classify(message.content) : typeof message.content,
    clientContext: typeof message.clientContext === 'string' ? classify(message.clientContext) : typeof message.clientContext,
  };
}

function semanticDigest(body: ObjectValue): string {
  const system = Array.isArray(body.system) ? body.system.map(value => {
    const block = { ...object(value) };
    if (typeof block.text === 'string') {
      block.text = block.text.replace(
        /^(x-anthropic-billing-header: cc_version=\d+\.\d+\.\d+)\.[a-z0-9]+(; cc_entrypoint=[a-z-]+;)(?: cc_workload=cron;)?$/,
        '$1.<launch>$2',
      );
    }
    return block;
  }) : body.system;
  return digest({ system, tools: body.tools, tool_choice: body.tool_choice });
}

const COMPACTION_PROMPT = 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.';

function compactionBase(messages: unknown[]): ObjectValue[] | undefined {
  if (!messages.length) return undefined;
  const base = structuredClone(messages) as ObjectValue[];
  const last = object(base.at(-1));
  if (!Array.isArray(last.content) || last.content.length < 2) return undefined;
  const final = object(last.content.at(-1));
  if (final.type !== 'text' || typeof final.text !== 'string' || !final.text.startsWith(COMPACTION_PROMPT)
    || !final.text.includes('Your task is to create a detailed summary of the conversation so far')) return undefined;
  last.content.pop();
  return base;
}

function isTitleRequest(messages: unknown[]): boolean {
  if (messages.length !== 1) return false;
  const message = object(messages[0]);
  if (message.role !== 'user' || !Array.isArray(message.content) || message.content.length !== 1) return false;
  const block = object(message.content[0]);
  if (block.type !== 'text' || typeof block.text !== 'string') return false;
  return /^<session>\n[\s\S]+\n<\/session>\n\nWrite the title in the predominant language of the session — a stray word or code token in another language doesn't change it, and neither does the English of these instructions\.$/.test(block.text);
}

function approvedCompactionReplacement(messages: ObjectValue[], summary: string | undefined,
  assistant: ObjectValue | undefined, pending: Set<string>): boolean {
  if (!summary || !assistant || messages.length !== 3) return false;
  const [summaryMessage, assistantMessage, resultMessage] = messages;
  if (object(summaryMessage).role !== 'user' || !JSON.stringify(summaryMessage).includes(summary)) return false;
  if (historyDigest(assistantMessage) !== historyDigest(assistant)) return false;
  if (object(resultMessage).role !== 'user' || !Array.isArray(object(resultMessage).content)) return false;
  const content = object(resultMessage).content as unknown[];
  if (content.some(value => {
    const block = object(value);
    return block.type !== 'tool_result'
      && !(block.type === 'text' && typeof block.text === 'string' && block.text.trim().startsWith('<system-reminder>'));
  })) return false;
  const results = toolResults({ messages: [resultMessage] });
  return new Set(results).size === results.length && results.length === pending.size && results.every(id => pending.has(id));
}

function normalizeClaudeCodeRequest(body: ObjectValue): void {
  if (body.thinking === null || typeof body.thinking !== 'object' || Array.isArray(body.thinking)) return;
  const thinking = body.thinking as ObjectValue;
  if (thinking.type === 'enabled' && thinking.display === 'omitted'
    && Object.keys(thinking).every(key => ['type', 'budget_tokens', 'display'].includes(key))
    && typeof thinking.budget_tokens === 'number' && Number.isSafeInteger(thinking.budget_tokens) && thinking.budget_tokens > 0) {
    body.thinking = { type: 'adaptive' };
  } else if (thinking.type === 'adaptive' && thinking.display === 'omitted'
    && Object.keys(thinking).every(key => ['type', 'display'].includes(key))) {
    body.thinking = { type: 'adaptive' };
  }
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

function validCredential(request: IncomingMessage, token: string): boolean {
  const authorization = request.headers.authorization;
  const apiKey = request.headers['x-api-key'];
  const supplied = authorization?.startsWith('Bearer ') ? authorization.slice(7) : apiKey;
  return typeof supplied === 'string'
    && Buffer.byteLength(supplied) === Buffer.byteLength(token)
    && timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
    && (apiKey === undefined || apiKey === token)
    && (authorization === undefined || authorization === 'Bearer ' + token);
}

async function write(response: ServerResponse, data: string): Promise<void> {
  if (response.destroyed) throw new BridgeError('CANCELLED_OR_TIMEOUT', 'Client disconnected.', 499);
  await new Promise<void>((resolve, reject) => {
    response.write(data, error => error ? reject(error) : resolve());
  });
}

async function streamResponse(upstream: Response, downstream: ServerResponse, tracker: MessageTracker,
  progress: () => void, commit: () => Promise<void>): Promise<void> {
  if (!upstream.body) throw new BridgeError('PROTOCOL_ERROR', 'Upstream stream has no body.', 502);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let terminal = false;
  let terminalFrame: string | undefined;
  for await (const bytes of upstream.body) {
    buffer = (buffer + decoder.decode(bytes, { stream: true })).replaceAll('\r\n', '\n');
    if (buffer.length > MAX_BODY) throw new BridgeError('LIMIT_REACHED', 'Upstream event exceeds 8 MiB.', 502);
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let deferFrame = false;
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
        if (value.type === 'message_stop') {
          terminalFrame = frame;
          deferFrame = true;
        }
      }
      if (frame && !deferFrame) await write(downstream, `${frame}\n\n`);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) throw new BridgeError('PROTOCOL_ERROR', 'Truncated upstream SSE frame.', 502);
  if (!tracker.stopped) throw new BridgeError('PROTOCOL_ERROR', 'Upstream ended before message_stop.', 502);
  tracker.finish();
  await commit();
  if (!terminalFrame) throw new BridgeError('PROTOCOL_ERROR', 'Upstream omitted the terminal message_stop frame.', 502);
  await write(downstream, `${terminalFrame}\n\n`);
}

function createSingleMessageSession(options: GatewayOptions, token: string, origin: string,
  restored?: MessageSessionCheckpoint, save?: (value: MessageSessionCheckpoint | undefined) => Promise<void>) {
  const maxTurns = options.maxTurns ?? 50;
  if (!Number.isSafeInteger(maxTurns) || maxTurns <= 0) throw new BridgeError('INVALID_OPTIONS', 'max-upstream-turns must be a positive integer.');
  const stats: { attempts: number; completed: number; failed: number; usage: Usage } =
    structuredClone(restored?.stats ?? { attempts: 0, completed: 0, failed: 0, usage: {} });
  const seen = new Set(restored?.seen ?? []);
  let prefix: string[] = structuredClone(restored?.prefix ?? []);
  let prefixFields: Record<string, string>[] = structuredClone(restored?.prefixFields ?? []);
  let prefixShapes: unknown[] = structuredClone(restored?.prefixShapes ?? []);
  let semantics: string | undefined = restored?.semantics;
  let compactionSummary: string | undefined = restored?.compactionSummary;
  let pendingAssistant: ObjectValue | undefined = structuredClone(restored?.pendingAssistant);
  let selectedModel: string | undefined = restored?.selectedModel;
  let pending: Set<string> = new Set(restored?.pending ?? []);
  let pendingSince = restored?.pendingSince ?? 0;
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
    if (!validCredential(request, token)) {
      throw new BridgeError('LOCAL_AUTH_REQUIRED', 'A valid per-launch gateway credential is required.', 401);
    }
    if (!['/v1/messages', '/v1/messages/count_tokens'].includes(path)) throw new BridgeError('ROUTE_UNSUPPORTED', 'This gateway only serves Messages and token counting.', 404);
    if (request.method !== 'POST') throw new BridgeError('METHOD_UNSUPPORTED', 'Messages requires POST.', 405);
    if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new BridgeError('INVALID_REQUEST', 'Expected application/json.', 415);
    if (Number(request.headers['content-length']) > MAX_BODY) throw new BridgeError('REQUEST_TOO_LARGE', 'Request exceeds 8 MiB.', 413);
    const body = await requestBody(request);
    const model = options.resolveModel?.(body.model) ?? options.model;
    body.model = options.resolveModel ? model.id : body.model;
    normalizeClaudeCodeRequest(body);
    if (path === '/v1/messages/count_tokens') {
      if (!options.backend.countTokens) throw new BridgeError('FEATURE_UNSUPPORTED', 'The configured connector does not provide exact token counting.', 404);
      validateTokenCountRequest(body, model);
      const headers = new Headers();
      for (const name of ['anthropic-version', 'anthropic-beta']) {
        const value = request.headers[name];
        if (typeof value === 'string') headers.set(name, value);
      }
      const upstream = await options.backend.countTokens(body, headers, AbortSignal.timeout(options.inactivityMs ?? 5 * 60_000));
      if (!upstream.ok) {
        await upstream.body?.cancel();
        throw statusError(upstream.status);
      }
      const value = object(await upstream.json());
      if (typeof value.input_tokens !== 'number' || !Number.isSafeInteger(value.input_tokens) || value.input_tokens < 0) {
        throw new BridgeError('PROTOCOL_ERROR', 'Invalid upstream token count.', 502);
      }
      json(response, 200, { input_tokens: value.input_tokens });
      return;
    }
    validateRequest(body, model);
    options.validate?.(body);
    const modelCheck = options.isModelCheck?.(body) === true;
    if (retired) throw new BridgeError('CONTEXT_CONFLICT', 'This session has uncertain or cancelled upstream state; start a new session.', 409);
    if (active) throw new BridgeError('CONTEXT_CONFLICT', 'Concurrent main-branch generation is not allowed.', 409);
    const switching = selectedModel !== undefined && selectedModel !== model.id;
    if (pending.size && (switching || modelCheck)) throw new BridgeError('CONTEXT_CONFLICT', 'Finish the current model tool batch before selecting another model.', 409);
    if (pending.size && Date.now() - pendingSince > (options.toolWaitMs ?? 15 * 60_000)) {
      retired = true;
      throw new BridgeError('CANCELLED_OR_TIMEOUT', 'Tool-result wait expired; start a new session.', 409);
    }
    if (!Array.isArray(body.messages)) throw new BridgeError('INVALID_REQUEST', 'Invalid messages.');
    const title = isTitleRequest(body.messages);
    if (title && (prefix.length || pending.size)) throw new BridgeError('CONTEXT_CONFLICT', 'Title generation is allowed only before the conversation starts.', 409);
    const base = compactionBase(body.messages);
    const normalizedBase = base === undefined ? undefined : (options.history?.(base) ?? base);
    const compaction = normalizedBase !== undefined
      && normalizedBase.length === prefix.length
      && normalizedBase.map(historyDigest).every((hash, index) => hash === prefix[index]);
    if (base !== undefined && !compaction) {
      const hashes = normalizedBase!.map(historyDigest);
      throw new BridgeError('CONTEXT_CONFLICT',
        `Compaction base diverged at message ${prefix.findIndex((hash, index) => hashes[index] !== hash) + 1}.`, 409);
    }
    const results = toolResults(body);
    if (!title && !compaction && (new Set(results).size !== results.length || results.length !== pending.size || results.some(id => !pending.has(id)))) {
      throw new BridgeError('CONTEXT_CONFLICT', `Tool-result batch mismatch: expected ${pending.size}, received ${results.length}, matched ${results.filter(id => pending.has(id)).length}.`, 409);
    }
    const normalizedHistory = options.history?.(body.messages) ?? body.messages;
    const history = normalizedHistory.map(historyDigest);
    const fields = normalizedHistory.map(historyFields);
    const shapes = normalizedHistory.map(historyShape);
    const mismatch = prefix.findIndex((hash, index) => history[index] !== hash);
    const approvedReplacement = !compaction
      && approvedCompactionReplacement(body.messages, compactionSummary, pendingAssistant, pending);
    if (!modelCheck && !title && !compaction && !approvedReplacement && mismatch >= 0) {
      const previous = prefixFields[mismatch] ?? {};
      const current = fields[mismatch] ?? {};
      const changed = [...new Set([...Object.keys(previous), ...Object.keys(current)])]
        .filter(key => previous[key] !== current[key]).sort();
      throw new BridgeError('CONTEXT_CONFLICT',
        `Conversation history diverged or was compacted at message ${mismatch + 1}; changed fields: ${changed.join(', ') || 'unknown'} ` +
        `(${prefix.length} previous, ${history.length} current); shapes: ` +
        `${JSON.stringify(prefixShapes[mismatch])} -> ${JSON.stringify(shapes[mismatch])}.`, 409);
    }
    if (!modelCheck && !title && !compaction && !approvedReplacement && switching && history.length <= prefix.length) throw new BridgeError('CONTEXT_CONFLICT', 'A model switch requires a new user turn, not a retry of the previous turn.', 409);
    const currentSemantics = semanticDigest(body);
    if (!modelCheck && !title && !compaction && semantics !== undefined && semantics !== currentSemantics) throw new BridgeError('CONTEXT_CONFLICT', 'System prompt or tool semantics changed.', 409);
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
      const commit = async () => {
        if (title) {
          if (tracker.pending.size || !tracker.text) throw new BridgeError('PROTOCOL_ERROR', 'Title generation must return non-empty text without tools.', 502);
        } else if (compaction) {
          if (tracker.pending.size || !tracker.text) throw new BridgeError('PROTOCOL_ERROR', 'Compaction must return a non-empty text summary.', 502);
          compactionSummary = tracker.text;
        } else if (!modelCheck) {
          prefix = history;
          prefixFields = fields;
          prefixShapes = shapes;
          semantics = currentSemantics;
          selectedModel = model.id;
          pending = tracker.pending;
          pendingAssistant = pending.size ? { role: 'assistant', content: structuredClone(tracker.content) } : undefined;
          pendingSince = Date.now();
          if (approvedReplacement) compactionSummary = undefined;
        }
        for (const [key, count] of Object.entries(tracker.usage)) stats.usage[key] = (stats.usage[key] ?? 0) + count;
        stats.completed++;
        if (!title && !modelCheck) {
          await save?.(pending.size ? {
            version: 1, prefix: structuredClone(prefix), prefixFields: structuredClone(prefixFields),
            prefixShapes: structuredClone(prefixShapes), semantics, compactionSummary,
            pendingAssistant: structuredClone(pendingAssistant), selectedModel, pending: [...pending],
            pendingSince, seen: [...seen], stats: structuredClone(stats),
          } : undefined);
        }
      };
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
        await streamResponse(upstream, response, tracker, progress, commit);
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
        await commit();
        json(response, 200, value);
      }
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

export function createMessageSession(options: GatewayOptions, token: string, origin: string) {
  const branches = new Map<string, ReturnType<typeof createSingleMessageSession>>();
  const maxTurns = options.maxTurns ?? 50;
  let totalAttempts = Object.values(options.restoredBranches ?? {})
    .reduce((sum, checkpoint) => sum + checkpoint.stats.attempts, 0);
  const create = (id: string) => createSingleMessageSession({
    ...options,
    admit() {
      if (totalAttempts >= maxTurns) throw new BridgeError('LIMIT_REACHED', 'Admission upstream-turn limit reached.', 429);
      options.admit?.();
      totalAttempts++;
    },
  }, token, origin, options.restoredBranches?.[id], value => options.checkpoint?.(id, value) ?? Promise.resolve());
  const main = create('main');
  branches.set('main', main);
  const handle = (request: IncomingMessage, response: ServerResponse) => {
    const header = request.headers['x-claude-code-agent-id'];
    const id = typeof header === 'string' ? header : 'main';
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id)) {
      json(response, 400, envelope(new BridgeError('INVALID_REQUEST', 'Invalid Claude agent identifier.')));
      return;
    }
    let branch = branches.get(id);
    if (!branch) {
      if (!validCredential(request, token)) {
        json(response, 401, envelope(new BridgeError('LOCAL_AUTH_REQUIRED', 'A valid per-launch gateway credential is required.', 401)));
        return;
      }
      if (branches.size >= 9) {
        json(response, 429, envelope(new BridgeError('LIMIT_REACHED', 'At most eight agent branches are allowed.', 429)));
        return;
      }
      branch = create(id);
      branches.set(id, branch);
    }
    branch.handle(request, response);
  };
  const stats = {
    get attempts() { return [...branches.values()].reduce((sum, branch) => sum + branch.stats.attempts, 0); },
    get completed() { return [...branches.values()].reduce((sum, branch) => sum + branch.stats.completed, 0); },
    get failed() { return [...branches.values()].reduce((sum, branch) => sum + branch.stats.failed, 0); },
    get usage(): Usage {
      const usage: Usage = {};
      for (const branch of branches.values()) {
        for (const [key, value] of Object.entries(branch.stats.usage)) usage[key] = (usage[key] ?? 0) + value;
      }
      return usage;
    },
  };
  return {
    handle,
    stats,
    close() {
      for (const branch of branches.values()) branch.close();
      branches.clear();
    },
  };
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
