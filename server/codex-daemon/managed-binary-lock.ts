import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

const lockName = '.project-space-provision.lock';
const lockOwnerSchema = 'project-space.managed-codex-lock/v1';
const tokenPattern = /^[0-9a-f]{32}$/;

interface LockOwner {
  pid: number;
  schema: typeof lockOwnerSchema;
  token: string;
}

async function optionalLstat(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
}

async function syncDirectory(path: string) {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isLockOwner(value: unknown): value is LockOwner {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join('\n') === ['pid', 'schema', 'token'].join('\n') &&
    Number.isSafeInteger(record.pid) && Number(record.pid) > 0 &&
    record.schema === lockOwnerSchema && typeof record.token === 'string' &&
    tokenPattern.test(record.token);
}

async function readOwner(path: string) {
  const status = await optionalLstat(path);
  if (!status) return undefined;
  if (!status.isFile() || status.isSymbolicLink() || status.size < 1 ||
      status.size > 1_024 || (status.mode & 0o077) !== 0) {
    throw new Error('The managed Codex repair lock owner is unsafe.');
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('The managed Codex repair lock owner is invalid.');
  }
  if (!isLockOwner(value)) {
    throw new Error('The managed Codex repair lock owner is invalid.');
  }
  return value;
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function reclaimDeadLock(root: string, lock: string, ownerPath: string) {
  let owner = await readOwner(ownerPath);
  if (!owner) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    owner = await readOwner(ownerPath);
  }
  if (owner && processIsAlive(owner.pid)) {
    throw new Error('Another managed Codex repair is already in progress.');
  }
  const quarantine = join(
    root,
    `.project-space-stale-lock-${randomBytes(8).toString('hex')}`
  );
  try {
    await rename(lock, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await rm(quarantine, { recursive: true });
  await syncDirectory(root);
}

async function acquireLock(root: string) {
  const lock = join(root, lockName);
  const ownerPath = join(lock, 'owner.json');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const status = await lstat(lock);
      if (!status.isDirectory() || status.isSymbolicLink() || (status.mode & 0o077) !== 0) {
        throw new Error('The managed Codex repair lock is unsafe.');
      }
      await reclaimDeadLock(root, lock, ownerPath);
      continue;
    }
    const owner: LockOwner = {
      pid: process.pid,
      schema: lockOwnerSchema,
      token: randomBytes(16).toString('hex')
    };
    try {
      const handle = await open(ownerPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(lock);
      await syncDirectory(root);
      return { lock, owner, ownerPath };
    } catch (error) {
      await rm(lock, { force: true, recursive: true }).catch(() => undefined);
      throw error;
    }
  }
  throw new Error('The managed Codex repair lock could not be acquired.');
}

export async function withManagedCodexRepairLock<Result>(
  root: string,
  action: () => Promise<Result>
) {
  const acquired = await acquireLock(root);
  try {
    return await action();
  } finally {
    const owner = await readOwner(acquired.ownerPath);
    if (!owner || owner.token !== acquired.owner.token || owner.pid !== process.pid) {
      throw new Error('The managed Codex repair lock ownership changed.');
    }
    await rm(acquired.lock, { recursive: true });
    await syncDirectory(root);
  }
}
