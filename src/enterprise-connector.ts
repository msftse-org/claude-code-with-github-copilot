import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import type { Backend } from './copilot.ts';
import type { DispatchClaims } from './enterprise-dispatch.ts';
import { LiteLLMBackend } from './litellm.ts';
import { BridgeError, object, parseJson, positive, text } from './protocol.ts';

export interface LiteLLMAccountCredential {
  login: string;
  apiKey: string;
  githubAccountId: number;
  credentialName: string;
}

export interface AccountCredentialResolver {
  resolve(claims: DispatchClaims): Promise<LiteLLMAccountCredential>;
}

export interface AccountConnectorFactory {
  connector(claims: DispatchClaims): Promise<Backend>;
}

export class KeyVaultAccountCredentialResolver implements AccountCredentialResolver {
  readonly client: SecretClient;

  constructor(vaultUrl: string) {
    const url = new URL(vaultUrl);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.vault.azure.net') || url.pathname !== '/') {
      throw new BridgeError('INVALID_OPTIONS', 'Enterprise Key Vault URL is invalid.');
    }
    this.client = new SecretClient(url.href, new DefaultAzureCredential());
  }

  async resolve(claims: DispatchClaims): Promise<LiteLLMAccountCredential> {
    const secret = await this.client.getSecret(claims.credentialSecretName);
    if (!secret.value) throw new BridgeError('AUTH_REQUIRED', 'The linked LiteLLM user key is unavailable.', 401);
    const value = object(parseJson(secret.value));
    const login = text(value.login, 'stored GitHub login');
    const apiKey = text(value.apiKey, 'stored LiteLLM user key');
    const githubAccountId = positive(value.githubAccountId, 'stored GitHub account ID');
    const credentialName = text(value.credentialName, 'stored LiteLLM credential name');
    if (login !== claims.githubLogin || githubAccountId !== claims.githubAccountId
      || !/^sk-[A-Za-z0-9._-]{16,}$/.test(apiKey)
      || !/^[A-Za-z0-9._-]{1,128}$/.test(credentialName)) {
      throw new BridgeError('IDENTITY_CONFLICT', 'The selected LiteLLM user does not match the immutable account binding.', 403);
    }
    return { login, apiKey, githubAccountId, credentialName };
  }
}

interface CachedConnector {
  backend: LiteLLMBackend;
  lastAt: number;
}

export class AccountScopedConnectorPool implements AccountConnectorFactory {
  readonly connectors = new Map<string, CachedConnector>();
  readonly creating = new Map<string, Promise<LiteLLMBackend>>();
  readonly credentials: AccountCredentialResolver;
  readonly litellmUrl: string;
  readonly fetcher: typeof fetch;
  readonly maxConnectors: number;
  readonly idleMilliseconds: number;
  readonly now: () => number;

  constructor(
    credentials: AccountCredentialResolver,
    litellmUrl: string,
    fetcher: typeof fetch = fetch,
    maxConnectors = 500,
    idleMilliseconds = 30 * 60_000,
    now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(maxConnectors) || maxConnectors < 1
      || !Number.isSafeInteger(idleMilliseconds) || idleMilliseconds < 60_000) {
      throw new BridgeError('INVALID_OPTIONS', 'Account connector cache limits are invalid.');
    }
    this.credentials = credentials;
    const endpoint = new URL(litellmUrl);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password
      || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
      throw new BridgeError('INVALID_OPTIONS', 'Enterprise LiteLLM URL must be a fixed HTTPS origin.');
    }
    this.litellmUrl = endpoint.origin;
    this.fetcher = fetcher;
    this.maxConnectors = maxConnectors;
    this.idleMilliseconds = idleMilliseconds;
    this.now = now;
  }

  private id(claims: DispatchClaims): string {
    return [
      claims.tenantId, claims.objectId, claims.bindingRevision,
      claims.githubAccountId, claims.credentialSecretName,
    ].join(':');
  }

  private expire(): void {
    for (const [id, connector] of this.connectors) {
      if (this.now() - connector.lastAt >= this.idleMilliseconds) this.connectors.delete(id);
    }
  }

  async connector(claims: DispatchClaims): Promise<Backend> {
    this.expire();
    const id = this.id(claims);
    const current = this.connectors.get(id);
    if (current) {
      current.lastAt = this.now();
      return current.backend;
    }
    const pending = this.creating.get(id);
    if (pending) return pending;
    if (this.connectors.size + this.creating.size >= this.maxConnectors) {
      throw new BridgeError('LIMIT_REACHED', 'Shared worker account connector capacity is exhausted.', 429);
    }
    const creating = (async () => {
      const credential = await this.credentials.resolve(claims);
      const backend = new LiteLLMBackend(this.litellmUrl, credential.apiKey, this.fetcher);
      this.connectors.set(id, { backend, lastAt: this.now() });
      return backend;
    })();
    this.creating.set(id, creating);
    try {
      return await creating;
    } finally {
      this.creating.delete(id);
    }
  }
}
