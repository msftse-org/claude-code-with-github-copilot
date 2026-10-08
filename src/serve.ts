#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpath } from 'node:fs/promises';
import { readPrivate, readState, writePrivate } from './private-state.ts';
import { LiteLLMBackend } from './litellm.ts';
import { startRemoteServer } from './remote-server.ts';
import { remoteInfo, REMOTE_PROFILE } from './remote.ts';
import { BridgeError, parseJson, text, safeError } from './protocol.ts';

const exec = promisify(execFile);
export async function main() {
  const directory = process.env.CCGC_STATE_DIR ?? '/state';
  const deployment = parseJson(await readPrivate(join(directory, 'deployment.json')));
  const publicUrl = text(deployment.publicUrl, 'public URL');
  const python = process.env.CCGC_PYTHON ?? '/app/server/.venv/bin/python';
  const script = fileURLToPath(new URL('../server/bootstrap.py', import.meta.url));
  const shutdown = new AbortController();
  const verify = async () => {
    let stdout: string;
    try {
      ({ stdout } = await exec(python, [script, 'verify', '--state', directory], { timeout: 25_000, maxBuffer: 65536, signal: shutdown.signal }));
    } catch {
      throw new BridgeError('METADATA_VERIFICATION_FAILED', 'Operator metadata verification failed. Check bootstrap verify, protected state, and the installed Python runtime; no inference was attempted.', 503);
    }
    return remoteInfo({ ...parseJson(stdout), profile: REMOTE_PROFILE, instance: 'verified-at-startup' });
  };
  const server = await startRemoteServer({
    publicUrl, ownerKey: (await readPrivate(join(directory, 'owner.key'))).trim(),
    backend: new LiteLLMBackend(process.env.CCGC_LITELLM_URL ?? 'http://litellm:4000', (await readPrivate(join(directory, 'litellm.key'))).trim()),
    verify,
    ownerIsRevoked: async () => (await readState(join(directory, 'owner.revoked')))?.revoked === true,
    revokeOwner: () => writePrivate(join(directory, 'owner.revoked'), { revoked: true }),
    onError: error => console.error(JSON.stringify({
      code: error.code, status: error.status, ...(error.status >= 500 ? { message: error.message } : {}),
    })),
    host: process.env.CCGC_BIND_HOST ?? '127.0.0.1', port: 8080,
  });
  console.log(JSON.stringify({ status: 'listening', publicUrl, profile: REMOTE_PROFILE, liveInference: 'not-verified-by-startup' }));
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    shutdown.abort();
    void server.close().catch(error => { console.error(safeError(error).code); process.exitCode = 1; });
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  main().catch(error => { const failure = safeError(error); console.error(`${failure.code}: ${failure.message}`); process.exitCode = 1; });
}
