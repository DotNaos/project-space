import { describe, expect, test } from 'bun:test';

import {
  MemoryAgentAuthorizationOperationStore,
  PostgresAgentAuthorizationOperationStore,
  type AgentAuthorizationOperation
} from '../server/agent-authorization/store';
import type { DatabaseQueryClient, DatabaseQueryResult } from '../server/database/client';
import {
  agentAuthorizationMigrationId,
  agentAuthorizationMigrationSql
} from '../server/database/agent-authorization-migration';
import { databaseMigrations } from '../server/database/migrations';

const operation: AgentAuthorizationOperation = {
  agentKind: 'codex',
  connectorGeneration: 7,
  connectorId: 'connector-one',
  environmentId: '11111111-1111-4111-8111-111111111111',
  fingerprint: 'a'.repeat(64),
  operationId: 'codex:authorization:one',
  userId: 'owner-one'
};

const deadlineAt = '2026-08-09T12:10:00.000Z';

class FakeDatabase implements DatabaseQueryClient {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  readonly responses: Array<DatabaseQueryResult<unknown>> = [];

  async query<Row>(sql: string, values: readonly unknown[] = []) {
    this.calls.push({ sql, values });
    return (this.responses.shift() ?? { rows: [] }) as DatabaseQueryResult<Row>;
  }

  async transaction<Result>(run: (client: DatabaseQueryClient) => Promise<Result>) {
    return run(this);
  }
}

describe('agent authorization migration', () => {
  test('registers an owner-scoped, fenced operation ledger without secrets', () => {
    expect(agentAuthorizationMigrationId).toBe('0033_agent_authorization_operations');
    expect(databaseMigrations.at(-1)).toEqual({
      id: agentAuthorizationMigrationId,
      sql: agentAuthorizationMigrationSql
    });
    expect(agentAuthorizationMigrationSql).toContain(
      'foreign key (environment_id, owner_user_id)'
    );
    expect(agentAuthorizationMigrationSql).toContain(
      'agent_authorization_one_unresolved_per_environment'
    );
    expect(agentAuthorizationMigrationSql).toContain(
      "state = 'ambiguous' and dispatch_attempted"
    );
    expect(agentAuthorizationMigrationSql).toContain(
      '(connector_id is null and connector_generation is null)'
    );
    expect(agentAuthorizationMigrationSql).not.toMatch(
      /\b(user_code|login_id|access_token|refresh_token|result jsonb)\b/
    );
  });
});

describe('memory agent authorization operation store', () => {
  test('persists pending connector evidence, replays it, and fences another attempt', async () => {
    const store = new MemoryAgentAuthorizationOperationStore();
    expect(await store.reserve(operation)).toEqual({ kind: 'new' });
    await store.markPending(operation, deadlineAt);

    const pending = await store.reserve({
      ...operation,
      connectorGeneration: 99,
      connectorId: 'changed-connector-evidence'
    });
    expect(pending).toEqual({
      kind: 'pending',
      record: {
        ...operation,
        deadlineAt,
        dispatchAttempted: true,
        state: 'pending'
      }
    });
    expect(await store.reserve({ ...operation, operationId: 'codex:authorization:two' }))
      .toEqual({ kind: 'fenced' });
  });

  test('fails closed when an operation id is reused for changed durable input', async () => {
    const store = new MemoryAgentAuthorizationOperationStore();
    expect(await store.reserve(operation)).toEqual({ kind: 'new' });

    for (const changed of [
      { environmentId: '22222222-2222-4222-8222-222222222222' },
      { agentKind: 'claude' },
      { fingerprint: 'b'.repeat(64) }
    ]) {
      expect(await store.reserve({ ...operation, ...changed })).toEqual({ kind: 'conflict' });
    }
  });

  test('isolates owners even when their operation ids and environments match', async () => {
    const store = new MemoryAgentAuthorizationOperationStore();
    expect(await store.reserve(operation)).toEqual({ kind: 'new' });
    expect(await store.reserve({ ...operation, userId: 'owner-two' })).toEqual({ kind: 'new' });
    expect(await store.read('missing-owner', operation.operationId)).toBeUndefined();
    expect(await store.read(operation.userId, operation.operationId)).toMatchObject(operation);
  });

  test('keeps attempted ambiguous work fenced but allows explicitly retryable work', async () => {
    const store = new MemoryAgentAuthorizationOperationStore();
    expect(await store.reserve(operation)).toEqual({ kind: 'new' });
    await store.markAmbiguous(operation, true, deadlineAt);
    expect(await store.reserve(operation)).toMatchObject({ kind: 'ambiguous' });
    expect(await store.reserve({ ...operation, operationId: 'another-attempt' }))
      .toEqual({ kind: 'fenced' });

    const retryStore = new MemoryAgentAuthorizationOperationStore();
    expect(await retryStore.reserve(operation)).toEqual({ kind: 'new' });
    await retryStore.markRetryable(operation);
    expect(await retryStore.reserve(operation)).toEqual({ kind: 'new' });
  });

  test('releases a confirmed authorization-required attempt from any unresolved state', async () => {
    for (const unresolved of ['dispatching', 'pending', 'ambiguous'] as const) {
      const store = new MemoryAgentAuthorizationOperationStore();
      await store.reserve(operation);
      if (unresolved === 'pending') await store.markPending(operation, deadlineAt);
      if (unresolved === 'ambiguous') await store.markAmbiguous(operation, true, deadlineAt);

      await store.markRetryable(operation);
      expect(await store.read(operation.userId, operation.operationId))
        .toMatchObject({ dispatchAttempted: false, state: 'retryable' });
    }
  });

  test('accepts the same concurrent terminal transition as a replay', async () => {
    const store = new MemoryAgentAuthorizationOperationStore();
    await store.reserve(operation);
    await store.markPending(operation, deadlineAt);

    await Promise.all([
      store.complete(operation, 'ready'),
      store.complete(operation, 'ready')
    ]);
    expect(await store.read(operation.userId, operation.operationId))
      .toMatchObject({ state: 'ready' });
  });

  test('replays every terminal outcome without another dispatch', async () => {
    for (const state of ['ready', 'cancelled', 'expired', 'failed'] as const) {
      const store = new MemoryAgentAuthorizationOperationStore();
      expect(await store.reserve(operation)).toEqual({ kind: 'new' });
      await store.complete(operation, state);
      expect(await store.reserve(operation)).toEqual({
        kind: 'replayed',
        record: {
          ...operation,
          dispatchAttempted: false,
          state
        }
      });
    }
  });

  test('expires old records and never serializes codes, login ids, or tokens', async () => {
    let now = 0;
    const store = new MemoryAgentAuthorizationOperationStore(() => now);
    expect(await store.reserve(operation)).toEqual({ kind: 'new' });
    const serialized = JSON.stringify(await store.read(operation.userId, operation.operationId));
    expect(serialized).not.toMatch(/userCode|loginId|accessToken|refreshToken|token/);

    now = 31 * 24 * 60 * 60 * 1_000;
    expect(await store.read(operation.userId, operation.operationId)).toBeUndefined();
    expect(await store.reserve(operation)).toEqual({ kind: 'new' });
  });
});

describe('Postgres agent authorization operation store', () => {
  test('reserves under an owner, environment, and agent fence with connector evidence', async () => {
    const database = new FakeDatabase();
    database.responses.push(
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [{ operation_id: operation.operationId }] }
    );
    const store = new PostgresAgentAuthorizationOperationStore(database);

    expect(await store.reserve(operation)).toEqual({ kind: 'new' });
    expect(database.calls[0]?.sql).toContain('pg_advisory_xact_lock');
    expect(database.calls[0]?.values).toEqual([
      `agent-authorization:${operation.userId}:${operation.environmentId}:${operation.agentKind}`
    ]);
    const insert = database.calls.find(({ sql }) => (
      sql.includes('insert into agent_authorization_operations')
    ));
    expect(insert?.values).toEqual([
      operation.userId,
      operation.operationId,
      operation.environmentId,
      operation.agentKind,
      operation.fingerprint,
      operation.connectorId,
      operation.connectorGeneration
    ]);
  });

  test('replays an exact terminal record and rejects a changed fingerprint', async () => {
    const row = {
      agent_kind: operation.agentKind,
      connector_generation: operation.connectorGeneration,
      connector_id: operation.connectorId,
      deadline_at: null,
      dispatch_attempted: false,
      environment_id: operation.environmentId,
      fingerprint_sha256: operation.fingerprint,
      operation_id: operation.operationId,
      owner_user_id: operation.userId,
      state: 'ready'
    };
    const replayDatabase = new FakeDatabase();
    replayDatabase.responses.push({ rows: [] }, { rows: [] }, { rows: [row] });
    const replayStore = new PostgresAgentAuthorizationOperationStore(replayDatabase);
    expect(await replayStore.reserve(operation)).toMatchObject({ kind: 'replayed', record: operation });

    const conflictDatabase = new FakeDatabase();
    conflictDatabase.responses.push({ rows: [] }, { rows: [] }, { rows: [row] });
    const conflictStore = new PostgresAgentAuthorizationOperationStore(conflictDatabase);
    expect(await conflictStore.reserve({ ...operation, fingerprint: 'b'.repeat(64) }))
      .toEqual({ kind: 'conflict' });
  });

  test('writes state transitions without result payloads or authorization secrets', async () => {
    const database = new FakeDatabase();
    database.responses.push({ rows: [{ operation_id: operation.operationId }] });
    const store = new PostgresAgentAuthorizationOperationStore(database);
    await store.markPending(operation, deadlineAt);

    const transition = database.calls[0];
    expect(transition?.sql).toContain("state = any($9::text[])");
    expect(transition?.values).toEqual([
      operation.userId,
      operation.operationId,
      operation.environmentId,
      operation.agentKind,
      operation.fingerprint,
      'pending',
      true,
      deadlineAt,
      ['dispatching']
    ]);
    expect(`${transition?.sql} ${JSON.stringify(transition?.values)}`)
      .not.toMatch(/userCode|loginId|accessToken|refreshToken|result jsonb/);
  });

  test('accepts a concurrently completed identical terminal transition', async () => {
    const database = new FakeDatabase();
    database.responses.push(
      { rows: [] },
      { rows: [{
        agent_kind: operation.agentKind,
        connector_generation: operation.connectorGeneration,
        connector_id: operation.connectorId,
        deadline_at: deadlineAt,
        dispatch_attempted: false,
        environment_id: operation.environmentId,
        fingerprint_sha256: operation.fingerprint,
        operation_id: operation.operationId,
        owner_user_id: operation.userId,
        state: 'ready'
      }] }
    );
    const store = new PostgresAgentAuthorizationOperationStore(database);

    await expect(store.complete(operation, 'ready')).resolves.toBeUndefined();
  });

  test('keeps a retryable operation fenced while a replacement attempt is active', async () => {
    const database = new FakeDatabase();
    database.responses.push(
      { rows: [] },
      { rows: [] },
      { rows: [{
        agent_kind: operation.agentKind,
        connector_generation: operation.connectorGeneration,
        connector_id: operation.connectorId,
        deadline_at: null,
        dispatch_attempted: false,
        environment_id: operation.environmentId,
        fingerprint_sha256: operation.fingerprint,
        operation_id: operation.operationId,
        owner_user_id: operation.userId,
        state: 'retryable'
      }] },
      { rows: [{ operation_id: 'replacement-operation' }] }
    );
    const store = new PostgresAgentAuthorizationOperationStore(database);

    await expect(store.reserve(operation)).resolves.toEqual({ kind: 'fenced' });
    expect(database.calls.at(-1)?.sql).toContain('operation_id <> $4');
  });
});
