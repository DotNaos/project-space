import { createHash, randomUUID } from 'node:crypto';

import type { DatabaseQueryClient } from '../database/client';
import {
  legacyConnectorCleanupSchemaVersion,
  type LegacyConnectorCleanupBlocker,
  type LegacyConnectorCleanupBlockerKind,
  type LegacyConnectorCleanupRecord,
  type LegacyConnectorCleanupSnapshot,
  type LegacyConnectorRemovalRequest,
  type LegacyConnectorRemovalResult,
  type LegacyConnectorRemovalResultItem,
  type LegacyConnectorRemovalTarget
} from '../../src/shared/legacy-connector-cleanup-api';

interface LegacyRow {
  canonical_kind: 'provider' | 'tailscale' | null;
  connector_id: string;
  environment_id: string;
  label: string | null;
  machine_updated_at: Date | string;
}

interface LockedLegacyRow extends LegacyRow {}

interface ReceiptRow { fingerprint_sha256: string; }

type BlockerCounts = Record<LegacyConnectorCleanupBlockerKind, number>;

const blockerKinds: readonly LegacyConnectorCleanupBlockerKind[] = [
  'active_credential', 'physical_host_mapping', 'execution_scope', 'environment_reference',
  'access_route', 'run_destination', 'task_execution', 'workspace_runtime',
  'workspace_command', 'active_operation', 'host_agent', 'codex_route', 'codex_snapshot',
  'dev_server', 'connector_operation'
];

const blankCounts = (): BlockerCounts => Object.fromEntries(blockerKinds.map((kind) => [kind, 0])) as BlockerCounts;

function requireText(value: string, name: string) {
  if (!value.trim()) throw new Error(`${name} is required.`);
  return value;
}

function safeLabel(value: string | null) {
  const normalized = (value ?? 'Legacy Connector').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/\s+/g, ' ');
  return (normalized || 'Legacy Connector').slice(0, 80);
}

function fingerprint(row: Pick<LegacyRow, 'connector_id' | 'environment_id' | 'machine_updated_at'>) {
  return createHash('sha256').update(`${row.connector_id}\u0000${row.environment_id}\u0000${new Date(row.machine_updated_at).toISOString()}`).digest('hex');
}

function recordFrom(row: LegacyRow, blockers: readonly LegacyConnectorCleanupBlocker[]): LegacyConnectorCleanupRecord {
  return {
    blockers,
    connectorId: row.connector_id,
    eligible: blockers.length === 0,
    environmentId: row.environment_id,
    fingerprint: fingerprint(row),
    label: safeLabel(row.label),
    replacement: row.canonical_kind ? { environmentId: row.environment_id, kind: row.canonical_kind } : undefined
  };
}

function blockersFrom(counts: Partial<BlockerCounts>): LegacyConnectorCleanupBlocker[] {
  return blockerKinds.flatMap((kind) => (Number(counts[kind] ?? 0) > 0 ? [{ kind, count: Number(counts[kind]) }] : []));
}

export class PostgresLegacyConnectorCleanupStore {
  constructor(
    private readonly client: DatabaseQueryClient,
    private readonly createId: () => string = randomUUID
  ) {}

  async listSnapshot(ownerUserId: string): Promise<LegacyConnectorCleanupSnapshot> {
    const result = await this.client.query<LegacyRow>(
      `select association.connector_id, association.environment_id, membership.updated_at as machine_updated_at,
              identity.name as label,
              case when exists (
                select 1 from tailscale_compute_environment_projections projection
                 where projection.owner_user_id = association.owner_user_id
                   and projection.environment_id = association.environment_id
              ) then 'tailscale'
              when exists (
                select 1 from environment_provider_bindings binding
                 where binding.owner_user_id = association.owner_user_id
                   and binding.environment_id = association.environment_id
              ) then 'provider' end as canonical_kind
         from connector_compute_environments association
         join machine_memberships membership
           on membership.machine_id = association.connector_id
          and membership.user_id = association.owner_user_id
          and membership.role = 'owner'
         left join machine_identities identity
           on identity.id = membership.machine_id and identity.owner_user_id = membership.user_id
         left join legacy_connector_removal_receipts receipt
           on receipt.owner_user_id = association.owner_user_id and receipt.connector_id = association.connector_id
        where association.owner_user_id = $1 and association.association_source = 'legacy'
          and receipt.connector_id is null
        order by association.connector_id`,
      [requireText(ownerUserId, 'ownerUserId')]
    );
    const records = await Promise.all(result.rows.map(async (row) => recordFrom(row, blockersFrom(await this.blockerCounts(this.client, ownerUserId, row.connector_id, row.environment_id)))));
    return { records, schemaVersion: legacyConnectorCleanupSchemaVersion };
  }

  async remove(ownerUserId: string, request: LegacyConnectorRemovalRequest): Promise<LegacyConnectorRemovalResult> {
    requireText(ownerUserId, 'ownerUserId'); requireText(request.actorId, 'actorId'); requireText(request.requestId, 'requestId');
    const seen = new Set<string>();
    const results: LegacyConnectorRemovalResultItem[] = [];
    for (const target of request.records) {
      const key = `${target.connectorId}\u0000${target.fingerprint}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(await this.removeOne(ownerUserId, request, target));
    }
    return { requestId: request.requestId, results };
  }

  private async removeOne(ownerUserId: string, request: LegacyConnectorRemovalRequest, target: LegacyConnectorRemovalTarget) {
    const run = async (client: DatabaseQueryClient): Promise<LegacyConnectorRemovalResultItem> => {
      const receipt = await client.query<ReceiptRow>(
        `select fingerprint_sha256 from legacy_connector_removal_receipts
          where owner_user_id = $1 and connector_id = $2 for update`, [ownerUserId, target.connectorId]
      );
      if (receipt.rows[0]) return {
        connectorId: target.connectorId, fingerprint: target.fingerprint,
        outcome: receipt.rows[0].fingerprint_sha256 === target.fingerprint ? 'already_removed' : 'conflict'
      };
      const current = await client.query<LockedLegacyRow>(
        `select association.connector_id, association.environment_id, membership.updated_at as machine_updated_at,
                identity.name as label, null::text as canonical_kind
           from connector_compute_environments association
           join machine_memberships membership
             on membership.machine_id = association.connector_id and membership.user_id = association.owner_user_id
            and membership.role = 'owner'
           left join machine_identities identity on identity.id = membership.machine_id and identity.owner_user_id = membership.user_id
          where association.owner_user_id = $1 and association.connector_id = $2 and association.association_source = 'legacy'
          for update of association, membership`, [ownerUserId, target.connectorId]
      );
      const row = current.rows[0];
      if (!row || fingerprint(row) !== target.fingerprint) return { connectorId: target.connectorId, fingerprint: target.fingerprint, outcome: 'conflict' };
      const blockers = blockersFrom(await this.blockerCounts(client, ownerUserId, row.connector_id, row.environment_id));
      if (blockers.length) return { blockers, connectorId: target.connectorId, fingerprint: target.fingerprint, outcome: 'blocked' };
      const inserted = await client.query<{ id: string }>(
        `insert into legacy_connector_removal_receipts (
           id, owner_user_id, actor_id, request_id, connector_id, fingerprint_sha256, environment_id
         ) values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (owner_user_id, connector_id) do nothing returning id`,
        [this.createId(), ownerUserId, request.actorId, request.requestId, row.connector_id, target.fingerprint, row.environment_id]
      );
      return { connectorId: target.connectorId, fingerprint: target.fingerprint, outcome: inserted.rows[0] ? 'removed' : 'already_removed' };
    };
    return this.client.transaction ? this.client.transaction(run) : run(this.client);
  }

  private async blockerCounts(client: DatabaseQueryClient, ownerUserId: string, connectorId: string, environmentId: string): Promise<BlockerCounts> {
    const result = await client.query<Partial<BlockerCounts>>(
      `select
        (select count(*) from connector_credentials credential where credential.owner_user_id = $1 and credential.machine_id = $2 and credential.revoked_at is null and credential.expires_at > now())::int as active_credential,
        (select count(*) from physical_machine_connectors physical where physical.owner_user_id = $1 and physical.connector_id = $2)::int as physical_host_mapping,
        (select count(*) from machine_execution_scope_members scope where scope.owner_user_id = $1 and scope.machine_id = $2)::int as execution_scope,
        (select count(*) from compute_environments child where child.owner_user_id = $1 and child.parent_environment_id = $3::uuid)::int as environment_reference,
        (select count(*) from access_routes route where route.owner_user_id = $1 and route.environment_id = $3::uuid)::int as access_route,
        (select count(*) from user_project_run_settings destination where destination.user_id = $1 and destination.machine_id = $2)::int as run_destination,
        ((select count(*) from task_executions execution where execution.owner_user_id = $1 and (execution.connector_id = $2 or execution.environment_id = $3::uuid) and execution.state not in ('blocked', 'completed', 'failed', 'cancelled', 'archived')) +
         (select count(*) from capacity_leases lease where lease.owner_user_id = $1 and lease.environment_id = $3::uuid and lease.state = 'active'))::int as task_execution,
        (select count(*) from workspace_runtime_generations runtime where runtime.owner_user_id = $1 and runtime.environment_id = $3::uuid and runtime.lifecycle_state not in ('stopped', 'failed') and runtime.connection_state <> 'superseded')::int as workspace_runtime,
        (select count(*) from workspace_commands command where command.owner_user_id = $1 and (command.connector_id = $2 or command.environment_id = $3::uuid) and command.state in ('queued', 'running', 'uncertain'))::int as workspace_command,
        ((select count(*) from agent_authorization_operations operation where operation.owner_user_id = $1 and (operation.connector_id = $2 or operation.environment_id = $3::uuid) and operation.state in ('dispatching', 'pending', 'ambiguous', 'retryable')) +
         (select count(*) from ssh_gateway_operations operation where operation.owner_user_id = $1 and operation.environment_id = $3::uuid and operation.state in ('reserved', 'dispatching', 'uncertain')) +
         (select count(*) from canonical_runtime_control_operations operation where operation.owner_user_id = $1 and operation.environment_id = $3::uuid and operation.state in ('reserved', 'dispatching', 'uncertain')))::int as active_operation,
        (select count(*) from project_hostd_devices device where device.owner_user_id = $1 and device.environment_id = $3::uuid)::int as host_agent,
        ((select count(*) from codex_session_operations operation where operation.owner_user_id = $1 and operation.machine_id = $2 and operation.state in ('pending', 'ambiguous')) +
         (select count(*) from codex_machine_task_starts task where task.owner_user_id = $1 and task.connector_id = $2 and task.state in ('pending', 'uncertain')) +
         (select count(*) from codex_machine_task_sends task where task.owner_user_id = $1 and task.connector_id = $2 and task.state in ('pending', 'queued', 'uncertain')))::int as codex_route,
        (select count(*) from codex_session_snapshots snapshot where snapshot.owner_user_id = $1 and snapshot.machine_id = $2 and not snapshot.archived and snapshot.status in ('active', 'idle', 'offline', 'unavailable'))::int as codex_snapshot,
        ((select count(*) from dev_server_sessions server where server.owner_user_id = $1 and server.machine_id = $2 and server.state in ('starting', 'running', 'stopping')) +
         (select count(*) from pull_request_dev_server_leases lease where lease.owner_user_id = $1 and lease.connector_id = $2 and lease.revoked_at is null and lease.expires_at > now()))::int as dev_server,
        (select count(*) from connector_runtime_operations operation where operation.machine_id = $2 and operation.state not in ('succeeded', 'failed', 'rolled-back'))::int as connector_operation`,
      [ownerUserId, connectorId, environmentId]
    );
    return { ...blankCounts(), ...(result.rows[0] ?? {}) };
  }
}
