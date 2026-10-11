import { createHash } from 'node:crypto';
import { BridgeError, object, parseJson, positive, text } from './protocol.ts';
import type { Model, ObjectValue } from './protocol.ts';

export const LEGACY_REMOTE_PROFILE = 'remote-litellm-cli-2.1.220-v1';
export const REMOTE_CLAUDE_VERSION = '2.1.284';
export const REMOTE_PROFILE = 'remote-litellm-cli-2.1.284-v2';
export const PROBE_PROMPT = 'Reply exactly CCGC_READY.';
export const PROBE_SYSTEM = 'This is an isolated connection probe. Reply with exactly CCGC_READY. Do not use tools.';

export function gatewayUrl(value: string): string {
  if (/[\\%\s]|\.\./.test(value)) throw new BridgeError('INVALID_OPTIONS', 'Gateway URL must not contain escapes, whitespace, or traversal segments.');
  let url: URL;
  try { url = new URL(value); }
  catch { throw new BridgeError('INVALID_OPTIONS', 'Gateway must be an absolute HTTPS URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || /%|\/\//.test(url.pathname) || url.pathname.includes('..')) {
    throw new BridgeError('INVALID_OPTIONS', 'Gateway requires HTTPS, no credentials/query/fragment, and a plain path prefix.');
  }
  return url.href.replace(/\/$/, '');
}

export function profileKey(url: string): string {
  return createHash('sha256').update(gatewayUrl(url)).digest('hex');
}

export function credential(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'Expected a 256-bit gateway credential supplied through protected input.', 401);
  }
  return value;
}

export function remoteModel(value: unknown): Model {
  const model = object(value);
  const id = text(model.id, 'model ID');
  if (!/^claude-[a-z0-9.-]+$/.test(id) || !Array.isArray(model.responseIds)
    || !model.responseIds.includes(id) || model.responseIds.some(id => typeof id !== 'string' || !/^claude-[a-z0-9.-]+$/.test(id))) {
    throw new BridgeError('INVALID_RESPONSE', 'Gateway model must be an exact Claude mapping.');
  }
  return { id, name: text(model.name, 'model name'), context: positive(model.context, 'context'), output: positive(model.output, 'output'), responseIds: model.responseIds };
}

export interface RemoteInfo {
  profile: string;
  instance: string;
  login: string;
  accountId: number;
  model: Model;
  models: Model[];
  maxTurns: number;
}

export function remoteInfo(data: ObjectValue, allowLegacy = false): RemoteInfo {
  const legacy = allowLegacy && data.profile === LEGACY_REMOTE_PROFILE;
  if (data.profile !== REMOTE_PROFILE && !legacy) throw new BridgeError('VERSION_UNSUPPORTED', 'Remote deployment uses an unverified compatibility profile.');
  const model = remoteModel(data.model);
  const models = legacy ? [model] : Array.isArray(data.models) ? data.models.map(remoteModel) : [];
  if (!models.length || models.length > 100 || !models.some(entry => JSON.stringify(entry) === JSON.stringify(model))) {
    throw new BridgeError('INVALID_RESPONSE', 'Gateway catalog must contain its exact default model.');
  }
  const aliases = new Map<string, string>();
  for (const entry of models) for (const alias of modelIds(entry)) {
    if (aliases.has(alias) && aliases.get(alias) !== entry.id) throw new BridgeError('INVALID_RESPONSE', 'Ambiguous gateway model mapping.');
    aliases.set(alias, entry.id);
  }
  if (new Set(models.map(entry => entry.id)).size !== models.length) throw new BridgeError('INVALID_RESPONSE', 'Duplicate gateway models.');
  return {
    profile: legacy ? LEGACY_REMOTE_PROFILE : REMOTE_PROFILE, instance: text(data.instance, 'deployment instance'), login: text(data.login, 'linked GitHub login'),
    accountId: positive(data.accountId, 'linked GitHub account'), model, models, maxTurns: positive(data.maxTurns, 'turn limit'),
  };
}

export function clientModelId(model: Model): string {
  return model.id === 'claude-haiku-4.5' ? 'claude-haiku-4-5-20251001' : model.id.replaceAll('.', '-');
}

function modelIds(model: Model): string[] {
  return [...new Set([model.id, clientModelId(model), model.id.replaceAll('.', '-'), ...model.responseIds])];
}

export function resolveModel(models: Model[], id: unknown): Model {
  const model = models.find(model => modelIds(model).includes(String(id)));
  if (!model) throw new BridgeError('MODEL_UNAVAILABLE', 'This exact Claude model is not in the approved Copilot catalog. No fallback was attempted.');
  return model;
}

export function isModelCheck(body: ObjectValue): boolean {
  if (body.max_tokens !== 1 || body.stream === true || body.tools !== undefined
    || Object.keys(body).some(key => !['model', 'max_tokens', 'system', 'messages', 'metadata'].includes(key))) return false;
  if (!Array.isArray(body.messages) || body.messages.length !== 1) return false;
  const message = object(body.messages[0]);
  if (message.role !== 'user' || !Array.isArray(message.content) || message.content.length !== 1
    || object(message.content[0]).type !== 'text' || object(message.content[0]).text !== 'Hi') return false;
  if (!Array.isArray(body.system) || body.system.length !== 2) return false;
  return object(body.system[0]).type === 'text'
    && /^x-anthropic-billing-header: cc_version=2\.1\.284\.[a-z0-9]+; cc_entrypoint=[a-z-]+;$/.test(String(object(body.system[0]).text))
    && object(body.system[1]).type === 'text'
    && object(body.system[1]).text === "You are Claude Code, Anthropic's official CLI for Claude.";
}

// Claude 2.1.284 moves the same context between native system messages and
// leading user reminders when switching to/from Haiku. Only the comparison
// representation changes; the actual request is forwarded without role edits.
export function clientHistory(messages: unknown[]): ObjectValue[] {
  const result: ObjectValue[] = [];
  const unwrap = (text: string) => text.replace(/<system-reminder>\n([\s\S]*?)\n<\/system-reminder>/g, '$1');
  const modelIdentity = /You are powered by the model named [^\n]+\. The exact model ID is claude-[a-z0-9.-]+\. Assistant knowledge cutoff is [A-Za-z]+ \d{4}\./g;
  const modelChange = /^<system-reminder>The model for this session has been changed to [^<\n]*\.<\/system-reminder>$/;
  const normalizeDynamicContext = (text: string) => {
    const identity = text.replace(modelIdentity, '<ccgc-model-identity>')
      .replace(/You are powered by the model[^\n]*/g, '<ccgc-model-identity>')
      .replace(/claude-(?:sonnet|haiku)-[a-z0-9.-]+/gi, '<ccgc-model-id>')
      .replace(/\b(?:Claude )?(?:Sonnet|Haiku)(?: [0-9.]+)?\b/g, '<ccgc-model>');
    if (!identity.includes('# Environment')) return identity;
    const date = /Today's date is \d{4}-\d{2}-\d{2}\./.exec(identity)?.[0];
    const os = /\n - OS Version: [^\n]+/.exec(identity);
    if (date && os) return `${identity.slice(0, os.index + os[0].length)}\n\n<ccgc-model-context>\n\n${date}`;
    return identity.replace(/<total_tokens>(?:\d+|Infinite) tokens left<\/total_tokens>/g,
      '<total_tokens>MODEL_BUDGET tokens left</total_tokens>');
  };
  const contextValue = (text: string) => {
    const unwrapped = unwrap(text);
    return normalizeDynamicContext(unwrapped);
  };
  const reminder = /^<system-reminder>\n(# Environment\n[\s\S]*|You are powered by the model named [^\n]+|<total_tokens>\d+ tokens left<\/total_tokens>|Today's date is \d{4}-\d{2}-\d{2}\.)\n<\/system-reminder>$/;
  for (const value of messages) {
    const message = object(value);
    if ('clientContext' in message) throw new BridgeError('FEATURE_UNSUPPORTED', 'clientContext is reserved for internal history comparison.');
    if (message.role === 'system' && typeof message.content === 'string' && result.at(-1)?.role === 'user') {
      const previous = result.at(-1)!;
      const next = contextValue(message.content);
      const existing = next.includes('<ccgc-model-context>') && previous.clientContext === '<ccgc-model-identity>'
        ? undefined : previous.clientContext;
      previous.clientContext = [existing, next].filter(Boolean).join('\n\n');
      continue;
    }
    if ((message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string') {
      result.push({ ...message, content: [{ type: 'text', text: message.content }] });
      continue;
    }
    if (message.role === 'user' && Array.isArray(message.content)) {
      const content = [...message.content];
      const context: string[] = [];
      let index = 0;
      while (index < content.length) {
        const block = object(content[index]);
        if (block.type !== 'text' || typeof block.text !== 'string') break;
        const text = block.text.trimEnd();
        const normalizedText = normalizeDynamicContext(text);
        if (modelChange.test(text) || text.includes('The model for this session has been changed to')) {
          content.splice(index, 1);
          continue;
        }
        if (/^<system-reminder>(?:\n)?<ccgc-model-(?:identity|id)>(?:\n)?<\/system-reminder>$/.test(normalizedText)) {
          context.push('<ccgc-model-identity>');
          content.splice(index, 1);
          continue;
        }
        if (!text.startsWith('<system-reminder>\n') || !text.endsWith('\n</system-reminder>')) break;
        if (reminder.test(text)) {
          context.push(contextValue(text));
          content.splice(index, 1);
        } else {
          content[index] = { ...block, text: normalizedText };
          index++;
        }
      }
      result.push({ ...message, content, ...(context.length ? { clientContext: context.join('\n\n') } : {}) });
    } else result.push({ ...message });
  }
  for (const message of result) {
    if (typeof message.clientContext === 'string' && message.clientContext.includes('# Environment')) {
      message.clientContext = normalizeDynamicContext(message.clientContext);
    }
  }
  for (const message of result) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    const content = [...message.content];
    const last = content.at(-1);
    if (last === undefined) continue;
    const block = object(last);
    if (block.type !== 'tool_result' || typeof block.content !== 'string') continue;
    let toolText = block.content;
    const suffix = /\n\n<system-reminder>\n(<total_tokens>\d+ tokens left<\/total_tokens>)\n<\/system-reminder>$/.exec(toolText);
    if (message.clientContext === undefined && suffix) {
      message.clientContext = suffix[1];
      toolText = toolText.slice(0, suffix.index);
    }
    // The client trims the tool text before appending this reminder on Haiku.
    if (typeof message.clientContext === 'string' && /^<total_tokens>\d+ tokens left<\/total_tokens>$/.test(message.clientContext)) {
      content[content.length - 1] = { ...block, content: toolText.trimEnd() };
      message.content = content;
    }
  }
  return result;
}

export async function remoteRequest(url: string, token: string, path: string, body?: ObjectValue, fetcher: typeof fetch = fetch): Promise<ObjectValue> {
  try {
    const response = await fetcher(`${gatewayUrl(url)}/ccgc/${path}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${credential(token)}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const code = response.status === 401 ? 'GATEWAY_AUTH_REQUIRED'
        : response.status === 409 || response.status === 410 ? 'ADMISSION_REQUIRED'
          : response.status === 403 ? 'ACCESS_DENIED' : 'GATEWAY_UNAVAILABLE';
      throw new BridgeError(code, `Gateway returned HTTP ${response.status}; no retry or fallback was attempted.`, response.status);
    }
    if (!response.body) throw new BridgeError('INVALID_RESPONSE', 'Empty gateway response.');
    let size = 0;
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 64 * 1024) throw new BridgeError('INVALID_RESPONSE', 'Gateway metadata response is too large.');
      chunks.push(chunk);
    }
    return parseJson(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError('GATEWAY_UNAVAILABLE', 'Remote DNS, TLS, connection, or timeout failure. No retry or fallback was attempted.', 502);
  }
}
