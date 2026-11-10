export const GITHUB_MCP_ID: 'ccgc-github-web-search';
export const GITHUB_MCP_ROUTES: readonly string[];
export const GITHUB_MCP_CONFIG: Readonly<{
  server_id: string; server_name: string; alias: string; url: string;
  transport: string; auth_type: string; static_headers: Record<string, string>;
  allowed_tools: string[]; extra_headers: string[]; allow_all_keys: boolean;
}>;
export function ensureGitHubMcp(options: {
  litellmUrl: string; masterKey: string; fetcher?: typeof fetch;
}): Promise<{ serverId: string; created: boolean }>;
