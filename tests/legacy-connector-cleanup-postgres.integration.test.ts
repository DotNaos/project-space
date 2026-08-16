import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'bun:test';
import pg from 'pg';

import type { DatabaseQueryClient } from '../server/database/client';
import { runDatabaseMigrations } from '../server/database/migrations';
import { ProjectSpaceDatabaseRepository } from '../server/database/repository';
import { PostgresLegacyConnectorCleanupStore } from '../server/legacy-connector-cleanup/store';

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

describe('legacy Connector cleanup PostgreSQL integration', () => {
  postgresTest('blocks active credentials and suppresses an exact retired projection after refresh', async () => {
    assertLoopbackDatabase(databaseUrl);
    const schema = `legacy_cleanup_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`create schema "${schema}"`);
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 2,
      options: `-c search_path=${schema}`
    });
    try {
      const client = databaseClient(pool);
      await runDatabaseMigrations(client);
      const ownerUserId = 'owner-postgres-cleanup';
      const connectorId = randomUUID();
      await pool.query(
        `insert into machine_memberships (id, machine_id, user_id, role)
         values ($1, $2, $3, 'owner')`,
        [randomUUID(), connectorId, ownerUserId]
      );
      await pool.query(
        `insert into machine_identities (
           id, owner_user_id, public_key, name, hostname, operating_system,
           architecture, client_version, created_at
         ) values ($1, $2, $3, 'Retired Linux', 'retired-linux', 'linux', 'amd64', '1.0.0', now())`,
        [connectorId, ownerUserId, 'a'.repeat(43)]
      );
      const credentialId = randomUUID();
      await pool.query(
        `insert into connector_credentials (
           id, owner_user_id, token_hash, expected_machine_id, machine_id,
           created_at, expires_at
         ) values ($1, $2, $3, $4, $4, now(), now() + interval '1 hour')`,
        [credentialId, ownerUserId, 'b'.repeat(64), connectorId]
      );

      const store = new PostgresLegacyConnectorCleanupStore(client);
      const blocked = (await store.listSnapshot(ownerUserId)).records[0]!;
      expect(blocked.label).toBe('Retired Linux');
      expect(blocked.blockers).toContainEqual({ count: 1, kind: 'active_credential' });
      await expect(store.remove(ownerUserId, {
        actorId: ownerUserId,
        records: [{ connectorId, fingerprint: blocked.fingerprint }],
        requestId: 'postgres-cleanup-blocked'
      })).resolves.toMatchObject({ results: [{ outcome: 'blocked' }] });

      await pool.query(`update connector_credentials set revoked_at = now() where id = $1`, [credentialId]);
      const eligible = (await store.listSnapshot(ownerUserId)).records[0]!;
      await expect(store.remove(ownerUserId, {
        actorId: ownerUserId,
        records: [{ connectorId, fingerprint: eligible.fingerprint }],
        requestId: 'postgres-cleanup-remove'
      })).resolves.toMatchObject({ results: [{ outcome: 'removed' }] });

      const repository = new ProjectSpaceDatabaseRepository(client);
      await repository.reconcileConnectorComputeInventory(ownerUserId, [{
        compute: {
          environmentIdentity: { key: 'environment:retired-linux', version: 1 },
          environmentKind: 'native_linux',
          environmentName: 'Retired Linux',
          hostEvidence: 'none',
          hostResolution: 'unresolved',
          platformKind: 'local',
          platformName: 'Local & self-hosted',
          resourceMode: 'dedicated'
        },
        id: connectorId,
        name: 'Retired Linux'
      }]);
      const inventory = await repository.listComputeInventory(ownerUserId);
      expect(inventory.connectors).toEqual([]);
      expect(inventory.environments).toEqual([]);
      expect((await store.listSnapshot(ownerUserId)).records).toEqual([]);
      expect((await pool.query(
        `select count(*)::int as count from machine_memberships
          where user_id = $1 and machine_id = $2`,
        [ownerUserId, connectorId]
      )).rows[0]?.count).toBe(1);
      expect((await pool.query(
        `select count(*)::int as count from legacy_connector_removal_receipts
          where owner_user_id = $1 and connector_id = $2`,
        [ownerUserId, connectorId]
      )).rows[0]?.count).toBe(1);

      await pool.query(
        `delete from connector_compute_environments
          where owner_user_id = $1 and connector_id = $2`,
        [ownerUserId, connectorId]
      );
      await pool.query(
        `update machine_memberships set updated_at = now()
          where user_id = $1 and machine_id = $2`,
        [ownerUserId, connectorId]
      );
      expect((await pool.query(
        `select count(*)::int as count from connector_compute_environments
          where owner_user_id = $1 and connector_id = $2`,
        [ownerUserId, connectorId]
      )).rows[0]?.count).toBe(0);
      expect((await store.listSnapshot(ownerUserId)).records).toEqual([]);
    } finally {
      await pool.end();
      await admin.query(`drop schema if exists "${schema}" cascade`);
      await admin.end();
    }
  });
});
