export interface AccessOptions {
  githubLogin: string;
  litellmUrl: string;
  masterKey: string;
  fetcher?: typeof fetch;
}

export interface EnrolledAccess {
  action: 'enroll';
  githubLogin: string;
  userId: string;
  key: string;
  expiresAt: string;
  models: string[];
  reusedUser: boolean;
  gateway: string;
}

export interface RevokedAccess {
  action: 'revoke';
  githubLogin: string;
  deleted: number;
}

export function manageEmployeeAccess(options: AccessOptions & { action: 'enroll' }): Promise<EnrolledAccess>;
export function manageEmployeeAccess(options: AccessOptions & { action: 'revoke' }): Promise<RevokedAccess>;
