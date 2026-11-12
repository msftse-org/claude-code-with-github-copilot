import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { isIPv4 } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { bootstrapLiteLLM, DEFAULT_MODELS, litellmOrigin, parsePromptStorage, validateModels } from './litellm-bootstrap.mjs';
import { DEFAULT_INSTALLER, describeInstaller, writeInstaller } from './build-installer.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BICEP_TEMPLATE = join(REPO_ROOT, 'infra', 'main.bicep');
const TERRAFORM_SOURCE = join(REPO_ROOT, 'infra', 'terraform');
const SOLUTION_SETTINGS = join(REPO_ROOT, 'infra', 'solution.json');
const ADMIN_ENVIRONMENT = 'ccgc-admin';
const ENGINES = ['terraform', 'bicep'];
const SIZES = ['enterprise', 'poc'];
const MINIMUM_TERRAFORM = [1, 11];
const STORAGE_BLOB_DATA_CONTRIBUTOR = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe';
const STATE_ACCESS_ATTEMPTS = 36;
const STATE_PERIMETER_API = '2026-01-01';
const STATE_PERIMETER_PROFILE = 'terraform-state';
const CLIENT_IP_SERVICE = 'https://api.ipify.org';
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export const USAGE = `Usage: node scripts/deploy.mjs --subscription <id> [options]

Without --confirm-deploy, previews the Azure changes (terraform plan, or what-if
with --engine bicep) and changes nothing in the solution. With --confirm-deploy,
deploys LiteLLM, registers the GitHub Copilot models, stores LITELLM_URL and
LITELLM_MASTER_KEY in the ccgc-admin GitHub environment, and writes the employee
setup file with the LiteLLM URL built in. Re-running is safe; it
reuses the private secrets file and, with Terraform, the state in resource group
rg-<prefix>-tfstate. That state is reachable only through a network security
perimeter, so every Terraform run that reads it, previews included, first allows
your current public IPv4 address through the perimeter.

Options:
  --subscription <id>    Azure subscription ID (required)
  --engine <name>        terraform (default) or bicep; both deploy the same resources
  --size <name>          poc (default; 1-2 replicas, Burstable PostgreSQL, no NAT)
                         or enterprise (zone-redundant, NAT egress). Fixed once deployed.
  --prefix <name>        Resource prefix (default: ccgc-pilot)
  --location <region>    Azure region (default: swedencentral)
  --name-seed <seed>     Seed for globally unique names (default: litellm2)
  --models <list>        Comma-separated model IDs (default: ${DEFAULT_MODELS.join(',')})
  --secrets-file <path>  Private secrets file (default: ~/.config/ccgc/<subscription>/<prefix>.json)
  --github-repo <o/r>    Repository with the ccgc-admin environment (default: this checkout's repository)
  --state-client-ip <ip> Public IPv4 address Azure sees for this machine (default: detected with ${CLIENT_IP_SERVICE})
  --installer <path>     Employee setup file to write (default: dist/ccgc-enterprise-setup.command)
  --skip-github          Do not configure the GitHub environment
  --store-prompts-in-spend-logs <true|false>
                        Store request/response content in PostgreSQL (omitted: preserve existing; new gateways: off)
  --confirm-deploy       Deploy instead of previewing
`;

function fail(message) {
  throw new Error(message);
}

export function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      subscription: { type: 'string' },
      engine: { type: 'string', default: 'terraform' },
      size: { type: 'string', default: 'poc' },
      prefix: { type: 'string', default: 'ccgc-pilot' },
      location: { type: 'string', default: 'swedencentral' },
      'name-seed': { type: 'string', default: 'litellm2' },
      models: { type: 'string' },
      'secrets-file': { type: 'string' },
      'github-repo': { type: 'string' },
      'state-client-ip': { type: 'string' },
      installer: { type: 'string' },
      'skip-github': { type: 'boolean', default: false },
      'store-prompts-in-spend-logs': { type: 'string' },
      'confirm-deploy': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) return { help: true };
  const subscription = values.subscription ?? '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(subscription)) {
    fail(`--subscription must be an Azure subscription ID.\n\n${USAGE}`);
  }
  if (!ENGINES.includes(values.engine)) fail('--engine must be terraform or bicep.');
  if (!SIZES.includes(values.size)) fail('--size must be enterprise or poc.');
  if (!/^[a-z][a-z0-9-]{2,15}$/.test(values.prefix)) fail('--prefix must be 3-16 lowercase letters, digits, or hyphens.');
  if (!/^[a-z0-9]{2,40}$/.test(values.location)) fail('--location must be an Azure region name such as swedencentral.');
  if (!/^[a-z0-9-]{1,16}$/.test(values['name-seed'])) fail('--name-seed must be 1-16 lowercase letters, digits, or hyphens.');
  const githubRepo = values['github-repo'];
  if (githubRepo !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubRepo)) {
    fail('--github-repo must be owner/repository.');
  }
  const stateClientIp = values['state-client-ip'];
  if (stateClientIp !== undefined && !isIPv4(stateClientIp)) fail('--state-client-ip must be an IPv4 address.');
  return {
    subscription: subscription.toLowerCase(),
    engine: values.engine,
    size: values.size,
    prefix: values.prefix,
    location: values.location,
    nameSeed: values['name-seed'],
    models: validateModels(values.models === undefined ? [...DEFAULT_MODELS] : values.models.split(',').map(model => model.trim())),
    secretsFile: values['secrets-file'] === undefined ? undefined : resolve(values['secrets-file']),
    githubRepo,
    stateClientIp,
    installerFile: resolve(values.installer ?? DEFAULT_INSTALLER),
    skipGithub: values['skip-github'],
    confirmDeploy: values['confirm-deploy'],
    storePromptsInSpendLogs: parsePromptStorage(values['store-prompts-in-spend-logs']),
  };
}

function randomPassword(length = 32) {
  for (;;) {
    let value = '';
    for (let index = 0; index < length; index += 1) value += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
    if (/[A-Z]/.test(value) && /[a-z]/.test(value) && /[0-9]/.test(value)) return value;
  }
}

export function generateSecrets() {
  return {
    litellmMasterKey: `sk-${randomBytes(32).toString('base64url')}`,
    litellmSaltKey: randomBytes(32).toString('base64url'),
    postgresAdminPassword: randomPassword(),
  };
}

function validSecrets(value) {
  return Boolean(value) && typeof value === 'object'
    && typeof value.litellmMasterKey === 'string' && /^sk-[A-Za-z0-9_-]{32,}$/.test(value.litellmMasterKey)
    && typeof value.litellmSaltKey === 'string' && /^[A-Za-z0-9_-]{32,}$/.test(value.litellmSaltKey)
    && typeof value.postgresAdminPassword === 'string' && /^[A-Za-z0-9]{16,}$/.test(value.postgresAdminPassword);
}

export async function loadOrCreateSecrets(path, { resourceGroupExists }) {
  let text;
  try {
    const info = await stat(path);
    if ((info.mode & 0o077) !== 0) fail(`${path} must be readable only by you (chmod 600 it).`);
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (text !== undefined) {
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      fail(`${path} is not valid JSON.`);
    }
    if (!validSecrets(value)) fail(`${path} does not contain valid LiteLLM secrets.`);
    return { secrets: value, created: false };
  }
  if (resourceGroupExists) {
    fail(`The resource group already exists but ${path} is missing. Restore that file: new secrets would `
      + 'not match the existing database and the LiteLLM salt key that encrypts employee GitHub connections.');
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const secrets = generateSecrets();
  await writeFile(path, `${JSON.stringify(secrets, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { secrets, created: true };
}

export function runCommand(command, args, { input, inherit = false, env } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      env: env === undefined ? process.env : { ...process.env, ...env },
      stdio: [input === undefined ? 'ignore' : 'pipe', inherit ? 'inherit' : 'pipe', inherit ? 'inherit' : 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.on('error', error => reject(new Error(`${command} could not start: ${error.message}`)));
    child.on('close', code => {
      if (code === 0) {
        resolvePromise(stdout.trim());
        return;
      }
      const detail = stderr.trim().slice(-4000);
      reject(new Error(`${command} ${args.slice(0, 3).join(' ')} failed with exit code ${code}.${detail ? `\n${detail}` : ''}`));
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

async function waitForReadiness(litellmUrl, { fetcher, sleep, attempts = 120, delayMs = 10_000 }) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetcher(new URL('/health/readiness', litellmUrl), {
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) {
        const body = await response.json();
        if (body?.db === 'connected') return body;
      }
    } catch {
      // Revisions take a few minutes to start after a deployment.
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  fail(`LiteLLM did not become ready at ${litellmUrl}/health/readiness.`);
}

async function configureGitHub(run, repo, litellmUrl, masterKey) {
  const environment = `repos/${repo}/environments/${ADMIN_ENVIRONMENT}`;
  try {
    await run('gh', ['api', environment, '--silent']);
  } catch (error) {
    if (!/HTTP 404/.test(error instanceof Error ? error.message : '')) throw error;
    await run('gh', ['api', '--method', 'PUT', environment, '--silent', '--input', '-'], {
      input: JSON.stringify({ deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }),
    });
    await run('gh', ['api', '--method', 'POST', `${environment}/deployment-branch-policies`, '--silent',
      '-f', 'name=main', '-f', 'type=branch']);
  }
  await run('gh', ['variable', 'set', 'LITELLM_URL', '--env', ADMIN_ENVIRONMENT, '--repo', repo, '--body', litellmUrl]);
  await run('gh', ['secret', 'set', 'LITELLM_MASTER_KEY', '--env', ADMIN_ENVIRONMENT, '--repo', repo], { input: masterKey });
}

async function deployWithBicep(options, secrets, { run, log }) {
  const directory = await mkdtemp(join(tmpdir(), 'ccgc-deploy-'));
  const parameterFile = join(directory, 'parameters.json');
  try {
    await writeFile(parameterFile, JSON.stringify({
      $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#',
      contentVersion: '1.0.0.0',
      parameters: {
        prefix: { value: options.prefix },
        location: { value: options.location },
        size: { value: options.size },
        nameSeed: { value: options.nameSeed },
        postgresAdminPassword: { value: secrets.postgresAdminPassword },
        litellmMasterKey: { value: secrets.litellmMasterKey },
        litellmSaltKey: { value: secrets.litellmSaltKey },
      },
    }), { flag: 'wx', mode: 0o600 });
    const deployment = [
      '--name', `${options.prefix}-litellm-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`,
      '--location', options.location,
      '--template-file', BICEP_TEMPLATE,
      '--parameters', `@${parameterFile}`,
      '--subscription', options.subscription,
    ];
    if (!options.confirmDeploy) {
      await run('az', ['deployment', 'sub', 'what-if', ...deployment], { inherit: true });
      return undefined;
    }
    log(`Deploying rg-${options.prefix}-enterprise (${options.size} size) with Bicep. A new PostgreSQL server can take up to 30 minutes.`);
    const outputs = JSON.parse(await run('az', ['deployment', 'sub', 'create', ...deployment,
      '--query', 'properties.outputs', '--output', 'json']));
    return {
      litellmUrl: outputs?.litellmUrl?.value,
      egressIp: outputs?.egressIp?.value,
      resourceGroupName: outputs?.resourceGroupName?.value,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function terraformStateLocation(options) {
  const hash = createHash('sha256').update(`${options.subscription}/${options.prefix}`).digest('hex');
  return {
    resourceGroup: `rg-${options.prefix}-tfstate`,
    account: (`sttf${options.prefix.replace(/-/g, '')}`.slice(0, 14) + hash).slice(0, 24),
    container: 'tfstate',
    key: `${options.prefix}.tfstate`,
    perimeter: `nsp-${options.prefix}-tfstate`,
  };
}

async function requireTerraform(run) {
  let version;
  try {
    version = String(JSON.parse(await run('terraform', ['version', '-json'])).terraform_version);
  } catch {
    fail('Terraform 1.11 or later is required (https://developer.hashicorp.com/terraform/install). '
      + 'Install it, or deploy the same resources with --engine bicep.');
  }
  const [major, minor] = version.split('.').map(Number);
  if (major < MINIMUM_TERRAFORM[0] || (major === MINIMUM_TERRAFORM[0] && minor < MINIMUM_TERRAFORM[1])) {
    fail(`Terraform ${version} is too old; 1.11 or later is required for write-only secrets.`);
  }
}

async function stateStorageExists(run, options, state) {
  const subscription = ['--subscription', options.subscription];
  if (await run('az', ['group', 'exists', '--name', state.resourceGroup, ...subscription]) !== 'true') return false;
  const count = await run('az', ['storage', 'account', 'list', '--resource-group', state.resourceGroup, ...subscription,
    '--query', `length([?name=='${state.account}'])`, '--output', 'tsv']);
  return count === '1';
}

async function signedInPrincipal(run, account) {
  if (account.user?.type === 'servicePrincipal') {
    return { id: await run('az', ['ad', 'sp', 'show', '--id', String(account.user.name), '--query', 'id', '--output', 'tsv']), type: 'ServicePrincipal' };
  }
  return { id: await run('az', ['ad', 'signed-in-user', 'show', '--query', 'id', '--output', 'tsv']), type: 'User' };
}

async function ensureStateStorage(run, options, state, principal, tags, { log }) {
  const subscription = ['--subscription', options.subscription];
  const tagArguments = Object.entries(tags).map(([name, value]) => `${name}=${value}`);
  await run('az', ['group', 'create', '--name', state.resourceGroup, '--location', options.location,
    '--tags', ...tagArguments, ...subscription, '--output', 'none']);
  // Tenant policy forces public network access off unless a network security perimeter secures the account.
  const accountId = await run('az', ['storage', 'account', 'create', '--name', state.account,
    '--resource-group', state.resourceGroup, '--location', options.location, '--kind', 'StorageV2',
    '--sku', 'Standard_ZRS', '--min-tls-version', 'TLS1_2', '--https-only', 'true',
    '--allow-blob-public-access', 'false', '--allow-shared-key-access', 'false',
    '--allow-cross-tenant-replication', 'false', '--public-network-access', 'SecuredByPerimeter',
    '--tags', ...tagArguments, ...subscription, '--query', 'id', '--output', 'tsv']);
  await run('az', ['storage', 'account', 'blob-service-properties', 'update', '--account-name', state.account,
    '--resource-group', state.resourceGroup, '--enable-versioning', 'true', '--enable-delete-retention', 'true',
    '--delete-retention-days', '30', '--enable-container-delete-retention', 'true',
    '--container-delete-retention-days', '30', ...subscription, '--output', 'none']);
  const containers = await run('az', ['storage', 'container-rm', 'list', '--storage-account', state.account,
    '--resource-group', state.resourceGroup, ...subscription, '--query', `length([?name=='${state.container}'])`, '--output', 'tsv']);
  if (containers !== '1') {
    await run('az', ['storage', 'container-rm', 'create', '--storage-account', state.account,
      '--resource-group', state.resourceGroup, '--name', state.container, '--public-access', 'off', ...subscription, '--output', 'none']);
  }

  // Shared keys are disabled, so Terraform reads and locks state with Microsoft Entra ID.
  const assigned = await run('az', ['role', 'assignment', 'list', '--scope', accountId, '--include-inherited', ...subscription,
    '--query', `length([?principalId=='${principal.id}' && ends_with(roleDefinitionId, '${STORAGE_BLOB_DATA_CONTRIBUTOR}')])`,
    '--output', 'tsv']);
  if (assigned === '0') {
    log(`Granting you Storage Blob Data Contributor on ${state.account} for Terraform state.`);
    await run('az', ['role', 'assignment', 'create', '--assignee-object-id', principal.id,
      '--assignee-principal-type', principal.type, '--role', STORAGE_BLOB_DATA_CONTRIBUTOR, '--scope', accountId,
      ...subscription, '--output', 'none']);
  }
}

async function publicClientIp(options, fetcher) {
  if (options.stateClientIp) return options.stateClientIp;
  let address = '';
  try {
    const response = await fetcher(CLIENT_IP_SERVICE, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (response.ok) address = (await response.text()).trim();
  } catch {
    // Reported below together with the manual alternative.
  }
  if (!isIPv4(address)) fail(`Could not detect this machine's public IPv4 address with ${CLIENT_IP_SERVICE}; pass it with --state-client-ip.`);
  return address;
}

// The state account accepts public traffic only through an enforced network security perimeter.
// Each deployer has one inbound rule that follows their current public IP.
async function ensureStateAccess(run, options, state, principal, tags, { log, sleep, fetcher }) {
  const subscription = ['--subscription', options.subscription];
  const clientIp = await publicClientIp(options, fetcher);
  const storage = JSON.parse(await run('az', ['storage', 'account', 'show', '--name', state.account,
    '--resource-group', state.resourceGroup, ...subscription,
    '--query', '{id:id, publicNetworkAccess:publicNetworkAccess}', '--output', 'json']));
  if (storage.publicNetworkAccess !== 'SecuredByPerimeter') {
    await run('az', ['storage', 'account', 'update', '--name', state.account, '--resource-group', state.resourceGroup,
      '--public-network-access', 'SecuredByPerimeter', ...subscription, '--output', 'none']);
  }
  const perimeter = `/subscriptions/${options.subscription}/resourceGroups/${state.resourceGroup}`
    + `/providers/Microsoft.Network/networkSecurityPerimeters/${state.perimeter}`;
  const profile = `${perimeter}/profiles/${STATE_PERIMETER_PROFILE}`;
  const association = `${perimeter}/resourceAssociations/${state.account}`;
  const put = (id, body) => run('az', ['rest', '--method', 'put', '--url', `${id}?api-version=${STATE_PERIMETER_API}`,
    '--body', JSON.stringify(body), '--output', 'none']);
  await put(perimeter, { location: options.location, tags, properties: {} });
  await put(profile, { properties: {} });
  await put(`${profile}/accessRules/deployer-${principal.id}`, {
    properties: { direction: 'Inbound', addressPrefixes: [`${clientIp}/32`] },
  });
  await put(association, {
    properties: { accessMode: 'Enforced', privateLinkResource: { id: storage.id }, profile: { id: profile } },
  });
  for (let attempt = 1; ; attempt += 1) {
    const status = await run('az', ['rest', '--method', 'get', '--url', `${association}?api-version=${STATE_PERIMETER_API}`,
      '--query', 'properties.provisioningState', '--output', 'tsv']);
    if (status === 'Succeeded') break;
    if (status === 'Failed' || attempt >= STATE_ACCESS_ATTEMPTS) {
      fail(`Network security perimeter association ${state.perimeter}/${state.account} is ${status || 'missing'}.`);
    }
    await sleep(5_000);
  }
  log(`Terraform state admits ${clientIp} through network security perimeter ${state.perimeter}.`);

  for (let attempt = 1; ; attempt += 1) {
    try {
      await run('az', ['storage', 'blob', 'list', '--account-name', state.account, '--container-name', state.container,
        '--auth-mode', 'login', '--num-results', '1', '--output', 'none']);
      return;
    } catch (error) {
      if (attempt >= STATE_ACCESS_ATTEMPTS) {
        fail(`Cannot read Terraform state in ${state.account}/${state.container} from ${clientIp} with Microsoft Entra ID. `
          + 'You need Storage Blob Data Contributor on the account (a confirmed deploy grants it), and Azure must see '
          + 'this machine at that address (if a VPN or proxy changes it, pass --state-client-ip): '
          + `${error instanceof Error ? error.message : String(error)}`);
      }
      // New role assignments and perimeter rules take a few minutes to reach the storage data plane.
      await sleep(10_000);
    }
  }
}

async function terraformWorkspace(directory) {
  const config = join(directory, 'terraform');
  const excluded = new Set(['.terraform', 'tests']);
  await cp(TERRAFORM_SOURCE, config, {
    recursive: true,
    filter: source => !excluded.has(basename(source)) && !/\.tfstate(\.|$)|\.tfplan$/.test(source),
  });
  await cp(SOLUTION_SETTINGS, join(directory, 'solution.json'));
  return config;
}

// Azure Monitor keeps diagnostic settings after their resource is deleted and re-attaches them to a
// new resource with the same ID, so creating them after a rebuild fails with "already exists".
// Imports every planned diagnostic setting that Azure already has and reports whether any was found.
async function importLeftoverDiagnosticSettings(run, { chdir, env, variables, directory, log }) {
  const planFile = join(directory, 'leftovers.tfplan');
  await run('terraform', [chdir, 'plan', '-input=false', `-out=${planFile}`, ...variables], { env });
  const plan = JSON.parse(await run('terraform', [chdir, 'show', '-json', planFile], { env }));
  let imported = false;
  for (const change of plan.resource_changes ?? []) {
    const planned = change.change?.after;
    const [type, apiVersion] = String(planned?.type ?? '').split('@');
    if (change.type !== 'azapi_resource' || type !== 'Microsoft.Insights/diagnosticSettings'
      || change.change.actions.join() !== 'create' || typeof planned.parent_id !== 'string') continue;
    const existing = JSON.parse(await run('az', ['monitor', 'diagnostic-settings', 'list',
      '--resource', planned.parent_id, '--query', '[].name', '--output', 'json']));
    if (!existing.includes(planned.name)) continue;
    log(`Importing diagnostic setting ${planned.name} that Azure kept from a deleted ${planned.parent_id}.`);
    await run('terraform', [chdir, 'import', '-input=false', ...variables, change.address,
      `${planned.parent_id}/providers/Microsoft.Insights/diagnosticSettings/${planned.name}?api-version=${apiVersion}`], { env });
    imported = true;
  }
  return imported;
}

async function deployWithTerraform(options, account, secrets, { groupExists, run, log, sleep, fetcher }) {
  await requireTerraform(run);
  const state = terraformStateLocation(options);
  const noState = `rg-${options.prefix}-enterprise exists, but Terraform state ${state.account}/${state.container}/${state.key} `
    + 'has no resources, so it was deployed without Terraform. Keep using --engine bicep for it, '
    + 'or import its resources into Terraform state first.';
  const storageExists = await stateStorageExists(run, options, state);
  if (groupExists && !storageExists) fail(noState);
  if (options.confirmDeploy || storageExists) {
    const principal = await signedInPrincipal(run, account);
    const tags = { ...JSON.parse(await readFile(SOLUTION_SETTINGS, 'utf8')).tags, environment: options.size };
    if (options.confirmDeploy) await ensureStateStorage(run, options, state, principal, tags, { log });
    await ensureStateAccess(run, options, state, principal, tags, { log, sleep, fetcher });
  }
  log(`Terraform state: ${state.account}/${state.container}/${state.key} in ${state.resourceGroup}.`);

  // A private temporary copy keeps provider downloads and backend settings out of the checkout.
  const directory = await mkdtemp(join(tmpdir(), 'ccgc-terraform-'));
  try {
    const config = await terraformWorkspace(directory);
    const chdir = `-chdir=${config}`;
    const env = { TF_DATA_DIR: join(directory, 'data'), TF_IN_AUTOMATION: '1', TF_INPUT: '0' };
    const backend = [];
    if (options.confirmDeploy || storageExists) {
      backend.push(
        `-backend-config=storage_account_name=${state.account}`,
        `-backend-config=container_name=${state.container}`,
        `-backend-config=key=${state.key}`,
        `-backend-config=tenant_id=${account.tenantId}`,
      );
    } else {
      // Nothing has been deployed yet: plan against empty local state instead of creating storage.
      await writeFile(join(config, 'local_backend_override.tf'), 'terraform {\n  backend "local" {}\n}\n', { flag: 'wx' });
    }
    await run('terraform', [chdir, 'init', '-input=false', '-reconfigure', ...backend], { env });
    if (groupExists && !(await run('terraform', [chdir, 'state', 'list'], { env })).trim()) fail(noState);

    // Secrets reach Terraform only through a private file and are write-only, so they
    // never appear in command lines, plans, or state.
    const secretFile = join(directory, 'secrets.tfvars.json');
    await writeFile(secretFile, JSON.stringify({
      postgres_admin_password: secrets.postgresAdminPassword,
      litellm_master_key: secrets.litellmMasterKey,
      litellm_salt_key: secrets.litellmSaltKey,
    }), { flag: 'wx', mode: 0o600 });
    const variables = [
      `-var-file=${secretFile}`,
      `-var=subscription_id=${options.subscription}`,
      `-var=tenant_id=${account.tenantId}`,
      `-var=prefix=${options.prefix}`,
      `-var=location=${options.location}`,
      `-var=size=${options.size}`,
      `-var=name_seed=${options.nameSeed}`,
    ];
    if (!options.confirmDeploy) {
      await run('terraform', [chdir, 'plan', '-input=false', '-lock=false', ...variables], { env, inherit: true });
      return undefined;
    }
    log(`Deploying rg-${options.prefix}-enterprise (${options.size} size) with Terraform. A new PostgreSQL server can take up to 30 minutes.`);
    const apply = () => run('terraform', [chdir, 'apply', '-input=false', '-auto-approve', ...variables], { env, inherit: true });
    try {
      await apply();
    } catch (error) {
      let imported = false;
      try {
        imported = await importLeftoverDiagnosticSettings(run, { chdir, env, variables, directory, log });
      } catch {
        // The apply error printed above explains the failure better than this check can.
      }
      if (!imported) throw error;
      log('Retrying the Terraform apply.');
      await apply();
    }
    const outputs = JSON.parse(await run('terraform', [chdir, 'output', '-json'], { env }));
    return {
      litellmUrl: outputs?.litellm_url?.value,
      egressIp: outputs?.egress_ip?.value,
      resourceGroupName: outputs?.resource_group_name?.value,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function deploy(options, {
  run = runCommand,
  bootstrap = bootstrapLiteLLM,
  fetcher = fetch,
  sleep = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds)),
  log = message => console.error(message),
} = {}) {
  const account = JSON.parse(await run('az', ['account', 'show', '--subscription', options.subscription, '--output', 'json']));
  if (String(account.id).toLowerCase() !== options.subscription) fail('Azure CLI resolved a different subscription.');
  log(`Subscription: ${account.name} (${account.id})`);
  log(options.storePromptsInSpendLogs === undefined
    ? 'Prompt/response storage: preserve existing policy (off on a new gateway).'
    : `Prompt/response storage requested: ${options.storePromptsInSpendLogs ? 'enabled' : 'disabled'}; applied only after confirmed deployment.`);

  const resourceGroup = `rg-${options.prefix}-enterprise`;
  const groupExists = await run('az', ['group', 'exists', '--name', resourceGroup, '--subscription', options.subscription]) === 'true';
  const secretsFile = options.secretsFile ?? join(homedir(), '.config', 'ccgc', options.subscription, `${options.prefix}.json`);
  const { secrets, created } = await loadOrCreateSecrets(secretsFile, { resourceGroupExists: groupExists });
  log(created
    ? `Created ${secretsFile}. Back it up privately; the salt key in it must never change.`
    : `Using ${secretsFile}.`);
  if (groupExists) {
    // The resource group's environment tag records the size it was deployed with. Azure cannot change zone
    // redundancy or shrink PostgreSQL storage in place, so switching sizes needs a new deployment.
    const deployedSize = await run('az', ['group', 'show', '--name', resourceGroup, '--subscription', options.subscription,
      '--query', 'tags.environment', '--output', 'tsv']);
    if (deployedSize !== options.size) {
      fail(`${resourceGroup} was deployed with size ${deployedSize || '(unknown)'}, not ${options.size}. Sizes cannot be `
        + `changed in place; pass --size ${deployedSize || '<original size>'}, or deploy the other size with a new --prefix.`);
    }
  }

  const outputs = options.engine === 'bicep'
    ? await deployWithBicep(options, secrets, { run, log })
    : await deployWithTerraform(options, account, secrets, { groupExists, run, log, sleep, fetcher });
  if (!options.confirmDeploy) {
    log(`${options.engine === 'bicep' ? 'What-if' : 'Plan'} only; the solution was not changed. Review the changes and cost, then re-run with --confirm-deploy.`);
    return { deployed: false, resourceGroup, secretsFile };
  }

  const litellmUrl = litellmOrigin(outputs?.litellmUrl ?? '');
  log(`Waiting for ${litellmUrl}/health/readiness ...`);
  const readiness = await waitForReadiness(litellmUrl, { fetcher, sleep });
  log(`LiteLLM${readiness.litellm_version ? ` ${readiness.litellm_version}` : ''} is ready and connected to PostgreSQL.`);
  const catalog = await bootstrap({ litellmUrl, masterKey: secrets.litellmMasterKey, models: options.models,
    storePromptsInSpendLogs: options.storePromptsInSpendLogs, fetcher, sleep });
  if (options.storePromptsInSpendLogs !== undefined) {
    log(`PostgreSQL prompt/response storage ${options.storePromptsInSpendLogs ? 'enabled' : 'disabled'} and configuration read back. Applies to new requests after replica sync.`);
  }
  log(`Credential github-copilot-user ${catalog.createdCredential ? 'created' : 'verified'}; models: ${catalog.models.join(', ')}.`);

  let repo;
  if (!options.skipGithub) {
    repo = options.githubRepo ?? await run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
    await configureGitHub(run, repo, litellmUrl, secrets.litellmMasterKey);
    log(`Configured ${repo} environment ${ADMIN_ENVIRONMENT}: variable LITELLM_URL and secret LITELLM_MASTER_KEY.`);
  }
  const installer = await writeInstaller({ gateway: litellmUrl, output: options.installerFile });
  log([
    '',
    `LiteLLM:      ${litellmUrl}`,
    `Admin UI:     ${litellmUrl}/ui/ (user admin, password = litellmMasterKey in ${secretsFile})`,
    `Egress IP:    ${outputs?.egressIp === '' ? 'not static (the poc size has no NAT gateway)' : outputs?.egressIp ?? 'unknown'}`,
    `Resources:    ${outputs?.resourceGroupName ?? resourceGroup}`,
    '',
    describeInstaller(installer),
    '',
    'Next: enroll employees from GitHub Actions > CCGC employee access.',
  ].join('\n'));
  return { deployed: true, resourceGroup, secretsFile, litellmUrl, repo, models: catalog.models, installer };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  await deploy(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
