import type { CommandRunner, Installer } from './build-installer.mjs';
import type { EnrolledAccess, RevokedAccess } from './enterprise-actions-access.mjs';

export const USAGE: string;
export const DEFAULT_CONFIG_ROOT: string;

export interface EmployeeAccessOptions {
  action: 'enroll' | 'revoke';
  githubLogin: string;
  prefix: string;
  subscription?: string;
  secretsFile?: string;
  gateway?: string;
  githubRepo?: string;
  installerFile: string;
}

export interface AccessOutcome {
  secretsFile: string;
  installer?: Installer;
  result: EnrolledAccess | RevokedAccess;
}

export function parseOptions(argv: string[]): EmployeeAccessOptions | { help: true };
export function findSecretsFile(
  options: Pick<EmployeeAccessOptions, 'prefix' | 'subscription' | 'secretsFile'>,
  configRoot?: string,
): Promise<string>;
export function readMasterKey(path: string): Promise<string>;
export function runAccess(
  options: EmployeeAccessOptions,
  dependencies?: { fetcher?: typeof fetch; run?: CommandRunner; configRoot?: string },
): Promise<AccessOutcome>;
export function describeAccess(outcome: AccessOutcome): string;
