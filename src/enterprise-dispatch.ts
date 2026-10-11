import { createSecretKey } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { BridgeError, object, positive, text } from './protocol.ts';

export interface DispatchClaims {
  dispatchId: string;
  tenantId: string;
  objectId: string;
  admissionId: string;
  branchId: string;
  bindingRevision: number;
  githubAccountId: number;
  githubLogin: string;
  credentialSecretName: string;
  fence: number;
  model: string;
}

function identifier(value: unknown, name: string): string {
  const result = text(value, name);
  if (!/^[0-9a-f-]{36}$/i.test(result)) throw new BridgeError('GATEWAY_AUTH_REQUIRED', `Dispatch ${name} is invalid.`, 401);
  return result.toLowerCase();
}

function branch(value: unknown): string {
  const result = text(value, 'branch ID');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(result)) throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'Dispatch branch ID is invalid.', 401);
  return result;
}

function secretName(value: unknown): string {
  const result = text(value, 'credential secret name');
  if (!/^[0-9A-Za-z-]{1,127}$/.test(result)) {
    throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'Dispatch credential reference is invalid.', 401);
  }
  return result;
}

function claims(value: unknown): DispatchClaims {
  const payload = object(value);
  const githubLogin = text(payload.githubLogin, 'GitHub login');
  const model = text(payload.model, 'model');
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(githubLogin)
    || !/^claude-[a-z0-9.-]+$/.test(model)) {
    throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'Dispatch account or model is invalid.', 401);
  }
  return {
    dispatchId: identifier(payload.jti, 'ID'),
    tenantId: identifier(payload.tenantId, 'tenant ID'),
    objectId: identifier(payload.objectId, 'object ID'),
    admissionId: identifier(payload.admissionId, 'admission ID'),
    branchId: branch(payload.branchId),
    bindingRevision: positive(payload.bindingRevision, 'binding revision'),
    githubAccountId: positive(payload.githubAccountId, 'GitHub account ID'),
    githubLogin,
    credentialSecretName: secretName(payload.credentialSecretName),
    fence: positive(payload.fence, 'dispatch fence'),
    model,
  };
}

function key(secret: string) {
  if (secret.length < 32 || /[\r\n]/.test(secret)) {
    throw new BridgeError('INVALID_OPTIONS', 'Dispatch signing secret must contain at least 32 safe characters.');
  }
  return createSecretKey(Buffer.from(secret));
}

function serviceOrigin(value: string, name: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/'
    || url.search || url.hash) {
    throw new BridgeError('INVALID_OPTIONS', `${name} must be an HTTPS origin.`);
  }
  return url.origin;
}

export class DispatchSigner {
  readonly signingKey;
  readonly issuer: string;
  readonly audience: string;

  constructor(secret: string, issuer: string, audience: string) {
    this.signingKey = key(secret);
    this.issuer = serviceOrigin(issuer, 'Dispatch issuer');
    this.audience = serviceOrigin(audience, 'Dispatch audience');
  }

  async sign(value: DispatchClaims): Promise<string> {
    return new SignJWT({
      tenantId: value.tenantId,
      objectId: value.objectId,
      admissionId: value.admissionId,
      branchId: value.branchId,
      bindingRevision: value.bindingRevision,
      githubAccountId: value.githubAccountId,
      githubLogin: value.githubLogin,
      credentialSecretName: value.credentialSecretName,
      fence: value.fence,
      model: value.model,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setJti(value.dispatchId)
      .setIssuedAt()
      .setExpirationTime('60s')
      .sign(this.signingKey);
  }
}

export class DispatchVerifier {
  readonly verificationKey;
  readonly issuer: string;
  readonly audience: string;

  constructor(secret: string, issuer: string, audience: string) {
    this.verificationKey = key(secret);
    this.issuer = serviceOrigin(issuer, 'Dispatch issuer');
    this.audience = serviceOrigin(audience, 'Dispatch audience');
  }

  async verify(token: string): Promise<DispatchClaims> {
    if (!token || token.length > 8192 || /[\r\n]/.test(token)) {
      throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'Broker dispatch assertion is invalid.', 401);
    }
    try {
      const result = await jwtVerify(token, this.verificationKey, {
        algorithms: ['HS256'],
        issuer: this.issuer,
        audience: this.audience,
        clockTolerance: 5,
      });
      return claims(result.payload);
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'Broker dispatch assertion is invalid or expired.', 401);
    }
  }
}
