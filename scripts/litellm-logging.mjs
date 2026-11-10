import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { configurePromptStorage, litellmOrigin, parsePromptStorage } from './litellm-bootstrap.mjs';

export const USAGE = `Usage: npm run logging -- --gateway <https-origin> --secrets-file <private-json-file> --store-prompts-in-spend-logs <true|false>

Updates only LiteLLM's PostgreSQL-backed prompt logging settings, then reads
them back. Uses litellmMasterKey from the existing deployment secrets file;
never pass a key on the command line. Does not redeploy Azure or rotate secrets.
true stores new request/response content, which can contain source code and
sensitive data. false stops future storage after replicas sync; existing logs
and backups are not deleted. Normal spend metadata remains available.
`;

export function parseLoggingOptions(argv) {
  const { values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
    gateway: { type: 'string' },
    'secrets-file': { type: 'string' },
    'store-prompts-in-spend-logs': { type: 'string' },
    help: { type: 'boolean', default: false },
  } });
  if (values.help) return { help: true };
  const enabled = parsePromptStorage(values['store-prompts-in-spend-logs']);
  if (!values.gateway || !values['secrets-file'] || enabled === undefined) {
    throw new Error(`--gateway, --secrets-file, and --store-prompts-in-spend-logs are required.\n${USAGE}`);
  }
  return { litellmUrl: litellmOrigin(values.gateway), secretsFile: resolve(values['secrets-file']), enabled };
}

export async function configureLogging(options, { fetcher = fetch } = {}) {
  const info = await lstat(options.secretsFile);
  if (!info.isFile() || (info.mode & 0o077) !== 0) {
    throw new Error('The secrets file must be a regular private file (chmod 600); symlinks are not accepted.');
  }
  let secrets;
  try { secrets = JSON.parse(await readFile(options.secretsFile, 'utf8')); }
  catch { throw new Error('Could not read a valid deployment secrets JSON file.'); }
  return configurePromptStorage({ litellmUrl: options.litellmUrl, masterKey: secrets?.litellmMasterKey,
    enabled: options.enabled, fetcher });
}

async function main() {
  const options = parseLoggingOptions(process.argv.slice(2));
  if (options.help) { process.stdout.write(USAGE); return; }
  const result = await configureLogging(options);
  console.log(`PostgreSQL prompt/response storage ${result.storePromptsInSpendLogs ? 'enabled' : 'disabled'}; configuration read back successfully.`);
  console.log('Allow replicas to sync, then verify a new request in LiteLLM Logs. Existing logs and backups are unchanged.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
}
