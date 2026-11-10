import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_INSTALLER, describeInstaller, installerGateway, readDeployedGateway, writeInstaller } from './build-installer.mjs';
import { manageEmployeeAccess } from './enterprise-actions-access.mjs';

const SUBSCRIPTION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DEFAULT_CONFIG_ROOT = join(homedir(), '.config', 'ccgc');

export const USAGE = `Usage: npm run access -- <enroll|revoke> <github-login> [options]

Enrolls or revokes an employee from your computer, like the CCGC employee
access workflow but without GitHub Actions. Reads the LiteLLM master key from
the private secrets file that deploy.mjs wrote, and the gateway from the
ccgc-admin LITELLM_URL variable. Enroll prints the employee's 90-day key and
writes the employee setup file; revoke deletes the employee's LiteLLM user,
keys, and Copilot connection.

Options:
  --prefix <name>        Deployment prefix (default: ccgc-pilot)
  --subscription <id>    Azure subscription ID; reads ~/.config/ccgc/<subscription>/<prefix>.json
                         (default: the only subscription with a secrets file for the prefix)
  --secrets-file <path>  Private secrets file to read instead
  --gateway <url>        LiteLLM HTTPS origin (default: the ccgc-admin LITELLM_URL variable)
  --github-repo <o/r>    Repository with the ccgc-admin environment (default: this checkout's repository)
  --installer <path>     Employee setup file to write on enroll (default: dist/ccgc-enterprise-setup.command)
`;

function fail(message) {
  throw new Error(message);
}

export function parseOptions(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: true,
    options: {
      prefix: { type: 'string', default: 'ccgc-pilot' },
      subscription: { type: 'string' },
      'secrets-file': { type: 'string' },
      gateway: { type: 'string' },
      'github-repo': { type: 'string' },
      installer: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) return { help: true };
  const [action, githubLogin, ...extra] = positionals;
  if (action !== 'enroll' && action !== 'revoke') fail(`Choose enroll or revoke.\n\n${USAGE}`);
  if (githubLogin === undefined || extra.length > 0) fail(`Pass exactly one GitHub username.\n\n${USAGE}`);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(githubLogin)) {
    fail(`${githubLogin} is not a valid GitHub username.`);
  }
  if (!/^[a-z][a-z0-9-]{2,15}$/.test(values.prefix)) fail('--prefix must be 3-16 lowercase letters, digits, or hyphens.');
  const subscription = values.subscription;
  if (subscription !== undefined && !SUBSCRIPTION.test(subscription)) {
    fail('--subscription must be an Azure subscription ID.');
  }
  if (subscription !== undefined && values['secrets-file'] !== undefined) {
    fail('Pass --subscription or --secrets-file, not both.');
  }
  const githubRepo = values['github-repo'];
  if (githubRepo !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubRepo)) {
    fail('--github-repo must be owner/repository.');
  }
  return {
    action,
    githubLogin,
    prefix: values.prefix,
    subscription: subscription?.toLowerCase(),
    secretsFile: values['secrets-file'] === undefined ? undefined : resolve(values['secrets-file']),
    gateway: values.gateway === undefined ? undefined : installerGateway(values.gateway),
    githubRepo,
    installerFile: resolve(values.installer ?? DEFAULT_INSTALLER),
  };
}

export async function findSecretsFile({ prefix, subscription, secretsFile }, configRoot = DEFAULT_CONFIG_ROOT) {
  if (secretsFile !== undefined) return secretsFile;
  if (subscription !== undefined) return join(configRoot, subscription, `${prefix}.json`);
  let entries = [];
  try {
    entries = await readdir(configRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SUBSCRIPTION.test(entry.name)) continue;
    const path = join(configRoot, entry.name, `${prefix}.json`);
    if ((await stat(path).catch(() => undefined))?.isFile()) matches.push(path);
  }
  if (matches.length === 0) {
    fail(`No secrets file for prefix ${prefix} under ${configRoot}. Pass --prefix, --subscription, or --secrets-file.`);
  }
  if (matches.length > 1) {
    fail(`Several subscriptions have a secrets file for prefix ${prefix}; pass --subscription:\n  ${matches.join('\n  ')}`);
  }
  return matches[0];
}

export async function readMasterKey(path) {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') fail(`Secrets file ${path} does not exist.`);
    throw error;
  }
  if ((info.mode & 0o077) !== 0) fail(`${path} must be readable only by you (chmod 600 it).`);
  let value;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    fail(`${path} is not valid JSON.`);
  }
  const key = value?.litellmMasterKey;
  if (typeof key !== 'string' || !/^sk-[A-Za-z0-9._-]{16,}$/.test(key)) {
    fail(`${path} does not contain a valid litellmMasterKey.`);
  }
  return key;
}

export async function runAccess(options, { fetcher = fetch, run, configRoot } = {}) {
  const secretsFile = await findSecretsFile(options, configRoot);
  const masterKey = await readMasterKey(secretsFile);
  const gateway = options.gateway ?? await readDeployedGateway(options.githubRepo, run);
  // Build the setup file before issuing a key so a failed build leaves LiteLLM unchanged.
  const installer = options.action === 'enroll'
    ? await writeInstaller({ gateway, output: options.installerFile })
    : undefined;
  const result = await manageEmployeeAccess({
    action: options.action,
    githubLogin: options.githubLogin,
    litellmUrl: gateway,
    masterKey,
    fetcher,
  });
  return { secretsFile, installer, result };
}

export function describeAccess({ installer, result }) {
  if (result.action === 'revoke') {
    return result.deleted > 0
      ? `Revoked ${result.githubLogin}: deleted their LiteLLM user, keys, and Copilot connection. `
        + 'Claude Code stops working on its next request.'
      : `${result.githubLogin} has no LiteLLM user; nothing to revoke.`;
  }
  return [
    `Enrolled ${result.githubLogin} (${result.reusedUser ? 'existing' : 'new'} LiteLLM user).`,
    `Personal LiteLLM key, expires ${result.expiresAt}:`,
    '',
    `  ${result.key}`,
    '',
    `Models: ${result.models.join(', ')}`,
    '',
    describeInstaller(installer),
    '',
    'The employee pastes the key when prompted and approves GitHub with their Copilot account.',
    'Send the key privately and clear this terminal: anyone with the key can use it until it',
    'expires or is revoked. Enroll again to renew it.',
  ].join('\n');
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if ('help' in options) {
    process.stdout.write(USAGE);
    return;
  }
  const outcome = await runAccess(options);
  process.stdout.write(`Using ${outcome.secretsFile}.\n${describeAccess(outcome)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
