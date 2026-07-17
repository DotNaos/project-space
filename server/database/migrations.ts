import { createHash } from 'node:crypto';

import type { DatabaseQueryClient } from './client';
import { machineConnectionMigrationSql } from './machine-connection-migration';
import {
  connectorRuntimeMigrationId,
  connectorRuntimeMigrationSql
} from './connector-runtime-migration';
import {
  codexSessionsMigrationId,
  codexSessionsMigrationSql
} from './codex-sessions-migration';
import {
  githubIssueCreationMigrationId,
  githubIssueCreationMigrationSql
} from './github-issue-creation-migration';
import {
  codexMachineTasksMigrationId,
  codexMachineTasksMigrationSql
} from './codex-machine-tasks-migration';
import {
  codexMachineTaskDurabilityMigrationId,
  codexMachineTaskDurabilityMigrationSql
} from './codex-machine-task-durability-migration';
import {
  codexMachineTaskStartPayloadMigrationId,
  codexMachineTaskStartPayloadMigrationSql
} from './codex-machine-task-start-payload-migration';

export interface DatabaseMigration {
  id: string;
  sql: string;
}

interface AppliedMigrationRow {
  checksum: string;
  id: string;
}

const migrationLockName = 'project-space:database-migrations';

export const databaseMigrations: readonly DatabaseMigration[] = [
  {
    id: '0001_github_oauth_tokens',
    sql: `
      create table if not exists github_oauth_tokens (
        user_id text primary key,
        login text,
        encrypted_access_token text not null,
        iv text not null,
        tag text not null,
        scope text,
        token_type text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `
  },
  {
    id: '0002_machine_memberships_and_run_settings',
    sql: `
      create table if not exists machine_memberships (
        id uuid primary key,
        machine_id text not null check (btrim(machine_id) <> ''),
        user_id text not null check (btrim(user_id) <> ''),
        role text not null check (role in ('owner', 'member')),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (machine_id, user_id)
      );

      create unique index if not exists machine_memberships_one_owner_per_machine
        on machine_memberships (machine_id)
        where role = 'owner';

      create index if not exists machine_memberships_user_id_idx
        on machine_memberships (user_id, machine_id);

      create table if not exists user_project_run_settings (
        id uuid primary key,
        user_id text not null check (btrim(user_id) <> ''),
        machine_id text not null check (btrim(machine_id) <> ''),
        project_id text not null check (btrim(project_id) <> ''),
        run_target text not null default 'dev' check (btrim(run_target) <> ''),
        preferred_worktree_id text,
        allowed_hosts text[] not null default '{}',
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (user_id, machine_id, project_id),
        foreign key (machine_id, user_id)
          references machine_memberships (machine_id, user_id)
          on delete cascade
      );

      create index if not exists user_project_run_settings_user_id_idx
        on user_project_run_settings (user_id, machine_id);
    `
  },
  {
    id: '0003_dev_server_sessions',
    sql: `
      create table if not exists dev_server_sessions (
        id uuid primary key,
        owner_user_id text not null check (btrim(owner_user_id) <> ''),
        machine_id text not null check (btrim(machine_id) <> ''),
        project_id text not null check (btrim(project_id) <> ''),
        worktree_id text not null check (btrim(worktree_id) <> ''),
        run_target text not null default 'dev' check (btrim(run_target) <> ''),
        state text not null check (
          state in ('starting', 'running', 'stopping', 'stopped', 'error')
        ),
        runtime_generation bigint not null default 0 check (runtime_generation >= 0),
        local_port integer check (local_port between 1 and 65535),
        tailscale_port integer check (tailscale_port between 1 and 65535),
        tailscale_url text,
        last_error text,
        started_at timestamptz,
        stopped_at timestamptz,
        last_seen_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        foreign key (machine_id, owner_user_id)
          references machine_memberships (machine_id, user_id)
          on delete cascade
      );

      create index if not exists dev_server_sessions_owner_idx
        on dev_server_sessions (owner_user_id, updated_at desc);

      create index if not exists dev_server_sessions_machine_idx
        on dev_server_sessions (machine_id, worktree_id, updated_at desc);

      create unique index if not exists dev_server_sessions_one_active_per_worktree
        on dev_server_sessions (machine_id, worktree_id)
        where state in ('starting', 'running', 'stopping');
    `
  },
  {
    id: '0004_connector_credentials',
    sql: `
      create table if not exists connector_credentials (
        id uuid primary key,
        owner_user_id text not null check (btrim(owner_user_id) <> ''),
        token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
        machine_id text check (machine_id is null or btrim(machine_id) <> ''),
        created_at timestamptz not null default now(),
        expires_at timestamptz not null,
        last_seen_at timestamptz,
        revoked_at timestamptz,
        check (expires_at > created_at),
        foreign key (machine_id, owner_user_id)
          references machine_memberships (machine_id, user_id)
          on delete cascade
          deferrable initially deferred
      );

      create index if not exists connector_credentials_owner_idx
        on connector_credentials (owner_user_id, created_at desc);

      create index if not exists connector_credentials_machine_idx
        on connector_credentials (machine_id)
        where machine_id is not null and revoked_at is null;
    `
  },
  {
    id: '0005_user_project_states',
    sql: `
      create table if not exists user_project_states (
        user_id text primary key check (btrim(user_id) <> ''),
        state jsonb not null check (jsonb_typeof(state) = 'object'),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `
  },
  {
    id: '0006_connector_credential_expected_machine',
    sql: `
      alter table connector_credentials
        add column expected_machine_id text;

      update connector_credentials
         set revoked_at = coalesce(revoked_at, now())
       where machine_id is null;

      update connector_credentials
         set expected_machine_id = coalesce(
           machine_id,
           'revoked-enrollment-' || id::text
         );

      alter table connector_credentials
        alter column expected_machine_id set not null,
        add constraint connector_credentials_expected_machine_id_not_blank
          check (btrim(expected_machine_id) <> ''),
        add constraint connector_credentials_machine_matches_expected
          check (machine_id is null or machine_id = expected_machine_id);
    `
  },
  {
    id: '0007_project_chat',
    sql: `
      create table if not exists project_chat_channels (
        space_id text not null check (btrim(space_id) <> ''),
        channel_id text not null check (btrim(channel_id) <> ''),
        name text not null check (btrim(name) <> ''),
        last_sequence bigint not null default 0 check (last_sequence >= 0),
        created_at timestamptz not null default now(),
        primary key (space_id, channel_id)
      );

      create table if not exists project_chat_members (
        space_id text not null check (btrim(space_id) <> ''),
        actor_key text not null check (btrim(actor_key) <> ''),
        member_id text not null check (btrim(member_id) <> ''),
        display_name text not null check (btrim(display_name) <> ''),
        handle text not null check (btrim(handle) <> ''),
        role text not null check (role in ('human', 'agent', 'system')),
        origin jsonb,
        joined_at timestamptz not null,
        updated_at timestamptz not null,
        primary key (space_id, member_id),
        constraint project_chat_members_space_actor_unique
          unique (space_id, actor_key),
        check (origin is null or jsonb_typeof(origin) = 'object')
      );

      create unique index if not exists project_chat_members_space_handle_unique
        on project_chat_members (space_id, lower(handle));

      create table if not exists project_chat_presences (
        space_id text not null,
        member_id text not null,
        state text not null check (state in ('working', 'idle')),
        last_seen_at timestamptz not null,
        expires_at timestamptz not null check (expires_at > last_seen_at),
        primary key (space_id, member_id),
        foreign key (space_id, member_id)
          references project_chat_members (space_id, member_id)
          on delete cascade
      );

      create table if not exists project_chat_messages (
        space_id text not null,
        channel_id text not null,
        id text not null check (btrim(id) <> ''),
        sequence bigint not null check (sequence > 0),
        body text not null check (btrim(body) <> ''),
        sender jsonb not null check (jsonb_typeof(sender) = 'object'),
        sender_member_id text not null,
        mentions jsonb not null default '[]'::jsonb
          check (jsonb_typeof(mentions) = 'array'),
        created_at timestamptz not null,
        expires_at timestamptz not null check (expires_at > created_at),
        primary key (space_id, id),
        unique (space_id, channel_id, sequence),
        foreign key (space_id, channel_id)
          references project_chat_channels (space_id, channel_id),
        foreign key (space_id, sender_member_id)
          references project_chat_members (space_id, member_id)
      );

      create index if not exists project_chat_messages_channel_sequence_idx
        on project_chat_messages (space_id, channel_id, sequence);

      create index if not exists project_chat_messages_expiry_idx
        on project_chat_messages (expires_at);

      create table if not exists project_chat_message_mentions (
        space_id text not null,
        message_id text not null,
        member_id text not null,
        primary key (space_id, message_id, member_id),
        foreign key (space_id, message_id)
          references project_chat_messages (space_id, id)
          on delete cascade,
        foreign key (space_id, member_id)
          references project_chat_members (space_id, member_id)
          on delete cascade
      );

      create index if not exists project_chat_message_mentions_member_idx
        on project_chat_message_mentions (space_id, member_id, message_id);

      create table if not exists project_chat_cursors (
        space_id text not null,
        member_id text not null,
        channel_id text not null,
        sequence bigint not null default 0 check (sequence >= 0),
        updated_at timestamptz not null,
        primary key (space_id, member_id, channel_id),
        foreign key (space_id, member_id)
          references project_chat_members (space_id, member_id)
          on delete cascade,
        foreign key (space_id, channel_id)
          references project_chat_channels (space_id, channel_id)
          on delete cascade
      );

      create table if not exists project_chat_idempotency (
        space_id text not null,
        channel_id text not null,
        sender_member_id text not null,
        idempotency_key text not null check (btrim(idempotency_key) <> ''),
        message_id text not null,
        body text not null,
        expires_at timestamptz not null,
        constraint project_chat_idempotency_identity_unique
          unique (space_id, channel_id, sender_member_id, idempotency_key),
        foreign key (space_id, message_id)
          references project_chat_messages (space_id, id)
          on delete cascade,
        foreign key (space_id, sender_member_id)
          references project_chat_members (space_id, member_id)
          on delete cascade,
        foreign key (space_id, channel_id)
          references project_chat_channels (space_id, channel_id)
          on delete cascade
      );

      create index if not exists project_chat_idempotency_expiry_idx
        on project_chat_idempotency (expires_at);
    `
  },
  {
    id: '0008_machine_connections',
    sql: machineConnectionMigrationSql
  },
  {
    id: '0009_project_chat_human_profiles',
    sql: `
      create table project_chat_human_profiles (
        space_id text not null check (btrim(space_id) <> ''),
        account_id text not null check (btrim(account_id) <> ''),
        default_display_name text not null
          check (btrim(default_display_name) <> '' and char_length(default_display_name) <= 48),
        default_avatar_url text
          check (default_avatar_url is null or char_length(default_avatar_url) <= 2048),
        display_name_override text
          check (
            display_name_override is null or
            (btrim(display_name_override) <> '' and char_length(display_name_override) <= 48)
          ),
        avatar_data_url_override text
          check (
            avatar_data_url_override is null or
            octet_length(avatar_data_url_override) <= 400000
          ),
        revision bigint not null default 1 check (revision > 0),
        created_at timestamptz not null,
        updated_at timestamptz not null check (updated_at >= created_at),
        primary key (space_id, account_id)
      );

      alter table project_chat_members
        add column avatar_url text,
        add column profile_revision bigint;

      insert into project_chat_human_profiles (
        space_id, account_id, default_display_name, default_avatar_url,
        display_name_override, avatar_data_url_override, revision, created_at, updated_at
      )
      select space_id, actor_key::jsonb ->> 1, display_name, null,
             null, null, 1, joined_at, updated_at
        from project_chat_members
       where role = 'human'
      on conflict (space_id, account_id) do nothing;

      update project_chat_members
         set profile_revision = 1
       where role = 'human';

      alter table project_chat_members
        add constraint project_chat_members_display_name_length
          check (char_length(display_name) <= 48),
        add constraint project_chat_members_handle_length
          check (char_length(handle) <= 32),
        add constraint project_chat_members_avatar_size
          check (avatar_url is null or octet_length(avatar_url) <= 400000),
        add constraint project_chat_members_profile_revision_positive
          check (profile_revision is null or profile_revision > 0),
        add constraint project_chat_members_role_origin_consistent
          check (
            (role = 'human' and origin is null and profile_revision is not null) or
            (role = 'agent' and origin is not null and avatar_url is null and profile_revision is null) or
            (role = 'system' and origin is null and avatar_url is null and profile_revision is null)
          );
    `
  },
  {
    id: '0010_connector_machine_snapshots',
    sql: `
      create table connector_machine_snapshots (
        machine_id text primary key check (btrim(machine_id) <> ''),
        machine_name text not null check (btrim(machine_name) <> ''),
        registry jsonb not null check (jsonb_typeof(registry) = 'object'),
        first_seen_at timestamptz not null,
        last_seen_at timestamptz not null check (last_seen_at >= first_seen_at),
        removed_at timestamptz,
        removed_by_user_id text,
        check (
          (removed_at is null and removed_by_user_id is null) or
          (removed_at is not null and removed_by_user_id is not null and btrim(removed_by_user_id) <> '')
        )
      );

      create index connector_machine_snapshots_last_seen_idx
        on connector_machine_snapshots (last_seen_at desc)
        where removed_at is null;
    `
  },
  {
    id: '0011_github_catalog_cache',
    sql: `
      create table if not exists github_catalog_cache (
        user_id text not null check (btrim(user_id) <> ''),
        scope text not null check (btrim(scope) <> ''),
        catalog jsonb not null check (jsonb_typeof(catalog) = 'object'),
        etag text,
        last_error text check (last_error is null or char_length(last_error) <= 240),
        last_refresh_at timestamptz,
        updated_at timestamptz not null,
        primary key (user_id, scope)
      );

      create index if not exists github_catalog_cache_retention_idx
        on github_catalog_cache (updated_at);
    `
  },
  {
    id: '0012_project_chat_name_registry',
    sql: `
      create table project_chat_name_claims (
        space_id text not null check (btrim(space_id) <> ''),
        account_id text not null check (btrim(account_id) <> ''),
        thread_id text not null check (btrim(thread_id) <> ''),
        actor_key text not null check (btrim(actor_key) <> ''),
        name_key text not null check (btrim(name_key) <> ''),
        display_name text not null check (btrim(display_name) <> ''),
        category text not null check (category in ('mythology','artist','science','detective')),
        parent_thread_id text,
        claimed_at timestamptz not null,
        updated_at timestamptz not null check (updated_at >= claimed_at),
        primary key (space_id, name_key),
        unique (space_id, account_id, thread_id),
        check ((category = 'mythology' and parent_thread_id is null) or
               (category <> 'mythology' and parent_thread_id is not null and btrim(parent_thread_id) <> ''))
      );
      alter table project_chat_members add column agent_name jsonb
        check (agent_name is null or jsonb_typeof(agent_name) = 'object');
    `
  },
  {
    id: '0013_project_chat_project_channels',
    sql: `
      alter table project_chat_channels
        add column kind text not null default 'general',
        add column account_id text,
        add column project_id text;

      alter table project_chat_channels
        alter column kind drop default,
        add constraint project_chat_channels_kind_valid
          check (kind in ('general', 'project')),
        add constraint project_chat_channels_scope_consistent
          check (
            (kind = 'general' and channel_id = 'general' and account_id is null and project_id is null) or
            (kind = 'project' and channel_id <> 'general' and
             account_id is not null and project_id is not null and
             btrim(account_id) <> '' and btrim(project_id) <> '')
          );

      create unique index project_chat_channels_project_unique
        on project_chat_channels (space_id, account_id, project_id)
        where kind = 'project';
    `
  },
  {
    id: '0014_dev_server_sessions_per_server',
    sql: `
      alter table dev_server_sessions
        add column if not exists server_id text;

      update dev_server_sessions
         set server_id = run_target
       where server_id is null;

      alter table dev_server_sessions
        alter column server_id set not null;

      alter table dev_server_sessions
        add constraint dev_server_sessions_server_id_not_blank
        check (btrim(server_id) <> '');

      drop index if exists dev_server_sessions_one_active_per_worktree;

      create unique index if not exists dev_server_sessions_one_active_per_server
        on dev_server_sessions (machine_id, worktree_id, server_id)
        where state in ('starting', 'running', 'stopping');

      create index if not exists dev_server_sessions_server_idx
        on dev_server_sessions (machine_id, worktree_id, server_id, updated_at desc);
    `
  },
  {
    id: connectorRuntimeMigrationId,
    sql: connectorRuntimeMigrationSql
  },
  {
    id: codexSessionsMigrationId,
    sql: codexSessionsMigrationSql
  },
  {
    id: githubIssueCreationMigrationId,
    sql: githubIssueCreationMigrationSql
  },
  {
    id: '0018_connector_enrollment_profiles',
    sql: `
      alter table machine_connection_requests
        add column connector_channel text,
        add column connector_source text,
        add constraint machine_connection_requests_connector_profile_pair
          check (
            (connector_channel is null and connector_source is null) or
            (connector_channel = 'dev' and connector_source = 'source')
          );

      alter table machine_identities
        add column connector_channel text,
        add column connector_source text,
        add constraint machine_identities_connector_profile_pair
          check (
            (connector_channel is null and connector_source is null) or
            (connector_channel = 'dev' and connector_source = 'source')
          );

      alter table connector_machine_snapshots
        add column connector_channel text,
        add column connector_source text,
        add constraint connector_machine_snapshots_connector_profile_pair
          check (
            (connector_channel is null and connector_source is null) or
            (connector_channel = 'dev' and connector_source = 'source')
          );
    `
  },
  {
    id: '0019_machine_execution_scopes',
    sql: `
      create table machine_execution_scopes (
        id uuid not null,
        owner_user_id text not null check (btrim(owner_user_id) <> ''),
        name text not null check (btrim(name) <> '' and char_length(name) <= 80),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        primary key (id, owner_user_id)
      );

      create table machine_execution_scope_members (
        scope_id uuid not null,
        owner_user_id text not null check (btrim(owner_user_id) <> ''),
        machine_id text not null check (btrim(machine_id) <> ''),
        created_at timestamptz not null default now(),
        primary key (owner_user_id, machine_id),
        foreign key (scope_id, owner_user_id)
          references machine_execution_scopes (id, owner_user_id)
          on delete cascade,
        foreign key (machine_id, owner_user_id)
          references machine_memberships (machine_id, user_id)
          on delete cascade
      );

      create index machine_execution_scope_members_scope_idx
        on machine_execution_scope_members (owner_user_id, scope_id, machine_id);
    `
  },
  {
    id: '0020_physical_machines',
    sql: `
      create table physical_machines (
        id uuid not null,
        owner_user_id text not null check (btrim(owner_user_id) <> ''),
        name text not null check (btrim(name) <> '' and char_length(name) <= 80),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        primary key (id, owner_user_id)
      );

      create table physical_machine_connectors (
        physical_machine_id uuid not null,
        owner_user_id text not null check (btrim(owner_user_id) <> ''),
        connector_id text not null check (btrim(connector_id) <> ''),
        created_at timestamptz not null default now(),
        primary key (owner_user_id, connector_id),
        foreign key (physical_machine_id, owner_user_id)
          references physical_machines (id, owner_user_id)
          on delete cascade,
        foreign key (connector_id, owner_user_id)
          references machine_memberships (machine_id, user_id)
          on delete cascade
      );

      create index physical_machine_connectors_machine_idx
        on physical_machine_connectors (owner_user_id, physical_machine_id, connector_id);

      insert into physical_machines (
        id, owner_user_id, name, created_at, updated_at
      )
      select id, owner_user_id, name, created_at, updated_at
        from machine_execution_scopes
      on conflict (id, owner_user_id) do nothing;

      insert into physical_machine_connectors (
        physical_machine_id, owner_user_id, connector_id, created_at
      )
      select scope_id, owner_user_id, machine_id, created_at
        from machine_execution_scope_members
      on conflict (owner_user_id, connector_id) do nothing;
    `
  },
  {
    id: codexMachineTasksMigrationId,
    sql: codexMachineTasksMigrationSql
  },
  {
    id: codexMachineTaskDurabilityMigrationId,
    sql: codexMachineTaskDurabilityMigrationSql
  },
  {
    id: codexMachineTaskStartPayloadMigrationId,
    sql: codexMachineTaskStartPayloadMigrationSql
  }
];

export function migrationChecksum(migration: DatabaseMigration) {
  return createHash('sha256').update(migration.sql.trim()).digest('hex');
}

export async function runDatabaseMigrations(
  client: DatabaseQueryClient,
  migrations: readonly DatabaseMigration[] = databaseMigrations
) {
  await client.query('begin');

  try {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [migrationLockName]);
    await client.query(`
      create table if not exists project_space_schema_migrations (
        id text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `);

    const appliedResult = await client.query<AppliedMigrationRow>(
      `select id, checksum
         from project_space_schema_migrations
        order by id`
    );
    const applied = new Map(appliedResult.rows.map((row) => [row.id, row.checksum]));

    for (const migration of migrations) {
      const checksum = migrationChecksum(migration);
      const appliedChecksum = applied.get(migration.id);

      if (appliedChecksum && appliedChecksum !== checksum) {
        throw new Error(`Database migration ${migration.id} changed after it was applied.`);
      }
      if (appliedChecksum) {
        continue;
      }

      await client.query(migration.sql);
      await client.query(
        `insert into project_space_schema_migrations (id, checksum)
         values ($1, $2)`,
        [migration.id, checksum]
      );
    }

    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}
