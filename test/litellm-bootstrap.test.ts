import assert from 'node:assert/strict';
import test from 'node:test';
import { bootstrapLiteLLM } from '../scripts/litellm-bootstrap.mjs';

const masterKey = `sk-${'m'.repeat(32)}`;
const litellmUrl = 'https://litellm.example';

interface Deployment {
  model_name: string;
  litellm_params: Record<string, string>;
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
      models.push(body as unknown as Deployment);
      return json({ model_id: 'generated' });
    }
    if (url.pathname === '/v1/models') {
      // Existing models are listed at once; new ones reach every replica after a few listings.
      listings += 1;
      return json({ data: (listings >= advertiseFrom ? models : deployments).map(model => ({ id: model.model_name })) });
    }
    return json({ error: { message: 'unexpected request' } }, 500);
  };
  return { calls, fetcher };
}

const noWait = async () => {};

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
