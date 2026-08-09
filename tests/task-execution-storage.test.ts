import { describe, expect, test } from 'bun:test';

import type { DatabaseQueryClient, DatabaseQueryResult } from '../server/database/client';
import { databaseMigrations } from '../server/database/migrations';
import {
  taskExecutionMigrationId,
  taskExecutionMigrationSql
} from '../server/database/task-execution-migration';
import type {
  StoredTaskExecution,
  StoredTaskHandoffRevision
} from '../server/task-execution/contracts';
import {
  MemoryTaskExecutionStore,
  PostgresTaskExecutionStore
} from '../server/task-execution/execution-store';
import {
  MemoryTaskHandoffStore,
  PostgresTaskHandoffStore
} from '../server/task-execution/handoff-store';
import {
  MemoryTaskExecutionOperationStore,
  PostgresTaskExecutionOperationStore
} from '../server/task-execution/operation-store';
import { TASK_EXECUTION_API_VERSION } from '../src/shared/task-execution-api';

const owner = 'owner-one';
const handoffId = '11111111-1111-4111-8111-111111111111';
const environmentId = '22222222-2222-4222-8222-222222222222';
const executionId = '33333333-3333-4333-8333-333333333333';
const now = '2026-08-09T12:00:00.000Z';

const handoff: StoredTaskHandoffRevision = {
  acceptanceCriteria: ['Tests pass'],
  artifacts: [{
    authorization: { kind: 'task', reference: 'task-544' },
    digest: `sha256:${'a'.repeat(64)}`,
    id: 'design-spec',
    mediaType: 'text/markdown',
    provenance: { kind: 'orchestrator', reference: 'claude-design' },
    sizeBytes: 128,
    storage: { kind: 'task_artifact', reference: 'artifact:design-spec' }
  }],
  constraints: ['No credentials'],
  context: 'Provider-neutral execution context.',
  createdAt: now,
  createdBy: { id: 'orchestrator-one', kind: 'orchestrator' },
  decisions: ['Use a durable execution ID'],
  fingerprint: 'b'.repeat(64),
  handoffId,
  objective: 'Implement the task safely.',
  ownerUserId: owner,
  requestedMode: 'implement',
  revision: 1,
  taskId: 'github:DotNaos/project-space#544'
};

const execution: StoredTaskExecution = {
  agent: { kind: 'codex' },
  connectorBinding: { connectorId: 'connector-one', generation: 7 },
  createdAt: now,
  environmentId,
  handoff: { id: handoffId, revision: 1 },
  id: executionId,
  ownerUserId: owner,
  source: {
    branch: 'issue-544-task-execution',
    commit: 'c'.repeat(40),
    repositoryId: 'github:DotNaos/project-space',
    taskId: handoff.taskId
  },
  state: 'planned',
  updatedAt: now,
  version: 1
};

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

describe('task execution storage contract and migration', () => {
  test('registers all owner-scoped durable records without secret or raw-location fields', () => {
    expect(TASK_EXECUTION_API_VERSION).toBe(1);
    expect(taskExecutionMigrationId).toBe('0034_task_execution_storage');
    expect(databaseMigrations.find(({ id }) => id === taskExecutionMigrationId)).toEqual({
      id: taskExecutionMigrationId,
      sql: taskExecutionMigrationSql
    });
    for (const table of [
      'task_handoffs', 'task_handoff_revisions', 'task_handoff_artifacts',
      'task_executions', 'task_execution_bindings', 'runner_workspaces',
      'task_execution_events', 'execution_operations', 'capacity_leases'
    ]) expect(taskExecutionMigrationSql).toContain(`create table ${table}`);
    expect(taskExecutionMigrationSql).toContain('foreign key (environment_id, owner_user_id)');
    expect(taskExecutionMigrationSql).toContain(
      'foreign key (handoff_id, owner_user_id, handoff_revision, task_id)'
    );
    expect(taskExecutionMigrationSql).toContain(
      'foreign key (execution_id, owner_user_id, repository_id, branch)'
    );
    expect(taskExecutionMigrationSql).toContain(
      'foreign key (execution_id, owner_user_id, agent_kind)'
    );
    expect(taskExecutionMigrationSql).toContain(
      'foreign key (execution_id, owner_user_id, environment_id)'
    );
    expect(taskExecutionMigrationSql).toContain('previous_handoff_revision integer');
    expect(taskExecutionMigrationSql).toContain("event_type = 'handoff_updated'");
    expect(taskExecutionMigrationSql).toContain('on delete restrict');
    expect(taskExecutionMigrationSql).toContain('capacity_leases_one_active_per_environment');
    expect(taskExecutionMigrationSql).toContain("where state in ('completed', 'blocked')");
    expect(taskExecutionMigrationSql).not.toMatch(
      /\b(access_token|refresh_token|device_code|user_code|login_id|transcript|raw_path|url)\b/
    );
  });
});

describe('immutable task handoffs', () => {
  test('replays exact revisions, rejects drift, and appends only a sequential revision', async () => {
    const store = new MemoryTaskHandoffStore();
    expect((await store.create(handoff)).kind).toBe('created');
    expect((await store.create(structuredClone(handoff))).kind).toBe('replayed');
    expect(await store.appendRevision(structuredClone(handoff))).toEqual({ kind: 'conflict' });
    expect(await store.create({ ...handoff, fingerprint: 'd'.repeat(64) }))
      .toEqual({ kind: 'conflict' });

    const second = { ...handoff, fingerprint: 'e'.repeat(64), revision: 2 };
    expect((await store.appendRevision(second)).kind).toBe('created');
    expect(await store.appendRevision({ ...second, revision: 4 })).toEqual({ kind: 'conflict' });
    expect((await store.read(owner, handoffId))?.revision).toBe(2);
    expect(await store.read('other-owner', handoffId)).toBeUndefined();
    expect(await store.archive(owner, handoffId, now)).toBe(true);
    expect(await store.appendRevision({ ...second, fingerprint: 'f'.repeat(64), revision: 3 }))
      .toEqual({ kind: 'conflict' });
  });

  test('rejects unrestricted artifact locations and oversized content before persistence', async () => {
    const store = new MemoryTaskHandoffStore();
    await expect(store.create({
      ...handoff,
      artifacts: [{
        ...handoff.artifacts[0]!,
        storage: { kind: 'task_artifact', reference: 'https://example.test/private' }
      }]
    })).rejects.toThrow('invalid');
    await expect(store.create({ ...handoff, objective: 'x'.repeat(12_001) }))
      .rejects.toThrow('invalid');
  });

  test('uses a transaction and owner-scoped advisory lock in Postgres', async () => {
    const database = new FakeDatabase();
    database.responses.push({ rows: [] }, { rows: [] }, { rows: [] });
    const store = new PostgresTaskHandoffStore(database);
    expect((await store.create(handoff)).kind).toBe('created');
    expect(database.calls[0]?.sql).toContain('pg_advisory_xact_lock');
    expect(database.calls[0]?.values).toEqual([`task-handoff:${owner}:${handoffId}`]);
    expect(database.calls.some(({ sql }) => sql.includes('insert into task_handoff_artifacts')))
      .toBe(true);
  });
});

describe('neutral task execution identity', () => {
  test('requires every new execution to enter through the planned state', async () => {
    const store = new MemoryTaskExecutionStore();
    await expect(store.create({ ...execution, state: 'completed' }))
      .rejects.toThrow('invalid');
  });

  test('keeps immutable identity, applies versioned transitions, and archives terminal work', async () => {
    const store = new MemoryTaskExecutionStore();
    expect(await store.create(execution)).toBe('created');
    expect(await store.create(structuredClone(execution))).toBe('replayed');
    expect(await store.create({
      ...execution,
      connectorBinding: { connectorId: 'connector-two', generation: 8 }
    })).toBe('conflict');
    expect(await store.read('other-owner', executionId)).toBeUndefined();

    expect((await store.transition({
      expectedVersion: 1,
      executionId,
      ownerUserId: owner,
      state: 'delivering',
      updatedAt: '2026-08-09T12:00:30.000Z'
    })).kind).toBe('conflict');
    const starting = await store.transition({
      expectedVersion: 1,
      executionId,
      ownerUserId: owner,
      state: 'starting_agent',
      updatedAt: '2026-08-09T12:01:00.000Z'
    });
    expect(starting).toMatchObject({
      kind: 'updated', execution: { state: 'starting_agent', version: 2 }
    });
    const running = await store.transition({
      expectedVersion: 2,
      executionId,
      ownerUserId: owner,
      state: 'running',
      updatedAt: '2026-08-09T12:02:00.000Z'
    });
    expect(running).toMatchObject({ kind: 'updated', execution: { state: 'running', version: 3 } });
    expect((await store.transition({
      expectedVersion: 2,
      executionId,
      ownerUserId: owner,
      state: 'completed',
      updatedAt: '2026-08-09T12:03:00.000Z'
    })).kind).toBe('conflict');
    const verifying = await store.transition({
      expectedVersion: 3,
      executionId,
      ownerUserId: owner,
      state: 'verifying',
      updatedAt: '2026-08-09T12:03:00.000Z'
    });
    expect(verifying.kind).toBe('updated');
    await store.transition({
      expectedVersion: 4,
      executionId,
      ownerUserId: owner,
      state: 'delivering',
      updatedAt: '2026-08-09T12:04:00.000Z'
    });
    const completed = await store.transition({
      expectedVersion: 5,
      executionId,
      ownerUserId: owner,
      state: 'completed',
      updatedAt: '2026-08-09T12:05:00.000Z'
    });
    expect(completed.kind).toBe('updated');
    expect((await store.archive(owner, executionId, 6, '2026-08-09T12:06:00.000Z')))
      .toMatchObject({ kind: 'updated', execution: { state: 'archived', version: 7 } });
  });

  test('persists monotonic events and versioned executor/workspace bindings', async () => {
    const store = new MemoryTaskExecutionStore();
    await store.create(execution);
    const first = await store.appendEvent({
      createdAt: now,
      executionId,
      ownerUserId: owner,
      state: 'planned',
      type: 'created'
    });
    const second = await store.appendEvent({
      actor: { id: 'orchestrator-one', kind: 'orchestrator' },
      createdAt: now,
      executionId,
      ownerUserId: owner,
      type: 'executor_bound'
    });
    expect(second.cursor).toBeGreaterThan(first.cursor);
    expect((await store.listEvents(owner, executionId, first.cursor))).toEqual([second]);

    const binding = {
      agent: 'codex' as const,
      createdAt: now,
      executionId,
      externalId: 'thread:codex-task-544',
      updatedAt: now,
      version: 1
    };
    expect(await store.bindExecutor(owner, binding)).toBe('created');
    expect((await store.updateExecutorTurn({
      expectedVersion: 1,
      executionId,
      ownerUserId: owner,
      turnId: 'turn:one',
      updatedAt: now
    }))?.version).toBe(2);

    const workspace = {
      branch: execution.source.branch,
      createdAt: now,
      executionId,
      id: '44444444-4444-4444-8444-444444444444',
      kind: 'worktree' as const,
      repositoryId: execution.source.repositoryId,
      state: 'preparing' as const,
      updatedAt: now,
      version: 1
    };
    expect(await store.bindWorkspace(owner, workspace)).toBe('created');
    expect(await store.bindWorkspace(owner, {
      ...workspace,
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      repositoryId: 'github:other/repository'
    })).toBe('conflict');
    expect((await store.updateWorkspace({
      commit: 'f'.repeat(40),
      expectedVersion: 1,
      executionId,
      ownerUserId: owner,
      state: 'ready',
      updatedAt: now
    }))?.state).toBe('ready');

    expect(await store.updateConnectorBinding({
      connectorBinding: { connectorId: 'connector-two', generation: 8 },
      executionId,
      expectedConnectorBinding: execution.connectorBinding,
      expectedVersion: 1,
      ownerUserId: owner,
      updatedAt: now
    })).toMatchObject({
      kind: 'updated',
      execution: { connectorBinding: { connectorId: 'connector-two', generation: 8 }, version: 2 }
    });
    expect(await store.updateHandoff({
      executionId,
      expectedVersion: 2,
      handoff: { id: handoffId, revision: 2 },
      ownerUserId: owner,
      updatedAt: now
    })).toMatchObject({
      kind: 'updated',
      execution: { handoff: { id: handoffId, revision: 2 }, version: 3 }
    });
    expect((await store.listEvents(owner, executionId)).at(-1)).toMatchObject({
      handoffChange: {
        from: { id: handoffId, revision: 1 },
        to: { id: handoffId, revision: 2 }
      },
      type: 'handoff_updated'
    });
    expect((await store.updateHandoff({
      executionId,
      expectedVersion: 3,
      handoff: { id: 'not-a-uuid', revision: 3 },
      ownerUserId: owner,
      updatedAt: now
    })).kind).toBe('conflict');
  });

  test('uses versioned owner-scoped writes in Postgres', async () => {
    const database = new FakeDatabase();
    database.responses.push({ rows: [] }, { rows: [] });
    const store = new PostgresTaskExecutionStore(database);
    expect(await store.create(execution)).toBe('conflict');
    expect(database.calls[0]?.sql).toContain('on conflict (id, owner_user_id)');
    expect(database.calls[1]?.values).toEqual([owner, executionId]);
  });

  test('records a Postgres handoff change in the same transaction', async () => {
    const database = new FakeDatabase();
    database.responses.push(
      { rows: [{ handoff_id: handoffId, handoff_revision: 1 }] },
      { rows: [{
        agent_kind: 'codex', archived_at: null, blocked_reason: null,
        branch: execution.source.branch, commit_sha: execution.source.commit,
        connector_generation: 7, connector_id: 'connector-one', created_at: now,
        environment_id: environmentId, handoff_id: handoffId, handoff_revision: 2,
        id: executionId, owner_user_id: owner, repository_id: execution.source.repositoryId,
        state: 'planned', task_id: execution.source.taskId, updated_at: now, version: 2
      }] },
      { rows: [] }
    );
    const store = new PostgresTaskExecutionStore(database);
    expect(await store.updateHandoff({
      executionId,
      expectedVersion: 1,
      handoff: { id: handoffId, revision: 2 },
      ownerUserId: owner,
      updatedAt: now
    })).toMatchObject({ kind: 'updated', execution: { handoff: { revision: 2 } } });
    expect(database.calls.at(-1)?.sql).toContain("'handoff_updated'");
    expect(database.calls.at(-1)?.values).toEqual([
      executionId, owner, handoffId, 1, handoffId, 2, now
    ]);
  });
});

describe('task execution operation ledger', () => {
  test('replays terminal work, conflicts changed input, and preserves uncertainty', async () => {
    let clock = Date.parse(now);
    const store = new MemoryTaskExecutionOperationStore(() => clock);
    const operation = {
      action: 'start_execution',
      executionId,
      fingerprint: '1'.repeat(64),
      operationId: 'task-execution:start:544',
      ownerUserId: owner
    };
    expect((await store.reserve(operation)).kind).toBe('new');
    expect((await store.reserve(operation)).kind).toBe('in_progress');
    expect(await store.reserve({ ...operation, fingerprint: '2'.repeat(64) }))
      .toEqual({ kind: 'conflict' });
    await expect(store.transition({
      ...operation,
      fingerprint: '2'.repeat(64),
      state: 'dispatched'
    })).rejects.toThrow('identity');
    await store.transition({
      ...operation,
      operationId: operation.operationId,
      ownerUserId: owner,
      state: 'uncertain'
    });
    expect((await store.reserve(operation)).kind).toBe('in_progress');
    clock += 31 * 24 * 60 * 60 * 1_000;
    expect((await store.reserve(operation)).kind).toBe('in_progress');
    await store.transition({
      ...operation,
      operationId: operation.operationId,
      ownerUserId: owner,
      result: { executionId, state: 'completed' },
      state: 'completed'
    });
    expect((await store.reserve(operation)).kind).toBe('replayed');
    clock += 31 * 24 * 60 * 60 * 1_000;
    expect(await store.read(owner, operation.operationId)).toBeUndefined();
  });

  test('rejects credentials, device codes, transcripts, paths, and unrestricted URLs', async () => {
    const store = new MemoryTaskExecutionOperationStore();
    const operation = {
      action: 'start_execution', fingerprint: '3'.repeat(64),
      operationId: 'task-execution:safe:544', ownerUserId: owner
    };
    await store.reserve(operation);
    for (const result of [
      { accessToken: 'secret' }, { userCode: 'ABCD-EFGH' },
      { transcript: 'private' }, { workspacePath: '/tmp/worktree' },
      { message: 'failed while reading /tmp/worktree' },
      { location: 'src/private/file.ts' },
      { link: 'HTTPS://example.test/private' }
    ]) {
      await expect(store.transition({
        ...operation,
        operationId: operation.operationId,
        ownerUserId: owner,
        result,
        state: 'completed'
      })).rejects.toThrow();
    }
  });

  test('reserves Postgres operations under an exact owner-operation lock', async () => {
    const database = new FakeDatabase();
    database.responses.push({ rows: [] }, { rows: [] }, { rows: [] }, { rows: [] });
    const store = new PostgresTaskExecutionOperationStore(database);
    const operation = {
      action: 'start_execution', fingerprint: '4'.repeat(64),
      operationId: 'task-execution:postgres:544', ownerUserId: owner
    };
    expect((await store.reserve(operation)).kind).toBe('conflict');
    expect(database.calls[0]?.values).toEqual([
      `task-execution-operation:${owner}:${operation.operationId}`
    ]);
    expect(database.calls.some(({ sql }) => sql.includes("interval '30 days'"))).toBe(true);
  });
});
