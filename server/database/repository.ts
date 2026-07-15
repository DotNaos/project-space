import { randomUUID } from 'node:crypto';

import type { DatabaseQueryClient } from './client';
import {
  ConnectorCredentialRepository,
  type ConnectorCredentialRepositoryOptions
} from './connector-credentials';
import type {
  AuthenticateConnectorCredentialInput,
  CreateDevServerSessionInput,
  CreateConnectorCredentialInput,
  DevServerSession,
  DevServerSessionKey,
  DevServerSessionListFilter,
  DevServerSessionState,
  MachineMembership,
  MachineMembershipKey,
  MachineMembershipRole,
  MachineExecutionScopeKey,
  ProjectRunSettings,
  ProjectRunSettingsKey,
  RevokeConnectorCredentialInput,
  SaveMachineExecutionScopeInput,
  TransitionDevServerSessionInput,
  UpsertUserProjectsStateInput,
  UpsertProjectRunSettingsInput
} from './models';
import { normalizeProjectsState } from './projects-state';
import type { ProjectsState } from '../../src/shared/project-space-api';
import type { MachineExecutionScopeRecord } from '../../src/shared/project-space-api';

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
  private readonly connectorCredentials: ConnectorCredentialRepository;

  constructor(
    private readonly client: DatabaseQueryClient,
    private readonly createId: () => string = randomUUID,
    connectorCredentialOptions: Omit<ConnectorCredentialRepositoryOptions, 'createId'> = {}
  ) {
    this.connectorCredentials = new ConnectorCredentialRepository(client, {
      ...connectorCredentialOptions,
      createId
    });
  }

  async createConnectorCredential(input: CreateConnectorCredentialInput) {
    return this.connectorCredentials.create(input);
  }

  async authenticateConnectorCredential(input: AuthenticateConnectorCredentialInput) {
    return this.connectorCredentials.authenticate(input);
  }

  async listConnectorCredentials(userId: string) {
    return this.connectorCredentials.list(userId);
  }

  async revokeConnectorCredential(input: RevokeConnectorCredentialInput) {
    return this.connectorCredentials.revoke(input);
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
      conditions.push(`state in ('starting', 'running', 'stopping')`);
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
