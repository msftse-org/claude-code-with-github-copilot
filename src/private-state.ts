import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeError, parseJson } from './protocol.ts';
import type { ObjectValue } from './protocol.ts';

export async function readPrivate(path: string): Promise<string> {
  const directory = await lstat(dirname(path));
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077)
    || (process.getuid && directory.uid !== process.getuid())) throw new BridgeError('CREDENTIAL_STORE_UNSAFE', 'State directory must be private and owned by you.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) || info.size > 65536 || (process.getuid && info.uid !== process.getuid())) {
      throw new BridgeError('CREDENTIAL_STORE_UNSAFE', 'State file must be private, bounded, and owned by you.');
    }
    return await file.readFile('utf8');
  } finally { await file.close(); }
}

export async function writePrivate(path: string, value: ObjectValue): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const directory = await lstat(dirname(path));
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077)
    || (process.getuid && directory.uid !== process.getuid())) throw new BridgeError('CREDENTIAL_STORE_UNSAFE', 'State directory must be private and owned by you.');
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(value, null, 2) + '\n');
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, path);
  }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export async function readState(path: string): Promise<ObjectValue | undefined> {
  try { return parseJson(await readPrivate(path)); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}
