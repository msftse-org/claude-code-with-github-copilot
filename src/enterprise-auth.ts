import { createRemoteJWKSet, jwtVerify } from 'jose';
import { BridgeError } from './protocol.ts';

export interface EnterprisePrincipal {
  tenantId: string;
  objectId: string;
  subject: string;
}

export interface EnterpriseAuthenticator {
  authenticate(token: string): Promise<EnterprisePrincipal>;
}

export interface EntraAuthenticatorOptions {
  tenantId: string;
  audience: string;
  requiredScope?: string;
}

export class EntraAuthenticator implements EnterpriseAuthenticator {
  readonly tenantId: string;
  readonly audience: string;
  readonly requiredScope: string;
  readonly issuer: string;
  readonly keys: ReturnType<typeof createRemoteJWKSet>;

  constructor(options: EntraAuthenticatorOptions) {
    if (!/^[0-9a-f-]{36}$/i.test(options.tenantId) || !options.audience.trim()) {
      throw new BridgeError('INVALID_OPTIONS', 'Enterprise Entra tenant and audience are required.');
    }
    this.tenantId = options.tenantId.toLowerCase();
    this.audience = options.audience;
    this.requiredScope = options.requiredScope ?? 'CCGC.Access';
    this.issuer = `https://login.microsoftonline.com/${this.tenantId}/v2.0`;
    this.keys = createRemoteJWKSet(new URL(`${this.issuer}/discovery/v2.0/keys`), {
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
      const scopes = typeof payload.scp === 'string' ? payload.scp.split(' ') : [];
      const roles = Array.isArray(payload.roles) ? payload.roles.filter(value => typeof value === 'string') : [];
      if (tenantId !== this.tenantId || !/^[0-9a-f-]{36}$/i.test(objectId) || !subject
        || (!scopes.includes(this.requiredScope) && !roles.includes(this.requiredScope))) {
        throw new BridgeError('ACCESS_DENIED', 'The Entra principal, tenant, audience, or delegated permission is not approved.', 403);
      }
      return { tenantId, objectId, subject };
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'Entra token validation failed.', 401);
    }
  }
}

export function bearerToken(authorization: string | undefined): string {
  if (!authorization?.startsWith('Bearer ') || authorization.length > 16_384 || /[\r\n]/.test(authorization)) {
    throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'A bearer token is required.', 401);
  }
  return authorization.slice(7);
}
