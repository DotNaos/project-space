import { createHash } from 'node:crypto';

import type { DatabaseQueryClient } from './client';
import { machineConnectionMigrationSql } from './machine-connection-migration';

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
        throw new Error(
          `Database migration ${migration.id} changed after it was applied.`
        );
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
