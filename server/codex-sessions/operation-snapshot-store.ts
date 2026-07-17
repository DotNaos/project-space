import { randomBytes } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';

import type { CodexOperationSnapshot } from './contracts';
import type { CodexOperationSnapshotPersist } from './operation-ledger';

export const codexOperationSnapshotFileEnvironment =
  'PROJECT_CODEX_OPERATION_SNAPSHOT_FILE';

const snapshotFileName = 'codex-operations.json';
const snapshotSchema = 'project-space.codex-operation-snapshot/v1';
const maximumSnapshotBytes = 8 * 1024 * 1024;

type SnapshotDocument = {
  operations: CodexOperationSnapshot;
  schema: typeof snapshotSchema;
};

export function createCodexOperationSnapshotPersistence(
  environment: Record<string, string | undefined> = process.env
): { persist: CodexOperationSnapshotPersist; snapshot: CodexOperationSnapshot } {
  const configuredPath = environment[codexOperationSnapshotFileEnvironment];
  if (!configuredPath) {
    return { persist: async () => {}, snapshot: [] };
  }
  const path = validateSnapshotPath(configuredPath);
  const snapshot = readSnapshot(path);
  let writeTail = Promise.resolve();
  return {
    persist(nextSnapshot) {
      const document = encodeSnapshot(nextSnapshot);
      const write = writeTail.then(() => publishSnapshot(path, document));
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

function readSnapshot(path: string): CodexOperationSnapshot {
  let status;
  try {
    status = lstatSync(path);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error('The Codex operation snapshot must be a regular file.');
  }
  if (process.platform !== 'win32' && (status.mode & 0o077) !== 0) {
    throw new Error('The Codex operation snapshot permissions are too broad.');
  }
  if (status.size > maximumSnapshotBytes) {
    throw new Error('The Codex operation snapshot exceeds its size limit.');
  }
  const document = JSON.parse(readFileSync(path, 'utf8')) as Partial<SnapshotDocument>;
  if (
    document.schema !== snapshotSchema ||
    !Array.isArray(document.operations) ||
    Object.keys(document).some((key) => key !== 'operations' && key !== 'schema')
  ) {
    throw new Error('The Codex operation snapshot has an unsupported format.');
  }
  return document.operations;
}

function encodeSnapshot(snapshot: CodexOperationSnapshot) {
  const document = `${JSON.stringify({ operations: snapshot, schema: snapshotSchema })}\n`;
  if (Buffer.byteLength(document) > maximumSnapshotBytes) {
    throw new Error('The Codex operation snapshot exceeds its size limit.');
  }
  return document;
}

async function publishSnapshot(path: string, document: string) {
  const directory = dirname(path);
  await mkdir(directory, { mode: 0o700, recursive: true });
  const directoryStatus = await lstat(directory);
  if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) {
    throw new Error('The Codex operation snapshot directory must be a regular directory.');
  }
  if (process.platform !== 'win32') await chmod(directory, 0o700);
  await rejectUnsafeExistingFile(path);

  const temporaryPath = join(
    directory,
    `.codex-operations-${randomBytes(12).toString('hex')}.tmp`
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

async function rejectUnsafeExistingFile(path: string) {
  try {
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new Error('The Codex operation snapshot must be a regular file.');
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
