import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DatabaseQueryClient } from '../database/client';
import { PostgresMachinePowerOperationStore } from './store';

test('the durable reservation records the exact caller and fences attempted outcomes', async () => {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const client: DatabaseQueryClient = {
    async query<Row>(sql: string, values: readonly unknown[] = []) {
      calls.push({ sql, values });
      return { rows: [] as Row[] };
    },
    async transaction<T>(run: (transaction: DatabaseQueryClient) => Promise<T>) {
      return run(client);
    }
  };
  const store = new PostgresMachinePowerOperationStore(client);

  const result = await store.reserve({
    actorType: 'machine',
    callerMachineId: 'connector-os-macbook',
    fingerprint: 'a'.repeat(64),
    machineId: '11111111-1111-4111-8111-111111111111',
    operationId: 'machine-power:on:audit',
    requestedState: 'on',
    userId: 'owner'
  });

  assert.deepEqual(result, { kind: 'new' });
  const insert = calls.find((call) =>
    call.sql.includes('insert into machine_power_operations')
  );
  assert.deepEqual(insert?.values, [
    'owner',
    'machine',
    'connector-os-macbook',
    'machine-power:on:audit',
    '11111111-1111-4111-8111-111111111111',
    'on',
    'a'.repeat(64)
  ]);
  assert(calls.some((call) =>
    call.sql.includes("state in ('accepted', 'uncertain') and dispatch_attempted")
  ));
});
