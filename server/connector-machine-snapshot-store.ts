import type { DatabaseQueryClient } from './database/client';
import type { ConnectorProjectRegistryResult } from '../src/shared/project-space-api';

export interface PersistedConnectorSnapshot {
  firstSeenAt: string;
  lastSeenAt: string;
  registry: ConnectorProjectRegistryResult;
}

interface SnapshotRow {
  first_seen_at: Date | string;
  last_seen_at: Date | string;
  registry: unknown;
}

function iso(value: Date | string) {
  return new Date(value).toISOString();
}

export class ConnectorMachineSnapshotStore {
  constructor(private readonly client: DatabaseQueryClient) {}

  async upsert(registry: ConnectorProjectRegistryResult, receivedAt: string) {
    const machineId = registry.connector.machineId.trim();
    await this.client.query(
      `insert into connector_machine_snapshots (
         machine_id, machine_name, registry, first_seen_at, last_seen_at
       ) values ($1, $2, $3, $4, $4)
       on conflict (machine_id) do update set
         machine_name = excluded.machine_name,
         registry = excluded.registry,
         last_seen_at = excluded.last_seen_at
       where connector_machine_snapshots.removed_at is null
         and connector_machine_snapshots.last_seen_at <= excluded.last_seen_at`,
      [machineId, registry.connector.machineName, registry, receivedAt]
    );
  }

  async list(): Promise<PersistedConnectorSnapshot[]> {
    const result = await this.client.query<SnapshotRow>(
      `select registry, first_seen_at, last_seen_at
         from connector_machine_snapshots
        where removed_at is null
        order by machine_name, machine_id`
    );
    return result.rows.map((row) => ({
      firstSeenAt: iso(row.first_seen_at),
      lastSeenAt: iso(row.last_seen_at),
      registry: row.registry as ConnectorProjectRegistryResult
    }));
  }

  async removeApproved(machineId: string, approvedByUserId: string, removedAt: string) {
    const normalizedMachineId = machineId.trim();
    const normalizedUserId = approvedByUserId.trim();
    if (!normalizedMachineId || !normalizedUserId) {
      throw new Error('Approved machine removal requires a machine and approving user.');
    }
    const result = await this.client.query<{ machine_id: string }>(
      `update connector_machine_snapshots
          set removed_at = $3,
              removed_by_user_id = $2
        where machine_id = $1
          and removed_at is null
          and exists (
            select 1
              from machine_memberships
             where machine_id = $1
               and user_id = $2
               and role = 'owner'
          )
      returning machine_id`,
      [normalizedMachineId, normalizedUserId, removedAt]
    );
    return result.rows.length > 0;
  }
}
