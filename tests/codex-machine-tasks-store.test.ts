import { describe, expect, test } from 'bun:test';

import { PostgresCodexMachineTasksStore } from '../server/codex-machine-tasks/store';
import type {
  CodexMachineTaskSendOperation,
  CodexMachineTaskStartOperation
} from '../server/codex-machine-tasks/service';
import type { DatabaseQueryClient, DatabaseQueryResult } from '../server/database/client';

class FakeDatabase implements DatabaseQueryClient {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  readonly responses: Array<DatabaseQueryResult<unknown>> = [];
  environmentBindingId?: string;
  environmentLifecycleState = 'running';
  lifecycleBlocked = false;

  async query<Row>(sql: string, values: readonly unknown[] = []) {
    this.calls.push({ sql, values });
    if (sql.includes('as admitted')) {
      return { rows: [{
        admitted: this.environmentLifecycleState === 'running' && !this.lifecycleBlocked
      }] } as DatabaseQueryResult<Row>;
    }
    if (sql.includes('from environment_provider_bindings') ||
        sql.includes('join environment_provider_bindings')) {
      return { rows: this.environmentBindingId
        ? [{ environment_id: this.environmentBindingId }]
        : [] } as DatabaseQueryResult<Row>;
    }
    if (sql.includes('pg_advisory_xact_lock')) {
      return { rows: [] } as DatabaseQueryResult<Row>;
    }
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
  test('finds a completed issue association by repository id or full name', async () => {
    const database = new FakeDatabase();
    database.responses.push({ rows: [row()] });

    expect(await new PostgresCodexMachineTasksStore(database).findStart({
      connectorId: operation.connectorId,
      issue: operation.startPayload.issue.number,
      repositoryId: operation.startPayload.repository.nameWithOwner,
      userId: operation.userId
    })).toEqual({ kind: 'confirmed', result: completed });
    expect(database.calls[0]?.sql).toContain("start_payload->'repository'->>'nameWithOwner'");
    expect(database.calls[0]?.values).toEqual([
      operation.userId,
      operation.connectorId,
      String(operation.startPayload.issue.number),
      operation.startPayload.repository.nameWithOwner
    ]);
  });

  test('fences a start while its Environment is stopping or being deleted', async () => {
    const database = new FakeDatabase();
    database.environmentBindingId = '019f6d33-6aad-7302-a45e-bb7a33fc399c';
    database.lifecycleBlocked = true;

    expect(await new PostgresCodexMachineTasksStore(database).reserveStart(operation))
      .toEqual({ kind: 'fenced' });
    expect(database.calls.some(({ sql }) => sql.includes('insert into codex_machine_task_starts')))
      .toBe(false);
  });

  test('fences a start unless its provider Environment is running', async () => {
    const database = new FakeDatabase();
    database.environmentBindingId = '019f6d33-6aad-7302-a45e-bb7a33fc399c';
    database.environmentLifecycleState = 'stopped';

    expect(await new PostgresCodexMachineTasksStore(database).reserveStart(operation))
      .toEqual({ kind: 'fenced' });
    expect(database.calls.some(({ sql }) => sql.includes('insert into codex_machine_task_starts')))
      .toBe(false);
  });

  test('releases an exact uncertain start and all of its operation aliases', async () => {
    const database = new FakeDatabase();
    database.responses.push(
      { rows: [{
        association_key: operation.associationKey,
        fingerprint_sha256: operation.fingerprint,
        state: 'uncertain'
      }] },
      { rows: [] },
      { rows: [{ association_key: operation.associationKey }] }
    );

    expect(await new PostgresCodexMachineTasksStore(database).releaseUncertainStart({
      fingerprint: operation.fingerprint,
      operationId: operation.operationId,
      userId: operation.userId
    })).toBe('released');
    expect(database.calls[1]?.sql).toContain('delete from codex_machine_task_start_operations');
    expect(database.calls[2]?.sql).toContain("and state = 'uncertain'");
    expect(database.calls[1]?.values).toEqual([operation.userId, operation.associationKey]);
  });

  test('does not release an uncertain start for changed input', async () => {
    const database = new FakeDatabase();
    database.responses.push({ rows: [{
      association_key: operation.associationKey,
      fingerprint_sha256: operation.fingerprint,
      state: 'uncertain'
    }] });

    expect(await new PostgresCodexMachineTasksStore(database).releaseUncertainStart({
      fingerprint: 'f'.repeat(64),
      operationId: operation.operationId,
      userId: operation.userId
    })).toBe('conflict');
    expect(database.calls).toHaveLength(1);
  });

  test('does not release a start that is still pending', async () => {
    const database = new FakeDatabase();
    database.responses.push({ rows: [{
      association_key: operation.associationKey,
      fingerprint_sha256: operation.fingerprint,
      state: 'pending'
    }] });

    expect(await new PostgresCodexMachineTasksStore(database).releaseUncertainStart({
      fingerprint: operation.fingerprint,
      operationId: operation.operationId,
      userId: operation.userId
    })).toBe('not_uncertain');
    expect(database.calls).toHaveLength(1);
  });

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
      dispatchOperationId: operation.operationId,
      durableOperations: true,
      generation: 4,
      kind: 'uncertain',
      sameOperation: false,
      startPayload: operation.startPayload
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
      dispatchOperationId: operation.operationId,
      generation: 4,
      durableOperations: true,
      kind: 'uncertain',
      sameOperation: true,
      startPayload: operation.startPayload
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
  const send: CodexMachineTaskSendOperation = {
    connectorId: 'connector-one',
    dispatchAttempt: 0,
    durableOperations: true,
    fingerprint: 'f'.repeat(64),
    generation: 9,
    operationId: 'send-operation-one',
    request: {
      message: 'Please continue with the implementation.',
      mode: 'queue',
      target: { physicalMachineId: 'physical-one' }
    },
    threadId: completed.task.threadId,
    userId: 'user-owner'
  };

  test('reserves a new send and restores its original generation for reconciliation', async () => {
    const fresh = new FakeDatabase();
    fresh.responses.push({ rows: [{ operation_id: send.operationId }] });
    expect(await new PostgresCodexMachineTasksStore(fresh).reserveSend(send)).toEqual({
      kind: 'new'
    });
    expect(fresh.calls.find(({ sql }) => sql.includes('insert into codex_machine_task_sends'))?.values)
      .toContain(JSON.stringify(send.request));

    const uncertain = new FakeDatabase();
    uncertain.responses.push({ rows: [] }, { rows: [{
      connector_generation: '9', connector_id: send.connectorId,
      dispatch_attempt: 3,
      durable_operations: true,
      fingerprint_sha256: send.fingerprint, operation_id: send.operationId,
      result: null, state: 'uncertain', thread_id: send.threadId
    }] });
    expect(await new PostgresCodexMachineTasksStore(uncertain).reserveSend(send)).toEqual({
      dispatchAttempt: 3,
      generation: 9,
      durableOperations: true,
      kind: 'uncertain'
    });
  });

  test('fences another operation only while a pending dispatch remains', async () => {
    const database = new FakeDatabase();
    database.responses.push({ rows: [] }, { rows: [{
      connector_generation: 9, connector_id: send.connectorId,
      durable_operations: true,
      fingerprint_sha256: send.fingerprint, operation_id: 'send-operation-earlier',
      result: null, state: 'pending', thread_id: send.threadId
    }] });
    expect(await new PostgresCodexMachineTasksStore(database).reserveSend(send)).toEqual({
      kind: 'fenced'
    });
    const lookup = database.calls.find(({ sql }) => sql.includes('order by (operation_id = $2)'));
    expect(lookup?.sql).toContain("thread_id = $4 and state = 'pending'");
    expect(lookup?.sql).not.toContain("state in ('pending', 'uncertain')");
  });

  test('replays the durable queued result for the same operation and payload', async () => {
    const database = new FakeDatabase();
    const queuedResult = {
      apiVersion: 1 as const,
      delivery: 'queued' as const,
      operationId: send.operationId,
      state: 'queued' as const,
      target: {
        connector: { generation: send.generation, id: send.connectorId, name: 'Connector' },
        physicalMachine: { id: 'physical-one', name: 'Machine' }
      },
      threadId: send.threadId
    };
    database.responses.push({ rows: [] }, { rows: [{
      connector_generation: send.generation,
      connector_id: send.connectorId,
      durable_operations: send.durableOperations,
      fingerprint_sha256: send.fingerprint,
      operation_id: send.operationId,
      request_payload: send.request,
      result: queuedResult,
      state: 'queued',
      thread_id: send.threadId
    }] });

    expect(await new PostgresCodexMachineTasksStore(database).reserveSend(send)).toEqual({
      kind: 'replayed',
      result: queuedResult
    });
  });

  test('rejects a changed payload when an operation id is reused', async () => {
    const database = new FakeDatabase();
    database.responses.push({ rows: [] }, { rows: [{
      connector_generation: send.generation,
      connector_id: send.connectorId,
      durable_operations: send.durableOperations,
      fingerprint_sha256: 'a'.repeat(64),
      operation_id: send.operationId,
      request_payload: { message: 'Different', mode: 'queue' },
      result: null,
      state: 'queued',
      thread_id: send.threadId
    }] });

    expect(await new PostgresCodexMachineTasksStore(database).reserveSend(send)).toEqual({
      kind: 'conflict'
    });
  });

  test('queues, claims, and completes the same durable operation', async () => {
    const queuedResult = {
      apiVersion: 1 as const,
      delivery: 'queued' as const,
      operationId: send.operationId,
      state: 'queued' as const,
      target: {
        connector: { generation: send.generation, id: send.connectorId, name: 'Connector' },
        physicalMachine: { id: 'physical-one', name: 'Machine' }
      },
      threadId: send.threadId
    };
    const queued = new FakeDatabase();
    queued.responses.push({ rows: [{ operation_id: send.operationId }] });
    await new PostgresCodexMachineTasksStore(queued).markSendQueued(send, queuedResult);
    expect(queued.calls[0]?.sql).toContain("state in ('pending', 'queued', 'uncertain')");

    const claimed = new FakeDatabase();
    claimed.responses.push({ rows: [{ dispatch_attempt: 1 }] });
    expect(await new PostgresCodexMachineTasksStore(claimed).claimQueuedSend(send)).toBe(1);
    const claim = claimed.calls.find(({ sql }) => sql.includes("set state = 'pending'"));
    expect(claim?.sql).toContain("pending.state = 'pending'");
    expect(claim?.sql).toContain('dispatch_attempt = dispatch_attempt + 1');
    expect(claim?.values[4]).toBe(send.generation);

    const completedSend = new FakeDatabase();
    completedSend.responses.push({ rows: [{ operation_id: send.operationId }] });
    await new PostgresCodexMachineTasksStore(completedSend).completeSend(send, queuedResult);
    expect(completedSend.calls[0]?.sql).toContain(
      "state in ('pending', 'queued', 'uncertain')"
    );

    const reconciledSend = new FakeDatabase();
    reconciledSend.responses.push({ rows: [{ operation_id: send.operationId }] });
    await new PostgresCodexMachineTasksStore(reconciledSend)
      .completeSend(send, queuedResult, 11);
    expect(reconciledSend.calls[0]?.values[4]).toBe(send.generation);
    expect(reconciledSend.calls[0]?.values[8]).toBe(11);

    const concurrentlyCompleted = new FakeDatabase();
    concurrentlyCompleted.responses.push({ rows: [] }, { rows: [{ state: 'completed' }] });
    await expect(new PostgresCodexMachineTasksStore(concurrentlyCompleted)
      .completeSend(send, queuedResult)).resolves.toBeUndefined();

    const uncertainSend = new FakeDatabase();
    uncertainSend.responses.push({ rows: [{ operation_id: send.operationId }] });
    await new PostgresCodexMachineTasksStore(uncertainSend).markSendUncertain(send);
    expect(uncertainSend.calls[0]?.sql).toContain(
      "state in ('pending', 'queued', 'uncertain')"
    );
  });

  test('restores queued requests in FIFO order', async () => {
    const database = new FakeDatabase();
    database.responses.push({ rows: [
      {
        connector_generation: '9', connector_id: send.connectorId,
        durable_operations: true, fingerprint_sha256: send.fingerprint,
        operation_id: send.operationId, owner_user_id: send.userId,
        request_payload: send.request, result: null, state: 'queued', thread_id: send.threadId
      },
      {
        connector_generation: '9', connector_id: send.connectorId,
        durable_operations: true, fingerprint_sha256: 'e'.repeat(64),
        operation_id: 'send-operation-two', owner_user_id: send.userId,
        request_payload: {
          message: 'And then verify it.', mode: 'queue',
          target: { physicalMachineId: 'physical-one' }
        },
        result: null, state: 'queued', thread_id: send.threadId
      }
    ] });

    expect(await new PostgresCodexMachineTasksStore(database).listQueuedSends()).toEqual([
      send,
      {
        ...send,
        fingerprint: 'e'.repeat(64),
        operationId: 'send-operation-two',
        request: {
          message: 'And then verify it.', mode: 'queue',
          target: { physicalMachineId: 'physical-one' }
        }
      }
    ]);
    expect(database.calls[0]?.sql).toContain('order by created_at, operation_id');
  });

  test('restores claimed pending requests for restart reconciliation', async () => {
    const database = new FakeDatabase();
    database.responses.push({ rows: [{
      connector_generation: '9', connector_id: send.connectorId,
      durable_operations: true, fingerprint_sha256: send.fingerprint,
      operation_id: send.operationId, owner_user_id: send.userId,
      request_payload: send.request, result: null, state: 'pending', thread_id: send.threadId
    }] });

    expect(await new PostgresCodexMachineTasksStore(database).listPendingSends()).toEqual([send]);
    expect(database.calls[0]?.sql).toContain("state = 'pending'");
    expect(database.calls[0]?.sql).toContain('request_payload is not null');
  });

  test('returns the oldest queued request for one thread', async () => {
    const database = new FakeDatabase();
    database.responses.push({ rows: [{
      connector_generation: '9', connector_id: send.connectorId,
      durable_operations: true, fingerprint_sha256: send.fingerprint,
      operation_id: send.operationId, request_payload: send.request,
      result: null, state: 'queued', thread_id: send.threadId
    }] });

    expect(await new PostgresCodexMachineTasksStore(database).nextQueuedSend({
      connectorId: send.connectorId,
      threadId: send.threadId,
      userId: send.userId
    })).toEqual(send);
    expect(database.calls[0]?.sql).toContain('order by created_at, operation_id');
    expect(database.calls[0]?.sql).toContain('limit 1');
  });

  test('fences a send unless its provider Environment is running', async () => {
    const database = new FakeDatabase();
    database.environmentBindingId = '019f6d33-6aad-7302-a45e-bb7a33fc399c';
    database.environmentLifecycleState = 'stopping';

    expect(await new PostgresCodexMachineTasksStore(database).reserveSend(send)).toEqual({
      kind: 'fenced'
    });
    expect(database.calls.some(({ sql }) => sql.includes('insert into codex_machine_task_sends')))
      .toBe(false);
  });
});
