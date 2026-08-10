import type { TaskExecutionCapacityLease } from '../../src/shared/task-execution-api';
import type { DatabaseQueryClient } from '../database/client';
import type {
  AcquireTaskExecutionCapacityInput,
  TaskExecutionCapacityReservation,
  TaskExecutionCapacityStore
} from './contracts';

interface LeaseRow {
  acquired_at: Date | string;
  environment_id: string;
  execution_id: string;
  expires_at: Date | string;
  id: string;
  released_at: Date | string | null;
  state: TaskExecutionCapacityLease['state'];
}

const columns = `id, environment_id, execution_id, state, acquired_at, expires_at, released_at`;

export class PostgresTaskExecutionCapacityStore implements TaskExecutionCapacityStore {
  constructor(private readonly client: DatabaseQueryClient) {}

  async acquire(
    input: AcquireTaskExecutionCapacityInput
  ): Promise<TaskExecutionCapacityReservation> {
    assertLeaseDuration(input.durationSeconds);
    const run = async (client: DatabaseQueryClient): Promise<TaskExecutionCapacityReservation> => {
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [
        `task-execution-capacity:${input.ownerUserId}:${input.environmentId}`
      ]);
      await expireLeases(client, input.ownerUserId, input.environmentId);
      const existing = await client.query<LeaseRow>(
        `select ${columns} from capacity_leases
          where owner_user_id = $1 and id = $2::uuid for update`,
        [input.ownerUserId, input.id]
      );
      if (existing.rows[0]) {
        const lease = mapLease(existing.rows[0]);
        return lease.environmentId === input.environmentId &&
          lease.executionId === input.executionId &&
          leaseDurationSeconds(lease) === input.durationSeconds
          ? { kind: 'replayed', lease }
          : conflict(lease);
      }
      const active = await client.query<LeaseRow>(
        `select ${columns} from capacity_leases
          where owner_user_id = $1 and environment_id = $2::uuid and state = 'active'
          limit 1 for update`,
        [input.ownerUserId, input.environmentId]
      );
      if (active.rows[0]) return unavailable(mapLease(active.rows[0]));
      const inserted = await client.query<LeaseRow>(
        `insert into capacity_leases (
           id, owner_user_id, environment_id, execution_id, state, acquired_at, expires_at
         ) values (
           $1::uuid, $2, $3::uuid, $4::uuid, 'active', now(),
           now() + ($5 * interval '1 second')
         )
         returning ${columns}`,
        [
          input.id, input.ownerUserId, input.environmentId, input.executionId,
          input.durationSeconds
        ]
      );
      if (!inserted.rows[0]) throw new Error('Task Execution capacity lease was not acquired.');
      return { kind: 'acquired', lease: mapLease(inserted.rows[0]) };
    };
    return this.client.transaction ? this.client.transaction(run) : run(this.client);
  }

  async read(ownerUserId: string, environmentId: string) {
    await this.client.query(
      `update capacity_leases set state = 'expired'
        where owner_user_id = $1 and environment_id = $2::uuid
          and state = 'active' and expires_at <= now()`,
      [ownerUserId, environmentId]
    );
    const result = await this.client.query<LeaseRow>(
      `select ${columns} from capacity_leases
        where owner_user_id = $1 and environment_id = $2::uuid and state = 'active'
        order by acquired_at desc limit 1`,
      [ownerUserId, environmentId]
    );
    return result.rows[0] ? mapLease(result.rows[0]) : undefined;
  }

  async renew(
    ownerUserId: string,
    leaseId: string,
    executionId: string,
    durationSeconds: number
  ) {
    assertLeaseDuration(durationSeconds);
    const result = await this.client.query<LeaseRow>(
      `update capacity_leases
          set expires_at = now() + ($4 * interval '1 second')
        where owner_user_id = $1 and id = $2::uuid and execution_id = $3::uuid
          and state = 'active' and expires_at > now()
          and expires_at < now() + ($4 * interval '1 second')
        returning ${columns}`,
      [ownerUserId, leaseId, executionId, durationSeconds]
    );
    return result.rows[0] ? mapLease(result.rows[0]) : undefined;
  }

  async release(
    ownerUserId: string,
    leaseId: string,
    executionId: string
  ) {
    const result = await this.client.query<LeaseRow>(
      `update capacity_leases
          set state = 'released', released_at = now()
        where owner_user_id = $1 and id = $2::uuid and execution_id = $3::uuid
          and state = 'active'
        returning ${columns}`,
      [ownerUserId, leaseId, executionId]
    );
    if (result.rows[0]) return mapLease(result.rows[0]);
    const current = await this.client.query<LeaseRow>(
      `select ${columns} from capacity_leases
        where owner_user_id = $1 and id = $2::uuid and execution_id = $3::uuid`,
      [ownerUserId, leaseId, executionId]
    );
    return current.rows[0]?.state === 'released' ? mapLease(current.rows[0]) : undefined;
  }
}

interface MemoryLease extends TaskExecutionCapacityLease {
  ownerUserId: string;
}

export class MemoryTaskExecutionCapacityStore implements TaskExecutionCapacityStore {
  private readonly leases = new Map<string, MemoryLease>();

  constructor(private readonly now: () => number = Date.now) {}

  async acquire(
    input: AcquireTaskExecutionCapacityInput
  ): Promise<TaskExecutionCapacityReservation> {
    assertLeaseDuration(input.durationSeconds);
    const acquiredAt = this.now();
    this.expire(acquiredAt, input.ownerUserId, input.environmentId);
    const existing = this.leases.get(key(input.ownerUserId, input.id));
    if (existing) {
      const lease = publicLease(existing);
      return lease.environmentId === input.environmentId && lease.executionId === input.executionId &&
        leaseDurationSeconds(lease) === input.durationSeconds
        ? { kind: 'replayed', lease }
        : conflict(lease);
    }
    const active = [...this.leases.values()].find((lease) =>
      lease.ownerUserId === input.ownerUserId && lease.environmentId === input.environmentId &&
      lease.state === 'active');
    if (active) return unavailable(publicLease(active));
    const lease: MemoryLease = {
      acquiredAt: new Date(acquiredAt).toISOString(),
      environmentId: input.environmentId,
      executionId: input.executionId,
      expiresAt: new Date(acquiredAt + input.durationSeconds * 1_000).toISOString(),
      id: input.id,
      ownerUserId: input.ownerUserId,
      state: 'active'
    };
    this.leases.set(key(input.ownerUserId, input.id), lease);
    return { kind: 'acquired', lease: publicLease(lease) };
  }

  async read(ownerUserId: string, environmentId: string) {
    this.expire(this.now(), ownerUserId, environmentId);
    const lease = [...this.leases.values()].find((candidate) =>
      candidate.ownerUserId === ownerUserId && candidate.environmentId === environmentId &&
      candidate.state === 'active');
    return lease ? publicLease(lease) : undefined;
  }

  async renew(
    ownerUserId: string,
    leaseId: string,
    executionId: string,
    durationSeconds: number
  ) {
    assertLeaseDuration(durationSeconds);
    const renewedAt = this.now();
    this.expire(renewedAt, ownerUserId);
    const lease = this.leases.get(key(ownerUserId, leaseId));
    const expiresAt = renewedAt + durationSeconds * 1_000;
    if (!lease || lease.executionId !== executionId || lease.state !== 'active' ||
        expiresAt <= Date.parse(lease.expiresAt)) return undefined;
    lease.expiresAt = new Date(expiresAt).toISOString();
    return publicLease(lease);
  }

  async release(
    ownerUserId: string,
    leaseId: string,
    executionId: string
  ) {
    const lease = this.leases.get(key(ownerUserId, leaseId));
    if (!lease || lease.executionId !== executionId || lease.state === 'expired') return undefined;
    if (lease.state === 'active') {
      lease.state = 'released';
      lease.releasedAt = new Date(this.now()).toISOString();
    }
    return publicLease(lease);
  }

  private expire(now: number, ownerUserId: string, environmentId?: string) {
    for (const lease of this.leases.values()) {
      if (lease.ownerUserId === ownerUserId &&
          (!environmentId || lease.environmentId === environmentId) &&
          lease.state === 'active' && Date.parse(lease.expiresAt) <= now) {
        lease.state = 'expired';
      }
    }
  }
}

async function expireLeases(
  client: DatabaseQueryClient,
  ownerUserId: string,
  environmentId: string
) {
  await client.query(
    `update capacity_leases set state = 'expired'
      where owner_user_id = $1 and environment_id = $2::uuid
        and state = 'active' and expires_at <= now()`,
    [ownerUserId, environmentId]
  );
}

function mapLease(row: LeaseRow): TaskExecutionCapacityLease {
  return {
    acquiredAt: new Date(row.acquired_at).toISOString(),
    environmentId: row.environment_id,
    executionId: row.execution_id,
    expiresAt: new Date(row.expires_at).toISOString(),
    id: row.id,
    ...(row.released_at ? { releasedAt: new Date(row.released_at).toISOString() } : {}),
    state: row.state
  };
}

function publicLease(lease: MemoryLease) {
  const { ownerUserId: _, ...record } = lease;
  return structuredClone(record);
}

function unavailable(lease: TaskExecutionCapacityLease) {
  return { kind: 'unavailable', lease } as const;
}

function conflict(lease: TaskExecutionCapacityLease) {
  return { kind: 'conflict', lease } as const;
}

function assertLeaseDuration(durationSeconds: number) {
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds <= 0 || durationSeconds > 86_400) {
    throw new Error('Task Execution capacity lease window is invalid.');
  }
}

function leaseDurationSeconds(lease: TaskExecutionCapacityLease) {
  return (Date.parse(lease.expiresAt) - Date.parse(lease.acquiredAt)) / 1_000;
}

function key(ownerUserId: string, leaseId: string) {
  return `${ownerUserId}\0${leaseId}`;
}
