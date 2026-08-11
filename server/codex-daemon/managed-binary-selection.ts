import { randomBytes } from 'node:crypto';
import { lstat, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

export interface ManagedCodexSelectionRecord {
  operationId: string;
  previousDigest: string | null;
  previousTarget: string | null;
  schema: typeof managedCodexSelectionSchema;
  selectedDigest: string;
  selectedTarget: string;
  state: 'committed' | 'restored' | 'staged';
}

export const managedCodexSelectionSchema =
  'project-space.managed-codex-selection/v1' as const;
const maintenanceOperationIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;

async function optionalLstat(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
}

export function assertManagedCodexMaintenanceOperationId(operationId: string) {
  if (!maintenanceOperationIdPattern.test(operationId)) {
    throw new Error('The managed Codex maintenance operation ID is invalid.');
  }
}

function isSelectionRecord(value: unknown): value is ManagedCodexSelectionRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [
    'operationId', 'previousDigest', 'previousTarget', 'schema',
    'selectedDigest', 'selectedTarget', 'state'
  ].sort();
  const previous = record.previousTarget === null && record.previousDigest === null ||
    typeof record.previousTarget === 'string' &&
    typeof record.previousDigest === 'string' && sha256Pattern.test(record.previousDigest);
  return keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]) && previous &&
    record.schema === managedCodexSelectionSchema &&
    typeof record.operationId === 'string' &&
    maintenanceOperationIdPattern.test(record.operationId) &&
    typeof record.selectedTarget === 'string' &&
    typeof record.selectedDigest === 'string' && sha256Pattern.test(record.selectedDigest) &&
    (record.state === 'committed' || record.state === 'restored' ||
      record.state === 'staged');
}

export async function readManagedCodexSelectionRecord(path: string) {
  const status = await optionalLstat(path);
  if (!status) return undefined;
  if (!status.isFile() || status.isSymbolicLink() || status.size < 1 ||
      status.size > 4_096 || (status.mode & 0o022) !== 0) {
    throw new Error('The managed Codex maintenance selection record is unsafe.');
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('The managed Codex maintenance selection record is invalid.');
  }
  if (!isSelectionRecord(value)) {
    throw new Error('The managed Codex maintenance selection record is invalid.');
  }
  return value;
}

export async function writeManagedCodexSelectionRecord(input: {
  path: string;
  record: ManagedCodexSelectionRecord;
  root: string;
}) {
  const existing = await optionalLstat(input.path);
  if (existing && (!existing.isFile() || existing.isSymbolicLink() ||
      (existing.mode & 0o022) !== 0)) {
    throw new Error('The managed Codex maintenance selection record is unsafe.');
  }
  const temporary = join(
    input.root,
    `.project-space-selection-${randomBytes(8).toString('hex')}.tmp`
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(input.record)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, input.path);
    const persisted = await open(input.path, 'r');
    try {
      await persisted.sync();
    } finally {
      await persisted.close();
    }
    const parent = await open(input.root, 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function persistPendingManagedCodexSelection(input: {
  path: string;
  record: ManagedCodexSelectionRecord;
  root: string;
}) {
  const existing = await readManagedCodexSelectionRecord(input.path);
  if (existing?.operationId === input.record.operationId) {
    if (existing.selectedTarget !== input.record.selectedTarget ||
        existing.selectedDigest !== input.record.selectedDigest) {
      throw new Error('The managed Codex maintenance operation changed its selected release.');
    }
    return existing;
  }
  await writeManagedCodexSelectionRecord(input);
  return input.record;
}
