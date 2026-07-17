import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, rm, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';

import type { CodexOperationSnapshot } from './contracts';
import type { CodexOperationSnapshotPersist } from './operation-ledger';

export const codexOperationSnapshotFileEnvironment =
  'PROJECT_CODEX_OPERATION_SNAPSHOT_FILE';

const snapshotFileName = 'codex-operations.json';
const recordsDirectoryName = 'codex-operation-records';
const snapshotSchema = 'project-space.codex-operation-journal/v2';
const maximumRecordBytes = 4 * 1024 * 1024;
const recordFilePattern = /^[a-f0-9]{64}\.json$/;
const temporaryRecordPattern = /^\.codex-operation-[a-f0-9]{24}\.tmp$/;

type SnapshotManifest = {
  machineId: string;
  schema: typeof snapshotSchema;
};

export function createCodexOperationSnapshotPersistence(
  environment: Record<string, string | undefined> = process.env,
  machineId?: string
): { persist: CodexOperationSnapshotPersist; snapshot: CodexOperationSnapshot } {
  const configuredPath = environment[codexOperationSnapshotFileEnvironment];
  if (!configuredPath) return { persist: async () => {}, snapshot: [] };
  if (!machineId) throw new Error('The Codex operation journal requires a machine identity.');

  const manifestPath = validateSnapshotPath(configuredPath);
  const recordsPath = join(dirname(manifestPath), recordsDirectoryName);
  const loaded = readSnapshot(manifestPath, recordsPath, machineId);
  const snapshot = loaded.snapshot;
  let previous = encodeRecords(snapshot);
  let manifestReady = pathExists(manifestPath) && !loaded.identityChanged;
  let resetRequired = loaded.identityChanged;
  let writeTail = Promise.resolve();
  return {
    persist(nextSnapshot) {
      const next = encodeRecords(nextSnapshot);
      const write = writeTail.then(async () => {
        await ensurePrivateDirectory(dirname(manifestPath));
        if (resetRequired) {
          await resetJournal(manifestPath, recordsPath);
          previous = new Map();
          resetRequired = false;
        }
        if (!manifestReady) {
          await publishPrivateFile(manifestPath, encodeManifest(machineId));
          await syncDirectory(dirname(manifestPath));
          manifestReady = true;
        }
        await ensurePrivateDirectory(recordsPath);
        await syncDirectory(dirname(recordsPath));
        await removeStaleTemporaryRecords(recordsPath);
        for (const [name, document] of next) {
          if (previous.get(name) !== document) {
            await publishPrivateFile(join(recordsPath, name), document);
          }
        }
        for (const name of previous.keys()) {
          if (!next.has(name)) await unlink(join(recordsPath, name)).catch(ignoreMissing);
        }
        await syncDirectory(recordsPath);
        previous = next;
      });
      writeTail = write.catch(() => undefined);
      return write;
    },
    snapshot
  };
}

function validateSnapshotPath(value: string) {
  if (value !== value.trim() || !isAbsolute(value) || basename(value) !== snapshotFileName) {
    throw new Error(
      `${codexOperationSnapshotFileEnvironment} must be an absolute path ending in ${snapshotFileName}.`
    );
  }
  return value;
}

function readSnapshot(manifestPath: string, recordsPath: string, machineId: string): {
  identityChanged: boolean;
  snapshot: CodexOperationSnapshot;
} {
  if (!pathExists(manifestPath)) {
    if (pathExists(recordsPath)) {
      throw new Error('The Codex operation journal has records without an identity manifest.');
    }
    return { identityChanged: false, snapshot: [] };
  }
  const manifest = readPrivateJson(manifestPath) as Partial<SnapshotManifest>;
  if (
    manifest.schema !== snapshotSchema ||
    typeof manifest.machineId !== 'string' ||
    Object.keys(manifest).some((key) => key !== 'machineId' && key !== 'schema')
  ) {
    throw new Error('The Codex operation journal identity manifest is invalid.');
  }
  if (manifest.machineId !== machineId) {
    return { identityChanged: true, snapshot: [] };
  }
  if (!pathExists(recordsPath)) return { identityChanged: false, snapshot: [] };
  const recordsStatus = lstatSync(recordsPath);
  if (!recordsStatus.isDirectory() || recordsStatus.isSymbolicLink()) {
    throw new Error('The Codex operation journal records path must be a directory.');
  }
  requirePrivateMode(recordsStatus.mode, 'journal records directory');
  return { identityChanged: false, snapshot: readdirSync(recordsPath).flatMap((name) => {
    if (temporaryRecordPattern.test(name)) {
      requirePrivateFile(join(recordsPath, name));
      return [];
    }
    if (!recordFilePattern.test(name)) {
      throw new Error('The Codex operation journal contains an unexpected file.');
    }
    const entry = readPrivateJson(join(recordsPath, name)) as CodexOperationSnapshot[number];
    if (recordFileName(entry.operationId) !== name) {
      throw new Error('The Codex operation journal record identity is invalid.');
    }
    return [entry];
  }) };
}

function readPrivateJson(path: string) {
  const status = requirePrivateFile(path);
  if (status.size > maximumRecordBytes) {
    throw new Error('A Codex operation journal entry exceeds its size limit.');
  }
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function requirePrivateFile(path: string) {
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error('The Codex operation journal entry must be a regular file.');
  }
  requirePrivateMode(status.mode, 'journal entry');
  return status;
}

function encodeManifest(machineId: string) {
  return `${JSON.stringify({ machineId, schema: snapshotSchema })}\n`;
}

function encodeRecords(snapshot: CodexOperationSnapshot) {
  const records = new Map<string, string>();
  for (const entry of snapshot) {
    const name = recordFileName(entry.operationId);
    if (records.has(name)) throw new Error('The Codex operation journal has duplicate records.');
    const document = `${JSON.stringify(entry)}\n`;
    if (Buffer.byteLength(document) > maximumRecordBytes) {
      throw new Error('A Codex operation journal entry exceeds its size limit.');
    }
    records.set(name, document);
  }
  return records;
}

function recordFileName(operationId: string) {
  return `${createHash('sha256').update(operationId, 'utf8').digest('hex')}.json`;
}

async function publishPrivateFile(path: string, document: string) {
  await rejectUnsafeExistingFile(path);
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.codex-operation-${randomBytes(12).toString('hex')}.tmp`
  );
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(document, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    if (process.platform !== 'win32') await chmod(path, 0o600);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function ensurePrivateDirectory(path: string) {
  await mkdir(path, { mode: 0o700, recursive: true });
  const status = await lstat(path);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error('The Codex operation journal path must be a regular directory.');
  }
  if (process.platform !== 'win32') await chmod(path, 0o700);
}

async function rejectUnsafeExistingFile(path: string) {
  try {
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new Error('The Codex operation journal entry must be a regular file.');
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function resetJournal(manifestPath: string, recordsPath: string) {
  if (pathExists(recordsPath)) {
    const status = await lstat(recordsPath);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new Error('The old Codex operation journal records path is unsafe.');
    }
    await rm(recordsPath, { recursive: true });
  }
  await unlink(manifestPath).catch(ignoreMissing);
  await syncDirectory(dirname(manifestPath));
}

async function removeStaleTemporaryRecords(recordsPath: string) {
  for (const name of await readdir(recordsPath)) {
    if (temporaryRecordPattern.test(name)) {
      await unlink(join(recordsPath, name)).catch(ignoreMissing);
    }
  }
}

async function syncDirectory(path: string) {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function requirePrivateMode(mode: number, label: string) {
  if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
    throw new Error(`The Codex operation ${label} permissions are too broad.`);
  }
}

function pathExists(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function ignoreMissing(error: unknown) {
  if (!isMissing(error)) throw error;
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
