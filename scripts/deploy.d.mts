import type { BootstrapOptions, BootstrapResult } from './litellm-bootstrap.mjs';

export const USAGE: string;

export interface DeployOptions {
  subscription: string;
  engine: 'terraform' | 'bicep';
  prefix: string;
  location: string;
  nameSeed: string;
  models: string[];
  secretsFile?: string;
  githubRepo?: string;
  stateClientIp?: string;
  skipGithub: boolean;
  confirmDeploy: boolean;
}

export interface Secrets {
  litellmMasterKey: string;
  litellmSaltKey: string;
  postgresAdminPassword: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: { input?: string; inherit?: boolean; env?: Record<string, string> },
) => Promise<string>;

export interface DeployDependencies {
  run?: CommandRunner;
  bootstrap?: (options: BootstrapOptions) => Promise<BootstrapResult>;
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface DeployResult {
  deployed: boolean;
  resourceGroup: string;
  secretsFile: string;
  litellmUrl?: string;
  repo?: string;
  models?: string[];
}

export function parseOptions(argv: string[]): DeployOptions | { help: true };
export function generateSecrets(): Secrets;
export function loadOrCreateSecrets(
  path: string,
  options: { resourceGroupExists: boolean },
): Promise<{ secrets: Secrets; created: boolean }>;
export const runCommand: CommandRunner;
export function deploy(options: DeployOptions, dependencies?: DeployDependencies): Promise<DeployResult>;
