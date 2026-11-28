import assert from 'node:assert/strict';
import test from 'node:test';
import { bootstrapLiteLLM } from '../scripts/litellm-bootstrap.mjs';

const masterKey = `sk-${'m'.repeat(32)}`;
const litellmUrl = 'https://litellm.example';

interface Deployment {
  model_name: string;
  litellm_params: Record<string, string>;
  model_info?: { id: string };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function copilotRoute(model: string): Deployment {
  return {
    model_name: model,
    litellm_params: {
      model: `github_copilot/${model}`,
      custom_llm_provider: 'github_copilot',
      litellm_credential_name: 'github-copilot-user',
    },
  };
}

function fakeLiteLLM({ credential, deployments = [], advertiseFrom = 1 }: {
  credential?: object;
  deployments?: Deployment[];
  advertiseFrom?: number;
}) {
  const calls: Array<{ method: string; url: URL; body?: Record<string, unknown>; authorization: string | null }> = [];
  const models = [...deployments];
  let listings = 0;
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    calls.push({ method, url, body, authorization: new Headers(init?.headers).get('authorization') });
    if (url.pathname === '/credentials/by_name/github-copilot-user') {
      return credential ? json(credential) : json({ detail: 'Credential not found' }, 404);
    }
    if (url.pathname === '/credentials' && method === 'POST') return json({ success: true });
    if (url.pathname === '/model/info') {
      // Like LiteLLM, fail until the first model exists.
      return models.length
        ? json({ data: models })
        : json({ detail: { error: 'LLM Model List not loaded in.' } }, 500);
    }
    if (url.pathname === '/model/new' && method === 'POST') {
      models.push({ ...(body as unknown as Deployment), model_info: { id: `id-${models.length}` } });
      return json({ model_id: 'generated' });
    }
    if (url.pathname === '/model/delete' && method === 'POST') {
      const index = models.findIndex(model => model.model_info?.id === body?.id);
      if (index === -1) return json({ detail: 'not found' }, 404);
      models.splice(index, 1);
      return json({ message: 'deleted' });
    }
    if (url.pathname === '/v1/models') {
      // Existing models are listed at once; new ones reach every replica after a few listings.
      listings += 1;
      const advertised = listings >= advertiseFrom ? models : deployments.filter(model => models.includes(model));
      return json({ data: advertised.map(model => ({ id: model.model_name })) });
    }
    return json({ error: { message: 'unexpected request' } }, 500);
  };
  return { calls, fetcher };
}

const noWait = async () => {};

test('bootstrap applies an explicit logging policy after model discovery', async () => {
  const litellm = fakeLiteLLM({});
  const settings: Record<string, boolean> = {};
  let writes = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/config/update') {
      assert.ok(litellm.calls.some(call => call.url.pathname === '/model/new'));
      Object.assign(settings, JSON.parse(String(init?.body)).general_settings);
      writes += 1;
      return json({ message: 'updated' });
    }
    if (url.pathname === '/config/field/info') {
      const field = url.searchParams.get('field_name')!;
      return json({ field_name: field, field_value: settings[field] });
    }
    return litellm.fetcher(input, init);
  };
  await bootstrapLiteLLM({ litellmUrl, masterKey, models: ['claude-sonnet-5.5'], fetcher,
    storePromptsInSpendLogs: false, sleep: noWait });
  assert.equal(writes, 1);
  assert.deepEqual(settings, { store_model_in_db: true, store_prompts_in_spend_logs: false });
});

test('bootstrap creates the per-user Copilot credential and only missing routes, then waits for discovery', async () => {
  const litellm = fakeLiteLLM({ deployments: [copilotRoute('claude-sonnet-5.5')], advertiseFrom: 3 });
  const result = await bootstrapLiteLLM({
    litellmUrl,
    masterKey,
    models: ['claude-sonnet-5.5', 'claude-haiku-4.5'],
    fetcher: litellm.fetcher,
    sleep: noWait,
    attempts: 3,
  });
  assert.deepEqual(result, {
    createdCredential: true,
    createdModels: ['claude-haiku-4.5'],
    models: ['claude-sonnet-5.5', 'claude-haiku-4.5'],
  });
  const credential = litellm.calls.find(call => call.url.pathname === '/credentials');
  assert.deepEqual(credential?.body?.credential_values, { github_copilot_auth_type: 'per_user_oauth' });
  assert.deepEqual(credential?.body?.credential_info, { custom_llm_provider: 'github_copilot' });
  const created = litellm.calls.filter(call => call.url.pathname === '/model/new');
  assert.deepEqual(created.map(call => call.body), [copilotRoute('claude-haiku-4.5')]);
  assert.equal(litellm.calls.filter(call => call.url.pathname === '/v1/models').length, 3);
  for (const call of litellm.calls) {
    assert.equal(call.url.origin, litellmUrl);
    assert.equal(call.authorization, `Bearer ${masterKey}`);
  }
  assert.equal(litellm.calls.some(call => call.url.pathname.startsWith('/config/')), false,
    'omitting the logging flag must preserve the existing policy');
});

test('bootstrap provisions a fresh LiteLLM that has no models yet', async () => {
  const litellm = fakeLiteLLM({});
  const result = await bootstrapLiteLLM({
    litellmUrl,
    masterKey,
    models: ['claude-sonnet-5.5', 'claude-haiku-4.5'],
    fetcher: litellm.fetcher,
    sleep: noWait,
  });
  assert.equal(result.createdCredential, true);
  assert.deepEqual(result.createdModels, ['claude-sonnet-5.5', 'claude-haiku-4.5']);
  assert.deepEqual(
    litellm.calls.filter(call => call.url.pathname === '/model/new').map(call => call.body),
    [copilotRoute('claude-sonnet-5.5'), copilotRoute('claude-haiku-4.5')],
  );
});

test('bootstrap fails closed on a non-Copilot credential or a model routed elsewhere', async () => {
  const wrongCredential = fakeLiteLLM({
    credential: { credential_values: { api_key: 'redacted' }, credential_info: { custom_llm_provider: 'openai' } },
  });
  await assert.rejects(
    bootstrapLiteLLM({ litellmUrl, masterKey, fetcher: wrongCredential.fetcher, sleep: noWait }),
    /not a per-user GitHub Copilot credential/,
  );
  assert.equal(wrongCredential.calls.some(call => call.method === 'POST'), false);

  const mixedRoute = fakeLiteLLM({
    credential: {
      credential_values: { github_copilot_auth_type: 'per_user_oauth' },
      credential_info: { custom_llm_provider: 'github_copilot' },
    },
    deployments: [
      copilotRoute('claude-sonnet-5.5'),
      { model_name: 'claude-sonnet-5.5', litellm_params: { model: 'anthropic/claude-sonnet-5.5' } },
    ],
  });
  await assert.rejects(
    bootstrapLiteLLM({ litellmUrl, masterKey, models: ['claude-sonnet-5.5'], fetcher: mixedRoute.fetcher, sleep: noWait }),
    /claude-sonnet-5\.5 exists but is not routed only to github-copilot-user/,
  );
  assert.equal(mixedRoute.calls.some(call => call.method === 'POST'), false);
});

test('bootstrap reports models that LiteLLM never advertises', async () => {
  const litellm = fakeLiteLLM({ advertiseFrom: Number.POSITIVE_INFINITY });
  await assert.rejects(
    bootstrapLiteLLM({
      litellmUrl,
      masterKey,
      models: ['claude-haiku-4.5'],
      fetcher: litellm.fetcher,
      sleep: noWait,
      attempts: 2,
    }),
    /did not advertise these models: claude-haiku-4\.5/,
  );
});

const perUserCredential = {
  credential_values: { github_copilot_auth_type: 'per_user_oauth' },
  credential_info: { custom_llm_provider: 'github_copilot' },
};

function anthropicRoute(model: string, extra: Record<string, string> = {}): Deployment {
  return {
    model_name: `ccgc-anthropic/${model}`,
    litellm_params: { model: `anthropic/${model.replaceAll('.', '-')}`, custom_llm_provider: 'anthropic', ...extra },
  };
}

test('bootstrap creates credential-free Anthropic routes on request and removes them on false', async () => {
  const litellm = fakeLiteLLM({ credential: perUserCredential, deployments: [copilotRoute('claude-sonnet-5.5')] });
  const models = ['claude-sonnet-5.5', 'claude-haiku-4.5'];
  const created = await bootstrapLiteLLM({ litellmUrl, masterKey, models, fetcher: litellm.fetcher, sleep: noWait,
    anthropicRoutes: true });
  assert.deepEqual(created.createdAnthropicRoutes, ['ccgc-anthropic/claude-sonnet-5.5', 'ccgc-anthropic/claude-haiku-4.5']);
  assert.deepEqual(
    litellm.calls.filter(call => call.url.pathname === '/model/new').map(call => call.body).slice(1),
    [anthropicRoute('claude-sonnet-5.5'), anthropicRoute('claude-haiku-4.5')],
  );

  const again = await bootstrapLiteLLM({ litellmUrl, masterKey, models, fetcher: litellm.fetcher, sleep: noWait,
    anthropicRoutes: true });
  assert.deepEqual(again.createdAnthropicRoutes, []);

  const removed = await bootstrapLiteLLM({ litellmUrl, masterKey, models, fetcher: litellm.fetcher, sleep: noWait,
    anthropicRoutes: false });
  assert.deepEqual(removed.removedAnthropicRoutes, ['ccgc-anthropic/claude-sonnet-5.5', 'ccgc-anthropic/claude-haiku-4.5']);
  const listed = await (await litellm.fetcher(`${litellmUrl}/v1/models`)).json() as { data: Array<{ id: string }> };
  assert.deepEqual(listed.data.map(model => model.id), ['claude-sonnet-5.5', 'claude-haiku-4.5']);
});

test('bootstrap refuses Anthropic routes that hold a credential or use another API host', async () => {
  const unsafe: Array<Record<string, string>> = [
    { api_key: 'sk-ant-api03-***' }, { api_base: 'https://proxy.example' }, { litellm_credential_name: 'shared' },
  ];
  for (const extra of unsafe) {
    const litellm = fakeLiteLLM({
      credential: perUserCredential,
      deployments: [copilotRoute('claude-sonnet-5.5'), anthropicRoute('claude-sonnet-5.5', extra)],
    });
    await assert.rejects(
      bootstrapLiteLLM({ litellmUrl, masterKey, models: ['claude-sonnet-5.5'], fetcher: litellm.fetcher, sleep: noWait,
        anthropicRoutes: true }),
      /ccgc-anthropic\/claude-sonnet-5\.5 must use only Anthropic's API/,
      JSON.stringify(extra),
    );
    assert.equal(litellm.calls.some(call => call.method === 'POST'), false);
  }
});
