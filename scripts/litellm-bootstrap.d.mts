export const CREDENTIAL_NAME: 'github-copilot-user';
export const ANTHROPIC_ROUTE_PREFIX: 'ccgc-anthropic/';
export const DEFAULT_MODELS: readonly string[];

export function litellmOrigin(value: string): string;
export function validateModels(models: readonly string[]): string[];
export function anthropicModel(model: string): string;
export function parseBooleanOption(value: string | undefined, flag: string): boolean | undefined;
export function parsePromptStorage(value?: string): boolean | undefined;
export function configurePromptStorage(options: {
  litellmUrl: string;
  masterKey: string;
  enabled: boolean;
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  attempts?: number;
  delayMs?: number;
}): Promise<{ storeModelInDb: boolean; storePromptsInSpendLogs: boolean }>;

export interface BootstrapOptions {
  litellmUrl: string;
  masterKey: string;
  models?: readonly string[];
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  attempts?: number;
  delayMs?: number;
  storePromptsInSpendLogs?: boolean;
  /** true creates credential-free ccgc-anthropic/<model> routes, false removes them, undefined leaves them. */
  anthropicRoutes?: boolean;
}

export interface BootstrapResult {
  createdCredential: boolean;
  createdModels: string[];
  models: string[];
  createdAnthropicRoutes?: string[];
  removedAnthropicRoutes?: string[];
}

export function bootstrapLiteLLM(options: BootstrapOptions): Promise<BootstrapResult>;
