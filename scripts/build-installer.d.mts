export const USAGE: string;
export const DEFAULT_INSTALLER: string;

export interface InstallerOptions {
  gateway?: string;
  githubRepo?: string;
  output: string;
}

export interface Installer {
  path: string;
  gateway: string;
  sha256: string;
}

export type CommandRunner = (command: string, args: string[]) => Promise<string>;

export function installerGateway(value: string): string;
export function stampGateway(scriptText: string, gateway: string): string;
export function readDeployedGateway(githubRepo: string | undefined, run?: CommandRunner): Promise<string>;
export function writeInstaller(options: { gateway: string; output?: string; script?: string }): Promise<Installer>;
export function buildInstaller(options: InstallerOptions, dependencies?: { run?: CommandRunner }): Promise<Installer>;
export function describeInstaller(installer: Installer): string;
export function parseOptions(argv: string[]): InstallerOptions | { help: true };
