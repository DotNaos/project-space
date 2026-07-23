import { describe, expect, test } from 'bun:test';

import type {
  DatabaseQueryClient,
  DatabaseQueryResult
} from '../server/database/client';
import {
  createConfiguredMachineConnectionRuntime,
  createMachineConnectionRuntime
} from '../server/machine-connection-runtime';

class MaintenanceDatabase implements DatabaseQueryClient {
  cleanupCalls: string[] = [];
  failure?: Error;

  async query<Row>(
    sql: string,
    _values: readonly unknown[] = []
  ): Promise<DatabaseQueryResult<Row>> {
    if (sql.includes('with expired_requests as')) {
      this.cleanupCalls.push('requests');
    }
    if (sql.includes('with expired as')) {
      this.cleanupCalls.push('rate-limit');
    }
    if (this.failure) {
      throw this.failure;
    }
    return { rowCount: 0, rows: [] };
  }

  async transaction<Result>(
    operation: (client: DatabaseQueryClient) => Promise<Result>
  ) {
    return operation(this);
  }
}

function createScheduler() {
  const callbacks: Array<() => void> = [];
  const cleared: unknown[] = [];
  const handle = { name: 'machine-cleanup' };

  return {
    callbacks,
    cleared,
    scheduler: {
      clearInterval(value: unknown) {
        cleared.push(value);
      },
      setInterval(callback: () => void, intervalMs: number) {
        expect(intervalMs).toBe(5_000);
        callbacks.push(callback);
        return handle;
      }
    },
    handle
  };
}

function runtimeOptions(databaseClient: MaintenanceDatabase) {
  return {
    cleanupIntervalMs: 5_000,
    databaseClient,
    isMachineOnline: () => false,
    publicOrigin: 'https://projects.os-home.net',
    rateLimitSecret: Buffer.alloc(32, 8),
    readAuthenticatedUserId: async () => null
  };
}

describe('machine connection runtime', () => {
  test('stays disabled without an explicit public origin and fails closed without a rate secret', async () => {
    await expect(createConfiguredMachineConnectionRuntime({})).resolves.toBeNull();
    await expect(
      createConfiguredMachineConnectionRuntime({
        PROJECT_SPACE_PREVIEW_MODE: '1',
        PROJECT_SPACE_PUBLIC_ORIGIN: 'https://pr-263.projects.os-home.net'
      })
    ).resolves.toBeNull();
    await expect(
      createConfiguredMachineConnectionRuntime({
        PROJECT_SPACE_PUBLIC_ORIGIN: 'https://projects.os-home.net'
      })
    ).rejects.toThrow('rate-limit secret is not configured securely');
  });

  test('runs bounded maintenance immediately, periodically, and only once at a time', async () => {
    const database = new MaintenanceDatabase();
    const scheduled = createScheduler();
    const runtime = createMachineConnectionRuntime({
      ...runtimeOptions(database),
      scheduler: scheduled.scheduler
    });

    runtime.start();
    runtime.start();
    await runtime.runMaintenance();
    expect(scheduled.callbacks).toHaveLength(1);
    expect(database.cleanupCalls.toSorted()).toEqual(['rate-limit', 'requests']);

    scheduled.callbacks[0]?.();
    await runtime.runMaintenance();
    expect(database.cleanupCalls.toSorted()).toEqual([
      'rate-limit',
      'rate-limit',
      'requests',
      'requests'
    ]);

    await runtime.stop();
    await runtime.stop();
    expect(scheduled.cleared).toEqual([scheduled.handle]);
  });

  test('reports only a generic maintenance error', async () => {
    const database = new MaintenanceDatabase();
    database.failure = new Error('postgres://user:secret@example.test/private');
    const messages: string[] = [];
    const runtime = createMachineConnectionRuntime({
      ...runtimeOptions(database),
      onMaintenanceError(message) {
        messages.push(message);
      }
    });

    await expect(runtime.runMaintenance()).resolves.toBeUndefined();
    expect(messages).toEqual(['Machine connection maintenance failed.']);
    expect(messages.join(' ')).not.toContain('secret');
  });

  test('rejects unsafe cleanup intervals', () => {
    const database = new MaintenanceDatabase();

    expect(() =>
      createMachineConnectionRuntime({
        ...runtimeOptions(database),
        cleanupIntervalMs: 999
      })
    ).toThrow('at least one second');
  });
});
