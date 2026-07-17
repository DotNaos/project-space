import { describe, expect, test } from 'bun:test';

import { PostgresCodexMachineTasksStore } from '../server/codex-machine-tasks/store';
import type { CodexMachineTaskStartOperation } from '../server/codex-machine-tasks/service';
import type { DatabaseQueryClient, DatabaseQueryResult } from '../server/database/client';

class FakeDatabase implements DatabaseQueryClient {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  readonly responses: Array<DatabaseQueryResult<unknown>> = [];

  async query<Row>(sql: string, values: readonly unknown[] = []) {
    this.calls.push({ sql, values });
    return (this.responses.shift() ?? { rows: [] }) as DatabaseQueryResult<Row>;
  }

  async transaction<Result>(operation: (client: DatabaseQueryClient) => Promise<Result>) {
    return operation(this);
  }
}

const operation: CodexMachineTaskStartOperation = {
  associationKey: 'a'.repeat(64),
  connectorId: 'connector-one',
  durableOperations: true,
  fingerprint: 'b'.repeat(64),
  generation: 4,
  operationId: 'start-operation-one',
  physicalMachineId: 'physical-one',
  startPayload: {
    branch: 'issue-262-work',
    commit: 'c'.repeat(40),
    issue: { number: 262, url: 'https://github.com/DotNaos/project-space/issues/262' },
    repository: { id: 'R_one', nameWithOwner: 'DotNaos/project-space' }
  },
  state: 'pending',
  userId: 'user-owner'
};

const completed = {
  apiVersion: 1 as const,
  operationId: operation.operationId,
  state: 'confirmed' as const,
  task: {
    canonicalTaskUrl: 'https://projects.example/codex/machines/connector-one/threads/019f6d33-6aad-7302-a45e-bb7a33fc399c',
    connector: { generation: 4, id: 'connector-one', name: 'Connector' },
    issue: { number: 262, url: 'https://github.com/DotNaos/project-space/issues/262' },
    physicalMachine: { id: 'physical-one', name: 'Machine' },
    repository: { id: 'R_one', nameWithOwner: 'DotNaos/project-space' },
    threadId: '019f6d33-6aad-7302-a45e-bb7a33fc399c',
    worktree: { branch: 'issue-262-work', id: 'worktree-one' }
  }
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    dispatch_operation_id: operation.operationId,
    connector_generation: operation.generation,
    connector_id: operation.connectorId,
    durable_operations: operation.durableOperations,
    physical_machine_id: operation.physicalMachineId,
    start_payload: operation.startPayload,
    result: completed,
    state: 'completed',
    ...overrides
  };
}

describe('Codex machine-task durable start store', () => {
  test('persists the immutable resolved start payload with a new reservation', async () => {
    const database = new FakeDatabase();
    database.responses.push(
      { rows: [{ association_key: operation.associationKey }] },
      { rows: [{ operation_id: operation.operationId }] },
      { rows: [{ association_key: operation.associationKey, fingerprint_sha256: operation.fingerprint }] },
      { rows: [row({ result: null, state: 'pending' })] }
    );

    expect(await new PostgresCodexMachineTasksStore(database).reserveStart(operation))
      .toEqual({ kind: 'new' });
    const insert = database.calls.find((call) => call.sql.includes('start_payload'));
    expect(insert?.values[7]).toBe(JSON.stringify(operation.startPayload));
  });

  test('looks up completed and reserved starts before live dependencies', async () => {
    const replayDatabase = new FakeDatabase();
    replayDatabase.responses.push({ rows: [{
      ...row(),
      fingerprint_sha256: operation.fingerprint
    }] });
    expect(await new PostgresCodexMachineTasksStore(replayDatabase).lookupStart({
      fingerprint: operation.fingerprint,
      operationId: operation.operationId,
      userId: operation.userId
    })).toEqual({ kind: 'replayed', result: completed });

    const reservedDatabase = new FakeDatabase();
    const sha256Payload = { ...operation.startPayload, commit: 'd'.repeat(64) };
    reservedDatabase.responses.push({ rows: [{
      ...row({ result: null, start_payload: sha256Payload, state: 'uncertain' }),
      fingerprint_sha256: operation.fingerprint
    }] });
    expect(await new PostgresCodexMachineTasksStore(reservedDatabase).lookupStart({
      fingerprint: operation.fingerprint,
      operationId: operation.operationId,
      userId: operation.userId
    })).toEqual({
      durableOperations: true,
      connectorId: operation.connectorId,
      generation: 4,
      kind: 'reserved',
      physicalMachineId: operation.physicalMachineId,
      startPayload: sha256Payload,
      state: 'uncertain'
    });
  });

  test('rejects changed input during an early start lookup', async () => {
    const database = new FakeDatabase();
    database.responses.push({ rows: [{
      ...row(),
      fingerprint_sha256: operation.fingerprint
    }] });
    expect(await new PostgresCodexMachineTasksStore(database).lookupStart({
      fingerprint: 'c'.repeat(64),
      operationId: operation.operationId,
      userId: operation.userId
    })).toEqual({ kind: 'conflict' });
  });

  test('rejects a reused operation id before replaying a completed result', async () => {
    const database = new FakeDatabase();
    database.responses.push(
      { rows: [] },
      { rows: [] },
      { rows: [{ association_key: operation.associationKey, fingerprint_sha256: 'c'.repeat(64) }] }
    );

    expect(await new PostgresCodexMachineTasksStore(database).reserveStart(operation)).toEqual({
      kind: 'conflict'
    });
  });

  test('replays a completed association under a new operation id', async () => {
    const database = new FakeDatabase();
    database.responses.push(
      { rows: [] },
      { rows: [{ operation_id: 'start-operation-two' }] },
      { rows: [{ association_key: operation.associationKey, fingerprint_sha256: 'd'.repeat(64) }] },
      { rows: [row()] }
    );

    expect(await new PostgresCodexMachineTasksStore(database).reserveStart({
      ...operation,
      fingerprint: 'd'.repeat(64),
      operationId: 'start-operation-two'
    })).toEqual({ kind: 'replayed', result: completed });
  });

  test('preserves an uncertain association under a new operation id', async () => {
    const database = new FakeDatabase();
    database.responses.push(
      { rows: [] },
      { rows: [{ operation_id: 'start-operation-two' }] },
      { rows: [{ association_key: operation.associationKey, fingerprint_sha256: 'd'.repeat(64) }] },
      { rows: [row({ result: null, state: 'uncertain' })] }
    );

    expect(await new PostgresCodexMachineTasksStore(database).reserveStart({
      ...operation,
      fingerprint: 'd'.repeat(64),
      operationId: 'start-operation-two'
    })).toEqual({
      durableOperations: true,
      generation: 4,
      kind: 'uncertain',
      sameOperation: false
    });
  });

  test('allows only the original operation to reconcile an uncertain start', async () => {
    const database = new FakeDatabase();
    database.responses.push(
      { rows: [] },
      { rows: [] },
      { rows: [{ association_key: operation.associationKey, fingerprint_sha256: operation.fingerprint }] },
      { rows: [row({ result: null, state: 'uncertain' })] }
    );

    expect(await new PostgresCodexMachineTasksStore(database).reserveStart(operation)).toEqual({
      generation: 4,
      durableOperations: true,
      kind: 'uncertain',
      sameOperation: true
    });
  });

  test('durably rejects a replay alias reused for another association', async () => {
    const database = new FakeDatabase();
    const anotherAssociation = 'e'.repeat(64);
    database.responses.push(
      { rows: [{ association_key: anotherAssociation }] },
      { rows: [] },
      { rows: [{ association_key: operation.associationKey, fingerprint_sha256: 'd'.repeat(64) }] },
      { rows: [] }
    );

    expect(await new PostgresCodexMachineTasksStore(database).reserveStart({
      ...operation,
      associationKey: anotherAssociation,
      fingerprint: 'f'.repeat(64),
      operationId: 'start-operation-two'
    })).toEqual({ kind: 'conflict' });
  });
});

describe('Codex machine-task durable send store', () => {
  const send = {
    connectorId: 'connector-one',
    durableOperations: true,
    fingerprint: 'f'.repeat(64),
    generation: 9,
    operationId: 'send-operation-one',
    threadId: completed.task.threadId,
    userId: 'user-owner'
  };

  test('reserves a new send and restores its original generation for reconciliation', async () => {
    const fresh = new FakeDatabase();
    fresh.responses.push({ rows: [{ operation_id: send.operationId }] });
    expect(await new PostgresCodexMachineTasksStore(fresh).reserveSend(send)).toEqual({
      kind: 'new'
    });

    const uncertain = new FakeDatabase();
    uncertain.responses.push({ rows: [] }, { rows: [{
      connector_generation: '9', connector_id: send.connectorId,
      durable_operations: true,
      fingerprint_sha256: send.fingerprint, operation_id: send.operationId,
      result: null, state: 'uncertain', thread_id: send.threadId
    }] });
    expect(await new PostgresCodexMachineTasksStore(uncertain).reserveSend(send)).toEqual({
      generation: 9,
      durableOperations: true,
      kind: 'uncertain'
    });
  });

  test('fences another operation while an uncertain turn remains', async () => {
    const database = new FakeDatabase();
    database.responses.push({ rows: [] }, { rows: [{
      connector_generation: 9, connector_id: send.connectorId,
      durable_operations: true,
      fingerprint_sha256: send.fingerprint, operation_id: 'send-operation-earlier',
      result: null, state: 'uncertain', thread_id: send.threadId
    }] });
    expect(await new PostgresCodexMachineTasksStore(database).reserveSend(send)).toEqual({
      kind: 'fenced'
    });
  });
});
