export const USAGE: string;
export interface LoggingOptions { litellmUrl: string; secretsFile: string; enabled: boolean }
export function parseLoggingOptions(argv: string[]): LoggingOptions | { help: true };
export function configureLogging(options: LoggingOptions, dependencies?: { fetcher?: typeof fetch }):
  Promise<{ storeModelInDb: boolean; storePromptsInSpendLogs: boolean }>;
