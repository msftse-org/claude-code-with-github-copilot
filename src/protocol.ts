export type ObjectValue = Record<string, unknown>;

export class BridgeError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.status = status;
  }
}

export function object(value: unknown): ObjectValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BridgeError('INVALID_RESPONSE', 'Expected a JSON object.');
  }
  return value as ObjectValue;
}

export function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BridgeError('INVALID_RESPONSE', `Missing or invalid ${field}.`);
  }
  return value;
}

export function positive(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new BridgeError('INVALID_RESPONSE', `Missing or invalid ${field}.`);
  }
  return value;
}

export function parseJson(value: string): ObjectValue {
  try {
    return object(JSON.parse(value));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new BridgeError('INVALID_JSON', 'Invalid JSON.');
    }
    throw error;
  }
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function safeError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error;
  if (error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.startsWith('ERR_PARSE_ARGS_')) {
    return new BridgeError('INVALID_OPTIONS', 'Invalid command-line options. Run ccgc --help.');
  }
  if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) {
    return new BridgeError('CANCELLED_OR_TIMEOUT', 'Generation was cancelled or timed out.', 504);
  }
  return new BridgeError('INTERNAL_ERROR', 'Unexpected local failure; no automatic retry was attempted.', 500);
}

export function envelope(error: BridgeError): ObjectValue {
  const type = error.status === 401 ? 'authentication_error'
    : error.status === 403 ? 'permission_error'
      : error.status === 429 ? 'rate_limit_error'
        : error.status >= 500 ? 'api_error' : 'invalid_request_error';
  return { type: 'error', error: { type, message: `${error.code}: ${error.message}` } };
}

export interface Model {
  id: string;
  name: string;
  context: number;
  output: number;
  responseIds: string[];
}

export function claudeModels(payload: unknown): Model[] {
  const data = object(payload).data;
  if (!Array.isArray(data)) throw new BridgeError('INVALID_RESPONSE', 'Invalid model catalog.', 502);
  return data.flatMap((item: unknown) => {
    const entry = object(item);
    if (typeof entry.id !== 'string' || !entry.id.startsWith('claude-')
      || typeof entry.vendor !== 'string' || entry.vendor.toLowerCase() !== 'anthropic') return [];
    if (entry.policy !== undefined && object(entry.policy).state !== 'enabled') return [];
    const capabilities = object(entry.capabilities);
    if (object(capabilities.supports).tool_calls !== true) return [];
    const limits = object(capabilities.limits);
    const responseIds = [entry.id];
    if (typeof entry.version === 'string' && entry.version.startsWith('claude-')) responseIds.push(entry.version);
    return [{
      id: entry.id,
      name: typeof entry.name === 'string' ? entry.name : entry.id,
      context: positive(limits.max_context_window_tokens, 'model context limit'),
      output: positive(limits.max_output_tokens, 'model output limit'),
      responseIds,
    }];
  });
}

const fields = new Set([
  'model', 'messages', 'system', 'tools', 'tool_choice', 'max_tokens', 'stream',
  'metadata', 'temperature', 'top_p', 'top_k', 'stop_sequences', 'thinking', 'output_config', 'context_management',
]);

export function validateRequest(body: ObjectValue, model: Model): void {
  for (const key of Object.keys(body)) {
    if (!fields.has(key)) throw new BridgeError('FEATURE_UNSUPPORTED', `Unsupported request field: ${key}.`);
  }

  if (body.model !== model.id) throw new BridgeError('MODEL_UNAVAILABLE', 'Only the explicitly selected Copilot Claude model is allowed.');
  if (positive(body.max_tokens, 'max_tokens') > model.output) {
    throw new BridgeError('LIMIT_REACHED', 'Requested output exceeds the catalog model limit.');
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new BridgeError('INVALID_REQUEST', 'stream must be boolean.');
  if (body.thinking !== undefined) {
    const thinking = object(body.thinking);
    if (thinking.type === 'enabled') {
      const budget = positive(thinking.budget_tokens, 'thinking budget');
      if (Object.keys(thinking).some(key => !['type', 'budget_tokens'].includes(key)) || budget >= Number(body.max_tokens)) {
        throw new BridgeError('INVALID_REQUEST', 'Enabled thinking requires only a positive budget_tokens smaller than max_tokens.');
      }
    } else if (thinking.type === 'adaptive') {
      if (Object.keys(thinking).some(key => key !== 'type')) throw new BridgeError('INVALID_REQUEST', 'Adaptive thinking accepts no additional fields.');
    } else if (thinking.type !== 'disabled' || Object.keys(thinking).some(key => key !== 'type')) {
      throw new BridgeError('INVALID_REQUEST', 'thinking.type must be disabled, enabled, or adaptive.');
    }
  }
  if (body.output_config !== undefined) {
    validateOutputConfig(body.output_config);
  }
  if (body.context_management !== undefined) {
    const management = object(body.context_management);
    if (Object.keys(management).some(key => key !== 'edits') || !Array.isArray(management.edits)
      || management.edits.length === 0 || management.edits.length > 4
      || management.edits.some(value => {
        const edit = object(value);
        return Object.keys(edit).some(key => !['type', 'keep'].includes(key))
          || edit.type !== 'clear_thinking_20251015' || edit.keep !== 'all';
      })) {
      throw new BridgeError('FEATURE_UNSUPPORTED', 'Only Claude Code clear-thinking context management is enabled.');
    }
  }
  if (body.system !== undefined && typeof body.system !== 'string') {
    if (!Array.isArray(body.system) || body.system.some(value => object(value).type !== 'text' || typeof object(value).text !== 'string')) {
      throw new BridgeError('INVALID_REQUEST', 'System content must be text.');
    }
  }
  if (body.metadata !== undefined) object(body.metadata);
  for (const key of ['temperature', 'top_p', 'top_k']) {
    if (body[key] !== undefined && (typeof body[key] !== 'number' || !Number.isFinite(body[key]))) {
      throw new BridgeError('INVALID_REQUEST', `Invalid ${key}.`);
    }
  }
  if (body.stop_sequences !== undefined && (!Array.isArray(body.stop_sequences) || body.stop_sequences.some(value => typeof value !== 'string'))) {
    throw new BridgeError('INVALID_REQUEST', 'stop_sequences must contain strings.');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw new BridgeError('INVALID_REQUEST', 'messages must be a nonempty array.');
  let lastConversationRole: 'user' | 'assistant' | undefined;
  for (const value of body.messages) {
    const message = object(value);
    if (message.role === 'system') {
      if (lastConversationRole !== 'user') throw new BridgeError('INVALID_REQUEST', 'Mid-conversation system messages must follow a user turn.');
      if (Object.keys(message).some(key => !['role', 'content', 'output_config'].includes(key))) {
        throw new BridgeError('FEATURE_UNSUPPORTED', 'Only persistent text system messages are enabled.');
      }
      if (message.output_config !== undefined) validateOutputConfig(message.output_config);
    } else if (message.role === 'user' || message.role === 'assistant') lastConversationRole = message.role;
    else throw new BridgeError('INVALID_REQUEST', 'Unsupported message role.');
    if (typeof message.content === 'string') continue;
    if (!Array.isArray(message.content)) throw new BridgeError('INVALID_REQUEST', 'Invalid message content.');
    for (const value of message.content) {
      const block = object(value);
      if (message.role === 'system' && block.type !== 'text') {
        throw new BridgeError('FEATURE_UNSUPPORTED', 'Mid-conversation system messages must contain only text.');
      }
      if (!['text', 'tool_use', 'tool_result', 'image', 'document'].includes(String(block.type))) {
        throw new BridgeError('FEATURE_UNSUPPORTED', 'Unsupported message content block.');
      }
      if (block.type === 'text') {
        if (typeof block.text !== 'string') throw new BridgeError('INVALID_REQUEST', 'Invalid text block.');
      } else if (block.type === 'image' || block.type === 'document') {
        if (message.role !== 'user') throw new BridgeError('INVALID_REQUEST', 'Media input must belong to a user message.');
        validateMediaSource(block.type, block.source);
      } else if (block.type === 'tool_use') {
        text(block.id, 'tool ID');
        text(block.name, 'tool name');
        object(block.input);
        if (message.role !== 'assistant') throw new BridgeError('INVALID_REQUEST', 'Tool use must belong to an assistant message.');
      } else {
        text(block.tool_use_id, 'tool result ID');
        if (message.role !== 'user') throw new BridgeError('INVALID_REQUEST', 'Tool results must belong to a user message.');
        if (block.is_error !== undefined && typeof block.is_error !== 'boolean') throw new BridgeError('INVALID_REQUEST', 'Invalid tool error flag.');
        if (Array.isArray(block.content)) {
          for (const nested of block.content) {
            const item = object(nested);
            if (item.type === 'text' && typeof item.text === 'string') continue;
            if (item.type === 'image') { validateMediaSource('image', item.source); continue; }
            throw new BridgeError('FEATURE_UNSUPPORTED', 'Only text and image tool results are enabled.');
          }
        } else if (typeof block.content !== 'string') throw new BridgeError('INVALID_REQUEST', 'Invalid tool result content.');
      }

    }
    if (body.tool_choice !== undefined) {
      const choice = object(body.tool_choice);
      if (!['auto', 'any', 'tool', 'none'].includes(String(choice.type))) throw new BridgeError('INVALID_REQUEST', 'Invalid tool choice.');
      if (choice.type === 'tool' && (!Array.isArray(body.tools) || !body.tools.some(value => object(value).name === choice.name))) {
        throw new BridgeError('INVALID_REQUEST', 'Selected tool is not declared.');
      }
    }
  }
  if (lastConversationRole !== 'user') throw new BridgeError('FEATURE_UNSUPPORTED', 'A user turn is required; assistant prefilling is not enabled.');
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) throw new BridgeError('INVALID_REQUEST', 'Invalid tools array.');
    const names = new Set<string>();
    for (const value of body.tools) {
      const tool = object(value);
      const name = text(tool.name, 'tool name');
      if (names.has(name) || (tool.type !== undefined && tool.type !== 'custom')) {
        throw new BridgeError('FEATURE_UNSUPPORTED', 'Duplicate or provider-executed tools are not allowed.');
      }
      names.add(name);
      object(tool.input_schema);
    }
  }
}

function validateOutputConfig(value: unknown): void {
  const output = object(value);
  if (Object.keys(output).some(key => key !== 'effort')) {
    throw new BridgeError('FEATURE_UNSUPPORTED', 'Only output_config.effort is enabled in this profile.');
  }
  if (typeof output.effort !== 'string' || !['low', 'medium', 'high', 'xhigh', 'max'].includes(output.effort)) {
    throw new BridgeError('INVALID_REQUEST', 'output_config.effort must be low, medium, high, xhigh, or max.');
  }
}

export function validateTokenCountRequest(body: ObjectValue, model: Model): void {
  validateRequest({ ...body, max_tokens: model.output, stream: false }, model);
}

function validateMediaSource(kind: 'image' | 'document', value: unknown): void {
  const source = object(value);
  const media = text(source.media_type, `${kind} media type`);
  const allowed = kind === 'image'
    ? ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
    : ['application/pdf', 'text/plain'];
  if (source.type !== 'base64' || !allowed.includes(media) || typeof source.data !== 'string'
    || !source.data.length || source.data.length > 8 * 1024 * 1024
    || source.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(source.data)) {
    throw new BridgeError('INVALID_REQUEST', `Invalid ${kind} base64 source.`);
  }
}

export function toolResults(body: ObjectValue): string[] {
  const messages = body.messages;
  if (!Array.isArray(messages)) return [];
  const last = messages.findLast(value => object(value).role !== 'system');
  const content = last === undefined ? undefined : object(last).content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((value: unknown) => {
    const block = object(value);
    return block.type === 'tool_result' ? [text(block.tool_use_id, 'tool result ID')] : [];
  });
}

export type Usage = Record<string, number>;

export function readUsage(value: unknown): Usage {
  const source = object(value);
  const result: Usage = {};
  for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    const count = source[key];
    if (count !== undefined) {
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new BridgeError('PROTOCOL_ERROR', 'Invalid upstream usage.', 502);
      result[key] = count;
    }
  }
  return result;
}

export class MessageTracker {
  readonly model: Model;
  readonly tools: Set<string>;
  readonly pending = new Set<string>();
  readonly blocks = new Map<number, { type: string; json: string; value: ObjectValue; signature?: boolean }>();
  readonly content: ObjectValue[] = [];
  usage: Usage = {};
  text = '';
  started = false;
  stopped = false;
  stopReason: string | undefined;
  nextIndex = 0;

  constructor(model: Model, body: ObjectValue) {
    this.model = model;
    this.tools = new Set(Array.isArray(body.tools) ? body.tools.map(value => text(object(value).name, 'tool name')) : []);
  }

  checkModel(value: unknown): void {
    if (typeof value !== 'string' || !this.model.responseIds.includes(value)) {
      throw new BridgeError('MODEL_MISMATCH', 'Upstream model does not match the selected catalog ID/version.', 502);
    }
  }

  block(value: unknown, streaming = false): { type: string; json: string; value: ObjectValue; signature?: boolean } {
    const block = object(value);
    if (block.type === 'tool_use') {
      const id = text(block.id, 'tool ID');
      if (this.pending.has(id) || !this.tools.has(text(block.name, 'tool name'))) {
        throw new BridgeError('PROTOCOL_ERROR', 'Duplicate or undeclared upstream tool.', 502);
      }
      this.pending.add(id);
      object(block.input);
    } else if (block.type === 'thinking') {
      if (typeof block.thinking !== 'string' || (!streaming && typeof block.signature !== 'string')) throw new BridgeError('PROTOCOL_ERROR', 'Invalid upstream thinking block.', 502);
      return { type: 'thinking', json: '', value: structuredClone(block), signature: typeof block.signature === 'string' };
    } else if (block.type === 'redacted_thinking') {
      if (typeof block.data !== 'string') throw new BridgeError('PROTOCOL_ERROR', 'Invalid upstream redacted thinking block.', 502);
    } else if (block.type !== 'text' || typeof block.text !== 'string') throw new BridgeError('FEATURE_UNSUPPORTED', 'Unsupported or invalid upstream content block.', 502);
    return { type: String(block.type), json: '', value: structuredClone(block) };
  }

  event(value: ObjectValue): boolean {
    if (value.type === 'ping') return false;
    if (this.stopped) throw new BridgeError('PROTOCOL_ERROR', 'Event after message completion.', 502);
    if (value.type === 'error') throw new BridgeError('UPSTREAM_FAILURE', 'Upstream reported a streaming error.', 502);
    if (value.type === 'message_start') {
      if (this.started) throw new BridgeError('PROTOCOL_ERROR', 'Duplicate message start.', 502);
      const message = object(value.message);
      this.checkModel(message.model);
      this.usage = readUsage(message.usage);
      this.started = true;
      return true;
    }
    if (!this.started) throw new BridgeError('PROTOCOL_ERROR', 'Event before message start.', 502);
    if (value.type === 'content_block_start') {
      if (value.index !== this.nextIndex++) throw new BridgeError('PROTOCOL_ERROR', 'Invalid content block order.', 502);
      const block = this.block(value.content_block, true);
      this.blocks.set(Number(value.index), block);
      this.content[Number(value.index)] = block.value;
    } else if (value.type === 'content_block_delta') {
      const block = this.blocks.get(Number(value.index));
      if (!block) throw new BridgeError('PROTOCOL_ERROR', 'Delta outside an open block.', 502);
      const delta = object(value.delta);
      if (block.type === 'tool_use' && delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') block.json += delta.partial_json;
      else if (block.type === 'text' && delta.type === 'text_delta' && typeof delta.text === 'string') {
        block.value.text = String(block.value.text ?? '') + delta.text;
        this.text += delta.text;
      } else if (block.type === 'thinking' && delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        block.value.thinking = String(block.value.thinking ?? '') + delta.thinking;
      } else if (block.type === 'thinking' && delta.type === 'signature_delta' && typeof delta.signature === 'string') {
        block.value.signature = delta.signature;
        block.signature = true;
      }
      else throw new BridgeError('PROTOCOL_ERROR', 'Invalid block delta.', 502);
      if (block.json.length > 8 * 1024 * 1024) throw new BridgeError('LIMIT_REACHED', 'Tool JSON exceeds the local limit.', 502);
    } else if (value.type === 'content_block_stop') {
      const block = this.blocks.get(Number(value.index));
      if (!block) throw new BridgeError('PROTOCOL_ERROR', 'Unknown or already closed block.', 502);
      if (block.json) block.value.input = parseJson(block.json);
      if (block.type === 'thinking' && !block.signature) throw new BridgeError('PROTOCOL_ERROR', 'Thinking block ended without a signature.', 502);
      this.blocks.delete(Number(value.index));
    } else if (value.type === 'message_delta') {
      const reason = object(value.delta).stop_reason;
      if (reason !== undefined && reason !== null) this.stopReason = text(reason, 'stop reason');
      if (value.usage !== undefined) this.usage = { ...this.usage, ...readUsage(value.usage) };
    } else if (value.type === 'message_stop') {
      this.finish();
      this.stopped = true;
    } else throw new BridgeError('FEATURE_UNSUPPORTED', 'Unknown upstream event.', 502);
    return true;
  }

  finish(): void {
    if (!this.started || this.blocks.size || !['end_turn', 'tool_use', 'max_tokens', 'stop_sequence', 'refusal'].includes(this.stopReason ?? '')) {
      throw new BridgeError('PROTOCOL_ERROR', 'Incomplete upstream model response.', 502);
    }
    if ((this.pending.size > 0) !== (this.stopReason === 'tool_use')) throw new BridgeError('PROTOCOL_ERROR', 'Tool batch and stop reason disagree.', 502);
    if (this.usage.input_tokens === undefined || this.usage.output_tokens === undefined) throw new BridgeError('PROTOCOL_ERROR', 'Required upstream token usage is missing.', 502);
  }

  complete(value: ObjectValue): void {
    this.checkModel(value.model);
    if (value.type !== 'message' || !Array.isArray(value.content)) throw new BridgeError('PROTOCOL_ERROR', 'Invalid upstream message.', 502);
    this.started = true;
    this.usage = readUsage(value.usage);
    this.content.push(...structuredClone(value.content) as ObjectValue[]);
    for (const block of value.content) {
      this.block(block);
      if (object(block).type === 'text') this.text += text(object(block).text, 'text response');
    }
    this.stopReason = text(value.stop_reason, 'stop reason');
    this.finish();
    this.stopped = true;
  }
}
