export const CREDENTIAL_NAME: 'github-copilot-user';
export const DEFAULT_MODELS: readonly string[];

export function litellmOrigin(value: string): string;
export function validateModels(models: readonly string[]): string[];

export interface BootstrapOptions {
  litellmUrl: string;
  masterKey: string;
  models?: readonly string[];
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  attempts?: number;
  delayMs?: number;
}

export interface BootstrapResult {
  createdCredential: boolean;
  createdModels: string[];
  models: string[];
}

export function bootstrapLiteLLM(options: BootstrapOptions): Promise<BootstrapResult>;
