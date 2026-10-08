import type { Backend } from './copilot.ts';
import { BridgeError } from './protocol.ts';
import type { ObjectValue } from './protocol.ts';

export class LiteLLMBackend implements Backend {
  readonly url: string;
  readonly token: string;
  readonly fetcher: typeof fetch;
  constructor(url: string, token: string, fetcher: typeof fetch = fetch) {
    const endpoint = new URL(url);
    if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
      || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
      throw new BridgeError('INVALID_OPTIONS', 'LiteLLM must have a fixed internal HTTP(S) origin.');
    }
    if (!token.trim() || /[\r\n]/.test(token)) throw new BridgeError('INVALID_OPTIONS', 'Invalid internal LiteLLM credential.');
    this.url = endpoint.origin;
    this.token = token;
    this.fetcher = fetcher;
  }
  async send(body: ObjectValue, headers: Headers, signal: AbortSignal): Promise<Response> {
    const upstream = new Headers({ authorization: `Bearer ${this.token}`, 'content-type': 'application/json' });
    for (const name of ['anthropic-version', 'anthropic-beta']) {
      const value = headers.get(name);
      if (value) upstream.set(name, value);
    }
    return this.fetcher(`${this.url}/v1/messages`, {
      method: 'POST', headers: upstream, body: JSON.stringify(body), redirect: 'error', signal,
    });
  }
}
