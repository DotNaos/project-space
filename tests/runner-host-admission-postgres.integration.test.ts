import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'bun:test';
import pg from 'pg';

import type { DatabaseQueryClient } from '../server/database/client';
import { runDatabaseMigrations } from '../server/database/migrations';
import {
  PostgresRunnerHostAdmissionStore,
  RunnerHostAdmissionService
} from '../server/runner-host/admission';
import type { RunnerSandboxIdentity } from '../src/shared/runner-host-admission-api';
import { evidence, policy, request } from './runner-host-admission-fixtures';

const databaseUrl = process.env.PROJECT_SPACE_TEST_DATABASE_URL ?? '';
const postgresTest = databaseUrl ? test : test.skip;

function assertSafeTestDatabase(value: string) {
  const url = new URL(value);
  const databaseName = url.pathname.slice(1).toLowerCase();
  if (
    !['127.0.0.1', 'localhost', '::1'].includes(url.hostname) ||
    (!databaseName.includes('test') && !databaseName.includes('runner'))
  ) {
    throw new Error(
      'PROJECT_SPACE_TEST_DATABASE_URL must point to a loopback runner test database.'
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

function transactionalClient(pool: pg.Pool): DatabaseQueryClient {
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

describe('PostgreSQL runner admission concurrency integration', () => {
  postgresTest('serializes concurrent reservations through a real advisory transaction lock', async () => {
    assertSafeTestDatabase(databaseUrl);
    const schema = `runner_admission_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`create schema "${schema}"`);
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 3,
      options: `-c search_path=${schema}`
    });
    try {
      const client = transactionalClient(pool);
      await runDatabaseMigrations(client);
      const insertReservation = async (
        reservationId: string,
        host: string,
        identity: RunnerSandboxIdentity
      ) => pool.query(
        `insert into runner_sandbox_reservations (
           reservation_id, host_id, host_generation, identity, isolation, resources, state, fingerprint,
           created_at, idle_timeout_seconds, maximum_runtime_seconds,
           idle_expires_at, lease_expires_at, runtime_expires_at
         ) values ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, 'active', $7, $8, $9, $10, $11, $12, $13)`,
        [
          reservationId, host, evidence.generation, JSON.stringify(identity),
          JSON.stringify(request('db-contract').isolation), JSON.stringify(request('db-contract').resources),
          'a'.repeat(64), '2026-08-20T10:00:01.000Z', 1_800, 43_200,
          '2026-08-20T10:30:01.000Z', '2026-08-20T10:15:01.000Z', '2026-08-20T22:00:01.000Z'
        ]
      );
      const insertReleasedWithProof = async (reservationId: string, proof: unknown) => {
        const identity = { ...request('db-contract-proof').identity, reservationId };
        return pool.query(
          `insert into runner_sandbox_reservations (
             reservation_id, host_id, host_generation, identity, isolation, resources, state, fingerprint,
             created_at, idle_timeout_seconds, maximum_runtime_seconds,
             idle_expires_at, lease_expires_at, runtime_expires_at, absence_proof
           ) values ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)`,
          [
            reservationId, evidence.hostId, evidence.generation, JSON.stringify(identity),
            JSON.stringify(request('db-contract-proof').isolation),
            JSON.stringify(request('db-contract-proof').resources), 'released', 'a'.repeat(64),
            '2026-08-20T10:00:01.000Z', 1_800, 43_200,
            '2026-08-20T10:30:01.000Z', '2026-08-20T10:15:01.000Z', '2026-08-20T22:00:01.000Z',
            JSON.stringify(proof)
          ]
        );
      };
      await expect(insertReservation(
        'db-contract-host-mismatch', 'vps:wrong-host', request('db-contract-host').identity
      )).rejects.toThrow();
      await expect(insertReservation(
        'db-contract-negative-issue', evidence.hostId,
        { ...request('db-contract-issue').identity, issueNumber: -1 }
      )).rejects.toThrow();
      const proofIdentity = request('db-contract-proof').identity;
      const proof = {
        checkedAt: '2026-08-20T10:00:01.000Z',
        identity: proofIdentity,
        resourcesAbsent: true
      };
      await expect(insertReleasedWithProof(
        'db-contract-proof-string-boolean', { ...proof, resourcesAbsent: 'true' }
      )).rejects.toThrow();
      await expect(insertReleasedWithProof(
        'db-contract-proof-extra-key', { ...proof, extra: true }
      )).rejects.toThrow();
      await expect(insertReleasedWithProof(
        'db-contract-proof-bad-checked-at', { ...proof, checkedAt: 1 }
      )).rejects.toThrow();
      await expect(insertReleasedWithProof(
        'db-contract-proof-unparseable-checked-at', { ...proof, checkedAt: 'not-a-date' }
      )).rejects.toThrow();
      await expect(insertReleasedWithProof(
        'db-contract-proof-long-checked-at', { ...proof, checkedAt: 'a'.repeat(65) }
      )).rejects.toThrow();
      const services = [1, 2, 3].map(() => new RunnerHostAdmissionService(
        new PostgresRunnerHostAdmissionStore(client),
        policy,
        () => new Date('2026-08-20T10:00:01.000Z')
      ));
      const results = await Promise.all(
        services.map((service, index) => service.reserve(evidence, request(`real-${index}`)))
      );

      expect(results.filter(({ kind }) => kind === 'reserved')).toHaveLength(2);
      expect(results.filter(({ kind }) => kind === 'blocked')).toHaveLength(1);
      expect((await pool.query(
        `select count(*)::int as count from runner_sandbox_reservations where state = 'active'`
      )).rows[0]?.count).toBe(2);
    } finally {
      await pool.end();
      await admin.query(`drop schema if exists "${schema}" cascade`);
      await admin.end();
    }
  });
});
