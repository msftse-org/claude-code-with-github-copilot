import { BridgeError } from './protocol.ts';
import type { AccountBinding } from './enterprise-store.ts';

export interface EnterpriseWorker {
  url: string;
  credentialSecretName: string;
}

export interface WorkerResolver {
  resolve(binding: AccountBinding): Promise<EnterpriseWorker>;
}

export class SharedWorkerResolver implements WorkerResolver {
  readonly url: string;

  constructor(workerUrl: string, dnsSuffix = '.internal') {
    const url = new URL(workerUrl);
    if (!dnsSuffix.startsWith('.') || /[^a-z0-9.-]/.test(dnsSuffix)
      || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || !url.hostname.endsWith(dnsSuffix) || url.pathname !== '/') {
      throw new BridgeError('INVALID_OPTIONS', 'Shared enterprise worker URL is invalid.');
    }
    this.url = url.origin;
  }

  async resolve(binding: AccountBinding): Promise<EnterpriseWorker> {
    return { url: this.url, credentialSecretName: binding.credentialSecretName };
  }
}
