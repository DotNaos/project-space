import { describe, expect, test } from 'bun:test';

import type { DatabaseQueryClient } from '../server/database/client';
import type { HostControlAuditIdentity } from '../server/host-control/contracts';
import { PostgresHostControlOperationStore } from '../server/host-control/postgres-store';

const hostId = '10000000-0000-4000-8000-000000000001';
const audit: HostControlAuditIdentity = {
  actorId: 'connector-os-macbook',
  actorKind: 'machine',
  approvalId: 'approval-one',
  auditId: '20000000-0000-4000-8000-000000000002',
  bindingRevision: 'b'.repeat(64),
  capability: 'host.console.key',
  effectiveRisk: 'boot',
  hostId,
  operationId: 'console-one',
  ownerUserId: 'owner-one',
  policyDecisionId: 'decision-one',
  policyExpiresAt: '2026-08-12T10:00:05.000Z',
  providerId: 'jetkvm-os-pc'
};
const reservation = {
  audit,
  attemptId: '30000000-0000-4000-8000-000000000003',
  fingerprint: 'a'.repeat(64),
  rateLimit: 30,
  reservedAt: '2026-08-12T10:00:00.000Z',
  reservedUntil: '2026-08-12T10:00:30.000Z'
};

describe('Postgres Host control audit store', () => {
  test('reserves, rate checks, dispatches, and completes one exact typed audit', async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const client: DatabaseQueryClient = {
      async query<Row>(sql: string, values: readonly unknown[] = []) {
        calls.push({ sql, values });
        if (sql.includes('count(*)')) return { rows: [{ count: '0' }] as Row[] };
        if (sql.includes('update host_control_operations')) return { rowCount: 1, rows: [] as Row[] };
        return { rows: [] as Row[] };
      },
      async transaction<Result>(operation: (transaction: DatabaseQueryClient) => Promise<Result>) {
        return operation(client);
      }
    };
    const store = new PostgresHostControlOperationStore(client);

    await expect(store.reserve(reservation)).resolves.toEqual({ kind: 'new' });
    expect(calls.slice(0, 2).map(({ values }) => values[0])).toEqual([
      'host-control-operation:owner-one:console-one',
      `host-control-host:owner-one:${hostId}`
    ]);
    const insert = calls.find(({ sql }) => sql.includes('insert into host_control_operations'));
    expect(insert?.values).toEqual([
      'owner-one', 'console-one', hostId, 'machine', 'connector-os-macbook',
      'host.console.key', 'boot', 'approval-one', 'decision-one',
      '2026-08-12T10:00:05.000Z', 'jetkvm-os-pc', 'b'.repeat(64), 'a'.repeat(64),
      '20000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000003',
      '2026-08-12T10:00:30.000Z',
      '2026-08-12T10:00:00.000Z'
    ]);
    expect(calls.find(({ sql }) => sql.includes('count(*)'))).toBeDefined();

    await expect(store.markDispatchAttempted({
      audit, attemptId: reservation.attemptId,
      dispatchedAt: '2026-08-12T10:00:01.000Z',
      dispatchedUntil: '2026-08-12T10:00:31.000Z', fingerprint: reservation.fingerprint
    }))
      .resolves.toBe('marked');
    await expect(store.finish({
      audit,
      attemptId: reservation.attemptId,
      fingerprint: reservation.fingerprint,
      result: {
        auditId: audit.auditId,
        completedAt: '2026-08-12T10:00:01.000Z',
        hostId,
        message: 'Host operation completed.',
        operationId: audit.operationId,
        provider: { id: audit.providerId, kind: 'jetkvm' },
        replayed: false,
        schemaVersion: 1,
        state: 'completed'
      }
    })).resolves.toBeUndefined();
    expect(calls.some(({ sql }) => sql.includes("state = 'dispatching'"))).toBe(true);
    expect(calls.some(({ sql }) => sql.includes('result_message = $6'))).toBe(true);
    expect(calls.every(({ sql }) => !sql.includes('result jsonb'))).toBe(true);
  });

  test('returns exact terminal replay before consulting the rate window', async () => {
    const calls: string[] = [];
    const row = operationRow();
    const client = transactionalClient(async <Row>(sql: string) => {
      calls.push(sql);
      if (sql.includes('for update')) return { rows: [row] as Row[] };
      return { rows: [] as Row[] };
    });
    const store = new PostgresHostControlOperationStore(client);
    await expect(store.reserve(reservation)).resolves.toMatchObject({
      kind: 'replayed',
      result: {
        auditId: audit.auditId, message: 'Host operation completed.', replayed: false, state: 'completed'
      }
    });
    expect(calls.some((sql) => sql.includes('count(*)'))).toBe(false);
  });

  test('fails closed on malformed persisted terminal evidence', async () => {
    const malformed = { ...operationRow(), result_message: null };
    const client = transactionalClient(async <Row>(sql: string) => ({
      rows: sql.includes('for update') ? [malformed] as Row[] : [] as Row[]
    }));
    await expect(new PostgresHostControlOperationStore(client).reserve(reservation))
      .rejects.toThrow('Host audit result is invalid.');
  });

  test('never reuses an operation ID retained from the immutable v1 ledger', async () => {
    const calls: string[] = [];
    const client = transactionalClient(async <Row>(sql: string) => {
      calls.push(sql);
      return {
        rows: sql.includes('host_control_operations_v1_retained')
          ? [{ present: 1 }] as Row[]
          : [] as Row[]
      };
    });
    await expect(new PostgresHostControlOperationStore(client).reserve(reservation))
      .resolves.toEqual({ kind: 'conflict' });
    expect(calls.some((sql) => sql.includes('insert into host_control_operations'))).toBe(false);
  });

  test('rejects a database client without transactional reservation support', () => {
    const client: DatabaseQueryClient = { async query<Row>() { return { rows: [] as Row[] }; } };
    expect(() => new PostgresHostControlOperationStore(client)).toThrow(
      'Host control operations require transactions.'
    );
  });
});

function operationRow() {
  return {
    actor_id: audit.actorId,
    actor_kind: audit.actorKind,
    approval_id: audit.approvalId ?? null,
    attempt_id: reservation.attemptId,
    audit_id: audit.auditId,
    binding_revision: audit.bindingRevision,
    capability: audit.capability,
    completed_at: '2026-08-12T10:00:01.000Z',
    dispatch_attempted: true,
    effective_risk: audit.effectiveRisk,
    fingerprint_sha256: reservation.fingerprint,
    host_id: audit.hostId,
    operation_id: audit.operationId,
    owner_user_id: audit.ownerUserId,
    policy_decision_id: audit.policyDecisionId,
    policy_expires_at: audit.policyExpiresAt,
    provider_id: audit.providerId,
    reserved_until: reservation.reservedUntil,
    result_code: null,
    result_message: 'Host operation completed.',
    state: 'completed'
  };
}

function transactionalClient(query: DatabaseQueryClient['query']): DatabaseQueryClient {
  const client: DatabaseQueryClient = {
    query,
    async transaction<Result>(operation: (transaction: DatabaseQueryClient) => Promise<Result>) {
      return operation(client);
    }
  };
  return client;
}
