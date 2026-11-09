import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { litellmOrigin } from './litellm-bootstrap.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EMPLOYEE_SCRIPT = join(REPO_ROOT, 'scripts', 'ccgc-enterprise-macos.sh');
const ADMIN_ENVIRONMENT = 'ccgc-admin';
const PLACEHOLDER = /^DEFAULT_GATEWAY=''$/gm;
const execFileAsync = promisify(execFile);

export const DEFAULT_INSTALLER = join(REPO_ROOT, 'dist', 'ccgc-enterprise-setup.command');

export const USAGE = `Usage: npm run installer -- [--gateway <https-origin>] [--github-repo <owner/repo>] [--output <path>]

Builds the employee setup file: scripts/ccgc-enterprise-macos.sh with this
deployment's LiteLLM URL built in, so employees run it without arguments.
Without --gateway, reads LITELLM_URL from the ccgc-admin GitHub environment
that deploy.mjs configures. Prints the file's SHA-256 for verification.
Rebuild it after updating the repository so employees get the current script.

Options:
  --gateway <url>        LiteLLM HTTPS origin (default: the ccgc-admin LITELLM_URL variable)
  --github-repo <o/r>    Repository with the ccgc-admin environment (default: this checkout's repository)
  --output <path>        File to write (default: dist/ccgc-enterprise-setup.command)
`;

function fail(message) {
  throw new Error(message);
}

async function runCommand(command, args) {
  const { stdout } = await execFileAsync(command, args, { encoding: 'utf8' });
  return stdout.trim();
}

// The URL is written into shell code, so accept only what the employee script's validate_gateway accepts.
export function installerGateway(value) {
  const origin = litellmOrigin(value);
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?$/.test(origin)) {
    fail('The LiteLLM URL must be an HTTPS origin with a DNS host name.');
  }
  return origin;
}

export function stampGateway(scriptText, gateway) {
  const origin = installerGateway(gateway);
  const text = scriptText.replace(/\r\n/g, '\n');
  if ((text.match(PLACEHOLDER) ?? []).length !== 1) {
    fail('The employee script must contain exactly one empty DEFAULT_GATEWAY line.');
  }
  return text.replace(PLACEHOLDER, () => `DEFAULT_GATEWAY='${origin}'`);
}

export async function readDeployedGateway(githubRepo, run = runCommand) {
  const repo = githubRepo ?? await run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
  let value;
  try {
    value = await run('gh', ['variable', 'get', 'LITELLM_URL', '--env', ADMIN_ENVIRONMENT, '--repo', repo]);
  } catch (error) {
    fail(`Could not read LITELLM_URL from the ${ADMIN_ENVIRONMENT} environment of ${repo}; pass --gateway. `
      + `${error instanceof Error ? error.message.trim() : String(error)}`);
  }
  return installerGateway(value);
}

export async function writeInstaller({ gateway, output = DEFAULT_INSTALLER, script = EMPLOYEE_SCRIPT }) {
  const origin = installerGateway(gateway);
  const text = stampGateway(await readFile(script, 'utf8'), origin);
  const path = resolve(output);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, text, { flag: 'wx', mode: 0o700 });
    await chmod(temporary, 0o700);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return { path, gateway: origin, sha256: createHash('sha256').update(text).digest('hex') };
}

export async function buildInstaller(options, { run = runCommand } = {}) {
  const gateway = options.gateway ?? await readDeployedGateway(options.githubRepo, run);
  return writeInstaller({ gateway, output: options.output });
}

export function describeInstaller(installer) {
  return [
    `Employee setup file for ${installer.gateway}:`,
    `  ${installer.path}`,
    `  SHA-256 ${installer.sha256}`,
    'Send it with the employee\'s personal key. The employee saves it in Downloads and runs:',
    `  bash "$HOME/Downloads/${basename(installer.path)}"`,
  ].join('\n');
}

export function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      gateway: { type: 'string' },
      'github-repo': { type: 'string' },
      output: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) return { help: true };
  const githubRepo = values['github-repo'];
  if (githubRepo !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubRepo)) {
    fail('--github-repo must be owner/repository.');
  }
  return {
    gateway: values.gateway === undefined ? undefined : installerGateway(values.gateway),
    githubRepo,
    output: resolve(values.output ?? DEFAULT_INSTALLER),
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if ('help' in options) {
    process.stdout.write(USAGE);
    return;
  }
  process.stdout.write(`${describeInstaller(await buildInstaller(options))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
