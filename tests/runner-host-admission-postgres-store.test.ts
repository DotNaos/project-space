import { describe, expect, test } from 'bun:test';

import type { DatabaseQueryClient, DatabaseQueryResult } from '../server/database/client';
import {
  PostgresRunnerHostAdmissionStore,
  RunnerHostAdmissionService
} from '../server/runner-host/admission';
import type { RunnerSandboxReservation } from '../src/shared/runner-host-admission-api';
import {
  evidence,
  hostId,
  policy,
  request
} from './runner-host-admission-fixtures';

describe('PostgreSQL runner admission store', () => {
  test('persists host generation, scopes reads, and fences release proof', async () => {
    const client = new RunnerAdmissionPostgresClient();
    const store = new PostgresRunnerHostAdmissionStore(client);
    const service = new RunnerHostAdmissionService(
      store,
      policy,
      () => new Date('2026-08-20T10:00:01.000Z')
    );

    const reserved = await service.reserve(evidence, request('postgres'));
    expect(reserved.kind).toBe('reserved');
    if (reserved.kind !== 'reserved') return;
    expect(reserved.reservation.hostGeneration).toBe(evidence.generation);
    expect((await store.read(hostId, reserved.reservation.identity.reservationId))?.hostGeneration)
      .toBe(evidence.generation);
    expect(await store.read('vps:other', reserved.reservation.identity.reservationId)).toBeUndefined();

    await expect(service.release(hostId, reserved.reservation.identity.reservationId, {
      checkedAt: '2026-08-20T10:00:02.000Z',
      identity: reserved.reservation.identity,
      resourcesAbsent: false as never
    })).rejects.toThrow('current exact absence evidence');

    const uncertain = await service.markUncertain(hostId, reserved.reservation.identity.reservationId);
    expect(uncertain?.state).toBe('uncertain');
    const released = await service.release(hostId, reserved.reservation.identity.reservationId, {
      checkedAt: '2026-08-20T10:00:01.000Z',
      identity: reserved.reservation.identity,
      resourcesAbsent: true
    });
    expect(released).toMatchObject({
      state: 'released',
      hostGeneration: evidence.generation,
      absenceProof: { identity: reserved.reservation.identity, resourcesAbsent: true }
    });
    expect((await service.release(hostId, reserved.reservation.identity.reservationId, {
      checkedAt: '2026-08-20T10:00:01.000Z',
      identity: reserved.reservation.identity,
      resourcesAbsent: true
    }))?.state).toBe('released');
    expect(client.calls.some(({ sql }) => sql.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(client.calls.some(({ sql, values }) => sql.includes('where host_id = $1') && values[0] === hostId)).toBe(true);
  });

  test('rejects a reservation whose stored host binding is inconsistent', async () => {
    const client = new RunnerAdmissionPostgresClient();
    const store = new PostgresRunnerHostAdmissionStore(client);
    const reservation = reservationFixture();
    await expect(store.save('vps:other', reservation)).rejects.toThrow('host binding');
    await expect(store.save(hostId, {
      ...reservation,
      hostGeneration: 'different-generation'
    })).rejects.toThrow('host binding');
    await expect(store.save(hostId, {
      ...reservation,
      identity: { ...reservation.identity, branch: '' }
    })).rejects.toThrow('host binding');
  });

  test('rejects admission when the PostgreSQL client cannot provide a transaction', async () => {
    const client = new RunnerAdmissionPostgresClient();
    const queryOnlyClient: DatabaseQueryClient = {
      query: (sql, values) => client.query(sql, values)
    };
    const service = new RunnerHostAdmissionService(
      new PostgresRunnerHostAdmissionStore(queryOnlyClient),
      policy,
      () => new Date('2026-08-20T10:00:01.000Z')
    );

    await expect(service.reserve(evidence, request('query-only'))).rejects.toThrow(
      'requires transaction support'
    );
    expect(client.calls).toHaveLength(0);
  });
});

function reservationFixture(): RunnerSandboxReservation {
  const admission = request('fixture');
  return {
    ...admission,
    createdAt: '2026-08-20T10:00:01.000Z',
    fingerprint: 'a'.repeat(64),
    hostGeneration: evidence.generation,
    idleExpiresAt: '2026-08-20T10:30:01.000Z',
    leaseExpiresAt: '2026-08-20T10:15:01.000Z',
    runtimeExpiresAt: '2026-08-20T22:00:01.000Z',
    state: 'active'
  };
}

type StoredRow = {
  absence_proof: RunnerSandboxReservation['absenceProof'] | null;
  created_at: string;
  fingerprint: string;
  host_generation: string;
  idle_expires_at: string;
  idle_timeout_seconds: number;
  identity: RunnerSandboxReservation['identity'];
  isolation: RunnerSandboxReservation['isolation'];
  lease_expires_at: string;
  maximum_runtime_seconds: number;
  resources: RunnerSandboxReservation['resources'];
  runtime_expires_at: string;
  state: RunnerSandboxReservation['state'];
};

class RunnerAdmissionPostgresClient implements DatabaseQueryClient {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  private readonly rows = new Map<string, StoredRow>();

  async transaction<Result>(operation: (client: DatabaseQueryClient) => Promise<Result>) {
    return operation(this);
  }

  async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = []
  ): Promise<DatabaseQueryResult<Row>> {
    this.calls.push({ sql, values });
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.startsWith('insert into runner_sandbox_reservations')) {
      const [reservationId, host, hostGeneration, identity, isolation, resources, state, fingerprint,
        createdAt, idleTimeoutSeconds, maximumRuntimeSeconds, idleExpiresAt, leaseExpiresAt, runtimeExpiresAt] = values;
      this.rows.set(String(reservationId), {
        absence_proof: null,
        created_at: String(createdAt),
        fingerprint: String(fingerprint),
        host_generation: String(hostGeneration),
        idle_expires_at: String(idleExpiresAt),
        idle_timeout_seconds: Number(idleTimeoutSeconds),
        identity: JSON.parse(String(identity)),
        isolation: JSON.parse(String(isolation)),
        lease_expires_at: String(leaseExpiresAt),
        maximum_runtime_seconds: Number(maximumRuntimeSeconds),
        resources: JSON.parse(String(resources)),
        runtime_expires_at: String(runtimeExpiresAt),
        state: String(state) as StoredRow['state']
      });
      return { rows: [] };
    }
    if (sql.startsWith('update runner_sandbox_reservations')) {
      const [host, reservationId, state, proof] = values;
      const row = this.rows.get(String(reservationId));
      if (!row || row.identity.hostId !== host || row.state === 'released') return { rows: [] };
      row.state = String(state) as StoredRow['state'];
      if (row.state === 'released') row.absence_proof = JSON.parse(String(proof));
      return { rows: [row as Row] };
    }
    const host = String(values[0]);
    const reservationId = values[1] === undefined ? undefined : String(values[1]);
    const rows = [...this.rows.values()].filter((row) =>
      row.identity.hostId === host && (reservationId === undefined || row.identity.reservationId === reservationId) &&
      (reservationId !== undefined || row.state !== 'released')
    );
    return { rows: rows as Row[] };
  }
}
