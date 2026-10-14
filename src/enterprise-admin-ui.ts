import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface AdminStatusResponse {
  status: 'ready';
  litellm: 'ready';
  enterpriseDatabase: 'initialized' | 'uninitialized';
}

export interface AdminBrowserConfig {
  tenantId: string;
  clientId: string;
  scope: string;
  redirectUri: string;
}

export interface AdminApiKeySummary {
  id: string;
  label: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface AdminBindingSummary {
  tenantId: string;
  objectId: string;
  githubAccountId: number;
  githubLogin: string;
  models: string[];
  revision: number;
  revokedAt: string | null;
  updatedAt: string;
  apiKeys: AdminApiKeySummary[];
}

export interface AdminEnrollmentSummary {
  id: string;
  tenantId: string;
  objectId: string;
  userEmail: string;
  userAlias: string;
  githubAccountId: number;
  githubLogin: string;
  models: string[];
  status: string;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
}

export interface AdminAccessQuery {
  limit: number;
  cursor?: string;
}

export interface AdminAccessResponse {
  bindings: AdminBindingSummary[];
  enrollments: AdminEnrollmentSummary[];
  nextCursor: string | null;
}

export interface CreateEnrollmentRequest {
  tenantId: string;
  userEmail: string;
  userAlias: string;
  githubAccountId: number;
  githubLogin: string;
  models: string[];
}

export interface CreateEnrollmentResponse {
  status: 'created';
  code: string;
  expiresAt: string;
  objectId: string;
  githubLogin: string;
  githubAccountId: number;
}

export interface RevokeBindingRequest {
  tenantId: string;
  objectId: string;
  evidence: string;
}

export interface RevokeApiKeyRequest {
  id: string;
  evidence: string;
}

export interface AdminBrowserAuthProvider {
  isConfigured: boolean;
  hasPendingCallback?: boolean;
  acquireToken(): Promise<string>;
  signOut?(): Promise<void>;
  principal?(): Promise<{ displayName?: string; username?: string } | undefined>;
}

const assets = new Map<string, { file: URL; contentType: string }>([
  ['/ccgc/admin', {
    file: new URL('../web/admin/index.html', import.meta.url),
    contentType: 'text/html; charset=utf-8',
  }],
  ['/ccgc/admin/', {
    file: new URL('../web/admin/index.html', import.meta.url),
    contentType: 'text/html; charset=utf-8',
  }],
  ['/ccgc/admin/assets/admin.css', {
    file: new URL('../web/admin/admin.css', import.meta.url),
    contentType: 'text/css; charset=utf-8',
  }],
  ['/ccgc/admin/assets/auth.js', {
    file: new URL('../web/admin/auth.js', import.meta.url),
    contentType: 'text/javascript; charset=utf-8',
  }],
  ['/ccgc/admin/assets/admin.js', {
    file: new URL('../web/admin/admin.js', import.meta.url),
    contentType: 'text/javascript; charset=utf-8',
  }],
]);

const browserHeaders = {
  'cache-control': 'no-store',
  'content-security-policy': [
    "default-src 'none'",
    "base-uri 'none'",
    "connect-src 'self' https://login.microsoftonline.com",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "script-src 'self'",
    "style-src 'self'",
  ].join('; '),
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

export async function serveEnterpriseAdminUi(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const asset = assets.get(pathname);
  if (!asset) return false;
  const body = await readFile(asset.file);
  response.writeHead(200, {
    ...browserHeaders,
    'content-type': asset.contentType,
    'content-length': body.length,
  });
  response.end(request.method === 'HEAD' ? undefined : body);
  return true;
}
