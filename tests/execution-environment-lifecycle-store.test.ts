import { describe, expect, test } from 'bun:test';

import type { DatabaseQueryClient, DatabaseQueryResult } from '../server/database/client';
import {
  environmentLifecycleMigrationId,
  environmentLifecycleMigrationSql
} from '../server/database/environment-lifecycle-migration';
import { databaseMigrations } from '../server/database/migrations';
import {
  EnvironmentProviderBindingConflictError,
  MemoryEnvironmentLifecycleStore,
  PostgresEnvironmentLifecycleStore,
  type EnvironmentLifecycleOperation,
  type EnvironmentProviderBinding
} from '../server/execution-environment-lifecycle/store';

const operation: EnvironmentLifecycleOperation = {
  action: 'provision',
  fingerprint: 'a'.repeat(64),
  operationId: 'environment:provision:one',
  providerKind: 'github_codespaces',
  scopeKey: `task:${'b'.repeat(64)}`,
  userId: 'user-owner'
};

const binding: EnvironmentProviderBinding = {
  branch: 'issue-536-lifecycle',
  environmentId: '11111111-1111-4111-8111-111111111111',
  id: '22222222-2222-4222-8222-222222222222',
  lifecycleState: 'running',
  nativeState: 'Available',
  observedAt: '2026-08-09T12:00:00.000Z',
  providerKind: 'github_codespaces',
  providerResourceId: 'durable-space-536',
  repositoryFullName: 'DotNaos/project-space',
  task: 536,
  userId: operation.userId
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

describe('environment lifecycle migration', () => {
  test('registers owner-scoped bindings and a fenced durable operation ledger', () => {
    expect(environmentLifecycleMigrationId).toBe('0032_environment_lifecycle');
    expect(databaseMigrations.at(-1)).toEqual({
      id: environmentLifecycleMigrationId,
      sql: environmentLifecycleMigrationSql
    });
    expect(environmentLifecycleMigrationSql).toContain('create table environment_provider_bindings');
    expect(environmentLifecycleMigrationSql).toContain(
      'unique (owner_user_id, provider_kind, provider_resource_id)'
    );
    expect(environmentLifecycleMigrationSql).toContain(
      'environment_provider_bindings_environment_unique'
    );
    expect(environmentLifecycleMigrationSql).toContain('create table environment_lifecycle_operations');
    expect(environmentLifecycleMigrationSql).toContain('environment_lifecycle_one_unresolved_per_scope');
    expect(environmentLifecycleMigrationSql).toContain("state = 'uncertain' and dispatch_attempted");
    expect(environmentLifecycleMigrationSql).toContain("action = 'provision' or environment_id is not null");
    expect(environmentLifecycleMigrationSql).toContain('on delete restrict');
  });
});

describe('memory environment lifecycle store', () => {
  test('replays exact completed operations and rejects changed input', async () => {
    const store = new MemoryEnvironmentLifecycleStore();
    expect(await store.reserve(operation)).toEqual({ kind: 'new' });
    await store.complete(operation, {
      operationId: operation.operationId,
      state: 'provisioning'
    });
    expect(await store.reserve(operation)).toEqual({
      kind: 'replayed',
      result: { operationId: operation.operationId, state: 'provisioning' }
    });
    expect(await store.reserve({ ...operation, action: 'delete' })).toEqual({ kind: 'conflict' });
  });

  test('does not redispatch an uncertain delete and fences another operation', async () => {
    const store = new MemoryEnvironmentLifecycleStore();
    const deletion = {
      ...operation,
      action: 'delete' as const,
      environmentId: binding.environmentId,
      operationId: 'environment:delete:one',
      scopeKey: `environment:${binding.environmentId}`
    };
    expect(await store.reserve(deletion)).toEqual({ kind: 'new' });
    await store.markUncertain(deletion, true);
    expect(await store.reserve(deletion)).toEqual({ kind: 'uncertain' });
    expect(await store.reserve({ ...deletion, operationId: 'environment:delete:two' }))
      .toEqual({ kind: 'fenced' });
  });

  test('attaches a canonical environment once and prevents provider identity drift', async () => {
    const store = new MemoryEnvironmentLifecycleStore();
    const provisional = { ...binding, environmentId: undefined, lifecycleState: 'provisioning' as const };
    expect(await store.saveBinding(provisional)).toEqual({
      binding: provisional,
      kind: 'saved'
    });
    expect((await store.saveBinding(binding)).kind).toBe('saved');
    expect(await store.readBindingByEnvironment(operation.userId, binding.environmentId!))
      .toEqual(binding);
    expect(await store.saveBinding({
      ...binding,
      environmentId: '33333333-3333-4333-8333-333333333333'
    })).toEqual({ kind: 'conflict' });
  });

  test('never retargets one provider resource to another repository, branch, or task', async () => {
    const store = new MemoryEnvironmentLifecycleStore();
    expect((await store.saveBinding(binding)).kind).toBe('saved');

    for (const changed of [
      { repositoryFullName: 'DotNaos/another-project' },
      { branch: 'issue-999-other-work' },
      { task: 999 }
    ]) {
      expect(await store.saveBinding({ ...binding, ...changed })).toEqual({ kind: 'conflict' });
    }
    expect(await store.readBindingByEnvironment(binding.userId, binding.environmentId!))
      .toEqual(binding);
  });

  test('lists owner bindings and fails closed for duplicate live task targets', async () => {
    const store = new MemoryEnvironmentLifecycleStore();
    await store.saveBinding(binding);
    expect(await store.listBindings(operation.userId)).toEqual([binding]);
    expect(await store.listBindings('another-owner')).toEqual([]);
    expect(await store.readBindingByTask({
      branch: binding.branch,
      providerKind: binding.providerKind,
      repositoryFullName: binding.repositoryFullName.toLowerCase(),
      task: binding.task,
      userId: binding.userId
    })).toEqual(binding);

    await store.saveBinding({
      ...binding,
      environmentId: '55555555-5555-4555-8555-555555555555',
      id: '66666666-6666-4666-8666-666666666666',
      providerResourceId: 'duplicate-space-536'
    });
    await expect(store.readBindingByTask({
      branch: binding.branch,
      providerKind: binding.providerKind,
      repositoryFullName: binding.repositoryFullName,
      task: binding.task,
      userId: binding.userId
    })).rejects.toBeInstanceOf(EnvironmentProviderBindingConflictError);
  });
});

describe('Postgres environment lifecycle store', () => {
  test('reserves under the provider scope and persists all idempotency evidence', async () => {
    const database = new FakeDatabase();
    database.responses.push(
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [{ operation_id: operation.operationId }] }
    );
    const store = new PostgresEnvironmentLifecycleStore(database);

    expect(await store.reserve(operation)).toEqual({ kind: 'new' });
    expect(database.calls[0]?.sql).toContain('pg_advisory_xact_lock');
    const insert = database.calls.find(({ sql }) => (
      sql.includes('insert into environment_lifecycle_operations')
    ));
    expect(insert?.values).toEqual([
      operation.userId,
      operation.operationId,
      operation.providerKind,
      operation.scopeKey,
      operation.action,
      null,
      null,
      operation.fingerprint
    ]);
  });

  test('replays a stored result only for the exact fingerprint', async () => {
    const database = new FakeDatabase();
    database.responses.push(
      { rows: [] },
      { rows: [{
        action: operation.action,
        fingerprint_sha256: operation.fingerprint,
        provider_kind: operation.providerKind,
        result: { operationId: operation.operationId, state: 'provisioning' },
        scope_key: operation.scopeKey,
        state: 'completed'
      }] }
    );
    const store = new PostgresEnvironmentLifecycleStore(database);
    expect(await store.reserve(operation)).toEqual({
      kind: 'replayed',
      result: { operationId: operation.operationId, state: 'provisioning' }
    });
  });

  test('returns a binding conflict instead of moving one provider resource', async () => {
    const database = new FakeDatabase();
    database.responses.push(
      { rows: [] },
      { rows: [{
        branch: binding.branch,
        environment_id: '44444444-4444-4444-8444-444444444444',
        id: binding.id,
        lifecycle_state: binding.lifecycleState,
        native_state: binding.nativeState,
        observed_at: binding.observedAt,
        owner_user_id: binding.userId,
        provider_kind: binding.providerKind,
        provider_resource_id: binding.providerResourceId,
        repository_full_name: binding.repositoryFullName,
        task_number: binding.task
      }] }
    );
    const store = new PostgresEnvironmentLifecycleStore(database);
    expect(await store.saveBinding(binding)).toEqual({ kind: 'conflict' });
    expect(database.calls.some(({ sql }) => (
      sql.includes('insert into environment_provider_bindings')
    ))).toBe(false);
  });

  test('rejects a Postgres provider-resource retarget before its upsert', async () => {
    const database = new FakeDatabase();
    database.responses.push(
      { rows: [] },
      { rows: [{
        branch: 'issue-535-original',
        environment_id: binding.environmentId,
        id: binding.id,
        lifecycle_state: binding.lifecycleState,
        native_state: binding.nativeState,
        observed_at: binding.observedAt,
        owner_user_id: binding.userId,
        provider_kind: binding.providerKind,
        provider_resource_id: binding.providerResourceId,
        repository_full_name: binding.repositoryFullName,
        task_number: binding.task
      }] }
    );
    const store = new PostgresEnvironmentLifecycleStore(database);

    expect(await store.saveBinding(binding)).toEqual({ kind: 'conflict' });
    expect(database.calls.some(({ sql }) => (
      sql.includes('insert into environment_provider_bindings')
    ))).toBe(false);
  });
});
