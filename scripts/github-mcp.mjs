import { litellmOrigin } from './litellm-bootstrap.mjs';

export const GITHUB_MCP_ID = 'ccgc-github-web-search';
// LiteLLM canonicalizes the named endpoint to /mcp during admission.
export const GITHUB_MCP_ROUTES = Object.freeze(['/github/mcp', '/mcp', '/mcp/']);
export const GITHUB_MCP_CONFIG = Object.freeze({
  server_id: GITHUB_MCP_ID,
  server_name: 'github',
  alias: 'github',
  url: 'https://api.githubcopilot.com/mcp/readonly',
  transport: 'http',
  auth_type: 'none',
  static_headers: { 'X-MCP-Toolsets': 'web_search' },
  allowed_tools: ['web_search'],
  extra_headers: [],
  allow_all_keys: false,
});

export async function ensureGitHubMcp({ litellmUrl, masterKey, fetcher = fetch }) {
  const origin = litellmOrigin(litellmUrl);
  if (typeof masterKey !== 'string' || !/^sk-[A-Za-z0-9._-]{16,512}$/.test(masterKey)) {
    throw new Error('A valid LiteLLM administrator key is required.');
  }
  const call = async (path, body) => {
    const response = await fetcher(new URL(path, origin), {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${masterKey}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    if (!body && response.status === 404) return undefined;
    if (!response.ok) throw new Error(`GitHub MCP configuration returned HTTP ${response.status}.`);
    return response.json();
  };
  const existing = await call(`/v1/mcp/server/${GITHUB_MCP_ID}`);
  if (existing) {
    const sameList = (value, expected) => Array.isArray(value)
      && value.length === expected.length && expected.every(item => value.includes(item));
    if (existing.server_id !== GITHUB_MCP_ID || existing.alias !== 'github'
      || existing.server_name !== 'github' || existing.url !== GITHUB_MCP_CONFIG.url
      || existing.transport !== 'http' || existing.auth_type !== 'none'
      || existing.allow_all_keys !== false
      || !sameList(existing.allowed_tools, ['web_search'])
      || !sameList(existing.extra_headers ?? [], [])
      || JSON.stringify(existing.static_headers) !== JSON.stringify(GITHUB_MCP_CONFIG.static_headers)
      || existing.credentials && Object.keys(existing.credentials).length
      || existing.auth_value) {
      throw new Error('Existing GitHub MCP configuration differs from the restricted per-user web-search configuration; review it before continuing.');
    }
    return { serverId: GITHUB_MCP_ID, created: false };
  }
  const created = await call('/v1/mcp/server', GITHUB_MCP_CONFIG);
  if (created?.server_id !== GITHUB_MCP_ID) throw new Error('LiteLLM returned an unexpected GitHub MCP server ID.');
  return { serverId: GITHUB_MCP_ID, created: true };
}
