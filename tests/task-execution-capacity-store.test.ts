import { describe, expect, test } from 'bun:test';

import type { DatabaseQueryClient, DatabaseQueryResult } from '../server/database/client';
import {
  MemoryTaskExecutionCapacityStore,
  PostgresTaskExecutionCapacityStore
} from '../server/task-execution/capacity-store';

const owner = 'owner-one';
const environmentId = '22222222-2222-4222-8222-222222222222';
const executionId = '33333333-3333-4333-8333-333333333333';
const now = '2026-08-09T12:00:00.000Z';

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

describe('task execution capacity leases', () => {
  test('fences capacity, replays exact leases, expires safely, and isolates owners', async () => {
    let clock = Date.parse(now);
    const store = new MemoryTaskExecutionCapacityStore(() => clock);
    const lease = {
      durationSeconds: 600,
      environmentId,
      executionId,
      id: '55555555-5555-4555-8555-555555555555',
      ownerUserId: owner
    };
    expect((await store.acquire(lease)).kind).toBe('acquired');
    expect((await store.acquire(lease)).kind).toBe('replayed');
    expect((await store.acquire({
      ...lease,
      durationSeconds: 540
    })).kind).toBe('conflict');
    expect((await store.acquire({
      ...lease,
      executionId: '66666666-6666-4666-8666-666666666666',
      id: '77777777-7777-4777-8777-777777777777'
    })).kind).toBe('unavailable');
    expect((await store.acquire({ ...lease, ownerUserId: 'owner-two' })).kind).toBe('acquired');

    clock = Date.parse('2026-08-09T12:11:00.000Z');
    expect(await store.read(owner, environmentId)).toBeUndefined();
    expect((await store.acquire({
      ...lease,
      durationSeconds: 540,
      executionId: '66666666-6666-4666-8666-666666666666',
      id: '77777777-7777-4777-8777-777777777777'
    })).kind).toBe('acquired');
  });

  test('allows only one winner when two executions acquire the same capacity concurrently', async () => {
    const store = new MemoryTaskExecutionCapacityStore(() => Date.parse(now));
    const shared = {
      durationSeconds: 600,
      environmentId,
      ownerUserId: owner
    };
    const results = await Promise.all([
      store.acquire({
        ...shared,
        executionId,
        id: '88888888-8888-4888-8888-888888888888'
      }),
      store.acquire({
        ...shared,
        executionId: '99999999-9999-4999-8999-999999999999',
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      })
    ]);
    expect(results.map(({ kind }) => kind).sort()).toEqual(['acquired', 'unavailable']);
  });

  test('serializes Postgres acquisition by owner and environment', async () => {
    const database = new FakeDatabase();
    database.responses.push(
      { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
      { rows: [{
        acquired_at: now,
        environment_id: environmentId,
        execution_id: executionId,
        expires_at: '2026-08-09T12:10:00.000Z',
        id: '55555555-5555-4555-8555-555555555555',
        released_at: null,
        state: 'active'
      }] }
    );
    const store = new PostgresTaskExecutionCapacityStore(database);
    const reservation = await store.acquire({
      durationSeconds: 600, environmentId, executionId,
      id: '55555555-5555-4555-8555-555555555555', ownerUserId: owner
    });
    expect(reservation).toMatchObject({ kind: 'acquired', lease: { executionId } });
    expect(database.calls[0]?.values).toEqual([
      `task-execution-capacity:${owner}:${environmentId}`
    ]);
  });
});
