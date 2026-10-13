import { createRemoteJWKSet, jwtVerify } from 'jose';
import { BridgeError } from './protocol.ts';

export interface EnterprisePrincipal {
  tenantId: string;
  objectId: string;
  subject: string;
  authentication?: 'entra' | 'apiKey';
}

export interface EnterpriseAuthenticator {
  authenticate(token: string): Promise<EnterprisePrincipal>;
}

export interface ApiKeyPrincipalResolver {
  authenticateApiKey(token: string): Promise<EnterprisePrincipal>;
}

export interface EntraAuthenticatorOptions {
  tenantId: string;
  audience: string;
  requiredRole?: string;
}

export function entraJwksUrl(tenantId: string): URL {
  return new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`);
}

export function hasEnterpriseRole(payload: unknown, requiredRole: string): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const roles = (payload as Record<string, unknown>).roles;
  return Array.isArray(roles)
    && roles.some(role => typeof role === 'string' && role === requiredRole);
}

export class EntraAuthenticator implements EnterpriseAuthenticator {
  readonly tenantId: string;
  readonly audience: string;
  readonly requiredRole: string;
  readonly issuer: string;
  readonly keys: ReturnType<typeof createRemoteJWKSet>;

  constructor(options: EntraAuthenticatorOptions) {
    if (!/^[0-9a-f-]{36}$/i.test(options.tenantId) || !options.audience.trim()) {
      throw new BridgeError('INVALID_OPTIONS', 'Enterprise Entra tenant and audience are required.');
    }
    this.tenantId = options.tenantId.toLowerCase();
    this.audience = options.audience;
    this.requiredRole = options.requiredRole ?? 'CCGC.Access';
    this.issuer = `https://login.microsoftonline.com/${this.tenantId}/v2.0`;
    this.keys = createRemoteJWKSet(entraJwksUrl(this.tenantId), {
      cooldownDuration: 30_000,
      timeoutDuration: 10_000,
    });
  }

  async authenticate(token: string): Promise<EnterprisePrincipal> {
    if (!token || /[\r\n]/.test(token)) throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'A valid Entra bearer token is required.', 401);
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        audience: this.audience,
        issuer: this.issuer,
        algorithms: ['RS256'],
        clockTolerance: 5,
      });
      const tenantId = typeof payload.tid === 'string' ? payload.tid.toLowerCase() : '';
      const objectId = typeof payload.oid === 'string' ? payload.oid.toLowerCase() : '';
      const subject = typeof payload.sub === 'string' ? payload.sub : '';
      if (tenantId !== this.tenantId || !/^[0-9a-f-]{36}$/i.test(objectId) || !subject
        || !hasEnterpriseRole(payload, this.requiredRole)) {
        throw new BridgeError('ACCESS_DENIED', 'The Entra principal, tenant, audience, or required app role is not approved.', 403);
      }
      return { tenantId, objectId, subject, authentication: 'entra' };
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'Entra token validation failed.', 401);
    }
  }
}

export class DualEnterpriseAuthenticator implements EnterpriseAuthenticator {
  readonly entra: EnterpriseAuthenticator;
  readonly apiKeys: ApiKeyPrincipalResolver;

  constructor(entra: EnterpriseAuthenticator, apiKeys: ApiKeyPrincipalResolver) {
    this.entra = entra;
    this.apiKeys = apiKeys;
  }

  authenticate(token: string): Promise<EnterprisePrincipal> {
    return token.startsWith('ccgc_sk_')
      ? this.apiKeys.authenticateApiKey(token)
      : this.entra.authenticate(token);
  }
}

export function bearerToken(authorization: string | undefined): string {
  if (!authorization?.startsWith('Bearer ') || authorization.length > 16_384 || /[\r\n]/.test(authorization)) {
    throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'A bearer token is required.', 401);
  }
  return authorization.slice(7);
}
