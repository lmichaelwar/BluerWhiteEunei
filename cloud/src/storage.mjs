import { mkdir, readFile, writeFile, rename, lstat, chmod, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const defaultDataDir = process.env.EUNNEI_DATA_DIR || join(homedir(), '.config', 'eunnei');

export async function secureDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if ((await lstat(path)).isSymbolicLink()) throw new Error('Credential directory must not be a symlink');
  await chmod(path, 0o700);
}

export async function readJSON(path) {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Credential file must not be a symlink');
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function writeJSON(path, value) {
  await secureDirectory(dirname(path));
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error('Credential file must not be a symlink'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
    await chmod(path, 0o600);
  } finally { await unlink(temp).catch(() => {}); }
}

export async function hostId(dataDir) {
  await secureDirectory(dataDir);
  const path = join(dataDir, 'host.json');
  const existing = await readJSON(path);
  if (existing?.ext_agent_host_id) return existing.ext_agent_host_id;
  const id = `urn:uuid:${randomUUID()}`;
  await writeJSON(path, { ext_agent_host_id: id });
  return id;
}
