import { createHmac } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { describe, expect, test } from 'bun:test';

import type { DatabaseQueryClient } from '../server/database/client';
import { createMachineConnectionRateLimiter } from '../server/machine-connection-rate-limit';

interface QueryCall {
  sql: string;
  transactionId: number | null;
  values: readonly unknown[];
}

interface RateEvent {
  createdAt: Date;
  requesterHash: string;
}

const fixedNow = new Date('2026-07-11T12:00:00.000Z');
const secret = Buffer.alloc(32, 17);

function hashAddress(address: string, key: Uint8Array = secret) {
  return createHmac('sha256', key).update(address, 'utf8').digest('hex');
}

function request(remoteAddress: string | undefined, forwardedFor?: string | string[]) {
  return {
    headers:
      forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
    socket: { remoteAddress }
  } as unknown as IncomingMessage;
}

class MemoryRateDatabase implements DatabaseQueryClient {
  readonly calls: QueryCall[] = [];
  events: RateEvent[] = [];
  failQueries = false;

  private nextTransactionId = 0;
  private readonly lockTails = new Map<string, Promise<void>>();

  async query<Row>(sql: string, values: readonly unknown[] = []) {
    this.calls.push({ sql, transactionId: null, values });
    if (this.failQueries) {
      throw new Error('The database is unavailable.');
    }

    if (!sql.includes('with expired as')) {
      return { rows: [] as Row[] };
    }

    const cutoff = values[0] as Date;
    const maximumRows = values[1] as number;
    const expired = this.events
      .filter((event) => event.createdAt.getTime() <= cutoff.getTime())
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .slice(0, maximumRows);
    const removed = new Set(expired);
    this.events = this.events.filter((event) => !removed.has(event));

    return {
      rowCount: expired.length,
      rows: expired.map(() => ({ removed: 1 })) as Row[]
    };
  }

  async transaction<Result>(
    operation: (client: DatabaseQueryClient) => Promise<Result>
  ): Promise<Result> {
    const transactionId = ++this.nextTransactionId;
    let releaseLock: (() => void) | undefined;
    const transactionClient: DatabaseQueryClient = {
      query: async <Row>(sql: string, values: readonly unknown[] = []) => {
        this.calls.push({ sql, transactionId, values });
        if (this.failQueries) {
          throw new Error('The database is unavailable.');
        }

        if (sql.includes('pg_advisory_xact_lock')) {
          releaseLock = await this.acquire(String(values[0]));
          return { rows: [] as Row[] };
        }

        if (sql.includes('as accepted_count')) {
          // Give another concurrent transaction an opportunity to reach its count.
          // Correct code remains serialized because it acquired the advisory lock first.
          await Promise.resolve();
          const requesterHash = String(values[0]);
          const windowStart = values[1] as Date;
          const maximumRows = Number(values[2]);
          const count = Math.min(
            maximumRows,
            this.events.filter(
              (event) =>
                event.requesterHash === requesterHash &&
                event.createdAt.getTime() > windowStart.getTime()
            ).length
          );
          return {
            rows: [{ accepted_count: String(count) }] as Row[]
          };
        }

        if (sql.includes('insert into machine_connection_rate_events')) {
          this.events.push({
            createdAt: new Date((values[1] as Date).getTime()),
            requesterHash: String(values[0])
          });
          return { rowCount: 1, rows: [] as Row[] };
        }

        return { rows: [] as Row[] };
      }
    };

    try {
      return await operation(transactionClient);
    } finally {
      releaseLock?.();
    }
  }

  private async acquire(key: string) {
    const previous = this.lockTails.get(key) ?? Promise.resolve();
    let releaseCurrent = () => {};
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    this.lockTails.set(key, current);
    await previous;

    return () => {
      releaseCurrent();
      if (this.lockTails.get(key) === current) {
        this.lockTails.delete(key);
      }
    };
  }
}

function createLimiter(database: DatabaseQueryClient, key: Uint8Array = secret) {
  return createMachineConnectionRateLimiter({
    client: database,
    hmacSecret: key,
    now: () => fixedNow
  });
}

function lockHashes(database: MemoryRateDatabase) {
  return database.calls
    .filter((call) => call.sql.includes('pg_advisory_xact_lock'))
    .map((call) => String(call.values[0]));
}

describe('machine connection rate limiter', () => {
  test('only trusts forwarded addresses from a local proxy and selects the rightmost valid hop', async () => {
    const database = new MemoryRateDatabase();
    const limiter = createLimiter(database);

    await expect(
      limiter.allowCreateRequest(
        request('203.0.113.8', '198.51.100.2, 192.0.2.4')
      )
    ).resolves.toBe(true);
    await expect(
      limiter.allowCreateRequest(
        request('10.0.0.8', 'malformed, 198.51.100.3, 192.0.2.5')
      )
    ).resolves.toBe(true);
    await expect(
      limiter.allowCreateRequest(
        request('::1', ['198.51.100.4', '2001:0db8:0:0:0:0:0:6'])
      )
    ).resolves.toBe(true);

    expect(lockHashes(database)).toEqual([
      hashAddress('203.0.113.8'),
      hashAddress('192.0.2.5'),
      hashAddress('2001:db8::6')
    ]);

    const callCount = database.calls.length;
    await expect(
      limiter.allowCreateRequest(request('not-an-address', '192.0.2.99'))
    ).resolves.toBe(false);
    expect(database.calls).toHaveLength(callCount);
  });

  test('falls back to the trusted proxy address when the final forwarded hop is invalid', async () => {
    const database = new MemoryRateDatabase();
    const limiter = createLimiter(database);

    await expect(
      limiter.allowCreateRequest(
        request('10.0.0.8', '198.51.100.99, not-an-address')
      )
    ).resolves.toBe(true);

    expect(lockHashes(database)).toEqual([hashAddress('10.0.0.8')]);
  });

  test('normalizes IPv4-mapped IPv6 and masks oversized forwarded input', async () => {
    const database = new MemoryRateDatabase();
    const limiter = createLimiter(database);

    await expect(
      limiter.allowCreateRequest(request('::ffff:203.0.113.44'))
    ).resolves.toBe(true);
    await expect(
      limiter.allowCreateRequest(request('203.0.113.44'))
    ).resolves.toBe(true);
    await expect(
      limiter.allowCreateRequest(request('10.0.0.9', 'x'.repeat(2_049)))
    ).resolves.toBe(true);

    const hashes = lockHashes(database);
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[2]).toBe(hashAddress('10.0.0.9'));
  });

  test('serializes concurrent attempts before counting and never accepts more than five', async () => {
    const database = new MemoryRateDatabase();
    const limiter = createLimiter(database);
    const requesterHash = hashAddress('198.51.100.12');
    database.events = Array.from({ length: 4 }, (_, index) => ({
      createdAt: new Date(fixedNow.getTime() - (index + 1) * 1_000),
      requesterHash
    }));

    const results = await Promise.all([
      limiter.allowCreateRequest(request('198.51.100.12')),
      limiter.allowCreateRequest(request('198.51.100.12'))
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      database.events.filter((event) => event.requesterHash === requesterHash)
    ).toHaveLength(5);

    const transactionIds = new Set(
      database.calls.flatMap((call) =>
        call.transactionId === null ? [] : [call.transactionId]
      )
    );
    expect(transactionIds.size).toBe(2);
    for (const transactionId of transactionIds) {
      const calls = database.calls.filter(
        (call) => call.transactionId === transactionId
      );
      const lockIndex = calls.findIndex((call) =>
        call.sql.includes('pg_advisory_xact_lock')
      );
      const countIndex = calls.findIndex((call) =>
        call.sql.includes('as accepted_count')
      );
      const insertIndex = calls.findIndex((call) =>
        call.sql.includes('insert into machine_connection_rate_events')
      );

      expect(lockIndex).toBe(0);
      expect(countIndex).toBeGreaterThan(lockIndex);
      if (insertIndex >= 0) {
        expect(insertIndex).toBeGreaterThan(countIndex);
      }
    }

    const countCall = database.calls.find((call) =>
      call.sql.includes('as accepted_count')
    );
    expect(countCall?.sql).toContain('limit $3');
    expect(countCall?.values[2]).toBe(5);
  });

  test('expires attempts exactly at the ten-minute boundary', async () => {
    const database = new MemoryRateDatabase();
    const limiter = createLimiter(database);
    const requesterHash = hashAddress('198.51.100.13');
    const boundary = new Date(fixedNow.getTime() - 10 * 60 * 1_000);
    database.events = Array.from({ length: 5 }, () => ({
      createdAt: new Date(boundary),
      requesterHash
    }));

    await expect(
      limiter.allowCreateRequest(request('198.51.100.13'))
    ).resolves.toBe(true);

    const countCall = database.calls.find((call) =>
      call.sql.includes('as accepted_count')
    );
    expect(countCall?.sql).toContain('created_at > $2');
    expect(countCall?.values[1]).toEqual(boundary);

    const stillRecentDatabase = new MemoryRateDatabase();
    stillRecentDatabase.events = Array.from({ length: 5 }, () => ({
      createdAt: new Date(boundary.getTime() + 1),
      requesterHash
    }));
    await expect(
      createLimiter(stillRecentDatabase).allowCreateRequest(
        request('198.51.100.13')
      )
    ).resolves.toBe(false);
  });

  test('fails closed on database errors and never passes raw addresses to SQL', async () => {
    const database = new MemoryRateDatabase();
    database.failQueries = true;
    const limiter = createLimiter(database);
    const remoteAddress = '10.20.30.40';
    const forwardedAddress = '198.51.100.77';

    await expect(
      limiter.allowCreateRequest(request(remoteAddress, forwardedAddress))
    ).resolves.toBe(false);

    const serializedCalls = JSON.stringify(database.calls);
    expect(serializedCalls).not.toContain(remoteAddress);
    expect(serializedCalls).not.toContain(forwardedAddress);
    expect(lockHashes(database)).toEqual([hashAddress(forwardedAddress)]);
  });

  test('requires an injected 32-byte secret and copies it at construction', async () => {
    expect(() =>
      createMachineConnectionRateLimiter({
        client: new MemoryRateDatabase(),
        hmacSecret: Buffer.alloc(31)
      })
    ).toThrow('at least 32 bytes');

    const mutableSecret = Buffer.alloc(32, 9);
    const originalSecret = Buffer.from(mutableSecret);
    const database = new MemoryRateDatabase();
    const limiter = createLimiter(database, mutableSecret);
    mutableSecret.fill(3);

    await limiter.allowCreateRequest(request('198.51.100.21'));
    expect(lockHashes(database)).toEqual([
      hashAddress('198.51.100.21', originalSecret)
    ]);
  });

  test('requires transaction support at construction', () => {
    const queryOnlyClient: DatabaseQueryClient = {
      async query<Row>() {
        return { rows: [] as Row[] };
      }
    };

    expect(() => createLimiter(queryOnlyClient)).toThrow(
      'requires transaction support'
    );
  });

  test('cleans expired events in fixed-size batches including the exact boundary', async () => {
    const database = new MemoryRateDatabase();
    const limiter = createLimiter(database);
    const boundary = new Date(fixedNow.getTime() - 10 * 60 * 1_000);
    database.events = [
      ...Array.from({ length: 501 }, (_, index) => ({
        createdAt: new Date(boundary.getTime() - index),
        requesterHash: `expired-${index}`
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        createdAt: new Date(boundary.getTime() + index + 1),
        requesterHash: `recent-${index}`
      }))
    ];

    await expect(limiter.cleanupOldEvents()).resolves.toBe(500);
    await expect(limiter.cleanupOldEvents()).resolves.toBe(1);
    expect(database.events).toHaveLength(3);

    const cleanupCall = database.calls.find((call) =>
      call.sql.includes('with expired as')
    );
    expect(cleanupCall?.sql).toContain('created_at <= $1');
    expect(cleanupCall?.sql).toContain('for update skip locked');
    expect(cleanupCall?.sql).toContain('limit $2');
    expect(cleanupCall?.values).toEqual([boundary, 500]);
  });
});
