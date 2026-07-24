import { dirname, join } from 'node:path';

import {
  codexOperationSnapshotFileEnvironment,
  createCodexOperationSnapshotPersistence
} from '../codex-sessions/operation-snapshot-store';
import { CODEX_OPERATION_ID_PATTERN } from '../../src/shared/codex-sessions-api';

export type CodexAuthorizationOperationRecord = {
  deadlineAt?: string;
  operationId: string;
  state: 'ambiguous' | 'cancelled' | 'expired' | 'failed' | 'pending' | 'ready';
  updatedAt: string;
};

export type CodexAuthorizationOperationPersistence = {
  persist(records: CodexAuthorizationOperationRecord[]): Promise<void>;
  snapshot: CodexAuthorizationOperationRecord[];
};

const fingerprint = 'project-space.codex-device-authorization/v1';
const maximumRecords = 64;
const states = new Set<CodexAuthorizationOperationRecord['state']>([
  'ambiguous', 'cancelled', 'expired', 'failed', 'pending', 'ready'
]);

export function createCodexAuthorizationOperationPersistence(
  environment: Record<string, string | undefined> = process.env,
  machineId?: string
): CodexAuthorizationOperationPersistence {
  const sessionSnapshotPath = environment[codexOperationSnapshotFileEnvironment];
  if (!sessionSnapshotPath) return { persist: async () => {}, snapshot: [] };
  const authorizationEnvironment = {
    ...environment,
    [codexOperationSnapshotFileEnvironment]: join(
      dirname(sessionSnapshotPath),
      'codex-authorization-journal',
      'codex-operations.json'
    )
  };
  const persistence = createCodexOperationSnapshotPersistence(
    authorizationEnvironment,
    machineId
  );
  const snapshot = persistence.snapshot.map((entry) => {
    if (
      entry.fingerprint !== fingerprint ||
      entry.state !== 'completed' ||
      !isOperationRecord(entry.result) ||
      entry.result.operationId !== entry.operationId
    ) {
      throw new Error('The Codex authorization operation journal is invalid.');
    }
    return entry.result;
  });
  if (snapshot.length > maximumRecords) {
    throw new Error('The Codex authorization operation journal is too large.');
  }
  return {
    async persist(records) {
      if (records.length > maximumRecords || records.some((record) => !isOperationRecord(record))) {
        throw new Error('The Codex authorization operation journal is invalid.');
      }
      await persistence.persist(records.map((record) => ({
        fingerprint,
        operationId: record.operationId,
        result: record,
        state: 'completed' as const
      })));
    },
    snapshot
  };
}

function isOperationRecord(value: unknown): value is CodexAuthorizationOperationRecord {
  if (!isRecord(value) ||
    typeof value.operationId !== 'string' ||
    !CODEX_OPERATION_ID_PATTERN.test(value.operationId) ||
    typeof value.state !== 'string' ||
    !states.has(value.state as CodexAuthorizationOperationRecord['state']) ||
    typeof value.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.updatedAt))) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => !['deadlineAt', 'operationId', 'state', 'updatedAt'].includes(key))) {
    return false;
  }
  if (value.deadlineAt !== undefined &&
    (typeof value.deadlineAt !== 'string' || !Number.isFinite(Date.parse(value.deadlineAt)))) {
    return false;
  }
  return value.state !== 'pending' || typeof value.deadlineAt === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
