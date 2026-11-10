export const CREDENTIAL_NAME = 'github-copilot-user';
export const DEFAULT_MODELS = Object.freeze([
  'claude-sonnet-5.5',
  'claude-sonnet-5',
  'claude-opus-5.5',
  'claude-haiku-5.5',
  'claude-haiku-4.5',
]);

const MODEL_PATTERN = /^claude-[a-z0-9.-]{1,64}$/;

function fail(message) {
  throw new Error(message);
}

export function litellmOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('The LiteLLM URL must be an HTTPS origin.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/'
    || url.search || url.hash) {
    fail('The LiteLLM URL must be an HTTPS origin without credentials, path, query, or fragment.');
  }
  return url.origin;
}

export function validateModels(models) {
  if (!Array.isArray(models) || !models.length || models.length > 100
    || models.some(model => typeof model !== 'string' || !MODEL_PATTERN.test(model))) {
    fail('Models must be 1-100 Claude model IDs such as claude-sonnet-5.5.');
  }
  return [...new Set(models)];
}

async function request(fetcher, origin, masterKey, path, {
  method = 'GET', body, allowNotFound = false, retryableStatuses = [],
} = {}) {
  let response;
  try {
    response = await fetcher(new URL(path, origin), {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${masterKey}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    fail(`LiteLLM ${method} ${path} could not be reached.`);
  }
  if (allowNotFound && response.status === 404) return undefined;
  const text = await response.text();
  if (!response.ok && retryableStatuses.includes(response.status)) return undefined;
  let value;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    value = undefined;
  }
  if (!response.ok) {
    const detail = value?.error?.message ?? value?.detail ?? '';
    const safeDetail = typeof detail === 'string' ? detail.slice(0, 300).replace(/sk-[A-Za-z0-9._-]+/g, 'sk-***') : '';
    fail(`LiteLLM ${method} ${path} returned HTTP ${response.status}${safeDetail ? `: ${safeDetail}` : ''}.`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`LiteLLM ${method} ${path} returned an invalid response.`);
  }
  return value;
}

function isPerUserCopilotRoute(deployment, model) {
  const params = deployment?.litellm_params ?? {};
  return params.model === `github_copilot/${model}`
    && params.custom_llm_provider === 'github_copilot'
    && params.litellm_credential_name === CREDENTIAL_NAME;
}

async function ensureCredential(call) {
  const path = `/credentials/by_name/${CREDENTIAL_NAME}`;
  const existing = await call(path, { allowNotFound: true });
  if (!existing) {
    await call('/credentials', {
      method: 'POST',
      body: {
        credential_name: CREDENTIAL_NAME,
        display_name: 'GitHub Copilot per-user OAuth',
        credential_values: { github_copilot_auth_type: 'per_user_oauth' },
        credential_info: { custom_llm_provider: 'github_copilot' },
      },
    });
    return true;
  }
  if (existing.credential_values?.github_copilot_auth_type !== 'per_user_oauth'
    || existing.credential_info?.custom_llm_provider !== 'github_copilot') {
    fail(`LiteLLM credential ${CREDENTIAL_NAME} exists but is not a per-user GitHub Copilot credential.`);
  }
  return false;
}

async function ensureModels(call, models) {
  // LiteLLM answers /model/info with HTTP 500 until its first model exists, so an
  // empty model listing means there is nothing to inspect yet.
  const listed = await call('/v1/models');
  const info = Array.isArray(listed.data) && listed.data.length ? await call('/model/info') : { data: [] };
  const deployments = Array.isArray(info.data) ? info.data : [];
  const created = [];
  for (const model of models) {
    const existing = deployments.filter(deployment => deployment?.model_name === model);
    if (existing.length) {
      if (!existing.every(deployment => isPerUserCopilotRoute(deployment, model))) {
        fail(`LiteLLM model ${model} exists but is not routed only to ${CREDENTIAL_NAME}.`);
      }
      continue;
    }
    await call('/model/new', {
      method: 'POST',
      body: {
        model_name: model,
        litellm_params: {
          model: `github_copilot/${model}`,
          custom_llm_provider: 'github_copilot',
          litellm_credential_name: CREDENTIAL_NAME,
        },
      },
    });
    created.push(model);
  }
  return created;
}

// Models are stored in PostgreSQL; other replicas load them on their next database sync.
async function waitForModels(call, models, { attempts, delayMs, sleep }) {
  let missing = models;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const listed = await call('/v1/models');
    const available = new Set(Array.isArray(listed.data) ? listed.data.map(model => model?.id) : []);
    missing = models.filter(model => !available.has(model));
    if (!missing.length) return;
    if (attempt < attempts) await sleep(delayMs);
  }
  fail(`LiteLLM did not advertise these models: ${missing.join(', ')}.`);
}

export function parsePromptStorage(value) {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  fail('--store-prompts-in-spend-logs must be true or false.');
}

function validateMasterKey(masterKey) {
  if (typeof masterKey !== 'string' || !/^sk-[A-Za-z0-9._-]{16,512}$/.test(masterKey)) {
    fail('The LiteLLM master key is missing or invalid.');
  }
}

export async function configurePromptStorage({
  litellmUrl,
  masterKey,
  enabled,
  fetcher = fetch,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  attempts = 24,
  delayMs = 5_000,
}) {
  const origin = litellmOrigin(litellmUrl);
  validateMasterKey(masterKey);
  if (typeof enabled !== 'boolean') fail('Prompt storage must be an explicit boolean.');
  const settings = { store_model_in_db: true, store_prompts_in_spend_logs: enabled };
  // LiteLLM merges only these fields into the PostgreSQL general_settings row.
  // Do not send a copy of the full config: it may contain unrelated secrets.
  await request(fetcher, origin, masterKey, '/config/update', {
    method: 'POST', body: { general_settings: settings },
  });
  const pending = new Set(Object.keys(settings));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    for (const [field, expected] of Object.entries(settings)) {
      const result = await request(fetcher, origin, masterKey, `/config/field/info?field_name=${field}`, {
        retryableStatuses: [400, 404, 429, 500, 502, 503, 504],
      });
      if (result?.field_name === field && result.field_value === expected) pending.delete(field);
      else pending.add(field);
    }
    if (!pending.size) break;
    if (attempt < attempts) await sleep(delayMs);
  }
  if (pending.size) {
    fail(`LiteLLM did not confirm ${[...pending].join(', ')}; check Admin Settings before sending requests.`);
  }
  return { storeModelInDb: true, storePromptsInSpendLogs: enabled };
}

export async function bootstrapLiteLLM({
  litellmUrl,
  masterKey,
  models = DEFAULT_MODELS,
  fetcher = fetch,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  attempts = 24,
  delayMs = 5_000,
  storePromptsInSpendLogs,
}) {
  const origin = litellmOrigin(litellmUrl);
  validateMasterKey(masterKey);
  const approved = validateModels([...models]);
  const call = (path, options) => request(fetcher, origin, masterKey, path, options);
  const createdCredential = await ensureCredential(call);
  const createdModels = await ensureModels(call, approved);
  await waitForModels(call, approved, { attempts, delayMs, sleep });
  // Omission preserves existing UI/DB policy; a fresh gateway defaults to off.
  if (storePromptsInSpendLogs !== undefined) {
    await configurePromptStorage({
      litellmUrl: origin, masterKey, enabled: storePromptsInSpendLogs, fetcher, sleep, attempts, delayMs,
    });
  }
  return { createdCredential, createdModels, models: approved };
}
