import { describe, expect, test } from 'bun:test';

import {
  codexSessionsMigrationId,
  codexSessionsMigrationSql
} from '../server/database/codex-sessions-migration';
import {
  codexSessionSettingsMigrationId,
  codexSessionSettingsMigrationSql
} from '../server/database/codex-session-settings-migration';
import { databaseMigrations } from '../server/database/migrations';
import {
  CodexSessionsStore,
  operationFingerprint,
  type CodexStoredOperationInput
} from '../server/codex-sessions-store';
import type { DatabaseQueryClient, DatabaseQueryResult } from '../server/database/client';

class FakeDatabase implements DatabaseQueryClient {
  readonly calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  readonly responses: Array<DatabaseQueryResult<unknown>> = [];

  async query<Row>(sql: string, values?: readonly unknown[]) {
    this.calls.push({ sql, values });
    return (this.responses.shift() ?? { rows: [] }) as DatabaseQueryResult<Row>;
  }

  async transaction<Result>(operation: (client: DatabaseQueryClient) => Promise<Result>) {
    return operation(this);
  }
}

const operation: CodexStoredOperationInput = {
  fingerprint: { message: 'continue once' },
  machineId: 'machine-one',
  operation: 'continue',
  operationId: 'operation-one',
  threadId: '019f5a78-3c4c-7082-bb45-5411be7d9b9a',
  userId: 'user-owner'
};

describe('Codex session durable store', () => {
  test('reserves a new operation atomically without storing the message', async () => {
    const database = new FakeDatabase();
    database.responses.push({ rows: [{ operation_id: operation.operationId }] });
    const store = new CodexSessionsStore(database);

    expect(await store.reserveOperation(operation)).toEqual({ kind: 'new' });
    expect(database.calls[0]?.values).toContain(operationFingerprint(operation.fingerprint));
    expect(database.calls[0]?.values).not.toContain('continue once');
  });

  test('replays only a completed operation with the same fingerprint', async () => {
    const result = {
      operationId: operation.operationId,
      replayed: false,
      status: 'completed' as const,
      threadId: operation.threadId,
      turnId: 'turn-one'
    };
    const database = new FakeDatabase();
    database.responses.push(
      { rows: [] },
      {
        rows: [{
          fingerprint_sha256: operationFingerprint(operation.fingerprint),
          result,
          state: 'completed'
        }]
      }
    );
    const store = new CodexSessionsStore(database);

    expect(await store.reserveOperation(operation)).toEqual({
      kind: 'replayed',
      result: { ...result, replayed: true }
    });
  });

  test('rejects reuse of an operation id for different input', async () => {
    const database = new FakeDatabase();
    database.responses.push(
      { rows: [] },
      { rows: [{ fingerprint_sha256: '0'.repeat(64), result: null, state: 'pending' }] }
    );
    const store = new CodexSessionsStore(database);
    expect(await store.reserveOperation(operation)).toEqual({ kind: 'conflict' });
  });

  test('does not replay a malformed persisted operation result', async () => {
    const database = new FakeDatabase();
    database.responses.push(
      { rows: [] },
      {
        rows: [{
          fingerprint_sha256: operationFingerprint(operation.fingerprint),
          result: {
            operationId: operation.operationId,
            replayed: false,
            status: 'invented',
            threadId: operation.threadId
          },
          state: 'completed'
        }]
      }
    );
    const store = new CodexSessionsStore(database);
    expect(await store.reserveOperation(operation)).toEqual({ kind: 'pending' });
  });

  test('treats reordered object keys as the same operation input', () => {
    expect(operationFingerprint({ a: 1, nested: { b: 2, c: 3 } })).toBe(
      operationFingerprint({ nested: { c: 3, b: 2 }, a: 1 })
    );
  });

  test('retains honest missing snapshots after a complete inventory refresh', async () => {
    const database = new FakeDatabase();
    const store = new CodexSessionsStore(database);
    await store.saveInventory({
      checkedAt: '2026-07-13T01:00:00.000Z',
      completeInventory: true,
      machineId: 'machine-one',
      sessions: [{
        archived: false,
        id: operation.threadId,
        lastActivityAt: '2026-07-13T00:59:00.000Z',
        loadedByProjectSpace: false,
        machineId: 'machine-one',
        machineName: 'os-macbook',
        status: 'idle',
        title: '#149 · Integrate Codex sessions'
      }],
      userId: 'user-owner'
    });

    expect(database.calls).toHaveLength(2);
    expect(database.calls[1]?.sql).toContain("set status = 'missing'");
    expect(database.calls[1]?.values?.[3]).toEqual([operation.threadId]);
  });

  test('drops malformed persisted snapshots instead of exposing them', async () => {
    const database = new FakeDatabase();
    database.responses.push({ rows: [
      { snapshot: {
        archived: false,
        id: operation.threadId,
        lastActivityAt: 'now',
        loadedByProjectSpace: false,
        machineId: 'machine-one',
        machineName: 'os-macbook',
        status: 'idle',
        title: 'Valid'
      } },
      { snapshot: {
        archived: false,
        id: operation.threadId,
        lastActivityAt: 'now',
        loadedByProjectSpace: false,
        machineId: 'machine-one',
        machineName: 'os-macbook',
        status: 'invented',
        title: 'Invalid status'
      } },
      { snapshot: { id: operation.threadId, secret: 'must-not-pass' } }
    ] });
    const store = new CodexSessionsStore(database);
    expect(await store.listInventory('user-owner', 'machine-one')).toHaveLength(1);
  });

  test('returns the durable sequence for new and duplicate stream events', async () => {
    const database = new FakeDatabase();
    database.responses.push({ rows: [{ sequence: '42' }] });
    const store = new CodexSessionsStore(database);
    const sequence = await store.appendEvent({
      event: { eventId: 'event-42', status: 'idle', type: 'session-status' },
      machineId: operation.machineId,
      threadId: operation.threadId,
      userId: operation.userId
    });

    expect(sequence).toBe(42);
    expect(database.calls[0]?.sql).toContain('on conflict');
    expect(database.calls[0]?.sql).toContain('select sequence from codex_session_events');
  });

  test('returns the scoped durable event cursor used by a fresh history read', async () => {
    const database = new FakeDatabase();
    database.responses.push({ rows: [{ sequence: '42' }] });
    const store = new CodexSessionsStore(database);

    expect(await store.latestEventSequence(operation)).toBe(42);
    expect(database.calls[0]?.sql).toContain('max(sequence)');
    expect(database.calls[0]?.values).toEqual([
      operation.userId, operation.machineId, operation.threadId
    ]);
  });
});

describe('Codex session migration contract', () => {
  test('reserves migration 0016 after connector runtime operations', () => {
    expect(codexSessionsMigrationId).toBe('0016_codex_sessions');
    expect(codexSessionsMigrationSql).toContain('codex_session_snapshots');
    expect(codexSessionsMigrationSql).toContain('codex_session_operations');
    expect(codexSessionsMigrationSql).toContain('codex_session_events');
    expect(codexSessionsMigrationSql).toContain('references machine_memberships');
    expect(databaseMigrations.find(({ id }) => id === codexSessionsMigrationId)).toEqual({
      id: codexSessionsMigrationId,
      sql: codexSessionsMigrationSql
    });
  });

  test('extends durable operations with permission settings', () => {
    expect(codexSessionSettingsMigrationId).toBe('0028_codex_session_settings_operations');
    expect(codexSessionSettingsMigrationSql).toContain("'settings'");
    expect(codexSessionSettingsMigrationSql).toContain(
      'drop constraint if exists codex_session_operations_operation_check'
    );
    expect(databaseMigrations.find(({ id }) => id === codexSessionSettingsMigrationId)).toEqual({
      id: codexSessionSettingsMigrationId,
      sql: codexSessionSettingsMigrationSql
    });
  });
});
