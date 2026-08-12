import { describe, expect, test } from 'bun:test';

import type { DatabaseQueryClient } from '../server/database/client';
import { PostgresHostControlOperationStore } from '../server/host-control/postgres-store';

describe('Postgres Host control audit store', () => {
  test('reserves and completes one exact owner, caller, Host, and fingerprint', async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const client: DatabaseQueryClient = {
      async query<Row>(sql: string, values: readonly unknown[] = []) {
        calls.push({ sql, values });
        if (sql.includes('update host_control_operations')) return { rowCount: 1, rows: [] as Row[] };
        return { rows: [] as Row[] };
      },
      async transaction<Result>(operation: (transaction: DatabaseQueryClient) => Promise<Result>) {
        return operation(client);
      }
    };
    const store = new PostgresHostControlOperationStore(client);
    const actor = { callerMachineId: 'connector-os-macbook', userId: 'owner-one' };
    const fingerprint = 'a'.repeat(64);
    const hostId = '10000000-0000-4000-8000-000000000001';

    await expect(store.reserve({ actor, fingerprint, hostId, operationId: 'console-one' }))
      .resolves.toBe('new');
    expect(calls.find(({ sql }) => sql.includes('insert into host_control_operations'))?.values)
      .toEqual(['owner-one', 'console-one', hostId, 'machine', 'connector-os-macbook', fingerprint]);

    await expect(store.finish({
      actor,
      fingerprint,
      result: {
        auditId: '20000000-0000-4000-8000-000000000002',
        completedAt: '2026-08-12T10:00:01.000Z',
        hostId,
        operationId: 'console-one',
        provider: { id: 'jetkvm-os-pc', kind: 'jetkvm' },
        replayed: false,
        schemaVersion: 1,
        state: 'completed'
      }
    })).resolves.toBeUndefined();
    expect(calls.some(({ sql }) => sql.includes("state = 'reserved'"))).toBe(true);
  });

  test('rejects a database client without transactional reservation support', () => {
    const client: DatabaseQueryClient = { async query<Row>() { return { rows: [] as Row[] }; } };
    expect(() => new PostgresHostControlOperationStore(client)).toThrow(
      'Host control operations require transactions.'
    );
  });
});
