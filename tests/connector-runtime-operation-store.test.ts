import { describe, expect, test } from 'bun:test';

import type { DatabaseQueryClient } from '../server/database/client';
import {
  MemoryConnectorRuntimeOperationStore,
  PostgresConnectorRuntimeOperationStore
} from '../server/connector-runtime-operation-store';

const createdAt = '2026-07-14T00:00:00.000Z';
const deadlineAt = '2026-07-14T00:05:00.000Z';
const previousFingerprint = {
  buildId: 'build-old',
  bundleVersions: {
    connector: '0.4.0',
    machineTools: '0.4.0',
    projectCli: '0.4.0'
  },
  capabilities: ['runtime.update'],
  instanceId: 'instance-old',
  protocolVersion: '1',
  releaseId: 'v0.4.0',
  version: '0.4.0'
};
const expectedFingerprint = {
  ...previousFingerprint,
  buildId: 'build-next',
  instanceId: 'instance-next',
  releaseId: 'v0.5.0',
  version: '0.5.0'
};

const createInput = {
  deadlineAt,
  expectedBuildId: 'build-next',
  expectedFingerprint,
  expectedReleaseId: 'v0.5.0',
  machineId: 'connector-123',
  operation: 'update' as const,
  previousFingerprint,
  previousInstanceId: 'instance-old',
  requestedByUserId: 'user-1',
  requestedReleaseId: 'v0.5.0',
  target: 'darwin-arm64' as const
};

const acceptedAudit = {
  at: createdAt,
  machineId: 'connector-123',
  operation: 'update' as const,
  outcome: 'accepted' as const,
  releaseId: 'v0.5.0',
  userId: 'user-1'
};

describe('connector runtime operation store', () => {
  test('atomically coalesces only a queued update and controls retained failure evidence', async () => {
    const store = new MemoryConnectorRuntimeOperationStore();
    const operation = await store.createAccepted(createInput, acceptedAudit, createdAt);
    const failure = {
      at: createdAt,
      code: 'download-failed',
      message: 'The earlier target could not be downloaded.',
      rollbackAvailable: false
    };
    await store.transition({
      expectedStates: ['queued'],
      id: operation.id,
      lastFailure: failure,
      state: 'queued',
      updatedAt: createdAt
    });

    const coalescedAt = '2026-07-14T00:01:00.000Z';
    const coalescedDeadline = '2026-07-14T00:06:00.000Z';
    const newestFingerprint = {
      ...expectedFingerprint,
      buildId: 'build-newest',
      instanceId: 'instance-newest',
      releaseId: 'v0.6.0',
      version: '0.6.0'
    };
    const coalesced = await store.coalesceQueuedUpdate({
      deadlineAt: coalescedDeadline,
      expectedBuildId: newestFingerprint.buildId,
      expectedFingerprint: newestFingerprint,
      expectedReleaseId: newestFingerprint.releaseId,
      fromExpectedFingerprint: expectedFingerprint,
      fromExpectedReleaseId: 'v0.5.0',
      fromTarget: 'darwin-arm64',
      id: operation.id,
      preserveLastFailure: true,
      previousFingerprint: expectedFingerprint,
      previousInstanceId: expectedFingerprint.instanceId,
      requestedReleaseId: newestFingerprint.releaseId,
      target: 'linux-x64',
      updatedAt: coalescedAt
    });

    expect(coalesced).toMatchObject({
      deadlineAt: coalescedDeadline,
      expectedBuildId: 'build-newest',
      expectedFingerprint: newestFingerprint,
      expectedReleaseId: 'v0.6.0',
      id: operation.id,
      lastFailure: failure,
      previousFingerprint: expectedFingerprint,
      previousInstanceId: 'instance-next',
      state: 'queued',
      updatedAt: coalescedAt
    });

    expect(await store.coalesceQueuedUpdate({
      deadlineAt: coalescedDeadline,
      expectedBuildId: expectedFingerprint.buildId,
      expectedFingerprint,
      expectedReleaseId: 'v0.5.0',
      fromExpectedFingerprint: expectedFingerprint,
      fromExpectedReleaseId: 'v0.5.0',
      fromTarget: 'darwin-arm64',
      id: operation.id,
      requestedReleaseId: 'v0.5.0',
      target: 'darwin-arm64',
      updatedAt: coalescedAt
    })).toBeNull();
    expect((await store.latest('connector-123'))?.expectedReleaseId).toBe('v0.6.0');

    const withoutFailure = await store.coalesceQueuedUpdate({
      deadlineAt: coalescedDeadline,
      expectedBuildId: newestFingerprint.buildId,
      expectedFingerprint: newestFingerprint,
      expectedReleaseId: newestFingerprint.releaseId,
      fromExpectedFingerprint: newestFingerprint,
      fromExpectedReleaseId: 'v0.6.0',
      fromTarget: 'linux-x64',
      id: operation.id,
      requestedReleaseId: newestFingerprint.releaseId,
      target: 'linux-x64',
      updatedAt: coalescedAt
    });
    expect(withoutFailure?.lastFailure).toBeUndefined();

    await store.transition({
      expectedStates: ['queued'],
      id: operation.id,
      state: 'validating',
      updatedAt: coalescedAt
    });
    expect(await store.coalesceQueuedUpdate({
      deadlineAt: coalescedDeadline,
      expectedBuildId: newestFingerprint.buildId,
      expectedFingerprint: newestFingerprint,
      expectedReleaseId: newestFingerprint.releaseId,
      fromExpectedFingerprint: newestFingerprint,
      fromExpectedReleaseId: 'v0.6.0',
      fromTarget: 'linux-x64',
      id: operation.id,
      requestedReleaseId: newestFingerprint.releaseId,
      target: 'linux-x64',
      updatedAt: coalescedAt
    })).toBeNull();

    const restartStore = new MemoryConnectorRuntimeOperationStore();
    const restart = await restartStore.createAccepted({
      ...createInput,
      operation: 'restart',
      requestedReleaseId: undefined
    }, { ...acceptedAudit, operation: 'restart', releaseId: undefined }, createdAt);
    expect(await restartStore.coalesceQueuedUpdate({
      deadlineAt: coalescedDeadline,
      expectedBuildId: newestFingerprint.buildId,
      expectedFingerprint: newestFingerprint,
      expectedReleaseId: newestFingerprint.releaseId,
      fromExpectedFingerprint: expectedFingerprint,
      fromExpectedReleaseId: 'v0.5.0',
      fromTarget: 'darwin-arm64',
      id: restart.id,
      requestedReleaseId: newestFingerprint.releaseId,
      target: 'linux-x64',
      updatedAt: coalescedAt
    })).toBeNull();
  });

  test('keeps one active operation per machine and preserves durable failure evidence', async () => {
    const store = new MemoryConnectorRuntimeOperationStore();
    const operation = await store.createAccepted(createInput, acceptedAudit, createdAt);

    expect(store.audits[0]).toMatchObject({
      operationId: operation.id,
      outcome: 'accepted'
    });
    await expect(store.createAccepted(createInput, acceptedAudit, createdAt)).rejects.toThrow(
      'already active'
    );

    const failedAt = '2026-07-14T00:01:00.000Z';
    const failure = { at: failedAt, code: 'restart-failed', message: 'Restart failed.' };
    expect(await store.transition({
      expectedStates: ['queued'],
      id: operation.id,
      lastFailure: failure,
      state: 'failed',
      updatedAt: failedAt
    })).toMatchObject({ lastFailure: failure, state: 'failed' });

    const retry = await store.createAccepted(createInput, acceptedAudit, failedAt);
    expect(retry.id).not.toBe(operation.id);
    expect((await store.latest(createInput.machineId))?.id).toBe(retry.id);
    expect(await store.listActive()).toHaveLength(1);
  });

  test('claims a queued dispatch only when every persisted release target still matches', async () => {
    const store = new MemoryConnectorRuntimeOperationStore();
    const operation = await store.createAccepted(createInput, acceptedAudit, createdAt);
    const claim = {
      deadlineAt: '2026-07-14T00:12:00.000Z',
      expectedBuildId: createInput.expectedBuildId,
      expectedFingerprint: createInput.expectedFingerprint,
      expectedReleaseId: createInput.expectedReleaseId,
      id: operation.id,
      requestedReleaseId: createInput.requestedReleaseId,
      startedAt: '2026-07-14T00:02:00.000Z',
      target: createInput.target,
      updatedAt: '2026-07-14T00:02:00.000Z'
    };
    expect(await store.claimQueued({ ...claim, target: 'linux-x64' })).toBeNull();
    expect((await store.latest(createInput.machineId))?.state).toBe('queued');
    expect(await store.claimQueued(claim)).toMatchObject({
      expectedReleaseId: 'v0.5.0', state: 'validating'
    });
    expect(await store.claimQueued(claim)).toBeNull();
  });

  test('writes accepted operation and audit in one Postgres statement', async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const row = {
      created_at: createdAt,
      deadline_at: deadlineAt,
      expected_build_id: 'build-next',
      expected_fingerprint: null,
      expected_release_id: 'v0.5.0',
      finished_at: null,
      id: '11111111-1111-4111-8111-111111111111',
      last_failure: null,
      machine_id: 'connector-123',
      operation: 'update',
      previous_fingerprint: null,
      previous_instance_id: 'instance-old',
      requested_by_user_id: 'user-1',
      started_at: null,
      state: 'queued',
      updated_at: createdAt
    };
    const client: DatabaseQueryClient = {
      async query<Row>(sql, values) {
        calls.push({ sql, values });
        return { rows: [row as Row] };
      }
    };
    const store = new PostgresConnectorRuntimeOperationStore(
      client,
      () => row.id
    );

    expect(await store.createAccepted(createInput, acceptedAudit, createdAt)).toMatchObject({
      id: row.id,
      machineId: 'connector-123',
      state: 'queued'
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("select 'connector-runtime.maintenance-request'");
    expect(calls[0]?.sql).toContain('from inserted');
    expect(calls[0]?.values).toEqual([
      row.id,
      'connector-123',
      'user-1',
      'update',
      'v0.5.0',
      'v0.5.0',
      'build-next',
      'instance-old',
      previousFingerprint,
      expectedFingerprint,
      'darwin-arm64',
      deadlineAt,
      createdAt,
      'connector-123',
      'user-1',
      'update',
      'accepted',
      null,
      'v0.5.0',
      createdAt
    ]);
  });

  test('guards the Postgres dispatch claim with the complete persisted target', async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const row = {
      created_at: createdAt, deadline_at: deadlineAt, expected_build_id: 'build-next',
      expected_fingerprint: expectedFingerprint, expected_release_id: 'v0.5.0',
      finished_at: null, id: '11111111-1111-4111-8111-111111111111',
      last_failure: null, machine_id: 'connector-123', operation: 'update',
      previous_fingerprint: previousFingerprint, previous_instance_id: 'instance-old',
      requested_by_user_id: 'user-1', started_at: createdAt, state: 'validating',
      updated_at: createdAt
    };
    const store = new PostgresConnectorRuntimeOperationStore({
      async query<Row>(sql, values) {
        calls.push({ sql, values });
        return { rows: [row as Row] };
      }
    });
    await store.claimQueued({
      deadlineAt,
      expectedBuildId: 'build-next',
      expectedFingerprint,
      expectedReleaseId: 'v0.5.0',
      id: row.id,
      requestedReleaseId: 'v0.5.0',
      startedAt: createdAt,
      target: 'darwin-arm64',
      updatedAt: createdAt
    });
    expect(calls[0]?.sql).toContain('requested_release_id is not distinct from $2');
    expect(calls[0]?.sql).toContain('expected_fingerprint is not distinct from $5');
    expect(calls[0]?.sql).toContain('target = $6');
    expect(calls[0]?.values).toEqual([
      row.id, 'v0.5.0', 'v0.5.0', 'build-next', expectedFingerprint,
      'darwin-arm64', createdAt, deadlineAt, createdAt
    ]);
  });

  test('coalesces a queued Postgres update in one guarded statement', async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const coalescedAt = '2026-07-14T00:01:00.000Z';
    const coalescedDeadline = '2026-07-14T00:06:00.000Z';
    const newestFingerprint = {
      ...expectedFingerprint,
      buildId: 'build-newest',
      instanceId: 'instance-newest',
      releaseId: 'v0.6.0',
      version: '0.6.0'
    };
    const row = {
      created_at: createdAt,
      deadline_at: coalescedDeadline,
      expected_build_id: newestFingerprint.buildId,
      expected_fingerprint: newestFingerprint,
      expected_release_id: newestFingerprint.releaseId,
      finished_at: null,
      id: '11111111-1111-4111-8111-111111111111',
      last_failure: null,
      machine_id: 'connector-123',
      operation: 'update',
      previous_fingerprint: expectedFingerprint,
      previous_instance_id: expectedFingerprint.instanceId,
      requested_by_user_id: 'user-1',
      started_at: null,
      state: 'queued',
      updated_at: coalescedAt
    };
    const client: DatabaseQueryClient = {
      async query<Row>(sql, values) {
        calls.push({ sql, values });
        return { rows: [row as Row] };
      }
    };
    const store = new PostgresConnectorRuntimeOperationStore(client);
    const coalesceInput = {
      deadlineAt: coalescedDeadline,
      expectedBuildId: newestFingerprint.buildId,
      expectedFingerprint: newestFingerprint,
      expectedReleaseId: newestFingerprint.releaseId,
      fromExpectedFingerprint: expectedFingerprint,
      fromExpectedReleaseId: 'v0.5.0',
      fromTarget: 'darwin-arm64',
      id: row.id,
      preserveLastFailure: true,
      previousFingerprint: expectedFingerprint,
      previousInstanceId: expectedFingerprint.instanceId,
      requestedReleaseId: newestFingerprint.releaseId,
      target: 'linux-x64' as const,
      updatedAt: coalescedAt
    };

    expect(await store.coalesceQueuedUpdate(coalesceInput)).toMatchObject({
      deadlineAt: coalescedDeadline,
      expectedBuildId: newestFingerprint.buildId,
      expectedReleaseId: newestFingerprint.releaseId,
      state: 'queued'
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("operation = 'update' and state = 'queued'");
    expect(calls[0]?.sql).toContain(
      'last_failure = case when $10 then last_failure else null end'
    );
    expect(calls[0]?.values).toEqual([
      row.id,
      'v0.6.0',
      'v0.6.0',
      'build-newest',
      newestFingerprint,
      expectedFingerprint,
      'instance-next',
      'linux-x64',
      coalescedDeadline,
      true,
      coalescedAt,
      'v0.5.0',
      expectedFingerprint,
      'darwin-arm64'
    ]);

    const racedStore = new PostgresConnectorRuntimeOperationStore({
      async query<Row>() {
        return { rows: [] as Row[] };
      }
    });
    expect(await racedStore.coalesceQueuedUpdate(coalesceInput)).toBeNull();
  });

  test('can reset the operation deadline when dispatch really starts', async () => {
    const dispatchAt = '2026-07-14T00:02:00.000Z';
    const dispatchDeadline = '2026-07-14T00:12:00.000Z';
    const memoryStore = new MemoryConnectorRuntimeOperationStore();
    const memoryOperation = await memoryStore.createAccepted(
      createInput,
      acceptedAudit,
      createdAt
    );
    expect(await memoryStore.transition({
      deadlineAt: dispatchDeadline,
      expectedStates: ['queued'],
      id: memoryOperation.id,
      startedAt: dispatchAt,
      state: 'validating',
      updatedAt: dispatchAt
    })).toMatchObject({
      deadlineAt: dispatchDeadline,
      startedAt: dispatchAt,
      state: 'validating'
    });

    const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const row = {
      created_at: createdAt,
      deadline_at: dispatchDeadline,
      expected_build_id: 'build-next',
      expected_fingerprint: expectedFingerprint,
      expected_release_id: 'v0.5.0',
      finished_at: null,
      id: memoryOperation.id,
      last_failure: null,
      machine_id: 'connector-123',
      operation: 'update',
      previous_fingerprint: previousFingerprint,
      previous_instance_id: 'instance-old',
      requested_by_user_id: 'user-1',
      started_at: dispatchAt,
      state: 'validating',
      updated_at: dispatchAt
    };
    const postgresStore = new PostgresConnectorRuntimeOperationStore({
      async query<Row>(sql, values) {
        calls.push({ sql, values });
        return { rows: [row as Row] };
      }
    });
    expect(await postgresStore.transition({
      deadlineAt: dispatchDeadline,
      expectedStates: ['queued'],
      id: row.id,
      startedAt: dispatchAt,
      state: 'validating',
      updatedAt: dispatchAt
    })).toMatchObject({ deadlineAt: dispatchDeadline, state: 'validating' });
    expect(calls[0]?.sql).toContain('deadline_at = coalesce($8, deadline_at)');
    expect(calls[0]?.values).toEqual([
      row.id,
      ['queued'],
      'validating',
      false,
      null,
      dispatchAt,
      null,
      dispatchDeadline,
      dispatchAt
    ]);
  });

  test('always records rejected requests with the fixed audit action', async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const client: DatabaseQueryClient = {
      async query<Row>(sql, values) {
        calls.push({ sql, values });
        return { rows: [] as Row[] };
      }
    };
    const store = new PostgresConnectorRuntimeOperationStore(client);
    await store.recordRejection({
      at: createdAt,
      machineId: 'connector-123',
      operation: 'restart',
      outcome: 'rejected',
      reason: 'forbidden',
      userId: 'user-2'
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain(
      "values ('connector-runtime.maintenance-request',$1,$2,$3,$4,$5,$6,$7,$8)"
    );
    expect(calls[0]?.values).toEqual([
      'connector-123', 'user-2', 'restart', null, 'rejected', 'forbidden', null, createdAt
    ]);
  });
});
