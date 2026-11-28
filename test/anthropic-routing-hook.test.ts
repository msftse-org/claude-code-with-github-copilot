import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

// Runs the real LiteLLM hook in python3 with minimal stand-ins for the
// LiteLLM/FastAPI names it imports. The repository has no Python toolchain.
const exec = promisify(execFile);
const hook = new URL('../infra/litellm/ccgc_anthropic_routing.py', import.meta.url).pathname;

const stubs: Record<string, string> = {
  'fastapi/__init__.py': [
    'class HTTPException(Exception):',
    '    def __init__(self, status_code, detail=None):',
    '        super().__init__(detail)',
    '        self.status_code = status_code',
    '        self.detail = detail',
  ].join('\n'),
  'litellm/__init__.py': '',
  'litellm/_logging.py': 'import logging\nverbose_proxy_logger = logging.getLogger("stub")\n',
  'litellm/integrations/__init__.py': '',
  'litellm/integrations/custom_logger.py': 'class CustomLogger:\n    pass\n',
  'litellm/proxy/__init__.py': '',
  'litellm/proxy/proxy_server.py': 'prisma_client = object()\nuser_api_key_cache = object()\nproxy_logging_obj = object()\n',
  'litellm/proxy/auth/__init__.py': '',
  // Same required parameters as LiteLLM 1.111.0, so a renamed argument fails here.
  'litellm/proxy/auth/auth_checks.py': [
    'from types import SimpleNamespace',
    'USERS = {}',
    'async def get_user_object(user_id, prisma_client, user_api_key_cache, user_id_upsert,',
    '                          parent_otel_span=None, proxy_logging_obj=None):',
    '    if user_id not in USERS:',
    '        raise ValueError("user not found")',
    '    return SimpleNamespace(models=USERS[user_id])',
  ].join('\n'),
};

const runner = `
import asyncio, importlib.util, json, sys
from types import SimpleNamespace
from litellm.proxy.auth import auth_checks
spec = importlib.util.spec_from_file_location("ccgc_anthropic_routing", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
results = []
for case in json.load(sys.stdin):
    data = case["data"]
    auth_checks.USERS = case.get("users", {})
    try:
        asyncio.run(module.handler.async_pre_call_hook(SimpleNamespace(**case["key"]), None, data, case["call_type"]))
        results.append({"model": data.get("model"), "tags": data.get("litellm_metadata", {}).get("tags")})
    except Exception as error:
        results.append({"status": getattr(error, "status_code", None), "detail": getattr(error, "detail", str(error))})
print(json.dumps(results))
`;

interface Case {
  key: { models?: string[]; user_id?: string | null; team_id?: string | null; team_models?: string[] };
  users?: Record<string, string[]>;
  data: Record<string, unknown>;
  call_type?: string;
}

async function runHook(cases: Case[]) {
  const directory = await mkdtemp(join(tmpdir(), 'ccgc-hook-test-'));
  try {
    for (const [file, source] of Object.entries(stubs)) {
      await mkdir(join(directory, file, '..'), { recursive: true });
      await writeFile(join(directory, file), source);
    }
    await writeFile(join(directory, 'runner.py'), runner);
    const input = JSON.stringify(cases.map(entry => ({ call_type: 'anthropic_messages', ...entry })));
    const child = exec('python3', ['-B', join(directory, 'runner.py'), hook], {
      env: { PATH: process.env.PATH ?? '', PYTHONPATH: directory },
    });
    child.child.stdin?.end(input);
    return JSON.parse((await child).stdout) as Array<{ model?: string; tags?: string[]; status?: number; detail?: string }>;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const granted = { models: ['claude-sonnet-5.5', 'ccgc-anthropic/claude-sonnet-5.5'] };
const copilotOnly = { models: ['claude-sonnet-5.5'] };
const webSearch = [{ type: 'web_search_20250305', name: 'web_search' }];

function request(model: string, signedIn: boolean, tools?: unknown[]) {
  return { model, ...(tools ? { tools } : {}), litellm_metadata: { used_client_oauth_token: signedIn, tags: ['existing'] } };
}

test('Anthropic routing hook keeps Copilot as the default and routes web search only for granted, signed-in keys', async () => {
  const [plain, routed, notGranted, adminKey, otherCall, teamDenied] = await runHook([
    { key: granted, data: request('claude-sonnet-5.5', true, [{ name: 'Read', input_schema: {} }]) },
    { key: granted, data: request('claude-sonnet-5.5', true, webSearch) },
    { key: copilotOnly, data: request('claude-sonnet-5.5', true, webSearch) },
    { key: { models: [] }, data: request('claude-sonnet-5.5', true, webSearch) },
    { key: granted, data: request('claude-sonnet-5.5', true, webSearch), call_type: 'acompletion' },
    { key: { ...granted, team_id: 'team', team_models: ['claude-sonnet-5.5'] }, data: request('claude-sonnet-5.5', true, webSearch) },
  ]);
  assert.deepEqual(plain, { model: 'claude-sonnet-5.5', tags: ['existing'] });
  assert.deepEqual(routed, {
    model: 'ccgc-anthropic/claude-sonnet-5.5',
    tags: ['existing', 'ccgc-route:anthropic', 'ccgc-reason:web_search_20250305'],
  });
  for (const unchanged of [notGranted, adminKey, otherCall, teamDenied]) {
    assert.deepEqual(unchanged, { model: 'claude-sonnet-5.5', tags: ['existing'] });
  }
});

test('Anthropic routing hook rejects Anthropic requests without a claude.ai sign-in with HTTP 400', async () => {
  const [webSearchSignedOut, sessionSignedOut, sessionSignedIn, unknownSignIn] = await runHook([
    { key: granted, data: request('claude-sonnet-5.5', false, webSearch) },
    { key: granted, data: request('ccgc-anthropic/claude-sonnet-5.5', false) },
    { key: granted, data: request('ccgc-anthropic/claude-sonnet-5.5', true) },
    { key: granted, data: { model: 'claude-sonnet-5.5', tools: webSearch, litellm_metadata: {} } },
  ]);
  assert.equal(webSearchSignedOut?.status, 400);
  assert.match(webSearchSignedOut?.detail ?? '', /Web search \(web_search_20250305\) uses Anthropic model ccgc-anthropic\/claude-sonnet-5\.5/);
  assert.equal(sessionSignedOut?.status, 400);
  assert.match(sessionSignedOut?.detail ?? '', /not signed in to claude\.ai\. Run claude auth login/);
  assert.deepEqual(sessionSignedIn, { model: 'ccgc-anthropic/claude-sonnet-5.5', tags: ['existing'] });
  assert.equal(unknownSignIn?.status, 500, 'a LiteLLM change that hides the sign-in flag must fail closed');
});

test('Anthropic routing hook needs the employee user grant too, so re-enrolling without it stops older keys', async () => {
  const withUser = { ...granted, user_id: 'employee' };
  const [userGranted, userRevoked, userMissing] = await runHook([
    { key: withUser, users: { employee: granted.models }, data: request('claude-sonnet-5.5', true, webSearch) },
    { key: withUser, users: { employee: copilotOnly.models }, data: request('claude-sonnet-5.5', true, webSearch) },
    { key: withUser, users: {}, data: request('claude-sonnet-5.5', true, webSearch) },
  ]);
  assert.equal(userGranted?.model, 'ccgc-anthropic/claude-sonnet-5.5');
  assert.deepEqual(userRevoked, { model: 'claude-sonnet-5.5', tags: ['existing'] });
  assert.equal(userMissing?.status, 500);
  assert.match(userMissing?.detail ?? '', /could not check the employee's Anthropic routing grant/);
});
