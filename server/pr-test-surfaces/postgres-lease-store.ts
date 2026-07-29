import type { DatabaseQueryClient } from '../database/client';
import {
  type PullRequestDevServerLease,
  type PullRequestDevServerLeaseMutationResult,
  type PullRequestDevServerLeaseStore
} from './lease-service';
import { requirePrototypeSurface } from './validation';

interface LeaseRow {
  branch_name: string;
  codex_thread_id: string | null;
  commit_sha: string;
  connector_id: string;
  created_at: Date | string;
  expires_at: Date | string;
  heartbeat_at: Date | string;
  id: string;
  lease_generation: number | string;
  owner_user_id: string;
  physical_machine_id: string;
  project_id: string;
  pull_request_number: number | string;
  repository_full_name: string;
  revoked_at: Date | string | null;
  served_surface: string;
  server_id: string;
  tailscale_ipv4: string;
  tailscale_port: number | string;
  tailscale_url: string;
  updated_at: Date | string;
  worktree_id: string;
}

type HeartbeatInput = Parameters<PullRequestDevServerLeaseStore['heartbeat']>[0];
type ReleaseInput = Parameters<PullRequestDevServerLeaseStore['release']>[0];
type SupersedeInput = Parameters<PullRequestDevServerLeaseStore['supersede']>[0];

const leaseColumns = `
  id,
  owner_user_id,
  repository_full_name,
  pull_request_number,
  project_id,
  worktree_id,
  branch_name,
  commit_sha,
  served_surface,
  physical_machine_id,
  connector_id,
  server_id,
  host(tailscale_ipv4) as tailscale_ipv4,
  tailscale_port,
  tailscale_url,
  codex_thread_id,
  lease_generation,
  heartbeat_at,
  expires_at,
  revoked_at,
  created_at,
  updated_at
`;

const leaseTable = 'pull_request_dev_server_leases';

export class PostgresPullRequestDevServerLeaseStore
  implements PullRequestDevServerLeaseStore {
  constructor(private readonly client: DatabaseQueryClient) {}

  async readCurrent(
    scope: Parameters<PullRequestDevServerLeaseStore['readCurrent']>[0]
  ) {
    const result = await this.client.query<LeaseRow>(
      `select ${leaseColumns}
         from ${leaseTable}
        where owner_user_id = $1
          and lower(repository_full_name) = lower($2)
          and pull_request_number = $3
          and revoked_at is null
        order by lease_generation desc
        limit 1`,
      [scope.ownerUserId, scope.repositoryFullName, scope.pullRequestNumber]
    );
    return result.rows[0] ? mapLease(result.rows[0]) : null;
  }

  async supersede(input: SupersedeInput) {
    assertActorMatchesRegistration(input);
    return this.withTransaction(async (transaction) => {
      const scope = {
        ownerUserId: input.actor.userId,
        pullRequestNumber: input.registration.pullRequestNumber,
        repositoryFullName: input.registration.repositoryFullName
      };
      await lockScope(transaction, scope);
      const current = await selectCurrentForUpdate(transaction, scope);
      const generation = current ? positiveSafeInteger(
        current.lease_generation,
        'lease_generation'
      ) + 1 : 1;
      if (!Number.isSafeInteger(generation)) {
        throw new Error('lease_generation exceeds the safe integer range.');
      }

      if (current) {
        await transaction.query(
          `update ${leaseTable}
              set expires_at = $2,
                  revoked_at = $2,
                  updated_at = $2
            where id = $1
              and revoked_at is null`,
          [current.id, input.at]
        );
      }

      const leaseId = input.createId();
      const registration = input.registration;
      const inserted = await transaction.query<LeaseRow>(
        `insert into ${leaseTable} (
           id,
           owner_user_id,
           repository_full_name,
           pull_request_number,
           project_id,
           worktree_id,
           branch_name,
           commit_sha,
           served_surface,
           physical_machine_id,
           connector_id,
           server_id,
           tailscale_ipv4,
           tailscale_port,
           tailscale_url,
           codex_thread_id,
           lease_generation,
           heartbeat_at,
           expires_at,
           revoked_at,
           created_at,
           updated_at
         ) values (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
           $12, $13::inet, $14, $15, $16, $17, $18, $19, null, $18, $18
         )
         returning ${leaseColumns}`,
        [
          leaseId,
          input.actor.userId,
          registration.repositoryFullName,
          registration.pullRequestNumber,
          registration.projectId,
          registration.worktreeId,
          registration.branchName,
          registration.commitSha,
          registration.servedSurface,
          input.actor.machineId,
          input.actor.connectorId,
          registration.serverId,
          registration.tailscaleIpv4,
          registration.tailscalePort,
          registration.tailscaleUrl,
          registration.codexThreadId ?? null,
          generation,
          input.at,
          registration.expiresAt
        ]
      );
      return mapRequiredLease(inserted.rows[0], 'insert');
    });
  }

  async heartbeat(
    input: HeartbeatInput
  ): Promise<PullRequestDevServerLeaseMutationResult> {
    return this.withLockedLease(input.leaseId, async (transaction, row) => {
      const state = await mutableLeaseState(transaction, row, input);
      if (state) return state;
      if (Date.parse(asIso(row.expires_at, 'expires_at')) <= Date.parse(input.heartbeatAt)) {
        return { state: 'expired' as const };
      }
      const updated = await transaction.query<LeaseRow>(
        `update ${leaseTable}
            set heartbeat_at = $2,
                expires_at = $3,
                tailscale_ipv4 = $4::inet,
                tailscale_port = $5,
                tailscale_url = $6,
                updated_at = $2
          where id = $1
            and revoked_at is null
          returning ${leaseColumns}`,
        [
          input.leaseId,
          input.heartbeatAt,
          input.expiresAt,
          input.tailscaleIpv4,
          input.tailscalePort,
          input.tailscaleUrl
        ]
      );
      return updatedResult(updated.rows[0], 'heartbeat');
    });
  }

  async release(
    input: ReleaseInput
  ): Promise<PullRequestDevServerLeaseMutationResult> {
    return this.withLockedLease(input.leaseId, async (transaction, row) => {
      const state = await mutableLeaseState(transaction, row, input);
      if (state) return state;
      const updated = await transaction.query<LeaseRow>(
        `update ${leaseTable}
            set expires_at = $2,
                revoked_at = $2,
                updated_at = $2
          where id = $1
            and revoked_at is null
          returning ${leaseColumns}`,
        [input.leaseId, input.revokedAt]
      );
      return updatedResult(updated.rows[0], 'release');
    });
  }

  private async withLockedLease<Result>(
    leaseId: string,
    operation: (
      transaction: DatabaseQueryClient,
      row: LeaseRow
    ) => Promise<Result>
  ): Promise<Result | { state: 'missing' }> {
    return this.withTransaction(async (transaction) => {
      const initial = await selectLease(transaction, leaseId);
      if (!initial) return { state: 'missing' as const };
      await lockScope(transaction, scopeFromRow(initial));
      const locked = await selectLease(transaction, leaseId, true);
      if (!locked) return { state: 'missing' as const };
      return operation(transaction, locked);
    });
  }

  private async withTransaction<Result>(
    operation: (transaction: DatabaseQueryClient) => Promise<Result>
  ) {
    if (!this.client.transaction) {
      throw new Error('PR Dev Server lease mutations require transaction support.');
    }
    return this.client.transaction(operation);
  }
}

async function mutableLeaseState(
  transaction: DatabaseQueryClient,
  row: LeaseRow,
  input: HeartbeatInput | ReleaseInput
): Promise<Exclude<PullRequestDevServerLeaseMutationResult, { state: 'updated' }> | null> {
  if (
    row.owner_user_id !== input.actor.userId ||
    row.connector_id !== input.actor.connectorId
  ) {
    return { state: 'forbidden' };
  }
  if (
    row.physical_machine_id !== input.actor.machineId ||
    positiveSafeInteger(row.lease_generation, 'lease_generation') !== input.generation
  ) {
    return { state: 'superseded' };
  }
  if (row.revoked_at) {
    const current = await selectCurrent(transaction, scopeFromRow(row));
    return { state: current && current.id !== row.id ? 'superseded' : 'revoked' };
  }
  const current = await selectCurrent(transaction, scopeFromRow(row));
  return current?.id === row.id ? null : { state: 'superseded' };
}

async function lockScope(
  client: DatabaseQueryClient,
  scope: {
    ownerUserId: string;
    pullRequestNumber: number;
    repositoryFullName: string;
  }
) {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
    JSON.stringify([
      'project-space:pr-dev-server-lease',
      scope.ownerUserId,
      scope.repositoryFullName.toLowerCase(),
      scope.pullRequestNumber
    ])
  ]);
}

async function selectCurrent(
  client: DatabaseQueryClient,
  scope: {
    ownerUserId: string;
    pullRequestNumber: number;
    repositoryFullName: string;
  }
) {
  const result = await client.query<LeaseRow>(
    `select ${leaseColumns}
       from ${leaseTable}
      where owner_user_id = $1
        and lower(repository_full_name) = lower($2)
        and pull_request_number = $3
        and revoked_at is null
      order by lease_generation desc
      limit 1`,
    [scope.ownerUserId, scope.repositoryFullName, scope.pullRequestNumber]
  );
  return result.rows[0] ?? null;
}

async function selectCurrentForUpdate(
  client: DatabaseQueryClient,
  scope: {
    ownerUserId: string;
    pullRequestNumber: number;
    repositoryFullName: string;
  }
) {
  const result = await client.query<LeaseRow>(
    `select ${leaseColumns}
       from ${leaseTable}
      where owner_user_id = $1
        and lower(repository_full_name) = lower($2)
        and pull_request_number = $3
        and revoked_at is null
      order by lease_generation desc
      limit 1
      for update`,
    [scope.ownerUserId, scope.repositoryFullName, scope.pullRequestNumber]
  );
  return result.rows[0] ?? null;
}

async function selectLease(
  client: DatabaseQueryClient,
  leaseId: string,
  forUpdate = false
) {
  const result = await client.query<LeaseRow>(
    `select ${leaseColumns}
       from ${leaseTable}
      where id = $1${forUpdate ? '\n      for update' : ''}`,
    [leaseId]
  );
  return result.rows[0] ?? null;
}

function assertActorMatchesRegistration(input: SupersedeInput) {
  if (
    input.registration.connectorId !== input.actor.connectorId ||
    input.registration.machineId !== input.actor.machineId
  ) {
    throw new Error('Lease registration actor does not match its machine context.');
  }
}

function scopeFromRow(row: LeaseRow) {
  return {
    ownerUserId: row.owner_user_id,
    pullRequestNumber: positiveSafeInteger(row.pull_request_number, 'pull_request_number'),
    repositoryFullName: row.repository_full_name
  };
}

function updatedResult(row: LeaseRow | undefined, operation: string) {
  return {
    lease: mapRequiredLease(row, operation),
    state: 'updated' as const
  };
}

function mapRequiredLease(row: LeaseRow | undefined, operation: string) {
  if (!row) {
    throw new Error(`PR Dev Server lease ${operation} returned no row.`);
  }
  return mapLease(row);
}

function mapLease(row: LeaseRow): PullRequestDevServerLease {
  return {
    branchName: row.branch_name,
    ...(row.codex_thread_id ? { codexThreadId: row.codex_thread_id } : {}),
    commitSha: row.commit_sha,
    connectorId: row.connector_id,
    createdAt: asIso(row.created_at, 'created_at'),
    expiresAt: asIso(row.expires_at, 'expires_at'),
    generation: positiveSafeInteger(row.lease_generation, 'lease_generation'),
    heartbeatAt: asIso(row.heartbeat_at, 'heartbeat_at'),
    id: row.id,
    machineId: row.physical_machine_id,
    ownerUserId: row.owner_user_id,
    projectId: row.project_id,
    pullRequestNumber: positiveSafeInteger(row.pull_request_number, 'pull_request_number'),
    repositoryFullName: row.repository_full_name,
    ...(row.revoked_at ? { revokedAt: asIso(row.revoked_at, 'revoked_at') } : {}),
    servedSurface: requirePrototypeSurface(row.served_surface),
    serverId: row.server_id,
    tailscaleIpv4: row.tailscale_ipv4,
    tailscalePort: positiveSafeInteger(row.tailscale_port, 'tailscale_port'),
    tailscaleUrl: row.tailscale_url,
    updatedAt: asIso(row.updated_at, 'updated_at'),
    worktreeId: row.worktree_id
  };
}

function positiveSafeInteger(value: number | string, name: string) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return number;
}

function asIso(value: Date | string, name: string) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${name} must be a valid timestamp.`);
  }
  return date.toISOString();
}
