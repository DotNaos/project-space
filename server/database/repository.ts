import { createHash, randomUUID } from 'node:crypto';

import type { DatabaseQueryClient } from './client';
import type {
  CreateDevServerSessionInput,
  DevServerSession,
  DevServerSessionKey,
  DevServerSessionListFilter,
  DevServerSessionState,
  MachineMembership,
  MachineMembershipKey,
  MachineMembershipRole,
  MachineExecutionScopeKey,
  PhysicalMachineKey,
  ProjectRunSettings,
  ProjectRunSettingsKey,
  SavePhysicalMachineInput,
  SaveMachineExecutionScopeInput,
  TransitionDevServerSessionInput,
  UpsertUserProjectsStateInput,
  UpsertProjectRunSettingsInput
} from './models';
import { normalizeProjectsState } from './projects-state';
import type {
  MachineExecutionScopeRecord,
  MachineRecord,
  PhysicalMachineRecord,
  ProjectsState
} from '../../src/shared/project-space-api';
import type {
  ComputeEnvironmentKind,
  ComputeEnvironmentRecord,
  ComputeHostRecord,
  ComputeInventorySnapshot,
  ComputePlatformRecord,
  ConnectorEnvironmentAssociation,
  ConnectorComputeMetadata,
  EnvironmentDefinitionRecord,
  ResourceProfile
} from '../../src/shared/compute-environment-api';
import {
  builtInEnvironmentDefinition,
  reconcileBuiltInEnvironmentDefinitions,
  validateComputeInventory
} from '../../src/shared/compute-environment-api';

interface MachineMembershipRow {
  created_at: Date | string;
  id: string;
  machine_id: string;
  role: MachineMembershipRole;
  updated_at: Date | string;
  user_id: string;
}

interface ProjectRunSettingsRow {
  allowed_hosts: string[];
  created_at: Date | string;
  id: string;
  machine_id: string;
  preferred_worktree_id: string | null;
  project_id: string;
  run_target: string;
  updated_at: Date | string;
  user_id: string;
}

interface DevServerSessionRow {
  created_at: Date | string;
  id: string;
  last_error: string | null;
  last_seen_at: Date | string | null;
  local_port: number | null;
  machine_id: string;
  owner_user_id: string;
  project_id: string;
  run_target: string;
  server_id: string;
  runtime_generation: number | string;
  started_at: Date | string | null;
  state: DevServerSessionState;
  stopped_at: Date | string | null;
  tailscale_port: number | null;
  tailscale_url: string | null;
  updated_at: Date | string;
  worktree_id: string;
}

interface UserProjectsStateRow {
  state: unknown;
}

interface MachineExecutionScopeRow {
  id: string;
  machine_ids: string[];
  name: string;
}

interface PhysicalMachineRow {
  connector_ids: string[];
  id: string;
  name: string;
}

interface ComputePlatformRow {
  id: string;
  kind: ComputePlatformRecord['kind'];
  name: string;
}

interface ComputeHostRow {
  legacy_tombstoned_only?: boolean;
  id: string;
  identity_key: string;
  identity_version: number;
  name: string;
  platform_id: string;
  resources: ResourceProfile | null;
}

interface EnvironmentDefinitionRow {
  bootstrap_strategy: EnvironmentDefinitionRecord['bootstrapStrategy'];
  id: string;
  kind: EnvironmentDefinitionRecord['kind'];
  name: string;
  operating_system_family: EnvironmentDefinitionRecord['operatingSystemFamily'];
  ownership: EnvironmentDefinitionRecord['ownership'];
  slug: string;
  supported_architectures: string[];
}

interface ComputeEnvironmentRow {
  environment_definition_id: string;
  host_evidence: ComputeEnvironmentRecord['hostAssociation']['evidence'];
  host_id: string | null;
  host_resolution: ComputeEnvironmentRecord['hostAssociation']['resolution'];
  id: string;
  identity_key: string;
  identity_resolution: 'resolved' | 'conflict';
  identity_version: number;
  kind: ComputeEnvironmentRecord['kind'];
  legacy_tombstoned_only?: boolean;
  name: string;
  parent_environment_id: string | null;
  platform_id: string;
  resource_mode: ComputeEnvironmentRecord['resourceMode'];
  resources: ResourceProfile | null;
}

interface ConnectorEnvironmentRow {
  associated_at: Date | string;
  connector_id: string;
  environment_id: string;
}

const membershipColumns = `
  id, machine_id, user_id, role, created_at, updated_at
`;

const runSettingsColumns = `
  id, user_id, machine_id, project_id, run_target, preferred_worktree_id,
  allowed_hosts, created_at, updated_at
`;

const sessionColumns = `
  id, owner_user_id, machine_id, project_id, worktree_id, run_target, server_id, state,
  runtime_generation, local_port, tailscale_port, tailscale_url, last_error,
  started_at, stopped_at, last_seen_at, created_at, updated_at
`;

function toIsoString(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function optionalIsoString(value: Date | string | null) {
  return value === null ? undefined : toIsoString(value);
}

function requireValue(value: string, name: string) {
  const normalized = value.trim();

  if (!normalized) {
    throw new Error(`${name} is required.`);
  }

  return normalized;
}

function normalizeAllowedHosts(hosts: readonly string[]) {
  return [...new Set(hosts.map((host) => host.trim().toLowerCase()).filter(Boolean))];
}

function accountScopedIdentity(userId: string, key: string) {
  return `account:${createHash('sha256').update(userId).update('\0').update(key).digest('hex')}`;
}

function mapMembership(row: MachineMembershipRow): MachineMembership {
  return {
    createdAt: toIsoString(row.created_at),
    id: row.id,
    machineId: row.machine_id,
    role: row.role,
    updatedAt: toIsoString(row.updated_at),
    userId: row.user_id
  };
}

function mapRunSettings(row: ProjectRunSettingsRow): ProjectRunSettings {
  return {
    allowedHosts: row.allowed_hosts,
    createdAt: toIsoString(row.created_at),
    id: row.id,
    machineId: row.machine_id,
    preferredWorktreeId: row.preferred_worktree_id ?? undefined,
    projectId: row.project_id,
    runTarget: row.run_target,
    updatedAt: toIsoString(row.updated_at),
    userId: row.user_id
  };
}

function mapSession(row: DevServerSessionRow): DevServerSession {
  return {
    createdAt: toIsoString(row.created_at),
    generation: Number(row.runtime_generation),
    id: row.id,
    lastError: row.last_error ?? undefined,
    lastSeenAt: optionalIsoString(row.last_seen_at),
    localPort: row.local_port ?? undefined,
    machineId: row.machine_id,
    ownerUserId: row.owner_user_id,
    projectId: row.project_id,
    runTarget: row.run_target,
    serverId: row.server_id,
    startedAt: optionalIsoString(row.started_at),
    state: row.state,
    stoppedAt: optionalIsoString(row.stopped_at),
    tailscalePort: row.tailscale_port ?? undefined,
    tailscaleUrl: row.tailscale_url ?? undefined,
    updatedAt: toIsoString(row.updated_at),
    worktreeId: row.worktree_id
  };
}

export class ProjectSpaceDatabaseRepository {
  constructor(
    private readonly client: DatabaseQueryClient,
    private readonly createId: () => string = randomUUID
  ) {}

  async listComputeInventory(
    userId: string,
    options: { additionalOwnerUserIds?: readonly string[] } = {}
  ): Promise<ComputeInventorySnapshot> {
    const ownerUserId = requireValue(userId, 'userId');
    const visibleOwnerUserIds = [...new Set([
      ownerUserId,
      ...(options.additionalOwnerUserIds ?? []).map((value) => requireValue(value, 'ownerUserId'))
    ])];
    const [definitionResult, platformResult, hostResult, environmentResult, connectorResult] = await Promise.all([
      this.client.query<EnvironmentDefinitionRow>(
        `select id, slug, name, kind, operating_system_family, supported_architectures,
                bootstrap_strategy, ownership
           from compute_environment_definitions
          where owner_user_id = any($1::text[]) order by lower(name), id`,
        [visibleOwnerUserIds]
      ),
      this.client.query<ComputePlatformRow>(
        `select id, kind, name from compute_platforms
          where owner_user_id = any($1::text[]) order by lower(name), id`,
        [visibleOwnerUserIds]
      ),
      this.client.query<ComputeHostRow>(
        `select id, platform_id, identity_version, identity_key, name, resources,
                (
                  exists (
                    select 1 from compute_environments environment
                    join connector_compute_environments legacy
                      on legacy.owner_user_id = environment.owner_user_id and legacy.environment_id = environment.id
                    join legacy_connector_removal_receipts receipt
                      on receipt.owner_user_id = legacy.owner_user_id and receipt.connector_id = legacy.connector_id
                   where environment.owner_user_id = compute_hosts.owner_user_id and environment.host_id = compute_hosts.id
                     and legacy.association_source = 'legacy'
                  )
                  and not exists (
                    select 1 from compute_environments environment
                   where environment.owner_user_id = compute_hosts.owner_user_id and environment.host_id = compute_hosts.id
                     and (
                       not exists (
                         select 1 from connector_compute_environments legacy
                         join legacy_connector_removal_receipts receipt on receipt.owner_user_id = legacy.owner_user_id and receipt.connector_id = legacy.connector_id
                         where legacy.owner_user_id = environment.owner_user_id and legacy.environment_id = environment.id and legacy.association_source = 'legacy'
                       )
                       or exists (select 1 from environment_provider_bindings binding where binding.owner_user_id = environment.owner_user_id and binding.environment_id = environment.id)
                       or exists (select 1 from tailscale_compute_environment_projections projection where projection.owner_user_id = environment.owner_user_id and projection.environment_id = environment.id)
                     )
                  )
                  and not exists (select 1 from physical_machines physical where physical.owner_user_id = compute_hosts.owner_user_id and physical.id = compute_hosts.id)
                ) as legacy_tombstoned_only
           from compute_hosts where owner_user_id = any($1::text[]) order by lower(name), id`,
        [visibleOwnerUserIds]
      ),
      this.client.query<ComputeEnvironmentRow>(
        `select id, environment_definition_id, platform_id, host_id,
                parent_environment_id, identity_version,
                identity_key, identity_resolution, kind, name, host_resolution, host_evidence,
                resource_mode, resources,
                (
                  exists (
                    select 1 from connector_compute_environments legacy
                    join legacy_connector_removal_receipts receipt
                      on receipt.owner_user_id = legacy.owner_user_id and receipt.connector_id = legacy.connector_id
                   where legacy.owner_user_id = compute_environments.owner_user_id
                     and legacy.environment_id = compute_environments.id
                     and legacy.association_source = 'legacy'
                  )
                  and not exists (
                    select 1 from connector_compute_environments live
                    left join legacy_connector_removal_receipts receipt
                      on receipt.owner_user_id = live.owner_user_id and receipt.connector_id = live.connector_id
                   where live.owner_user_id = compute_environments.owner_user_id
                     and live.environment_id = compute_environments.id and receipt.connector_id is null
                  )
                  and not exists (select 1 from environment_provider_bindings binding where binding.owner_user_id = compute_environments.owner_user_id and binding.environment_id = compute_environments.id)
                  and not exists (select 1 from tailscale_compute_environment_projections projection where projection.owner_user_id = compute_environments.owner_user_id and projection.environment_id = compute_environments.id)
                ) as legacy_tombstoned_only
           from compute_environments where owner_user_id = any($1::text[]) order by lower(name), id`,
        [visibleOwnerUserIds]
      ),
      this.client.query<ConnectorEnvironmentRow>(
        `select association.connector_id, association.environment_id, association.associated_at
           from connector_compute_environments association
           left join legacy_connector_removal_receipts receipt
             on receipt.owner_user_id = association.owner_user_id and receipt.connector_id = association.connector_id
          where association.owner_user_id = $1 and receipt.connector_id is null
          order by connector_id`,
        [ownerUserId]
      )
    ]);
    const visibleEnvironmentRows = environmentResult.rows.filter((row) => !row.legacy_tombstoned_only);
    const hosts: ComputeHostRecord[] = hostResult.rows.filter((row) => !row.legacy_tombstoned_only).map((row) => ({
      id: row.id,
      identity: { key: row.identity_key, version: row.identity_version },
      name: row.name,
      platformId: row.platform_id,
      resources: row.resources ?? undefined
    }));
    const environments: ComputeEnvironmentRecord[] = visibleEnvironmentRows.map((row) => ({
      environmentDefinitionId: row.environment_definition_id,
      hostAssociation: row.host_resolution === 'verified'
        ? { evidence: row.host_evidence as 'provider' | 'tpm' | 'smbios' | 'host_broker', hostId: row.host_id!, resolution: 'verified' }
        : row.host_resolution === 'manual'
          ? { evidence: 'user', hostId: row.host_id!, resolution: 'manual' }
          : row.host_resolution === 'conflict'
            ? { evidence: row.host_evidence, hostId: row.host_id ?? undefined, resolution: 'conflict' } as ComputeEnvironmentRecord['hostAssociation']
            : row.host_resolution === 'not_applicable'
              ? { evidence: row.host_evidence as 'none' | 'provider', resolution: 'not_applicable' }
              : { evidence: 'none', resolution: 'unresolved' },
      id: row.id,
      identity: { key: row.identity_key, version: row.identity_version },
      identityResolution: row.identity_resolution,
      kind: row.kind,
      name: row.name,
      parentEnvironmentId: row.parent_environment_id ?? undefined,
      platformId: row.platform_id,
      resourceMode: row.resource_mode,
      resources: row.resources ?? undefined
    }));
    const environmentDefinitions: EnvironmentDefinitionRecord[] = definitionResult.rows.map((row) => ({
      bootstrapStrategy: row.bootstrap_strategy,
      id: row.id,
      kind: row.kind,
      name: row.name,
      operatingSystemFamily: row.operating_system_family,
      ownership: row.ownership,
      slug: row.slug,
      supportedArchitectures: row.supported_architectures
    }));
    const platforms: ComputePlatformRecord[] = platformResult.rows;
    const connectors: ConnectorEnvironmentAssociation[] = connectorResult.rows.map((row) => ({
      associatedAt: toIsoString(row.associated_at),
      connectorId: row.connector_id,
      environmentId: row.environment_id
    }));
    const reconciled = reconcileBuiltInEnvironmentDefinitions({
      environmentDefinitions,
      environments
    });
    const input = { ...reconciled, connectors, hosts, platforms };
    return { ...input, violations: validateComputeInventory(input) };
  }

  async reconcileConnectorComputeInventory(
    userId: string,
    machines: readonly Pick<MachineRecord, 'compute' | 'id' | 'name'>[]
  ) {
    const ownerUserId = requireValue(userId, 'userId');
    const reported = machines.filter((machine): machine is typeof machine & { compute: ConnectorComputeMetadata } => (
      machine.compute !== undefined
    ));
    if (reported.length === 0) return;

    const operation = async (client: DatabaseQueryClient) => {
      for (const machine of reported) {
        const owned = await client.query<{ machine_id: string }>(
          `select machine_id from machine_memberships
            where machine_id = $1 and user_id = $2 and role = 'owner' for update`,
          [machine.id, ownerUserId]
        );
        if (!owned.rows[0]) continue;
        const retired = await client.query<{ connector_id: string }>(
          `select connector_id from legacy_connector_removal_receipts
            where owner_user_id = $1 and connector_id = $2`,
          [ownerUserId, machine.id]
        );
        if (retired.rows[0]) continue;
        const metadata = machine.compute;
        const platform = await client.query<{ id: string }>(
          `insert into compute_platforms (id, owner_user_id, kind, name)
           values ($1, $2, $3, $4)
           on conflict (owner_user_id, kind, name) do update set updated_at = now()
           returning id`,
          [this.createId(), ownerUserId, metadata.platformKind, metadata.platformName]
        );
        const platformId = platform.rows[0]?.id;
        if (!platformId) throw new Error('The compute platform could not be reconciled.');
        const environmentDefinitionId = await this.ensureBuiltInEnvironmentDefinition(
          client,
          ownerUserId,
          metadata.environmentKind
        );
        const environmentIdentityKey = accountScopedIdentity(
          ownerUserId,
          metadata.environmentIdentity.key
        );
        const currentAssociation = await client.query<{
          association_source: string;
          environment_id: string;
          host_evidence: ConnectorComputeMetadata['hostEvidence'];
          host_id: string | null;
          host_identity_key: string | null;
          host_resolution: ConnectorComputeMetadata['hostResolution'];
          identity_key: string;
          platform_id: string;
        }>(
          `select association.association_source, association.environment_id,
                  environment.identity_key, environment.platform_id, environment.host_id,
                  environment.host_resolution, environment.host_evidence,
                  host.identity_key as host_identity_key
             from connector_compute_environments association
             join compute_environments environment
               on environment.id = association.environment_id
              and environment.owner_user_id = association.owner_user_id
             left join compute_hosts host
               on host.id = environment.host_id
              and host.owner_user_id = environment.owner_user_id
            where association.connector_id = $1 and association.owner_user_id = $2
            for update of association, environment`,
          [machine.id, ownerUserId]
        );
        const current = currentAssociation.rows[0];
        if (current && current.association_source !== 'legacy' && (
          current.identity_key !== environmentIdentityKey || current.platform_id !== platformId
        )) {
          await client.query(
            `update compute_environments
                set identity_resolution = 'conflict', updated_at = now()
              where id = $1 and owner_user_id = $2`,
            [current.environment_id, ownerUserId]
          );
          continue;
        }

        const reportedHostIdentityKey = metadata.hostIdentity
          ? accountScopedIdentity(ownerUserId, metadata.hostIdentity.key)
          : null;
        if (current && current.association_source !== 'legacy' &&
          current.host_identity_key && reportedHostIdentityKey &&
          current.host_identity_key !== reportedHostIdentityKey) {
          await client.query(
            `update compute_environments
                set host_resolution = 'conflict', host_evidence = $3, updated_at = now()
              where id = $1 and owner_user_id = $2`,
            [current.environment_id, ownerUserId, metadata.hostEvidence]
          );
          continue;
        }

        let hostId: string | null = current?.host_id ?? null;
        let hostResolution = metadata.hostResolution;
        let hostEvidence = metadata.hostEvidence;
        if (!metadata.hostIdentity && current?.host_id) {
          hostResolution = current.host_resolution;
          hostEvidence = current.host_evidence;
        }
        if (metadata.hostIdentity && metadata.hostName) {
          const host = await client.query<{ id: string }>(
            `insert into compute_hosts (
               id, owner_user_id, platform_id, identity_version, identity_key, name, resources
             ) values ($1, $2, $3, $4, $5, $6, $7::jsonb)
             on conflict (owner_user_id, platform_id, identity_version, identity_key) do update set
               name = excluded.name, resources = excluded.resources, updated_at = now()
             returning id`,
          [this.createId(), ownerUserId, platformId, metadata.hostIdentity.version,
              reportedHostIdentityKey, metadata.hostName,
              metadata.resourceMode === 'exclusive' && metadata.resources
                ? JSON.stringify(metadata.resources)
                : null]
          );
          hostId = host.rows[0]?.id ?? null;
        }

        let parentEnvironmentId: string | null = null;
        if (metadata.parentEnvironmentIdentity) {
          const parentDefinitionId = await this.ensureBuiltInEnvironmentDefinition(
            client,
            ownerUserId,
            'other'
          );
          const parentIdentityKey = accountScopedIdentity(
            ownerUserId,
            metadata.parentEnvironmentIdentity.key
          );
          const parent = await client.query<{ id: string }>(
            `insert into compute_environments (
               id, owner_user_id, platform_id, host_id, identity_version, identity_key,
               kind, name, host_resolution, host_evidence, resource_mode,
               environment_definition_id
             ) values ($1, $2, $3, $4, $5, $6, 'other', $7, $8, $9, 'shared', $10)
             on conflict (owner_user_id, platform_id, identity_version, identity_key) do update set
               updated_at = now()
             returning id`,
            [this.createId(), ownerUserId, platformId, hostId,
              metadata.parentEnvironmentIdentity.version, parentIdentityKey,
              `${metadata.environmentName} parent`, metadata.hostResolution, metadata.hostEvidence,
              parentDefinitionId]
          );
          parentEnvironmentId = parent.rows[0]?.id ?? null;
        }

        const environment = await client.query<{ id: string }>(
          `insert into compute_environments (
             id, owner_user_id, platform_id, host_id, parent_environment_id, identity_version, identity_key,
             kind, name, host_resolution, host_evidence, resource_mode, resources,
             environment_definition_id
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)
           on conflict (owner_user_id, platform_id, identity_version, identity_key) do update set
             host_id = excluded.host_id, identity_resolution = 'resolved',
             parent_environment_id = excluded.parent_environment_id,
             kind = excluded.kind, name = excluded.name,
             host_resolution = excluded.host_resolution, host_evidence = excluded.host_evidence,
             resource_mode = excluded.resource_mode, resources = excluded.resources, updated_at = now()
           returning id`,
          [this.createId(), ownerUserId, platformId, hostId, parentEnvironmentId,
            metadata.environmentIdentity.version, environmentIdentityKey, metadata.environmentKind, metadata.environmentName,
            hostResolution, hostEvidence, metadata.resourceMode,
            metadata.resourceMode !== 'exclusive' && metadata.resources
              ? JSON.stringify(metadata.resources)
              : null,
            environmentDefinitionId]
        );
        const environmentId = environment.rows[0]?.id;
        if (!environmentId) throw new Error('The compute environment could not be reconciled.');
        const association = await client.query<{ environment_id: string }>(
          `insert into connector_compute_environments (
             connector_id, owner_user_id, environment_id, association_source
           ) values ($1, $2, $3, 'connector')
           on conflict (owner_user_id, connector_id) do update set
             environment_id = excluded.environment_id,
             association_source = 'connector',
             associated_at = now()
           where (
             connector_compute_environments.association_source = 'legacy'
             or connector_compute_environments.environment_id = excluded.environment_id
           ) and not exists (
               select 1 from legacy_connector_removal_receipts receipt
                where receipt.owner_user_id = excluded.owner_user_id
                  and receipt.connector_id = excluded.connector_id
             )
           returning environment_id`,
          [machine.id, ownerUserId, environmentId]
        );
        if (!association.rows[0]) throw new Error('The connector environment could not be persisted.');
        await client.query(
          `delete from compute_environments environment
            where environment.owner_user_id = $1
              and environment.id <> $2
              and not exists (
                select 1 from connector_compute_environments association
                 where association.owner_user_id = environment.owner_user_id
                   and association.environment_id = environment.id
              )
              and not exists (
                select 1 from environment_provider_bindings binding
                 where binding.owner_user_id = environment.owner_user_id
                   and binding.environment_id = environment.id
              )
              and not exists (
                select 1 from tailscale_compute_environment_projections projection
                 where projection.owner_user_id = environment.owner_user_id
                   and projection.environment_id = environment.id
              )`,
          [ownerUserId, environmentId]
        );
      }
    };
    return this.client.transaction ? this.client.transaction(operation) : operation(this.client);
  }

  private async ensureBuiltInEnvironmentDefinition(
    client: DatabaseQueryClient,
    ownerUserId: string,
    kind: ComputeEnvironmentKind
  ) {
    const definition = builtInEnvironmentDefinition(kind);
    const result = await client.query<{ id: string }>(
      `insert into compute_environment_definitions (
         id, owner_user_id, slug, name, kind, operating_system_family,
         supported_architectures, bootstrap_strategy, ownership
       ) values ($1, $2, $3, $4, $5, $6, $7::text[], $8, 'built_in')
       on conflict (owner_user_id, slug) do update set updated_at = now()
         where compute_environment_definitions.ownership = 'built_in'
           and compute_environment_definitions.kind = excluded.kind
       returning id`,
      [
        this.createId(),
        ownerUserId,
        definition.slug,
        definition.name,
        definition.kind,
        definition.operatingSystemFamily,
        definition.supportedArchitectures,
        definition.bootstrapStrategy
      ]
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error(`The ${kind} Environment definition could not be reconciled.`);
    return id;
  }

  async listPhysicalMachines(userId: string): Promise<PhysicalMachineRecord[]> {
    const result = await this.client.query<PhysicalMachineRow>(
      `select machine.id, machine.name,
              coalesce(array_agg(connector.connector_id order by connector.connector_id)
                filter (where connector.connector_id is not null), '{}') as connector_ids
         from physical_machines machine
         left join physical_machine_connectors connector
           on connector.physical_machine_id = machine.id
          and connector.owner_user_id = machine.owner_user_id
        where machine.owner_user_id = $1
        group by machine.id, machine.owner_user_id, machine.name
        order by lower(machine.name), machine.id`,
      [requireValue(userId, 'userId')]
    );

    return result.rows.map((row) => ({
      connectorIds: row.connector_ids,
      id: row.id,
      name: row.name
    }));
  }

  async savePhysicalMachine(
    input: SavePhysicalMachineInput
  ): Promise<PhysicalMachineRecord> {
    const userId = requireValue(input.userId, 'userId');
    const name = requireValue(input.name, 'name');
    if (name.length > 80) throw new Error('Physical machine names must be 80 characters or fewer.');
    const connectorIds = [
      ...new Set(input.connectorIds.map((id) => requireValue(id, 'connectorId')))
    ];
    if (connectorIds.length === 0) throw new Error('Choose at least one connector installation.');
    const physicalMachineId = input.physicalMachineId
      ? requireValue(input.physicalMachineId, 'physicalMachineId')
      : this.createId();

    const operation = async (client: DatabaseQueryClient) => {
      const owned = await client.query<{ machine_id: string }>(
        `select machine_id
           from machine_memberships
          where user_id = $1
            and role = 'owner'
            and machine_id = any($2::text[])
          order by machine_id
          for update`,
        [userId, connectorIds]
      );
      if (owned.rows.length !== connectorIds.length) {
        throw new Error('Only connector installations owned by this account can be grouped.');
      }

      const machine = await client.query<{ id: string; name: string }>(
        `insert into physical_machines (id, owner_user_id, name)
         values ($1, $2, $3)
         on conflict (id, owner_user_id) do update set
           name = excluded.name,
           updated_at = now()
         returning id, name`,
        [physicalMachineId, userId, name]
      );
      if (!machine.rows[0]) throw new Error('The physical machine could not be saved.');

      await client.query(
        `delete from physical_machine_connectors
          where physical_machine_id = $1
            and owner_user_id = $2
            and not (connector_id = any($3::text[]))`,
        [physicalMachineId, userId, connectorIds]
      );
      await client.query(
        `insert into physical_machine_connectors (
           physical_machine_id, owner_user_id, connector_id
         )
         select $1, $2, connector_id
           from unnest($3::text[]) as connector_id
         on conflict (owner_user_id, connector_id) do update set
           physical_machine_id = excluded.physical_machine_id`,
        [physicalMachineId, userId, connectorIds]
      );
      const platform = await client.query<{ id: string }>(
        `select id from compute_platforms
          where owner_user_id = $1 and kind = 'local' and name = 'Local & self-hosted'
          limit 1`,
        [userId]
      );
      const platformId = platform.rows[0]?.id;
      if (platformId) {
        await client.query(
          `insert into compute_hosts (
             id, owner_user_id, platform_id, identity_version, identity_key, name
           ) values ($1, $2, $3, 1, $4, $5)
           on conflict (id, owner_user_id) do update set
             name = excluded.name, updated_at = now()`,
          [physicalMachineId, userId, platformId,
            accountScopedIdentity(userId, `manual:${physicalMachineId}`), name]
        );
        await client.query(
          `update compute_environments environment
              set host_id = null, host_resolution = 'unresolved', host_evidence = 'none',
                  updated_at = now()
             from connector_compute_environments association
            where environment.id = association.environment_id
              and environment.owner_user_id = $1
              and association.owner_user_id = $1
              and environment.host_resolution = 'manual'
              and not exists (
                select 1 from physical_machine_connectors physical
                 where physical.owner_user_id = association.owner_user_id
                   and physical.connector_id = association.connector_id
              )`,
          [userId]
        );
        await client.query(
          `update compute_environments environment
              set host_id = $2, host_resolution = 'manual', host_evidence = 'user',
                  updated_at = now()
             from connector_compute_environments association
            where environment.id = association.environment_id
              and environment.owner_user_id = $1
              and association.owner_user_id = $1
              and association.connector_id = any($3::text[])`,
          [userId, physicalMachineId, connectorIds]
        );
      }
      await client.query(
        `delete from physical_machines machine
          where machine.owner_user_id = $1
            and machine.id <> $2
            and not exists (
              select 1
                from physical_machine_connectors connector
               where connector.physical_machine_id = machine.id
                 and connector.owner_user_id = machine.owner_user_id
            )`,
        [userId, physicalMachineId]
      );

      return {
        connectorIds,
        id: machine.rows[0].id,
        name: machine.rows[0].name
      };
    };

    return this.client.transaction
      ? this.client.transaction(operation)
      : operation(this.client);
  }

  async deletePhysicalMachine(input: PhysicalMachineKey) {
    const physicalMachineId = requireValue(input.physicalMachineId, 'physicalMachineId');
    const userId = requireValue(input.userId, 'userId');
    const operation = async (client: DatabaseQueryClient) => {
      await client.query(
        `update compute_environments
            set host_id = null, host_resolution = 'unresolved', host_evidence = 'none',
                updated_at = now()
          where host_id = $1 and owner_user_id = $2`,
        [physicalMachineId, userId]
      );
      await client.query(
        `delete from compute_hosts where id = $1 and owner_user_id = $2`,
        [physicalMachineId, userId]
      );
      const result = await client.query<{ id: string }>(
        `delete from physical_machines
        where id = $1 and owner_user_id = $2
        returning id`,
        [physicalMachineId, userId]
      );
      return result.rows.length > 0;
    };
    return this.client.transaction ? this.client.transaction(operation) : operation(this.client);
  }

  async listMachineExecutionScopes(userId: string): Promise<MachineExecutionScopeRecord[]> {
    const result = await this.client.query<MachineExecutionScopeRow>(
      `select scope.id, scope.name,
              coalesce(array_agg(member.machine_id order by member.machine_id)
                filter (where member.machine_id is not null), '{}') as machine_ids
         from machine_execution_scopes scope
         left join machine_execution_scope_members member
           on member.scope_id = scope.id
          and member.owner_user_id = scope.owner_user_id
        where scope.owner_user_id = $1
        group by scope.id, scope.owner_user_id, scope.name
        order by lower(scope.name), scope.id`,
      [requireValue(userId, 'userId')]
    );

    return result.rows.map((row) => ({
      id: row.id,
      machineIds: row.machine_ids,
      name: row.name
    }));
  }

  async saveMachineExecutionScope(
    input: SaveMachineExecutionScopeInput
  ): Promise<MachineExecutionScopeRecord> {
    const userId = requireValue(input.userId, 'userId');
    const name = requireValue(input.name, 'name');
    if (name.length > 80) throw new Error('Machine group names must be 80 characters or fewer.');
    const machineIds = [...new Set(input.machineIds.map((id) => requireValue(id, 'machineId')))];
    if (machineIds.length === 0) throw new Error('Choose at least one connector instance.');
    const scopeId = input.scopeId ? requireValue(input.scopeId, 'scopeId') : this.createId();

    const operation = async (client: DatabaseQueryClient) => {
      const owned = await client.query<{ machine_id: string }>(
        `select machine_id
           from machine_memberships
          where user_id = $1
            and role = 'owner'
            and machine_id = any($2::text[])
          order by machine_id
          for update`,
        [userId, machineIds]
      );
      if (owned.rows.length !== machineIds.length) {
        throw new Error('Only connector instances owned by this account can be grouped.');
      }

      const scope = await client.query<{ id: string; name: string }>(
        `insert into machine_execution_scopes (id, owner_user_id, name)
         values ($1, $2, $3)
         on conflict (id, owner_user_id) do update set
           name = excluded.name,
           updated_at = now()
         returning id, name`,
        [scopeId, userId, name]
      );
      if (!scope.rows[0]) throw new Error('The machine group could not be saved.');

      await client.query(
        `delete from machine_execution_scope_members
          where scope_id = $1
            and owner_user_id = $2
            and not (machine_id = any($3::text[]))`,
        [scopeId, userId, machineIds]
      );
      await client.query(
        `insert into machine_execution_scope_members (
           scope_id, owner_user_id, machine_id
         )
         select $1, $2, machine_id
           from unnest($3::text[]) as machine_id
         on conflict (owner_user_id, machine_id) do update set
           scope_id = excluded.scope_id`,
        [scopeId, userId, machineIds]
      );
      await client.query(
        `delete from machine_execution_scopes scope
          where scope.owner_user_id = $1
            and scope.id <> $2
            and not exists (
              select 1
                from machine_execution_scope_members member
               where member.scope_id = scope.id
                 and member.owner_user_id = scope.owner_user_id
            )`,
        [userId, scopeId]
      );

      return { id: scope.rows[0].id, machineIds, name: scope.rows[0].name };
    };

    return this.client.transaction
      ? this.client.transaction(operation)
      : operation(this.client);
  }

  async deleteMachineExecutionScope(input: MachineExecutionScopeKey) {
    const result = await this.client.query<{ id: string }>(
      `delete from machine_execution_scopes
        where id = $1 and owner_user_id = $2
      returning id`,
      [requireValue(input.scopeId, 'scopeId'), requireValue(input.userId, 'userId')]
    );
    return result.rows.length > 0;
  }

  async claimMachineMembership(input: MachineMembershipKey) {
    const machineId = requireValue(input.machineId, 'machineId');
    const userId = requireValue(input.userId, 'userId');
    const result = await this.client.query<MachineMembershipRow>(
      `with existing_membership as (
         select ${membershipColumns}
           from machine_memberships
          where machine_id = $2 and user_id = $3
       ), claimed_membership as (
         insert into machine_memberships (id, machine_id, user_id, role)
         select $1, $2, $3, 'owner'
          where not exists (
            select 1 from machine_memberships where machine_id = $2
          )
         on conflict do nothing
         returning ${membershipColumns}
       )
       select * from claimed_membership
       union all
       select * from existing_membership
       limit 1`,
      [this.createId(), machineId, userId]
    );

    if (result.rows[0]) {
      return mapMembership(result.rows[0]);
    }

    // A concurrent claim by the same user can win after this statement's
    // snapshot was taken. Re-read the user's membership before reporting that
    // another account owns the machine.
    return this.readMachineMembership({ machineId, userId });
  }

  async hasMachineMembership(input: MachineMembershipKey) {
    const result = await this.client.query<{ allowed: boolean }>(
      `select exists (
         select 1
           from machine_memberships
          where machine_id = $1 and user_id = $2
       ) as allowed`,
      [requireValue(input.machineId, 'machineId'), requireValue(input.userId, 'userId')]
    );

    return result.rows[0]?.allowed === true;
  }

  async isMachineClaimed(machineId: string) {
    const result = await this.client.query<{ claimed: boolean }>(
      `select exists (
         select 1
           from machine_memberships
          where machine_id = $1
       ) as claimed`,
      [requireValue(machineId, 'machineId')]
    );

    return result.rows[0]?.claimed === true;
  }

  async readMachineMembership(input: MachineMembershipKey) {
    const result = await this.client.query<MachineMembershipRow>(
      `select ${membershipColumns}
         from machine_memberships
        where machine_id = $1 and user_id = $2`,
      [requireValue(input.machineId, 'machineId'), requireValue(input.userId, 'userId')]
    );

    return result.rows[0] ? mapMembership(result.rows[0]) : null;
  }

  async listMachineMemberships(userId: string) {
    const result = await this.client.query<MachineMembershipRow>(
      `select ${membershipColumns}
         from machine_memberships
        where user_id = $1
        order by machine_id`,
      [requireValue(userId, 'userId')]
    );

    return result.rows.map(mapMembership);
  }

  async readProjectRunSettings(input: ProjectRunSettingsKey) {
    const result = await this.client.query<ProjectRunSettingsRow>(
      `select ${runSettingsColumns}
         from user_project_run_settings
        where user_id = $1 and machine_id = $2 and project_id = $3`,
      [
        requireValue(input.userId, 'userId'),
        requireValue(input.machineId, 'machineId'),
        requireValue(input.projectId, 'projectId')
      ]
    );

    return result.rows[0] ? mapRunSettings(result.rows[0]) : null;
  }

  async upsertProjectRunSettings(input: UpsertProjectRunSettingsInput) {
    const result = await this.client.query<ProjectRunSettingsRow>(
      `insert into user_project_run_settings (
         id, user_id, machine_id, project_id, run_target, preferred_worktree_id,
         allowed_hosts
       ) values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (user_id, machine_id, project_id) do update set
         run_target = excluded.run_target,
         preferred_worktree_id = excluded.preferred_worktree_id,
         allowed_hosts = excluded.allowed_hosts,
         updated_at = now()
       returning ${runSettingsColumns}`,
      [
        this.createId(),
        requireValue(input.userId, 'userId'),
        requireValue(input.machineId, 'machineId'),
        requireValue(input.projectId, 'projectId'),
        requireValue(input.runTarget ?? 'dev', 'runTarget'),
        input.preferredWorktreeId?.trim() || null,
        normalizeAllowedHosts(input.allowedHosts ?? [])
      ]
    );

    return mapRunSettings(result.rows[0]);
  }

  async deleteProjectRunSettings(input: ProjectRunSettingsKey) {
    const result = await this.client.query<{ id: string }>(
      `delete from user_project_run_settings
        where user_id = $1 and machine_id = $2 and project_id = $3
      returning id`,
      [
        requireValue(input.userId, 'userId'),
        requireValue(input.machineId, 'machineId'),
        requireValue(input.projectId, 'projectId')
      ]
    );

    return result.rows.length > 0;
  }

  async readUserProjectsState(userId: string): Promise<ProjectsState | null> {
    const result = await this.client.query<UserProjectsStateRow>(
      `select state
         from user_project_states
        where user_id = $1`,
      [requireValue(userId, 'userId')]
    );

    return result.rows[0] ? normalizeProjectsState(result.rows[0].state) : null;
  }

  async upsertUserProjectsState(input: UpsertUserProjectsStateInput) {
    const state = normalizeProjectsState(input.state);
    const result = await this.client.query<UserProjectsStateRow>(
      `insert into user_project_states (user_id, state)
       values ($1, $2)
       on conflict (user_id) do update set
         state = excluded.state,
         updated_at = now()
       returning state`,
      [requireValue(input.userId, 'userId'), state]
    );

    return normalizeProjectsState(result.rows[0]?.state ?? state);
  }

  async createDevServerSession(input: CreateDevServerSessionInput) {
    const result = await this.client.query<DevServerSessionRow>(
      `insert into dev_server_sessions (
         id, owner_user_id, machine_id, project_id, worktree_id, run_target, server_id,
         state, local_port, tailscale_port, tailscale_url
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       returning ${sessionColumns}`,
      [
        this.createId(),
        requireValue(input.ownerUserId, 'ownerUserId'),
        requireValue(input.machineId, 'machineId'),
        requireValue(input.projectId, 'projectId'),
        requireValue(input.worktreeId, 'worktreeId'),
        requireValue(input.runTarget ?? 'dev', 'runTarget'),
        requireValue(input.serverId, 'serverId'),
        input.state ?? 'starting',
        input.localPort ?? null,
        input.tailscalePort ?? null,
        input.tailscaleUrl?.trim() || null
      ]
    );

    return mapSession(result.rows[0]);
  }

  async readDevServerSession(input: DevServerSessionKey) {
    const result = await this.client.query<DevServerSessionRow>(
      `select ${sessionColumns}
         from dev_server_sessions
        where id = $1 and owner_user_id = $2`,
      [requireValue(input.sessionId, 'sessionId'), requireValue(input.userId, 'userId')]
    );

    return result.rows[0] ? mapSession(result.rows[0]) : null;
  }

  async listDevServerSessions(
    userId: string,
    filter: DevServerSessionListFilter = {}
  ) {
    const values: unknown[] = [requireValue(userId, 'userId')];
    const conditions = ['owner_user_id = $1'];

    const addFilter = (column: string, value?: string) => {
      if (value === undefined) {
        return;
      }
      values.push(requireValue(value, column));
      conditions.push(`${column} = $${values.length}`);
    };

    addFilter('machine_id', filter.machineId);
    addFilter('project_id', filter.projectId);
    addFilter('worktree_id', filter.worktreeId);
    addFilter('server_id', filter.serverId);
    if (filter.activeOnly) {
      conditions.push(`state in ('starting', 'running', 'local-only', 'stopping')`);
    }

    const result = await this.client.query<DevServerSessionRow>(
      `select ${sessionColumns}
         from dev_server_sessions
        where ${conditions.join(' and ')}
        order by updated_at desc`,
      values
    );

    return result.rows.map(mapSession);
  }

  async transitionDevServerSession(input: TransitionDevServerSessionInput) {
    if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0) {
      throw new Error('expectedGeneration must be a non-negative integer.');
    }

    const values: unknown[] = [
      requireValue(input.sessionId, 'sessionId'),
      requireValue(input.userId, 'userId'),
      input.expectedGeneration,
      input.state
    ];
    const assignments = [
      'state = $4',
      'runtime_generation = runtime_generation + 1',
      'updated_at = now()'
    ];
    const optionalAssignments: Array<[
      keyof TransitionDevServerSessionInput,
      string
    ]> = [
      ['localPort', 'local_port'],
      ['tailscalePort', 'tailscale_port'],
      ['tailscaleUrl', 'tailscale_url'],
      ['lastError', 'last_error'],
      ['startedAt', 'started_at'],
      ['stoppedAt', 'stopped_at'],
      ['lastSeenAt', 'last_seen_at']
    ];

    for (const [property, column] of optionalAssignments) {
      if (input[property] === undefined) {
        continue;
      }
      values.push(input[property]);
      assignments.push(`${column} = $${values.length}`);
    }

    const result = await this.client.query<DevServerSessionRow>(
      `update dev_server_sessions
          set ${assignments.join(', ')}
        where id = $1
          and owner_user_id = $2
          and runtime_generation = $3
      returning ${sessionColumns}`,
      values
    );

    return result.rows[0] ? mapSession(result.rows[0]) : null;
  }

  async deleteDevServerSession(input: DevServerSessionKey) {
    const result = await this.client.query<{ id: string }>(
      `delete from dev_server_sessions
        where id = $1 and owner_user_id = $2
      returning id`,
      [requireValue(input.sessionId, 'sessionId'), requireValue(input.userId, 'userId')]
    );

    return result.rows.length > 0;
  }
}
