import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'bun:test';
import pg from 'pg';

import type { DatabaseQueryClient } from '../server/database/client';
import { databaseMigrations, runDatabaseMigrations } from '../server/database/migrations';
import { PostgresTailscaleInventoryStore } from '../server/tailscale-inventory/store';

const databaseUrl = process.env.PROJECT_SPACE_TEST_DATABASE_URL ?? '';
const postgresTest = databaseUrl ? test : test.skip;

function databaseClient(pool: pg.Pool): DatabaseQueryClient {
  return {
    async query<Row>(sql: string, values?: readonly unknown[]) {
      const result = await pool.query(sql, values ? [...values] : undefined);
      return { rowCount: result.rowCount, rows: result.rows as Row[] };
    },
    async transaction<Result>(operation: (client: DatabaseQueryClient) => Promise<Result>) {
      const connection = await pool.connect();
      const client: DatabaseQueryClient = {
        async query<Row>(sql: string, values?: readonly unknown[]) {
          const result = await connection.query(sql, values ? [...values] : undefined);
          return { rowCount: result.rowCount, rows: result.rows as Row[] };
        }
      };
      try {
        await client.query('begin');
        const result = await operation(client);
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        connection.release();
      }
    }
  };
}

function assertLoopbackDatabase(value: string) {
  const url = new URL(value);
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('PROJECT_SPACE_TEST_DATABASE_URL must point to loopback PostgreSQL.');
  }
}

describe('Tailscale inventory PostgreSQL integration', () => {
  postgresTest('round-trips exact IPv4 and IPv6 inet values without CIDR suffixes', async () => {
    assertLoopbackDatabase(databaseUrl);
    const schema = `tailscale_inventory_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`create schema "${schema}"`);
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 2,
      options: `-c search_path=${schema}`
    });
    try {
      await runDatabaseMigrations(databaseClient(pool));
      const store = new PostgresTailscaleInventoryStore(databaseClient(pool));
      await store.reconcile('owner-inet-test', {
        complete: true,
        kind: 'snapshot',
        snapshot: {
          backendState: 'running',
          deviceErrors: [],
          devices: [{
            addresses: ['100.100.100.100', 'fd7a:115c:a1e0::42'],
            id: 'tailscale-inet-test-device',
            online: true,
            tags: []
          }],
          freshness: {
            freshUntil: '2026-08-14T09:01:00.000Z',
            observedAt: '2026-08-14T09:00:00.000Z',
            state: 'fresh'
          },
          source: 'tailscale_status_json'
        }
      });
      const device = (await store.list('owner-inet-test'))[0];
      expect(device?.addresses).toEqual(['100.100.100.100', 'fd7a:115c:a1e0::42']);
      expect(device?.addresses.some((address) => address.includes('/'))).toBe(false);
    } finally {
      await pool.end();
      await admin.query(`drop schema if exists "${schema}" cascade`);
      await admin.end();
    }
  });
});
