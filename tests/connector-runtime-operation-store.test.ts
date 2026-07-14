import { describe, expect, test } from 'bun:test';

import type { DatabaseQueryClient } from '../server/database/client';
import {
  MemoryConnectorRuntimeOperationStore,
  PostgresConnectorRuntimeOperationStore
} from '../server/connector-runtime-operation-store';

const createdAt = '2026-07-14T00:00:00.000Z';
const deadlineAt = '2026-07-14T00:05:00.000Z';

const createInput = {
  deadlineAt,
  expectedBuildId: 'build-next',
  expectedReleaseId: 'v0.5.0',
  machineId: 'connector-123',
  operation: 'update' as const,
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
    expect(calls[0]?.values).toContain('darwin-arm64');
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
