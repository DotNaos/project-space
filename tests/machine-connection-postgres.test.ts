import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';

import { describe, expect, test } from 'bun:test';
import pg from 'pg';

import { ConnectorCredentialRepository } from '../server/database/connector-credentials';
import type { DatabaseQueryClient } from '../server/database/client';
import { databaseMigrations } from '../server/database/migrations';
import {
  DatabaseMachineConnectionStore,
  type TransactionalDatabaseQueryClient
} from '../server/machine-connection-database-store';
import {
  MachineConnectionService,
  machineApprovalProofMessage
} from '../server/machine-connection-service';

const testDatabaseUrl = process.env.PROJECT_SPACE_TEST_DATABASE_URL;
const postgresTest = testDatabaseUrl ? test : test.skip;

function assertSafeTestDatabase(value: string) {
  const url = new URL(value);
  const databaseName = url.pathname.slice(1).toLowerCase();
  if (
    !['127.0.0.1', 'localhost', '::1'].includes(url.hostname) ||
    (!databaseName.includes('test') && !databaseName.includes('machine'))
  ) {
    throw new Error(
      'PROJECT_SPACE_TEST_DATABASE_URL must point to a loopback test database.'
    );
  }
}

function queryClient(queryable: pg.Pool | pg.PoolClient): DatabaseQueryClient {
  return {
    async query<Row>(sql: string, values?: readonly unknown[]) {
      const result = await queryable.query(sql, values ? [...values] : undefined);
      return { rowCount: result.rowCount, rows: result.rows as Row[] };
    }
  };
}

function transactionalClient(pool: pg.Pool): TransactionalDatabaseQueryClient {
  return {
    ...queryClient(pool),
    async transaction<Result>(operation: (client: DatabaseQueryClient) => Promise<Result>) {
      const connection = await pool.connect();
      const client = queryClient(connection);
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

function machineKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  if (!jwk.x) throw new Error('Ed25519 key export did not include x.');
  return { privateKey, publicKey: jwk.x };
}

async function connectMachine(
  service: MachineConnectionService,
  keys: ReturnType<typeof machineKeyPair>,
  clientVersion: string
) {
  const request = await service.createRequest({
    architecture: 'arm64',
    clientVersion,
    hostname: 'postgres-machine',
    name: 'Postgres Machine',
    operatingSystem: 'linux',
    publicKey: keys.publicKey
  });
  await service.approveRequest(request.requestId, 'user_postgres_test');
  const approval = await service.pollRequest(request.requestId, request.pollToken);
  if (approval.status !== 'approved') throw new Error('Request was not approved.');
  const signature = sign(
    null,
    machineApprovalProofMessage(request.requestId, approval.approvalChallenge),
    keys.privateKey
  ).toString('base64url');
  return service.exchangeApproval(request.requestId, request.pollToken, signature);
}

describe('machine connection PostgreSQL integration', () => {
  postgresTest(
    'migrates, rotates the current credential, authenticates, and revokes atomically',
    async () => {
      assertSafeTestDatabase(testDatabaseUrl!);
      const pool = new pg.Pool({ connectionString: testDatabaseUrl!, max: 4 });
      try {
        const existing = await pool.query<{ count: string }>(
          `select count(*)::text as count
             from information_schema.tables
            where table_schema = 'public' and table_type = 'BASE TABLE'`
        );
        if (existing.rows[0]?.count !== '0') {
          throw new Error('PostgreSQL integration test requires an empty database.');
        }

        const migrationConnection = await pool.connect();
        try {
          for (const migration of databaseMigrations) {
            await migrationConnection.query(migration.sql);
          }
        } finally {
          migrationConnection.release();
        }

        const client = transactionalClient(pool);
        const onlineMachines = new Map<string, string>();
        const store = new DatabaseMachineConnectionStore(client);
        const service = new MachineConnectionService({
          isMachineOnline: (machineId, credential) =>
            onlineMachines.get(machineId) === credential,
          now: () => new Date('2026-07-11T12:00:00.000Z'),
          publicOrigin: 'https://projects.os-home.net',
          store
        });
        const connectorCredentials = new ConnectorCredentialRepository(client, {
          createId: randomUUID
        });
        const keys = machineKeyPair();

        const first = await connectMachine(service, keys, '0.2.0');
        await expect(
          connectorCredentials.authenticate({
            machineId: first.machineId,
            token: first.credential
          })
        ).resolves.toMatchObject({ machineId: first.machineId });

        const second = await connectMachine(service, keys, '0.3.0');
        expect(second.machineId).toBe(first.machineId);
        await expect(
          connectorCredentials.authenticate({
            machineId: first.machineId,
            token: first.credential
          })
        ).resolves.toBeNull();
        await expect(
          connectorCredentials.authenticate({
            machineId: second.machineId,
            token: second.credential
          })
        ).resolves.toMatchObject({ machineId: second.machineId });

        await service.markMachineOnline(second.machineId, second.credential);
        onlineMachines.set(second.machineId, second.credential);
        await expect(
          service.getConnectionStatus(second.machineId, second.credential)
        ).resolves.toMatchObject({ status: 'online' });

        await service.revokeMachine(second.machineId, second.credential);
        await expect(
          connectorCredentials.authenticate({
            machineId: second.machineId,
            token: second.credential
          })
        ).resolves.toBeNull();
        await expect(
          service.getConnectionStatus(second.machineId, second.credential)
        ).resolves.toMatchObject({ status: 'revoked' });

        await pool.query(
          `insert into machine_connection_requests (
             id, poll_token_hash, public_key, name, hostname, operating_system,
             architecture, client_version, status, created_at, expires_at
           ) values (
             $1, $2, $3, 'Expired Machine', 'expired-machine', 'linux',
             'arm64', '0.1.0', 'pending', now() - interval '3 days',
             now() - interval '2 days'
           )`,
          [randomUUID(), 'f'.repeat(64), keys.publicKey]
        );
        await expect(store.cleanupOldRequests()).resolves.toBe(1);
      } finally {
        await pool.end();
      }
    },
    30_000
  );
});
