#!/usr/bin/env node
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { DefaultAzureCredential } from '@azure/identity';
import { BridgeError, object, parseJson, positive, safeError, text, type ObjectValue } from './protocol.ts';

type Command = 'status' | 'create-user' | 'connect' | 'link' | 'revoke';

function usage(): never {
  throw new BridgeError(
    'INVALID_OPTIONS',
    'Usage: enterprise:manage <status|create-user|connect|link|revoke> --url <broker-https-url> --audience <app-id-uri> [--input <0600-json>] [--output <new-json>]',
  );
}

function fixedUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new BridgeError('INVALID_OPTIONS', 'Broker URL must be a fixed HTTPS URL.');
  }
  return url.origin;
}

async function privateJson(path: string): Promise<ObjectValue> {
  const stat = await lstat(path);
  const uid = process.getuid?.();
  if (uid === undefined || !stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
    throw new BridgeError('INVALID_OPTIONS', 'Input must be a user-owned, non-symlink regular file with mode 0600.');
  }
  return object(parseJson(await readFile(path, 'utf8')));
}

async function writePrivate(path: string, value: unknown): Promise<void> {
  const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
}

function argumentsFrom(argv: string[]) {
  const command = argv[0] as Command;
  if (!['status', 'create-user', 'connect', 'link', 'revoke'].includes(command)) usage();
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || !value) usage();
    values.set(flag, value);
  }
  const url = values.get('--url');
  const audience = values.get('--audience');
  if (!url || !audience) usage();
  return {
    command,
    url: fixedUrl(url),
    audience,
    input: values.get('--input'),
    output: values.get('--output'),
  };
}

const options = argumentsFrom(process.argv.slice(2));
const input = options.command === 'status'
  ? {}
  : options.input ? await privateJson(options.input) : usage();
const credential = new DefaultAzureCredential();
const token = await credential.getToken(`${options.audience.replace(/\/+$/, '')}/.default`);
if (!token?.token) throw new BridgeError('AUTHENTICATION_FAILED', 'Could not acquire an administrator access token.');

async function request(path: string, value: ObjectValue): Promise<ObjectValue> {
  const response = await fetch(`${options.url}${path}`, {
    method: 'POST',
    headers: {
      authorization: ['Bearer', token.token].join(' '),
      'content-type': 'application/json',
    },
    body: JSON.stringify(value),
    redirect: 'error',
    signal: AbortSignal.timeout(35_000),
  });
  const raw = await response.text();
  if (!response.ok) {
    const error = parseJson(raw);
    throw new BridgeError('ADMIN_REQUEST_FAILED', `Broker administration route returned HTTP ${response.status}: ${JSON.stringify(error)}`, response.status);
  }
  return parseJson(raw);
}

async function execute(): Promise<ObjectValue> {
  if (options.command === 'status') return request('/ccgc/admin/status', {});
  if (options.command === 'create-user') {
    if (!options.output) usage();
    const created = await request('/ccgc/admin/users', input);
    await writePrivate(options.output, created);
    return { status: 'created', output: options.output };
  }
  if (options.command === 'link') return request('/ccgc/admin/link', input);
  if (options.command === 'revoke') return request('/ccgc/admin/revoke', input);

  const started = await request('/ccgc/admin/connections/start', input);
  if (started.status === 'connected') return started;
  const verificationUri = text(started.verificationUri, 'verification URI');
  const userCode = text(started.userCode, 'device code');
  const flowHandle = text(started.flowHandle, 'flow handle');
  const expiresIn = positive(started.expiresIn, 'device flow expiry');
  let interval = positive(started.interval, 'device flow interval');
  console.error(`Open ${verificationUri} and enter code ${userCode}.`);
  const deadline = Date.now() + expiresIn * 1000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, interval * 1000));
    const polled = await request('/ccgc/admin/connections/poll', { ...input, flowHandle });
    if (polled.status === 'connected') return polled;
    if (polled.status === 'slow_down') interval = Math.max(interval + 5, Number(polled.interval ?? 0));
    else if (polled.status !== 'pending') {
      throw new BridgeError('GITHUB_AUTHORIZATION_FAILED', `GitHub authorization ended with status ${String(polled.status)}.`);
    }
  }
  throw new BridgeError('GITHUB_AUTHORIZATION_EXPIRED', 'GitHub device authorization expired.');
}

try {
  console.log(JSON.stringify(await execute(), null, 2));
} catch (error) {
  const failure = safeError(error);
  console.error(`${failure.code}: ${failure.message}`);
  process.exitCode = 1;
}
