import { spawn } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { bootstrapLiteLLM, DEFAULT_MODELS, litellmOrigin, validateModels } from './litellm-bootstrap.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = join(REPO_ROOT, 'infra', 'main.bicep');
const ADMIN_ENVIRONMENT = 'ccgc-admin';
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export const USAGE = `Usage: node scripts/deploy.mjs --subscription <id> [options]

Without --confirm-deploy, previews the Azure changes (what-if) and changes nothing.
With --confirm-deploy, deploys LiteLLM, registers the GitHub Copilot models, and
stores LITELLM_URL and LITELLM_MASTER_KEY in the ccgc-admin GitHub environment.
Re-running is safe; it reuses the private secrets file.

Options:
  --subscription <id>    Azure subscription ID (required)
  --prefix <name>        Resource prefix (default: ccgc-pilot)
  --location <region>    Azure region (default: swedencentral)
  --name-seed <seed>     Seed for globally unique names (default: litellm)
  --models <list>        Comma-separated model IDs (default: ${DEFAULT_MODELS.join(',')})
  --secrets-file <path>  Private secrets file (default: ~/.config/ccgc/<subscription>/<prefix>.json)
  --github-repo <o/r>    Repository with the ccgc-admin environment (default: this checkout's repository)
  --skip-github          Do not configure the GitHub environment
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
      prefix: { type: 'string', default: 'ccgc-pilot' },
      location: { type: 'string', default: 'swedencentral' },
      'name-seed': { type: 'string', default: 'litellm' },
      models: { type: 'string' },
      'secrets-file': { type: 'string' },
      'github-repo': { type: 'string' },
      'skip-github': { type: 'boolean', default: false },
      'confirm-deploy': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) return { help: true };
  const subscription = values.subscription ?? '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(subscription)) {
    fail(`--subscription must be an Azure subscription ID.\n\n${USAGE}`);
  }
  if (!/^[a-z][a-z0-9-]{2,15}$/.test(values.prefix)) fail('--prefix must be 3-16 lowercase letters, digits, or hyphens.');
  if (!/^[a-z0-9]{2,40}$/.test(values.location)) fail('--location must be an Azure region name such as swedencentral.');
  if (!/^[a-z0-9-]{1,16}$/.test(values['name-seed'])) fail('--name-seed must be 1-16 lowercase letters, digits, or hyphens.');
  const githubRepo = values['github-repo'];
  if (githubRepo !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubRepo)) {
    fail('--github-repo must be owner/repository.');
  }
  return {
    subscription: subscription.toLowerCase(),
    prefix: values.prefix,
    location: values.location,
    nameSeed: values['name-seed'],
    models: validateModels(values.models === undefined ? [...DEFAULT_MODELS] : values.models.split(',').map(model => model.trim())),
    secretsFile: values['secrets-file'] === undefined ? undefined : resolve(values['secrets-file']),
    githubRepo,
    skipGithub: values['skip-github'],
    confirmDeploy: values['confirm-deploy'],
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

export function runCommand(command, args, { input, inherit = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
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

  const resourceGroup = `rg-${options.prefix}-enterprise`;
  const groupExists = await run('az', ['group', 'exists', '--name', resourceGroup, '--subscription', options.subscription]);
  const secretsFile = options.secretsFile ?? join(homedir(), '.config', 'ccgc', options.subscription, `${options.prefix}.json`);
  const { secrets, created } = await loadOrCreateSecrets(secretsFile, { resourceGroupExists: groupExists === 'true' });
  log(created
    ? `Created ${secretsFile}. Back it up privately; the salt key in it must never change.`
    : `Using ${secretsFile}.`);

  const directory = await mkdtemp(join(tmpdir(), 'ccgc-deploy-'));
  const parameterFile = join(directory, 'parameters.json');
  let outputs;
  try {
    await writeFile(parameterFile, JSON.stringify({
      $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#',
      contentVersion: '1.0.0.0',
      parameters: {
        prefix: { value: options.prefix },
        location: { value: options.location },
        nameSeed: { value: options.nameSeed },
        postgresAdminPassword: { value: secrets.postgresAdminPassword },
        litellmMasterKey: { value: secrets.litellmMasterKey },
        litellmSaltKey: { value: secrets.litellmSaltKey },
      },
    }), { flag: 'wx', mode: 0o600 });
    const deployment = [
      '--name', `${options.prefix}-litellm-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`,
      '--location', options.location,
      '--template-file', TEMPLATE,
      '--parameters', `@${parameterFile}`,
      '--subscription', options.subscription,
    ];
    if (!options.confirmDeploy) {
      await run('az', ['deployment', 'sub', 'what-if', ...deployment], { inherit: true });
      log('What-if only; nothing changed. Review the changes and cost, then re-run with --confirm-deploy.');
      return { deployed: false, resourceGroup, secretsFile };
    }
    log(`Deploying ${resourceGroup}. A new zone-redundant PostgreSQL server can take 20-30 minutes.`);
    outputs = JSON.parse(await run('az', ['deployment', 'sub', 'create', ...deployment,
      '--query', 'properties.outputs', '--output', 'json']));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const litellmUrl = litellmOrigin(outputs?.litellmUrl?.value ?? '');
  log(`Waiting for ${litellmUrl}/health/readiness ...`);
  const readiness = await waitForReadiness(litellmUrl, { fetcher, sleep });
  log(`LiteLLM ${readiness.litellm_version ?? ''} is ready and connected to PostgreSQL.`);
  const catalog = await bootstrap({ litellmUrl, masterKey: secrets.litellmMasterKey, models: options.models, fetcher, sleep });
  log(`Credential github-copilot-user ${catalog.createdCredential ? 'created' : 'verified'}; models: ${catalog.models.join(', ')}.`);

  let repo;
  if (!options.skipGithub) {
    repo = options.githubRepo ?? await run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
    await configureGitHub(run, repo, litellmUrl, secrets.litellmMasterKey);
    log(`Configured ${repo} environment ${ADMIN_ENVIRONMENT}: variable LITELLM_URL and secret LITELLM_MASTER_KEY.`);
  }
  log([
    '',
    `LiteLLM:      ${litellmUrl}`,
    `Admin UI:     ${litellmUrl}/ui/ (user admin, password = litellmMasterKey in ${secretsFile})`,
    `Egress IP:    ${outputs?.egressIp?.value ?? 'unknown'}`,
    `Resources:    ${outputs?.resourceGroupName?.value ?? resourceGroup}`,
    'Next: enroll employees from GitHub Actions > CCGC employee access.',
  ].join('\n'));
  return { deployed: true, resourceGroup, secretsFile, litellmUrl, repo, models: catalog.models };
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
