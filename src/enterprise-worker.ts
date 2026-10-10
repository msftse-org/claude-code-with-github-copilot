import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import { BridgeError, object, parseJson, positive, text } from './protocol.ts';
import type { AccountBinding } from './enterprise-store.ts';

export interface EnterpriseWorker {
  url: string;
  token: string;
  githubAccountId: number;
}

export interface WorkerResolver {
  resolve(binding: AccountBinding): Promise<EnterpriseWorker>;
}

export class KeyVaultWorkerResolver implements WorkerResolver {
  readonly client: SecretClient;
  readonly dnsSuffix: string;

  constructor(vaultUrl: string, dnsSuffix = '.internal') {
    const url = new URL(vaultUrl);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.vault.azure.net') || url.pathname !== '/') {
      throw new BridgeError('INVALID_OPTIONS', 'Enterprise Key Vault URL is invalid.');
    }
    if (!dnsSuffix.startsWith('.') || /[^a-z0-9.-]/.test(dnsSuffix)) {
      throw new BridgeError('INVALID_OPTIONS', 'Enterprise worker DNS suffix is invalid.');
    }
    this.client = new SecretClient(url.href, new DefaultAzureCredential());
    this.dnsSuffix = dnsSuffix;
  }

  async resolve(binding: AccountBinding): Promise<EnterpriseWorker> {
    const secret = await this.client.getSecret(binding.workerSecretName);
    if (!secret.value) throw new BridgeError('GATEWAY_UNAVAILABLE', 'The isolated worker credential is unavailable.', 503);
    const value = object(parseJson(secret.value));
    const url = new URL(text(value.url, 'worker URL'));
    const token = text(value.token, 'worker token');
    const githubAccountId = positive(value.githubAccountId, 'worker GitHub account');
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || !url.hostname.endsWith(this.dnsSuffix) || /[\r\n]/.test(token) || token.length < 32
      || githubAccountId !== binding.githubAccountId) {
      throw new BridgeError('IDENTITY_CONFLICT', 'The worker secret does not match the linked GitHub account.', 403);
    }
    return { url: url.origin, token, githubAccountId };
  }
}
