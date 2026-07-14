import { describe, expect, test } from 'bun:test';

import { ConnectorRuntimeMaintenanceWindowRateLimiter } from '../server/connector-runtime-rate-limiter';

describe('connector runtime maintenance rate limiter', () => {
  test('scopes bounded windows to the actor, machine, and named operation', async () => {
    const limiter = new ConnectorRuntimeMaintenanceWindowRateLimiter(2, 1_000, 2);
    const input = {
      machineId: 'machine-1', operation: 'restart' as const,
      requestedAt: '2026-07-14T00:00:00.000Z', userId: 'owner'
    };
    expect(await limiter.consume(input)).toEqual({ allowed: true });
    expect(await limiter.consume(input)).toEqual({ allowed: true });
    expect(await limiter.consume(input)).toEqual({ allowed: false, retryAfterMs: 1_000 });
    expect(await limiter.consume({ ...input, operation: 'update' })).toEqual({ allowed: true });
  });

  test('expires old windows and fails closed at capacity', async () => {
    const limiter = new ConnectorRuntimeMaintenanceWindowRateLimiter(1, 1_000, 1);
    const base = {
      operation: 'restart' as const,
      requestedAt: '2026-07-14T00:00:00.000Z', userId: 'owner'
    };
    expect(await limiter.consume({ ...base, machineId: 'machine-1' })).toEqual({ allowed: true });
    expect(await limiter.consume({ ...base, machineId: 'machine-2' }))
      .toEqual({ allowed: false, retryAfterMs: 1_000 });
    expect(await limiter.consume({
      ...base, machineId: 'machine-2', requestedAt: '2026-07-14T00:00:01.001Z'
    })).toEqual({ allowed: true });
  });
});
