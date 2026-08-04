import { describe, expect, test } from 'bun:test';

import type { DatabaseQueryClient } from '../server/database/client';
import {
  databaseMigrations,
  migrationChecksum,
  runDatabaseMigrations
} from '../server/database/migrations';
import {
  codexMachineTasksMigrationId,
  codexMachineTasksMigrationSql
} from '../server/database/codex-machine-tasks-migration';

interface QueryCall {
  sql: string;
  values: readonly unknown[];
}

class MigrationTestClient implements DatabaseQueryClient {
  readonly calls: QueryCall[] = [];
  readonly applied = new Map<string, string>();

  async query<Row>(sql: string, values: readonly unknown[] = []) {
    this.calls.push({ sql, values });

    if (sql.includes('select id, checksum') && sql.includes('project_space_schema_migrations')) {
      return {
        rows: [...this.applied].map(([id, checksum]) => ({
          id,
          checksum
        })) as Row[]
      };
    }

    if (sql.includes('insert into project_space_schema_migrations')) {
      this.applied.set(String(values[0]), String(values[1]));
    }

    return { rows: [] as Row[] };
  }
}

describe('database migrations', () => {
  test('preserves the original machine-task migration and backfills durability conservatively', () => {
    expect(migrationChecksum({
      id: codexMachineTasksMigrationId,
      sql: codexMachineTasksMigrationSql
    })).toBe('7da3fce3e7e2b8a5915a605991e463b498392f2aacd2fc584414b475ccefbc06');
    const durability = databaseMigrations.find((migration) => (
      migration.id === '0022_codex_machine_task_durable_operations'
    ));
    expect(durability?.sql).toContain('set durable_operations = false');
    expect(durability?.sql).toContain('alter column durable_operations set not null');
  });

  test('defines the multi-user tables and their ownership constraints', () => {
    expect(databaseMigrations.map((migration) => migration.id)).toEqual([
      '0001_github_oauth_tokens',
      '0002_machine_memberships_and_run_settings',
      '0003_dev_server_sessions',
      '0004_connector_credentials',
      '0005_user_project_states',
      '0006_connector_credential_expected_machine',
      '0007_project_chat',
      '0008_machine_connections',
      '0009_project_chat_human_profiles',
      '0010_connector_machine_snapshots',
      '0011_github_catalog_cache',
      '0012_project_chat_name_registry',
      '0013_project_chat_project_channels',
      '0014_dev_server_sessions_per_server',
      '0015_connector_runtime_operations',
      '0016_codex_sessions',
      '0017_github_issue_creation_operations',
      '0018_connector_enrollment_profiles',
      '0019_machine_execution_scopes',
      '0020_physical_machines',
      '0021_codex_machine_tasks',
      '0022_codex_machine_task_durable_operations',
      '0023_codex_machine_task_start_payload',
      '0024_roadmap_plans',
      '0025_pr_dev_server_leases',
      '0026_machine_power_operations',
      '0027_project_chat_name_leases'
    ]);

    const sql = databaseMigrations.map((migration) => migration.sql).join('\n');

    expect(sql).toContain('create table if not exists github_oauth_tokens');
    expect(sql).toContain('create table if not exists machine_memberships');
    expect(sql).toContain('create table project_chat_name_claims');
    expect(sql).toContain('name_lease_retired_at timestamptz');
    expect(sql).toContain(
      "update project_chat_name_claims\n    set updated_at = date_trunc('milliseconds', now())"
    );
    expect(sql).toContain('project_chat_name_claims_lease_expiry_idx');
    expect(sql).toContain('create table if not exists user_project_run_settings');
    expect(sql).toContain('allowed_hosts text[]');
    expect(sql).toContain('foreign key (machine_id, user_id)');
    expect(sql).toContain('on dev_server_sessions (machine_id, worktree_id, server_id)');
    expect(sql).toContain('drop index if exists dev_server_sessions_one_active_per_worktree');
    expect(sql).toContain('create table if not exists dev_server_sessions');
    expect(sql).toContain('foreign key (machine_id, owner_user_id)');
    expect(sql).toContain('create table machine_power_operations');
    expect(sql).toContain('create unique index machine_power_one_dispatch_per_machine');
    expect(sql).toContain('dispatch_attempted boolean not null default false');
    expect(sql).toContain("state in ('accepted', 'uncertain') and dispatch_attempted");
    expect(sql).toContain("'expired'");
    expect(sql).toContain("actor_type text not null");
    expect(sql).toContain("actor_type = 'machine'");
    expect(sql).toContain('caller_machine_id text');
    expect(sql).toContain('add column expected_machine_id text');
    expect(sql).toContain("'revoked-enrollment-' || id::text");
    expect(sql).toContain('alter column expected_machine_id set not null');
    expect(sql).toContain('connector_credentials_expected_machine_id_not_blank');
    expect(sql).toContain('connector_credentials_machine_matches_expected');
    expect(sql).toContain('create table connector_runtime_operations');
    expect(sql).toContain('connector_runtime_operations_one_active_per_machine');
    expect(sql).toContain('create table connector_runtime_audit_events');
    expect(sql).toContain("action = 'connector-runtime.maintenance-request'");
    expect(sql).toContain('connector_machine_snapshots');
    expect(sql).toContain('machine_connection_requests_connector_profile_pair');
    expect(sql).toContain('machine_identities_connector_profile_pair');
    expect(sql).toContain('connector_machine_snapshots_connector_profile_pair');
    expect(sql).toContain('create table machine_execution_scopes');
    expect(sql).toContain('create table machine_execution_scope_members');
    expect(sql).toContain('create table physical_machines');
    expect(sql).toContain('create table physical_machine_connectors');
    expect(sql).toContain('primary key (owner_user_id, connector_id)');
    expect(sql).toContain('insert into physical_machines');
    expect(sql).toContain('from machine_execution_scopes');
    expect(sql).toContain('insert into physical_machine_connectors');
    expect(sql).toContain('from machine_execution_scope_members');
    expect(sql).toContain('create table if not exists codex_machine_task_starts');
    expect(sql).toContain('primary key (owner_user_id, association_key)');
    expect(sql).toContain('create table if not exists codex_machine_task_start_operations');
    expect(sql).toContain('primary key (owner_user_id, operation_id)');
    expect(sql).toContain('create table if not exists codex_machine_task_sends');
    expect(sql).toContain('codex_machine_task_sends_one_unresolved_per_thread');
    expect(sql).toContain('add column if not exists durable_operations boolean');
    expect(sql).toContain('set durable_operations = false');
    expect(sql).toContain('alter column durable_operations set not null');
    expect(sql).toContain('add column start_payload jsonb');
    expect(sql).toContain('references machine_memberships (machine_id, user_id)');
    expect(sql).toContain('registry jsonb not null');
    expect(sql).toContain('removed_by_user_id text');
    expect(sql).toContain('machine_id is null or machine_id = expected_machine_id');
    expect(sql).toContain('create table if not exists user_project_states');
    expect(sql).toContain('user_id text primary key');
    expect(sql).toContain('state jsonb not null');
    expect(sql).toContain('dev_server_sessions_one_active_per_worktree');
    expect(sql).toContain("where state in ('starting', 'running', 'stopping')");
    expect(sql).toContain('create table if not exists connector_credentials');
    expect(sql).toContain('token_hash text not null unique');
    expect(sql).toContain('machine_id text check');
    expect(sql).toContain('expires_at timestamptz not null');
    expect(sql).toContain('last_seen_at timestamptz');
    expect(sql).toContain('revoked_at timestamptz');
    expect(sql).toContain('foreign key (machine_id, owner_user_id)');
    expect(sql).toContain('create table if not exists project_chat_channels');
    expect(sql).toContain('create table if not exists project_chat_members');
    expect(sql).toContain('project_chat_members_space_actor_unique');
    expect(sql).toContain('project_chat_members_space_handle_unique');
    expect(sql).toContain('create table if not exists project_chat_messages');
    expect(sql).toContain('create table if not exists project_chat_message_mentions');
    expect(sql).toContain('create table if not exists project_chat_cursors');
    expect(sql).toContain('create table if not exists project_chat_idempotency');
    expect(sql).toContain('project_chat_idempotency_identity_unique');
    expect(sql).toContain('add column project_id text');
    expect(sql).toContain('project_chat_channels_scope_consistent');
    expect(sql).toContain('project_chat_channels_project_unique');
    expect(sql).toContain('create table project_chat_human_profiles');
    expect(sql).toContain('avatar_data_url_override text');
    expect(sql).toContain('revision bigint not null default 1');
    expect(sql).toContain('insert into project_chat_human_profiles');
    expect(sql).toContain('set profile_revision = 1');
    expect(sql).toContain('project_chat_members_profile_revision_positive');
    expect(sql).toContain('project_chat_members_role_origin_consistent');
    expect(sql).toContain("role = 'agent' and origin is not null and avatar_url is null");
    expect(sql).toContain('references project_chat_messages (space_id, id)');
    expect(sql).toContain('on delete cascade');
    expect(sql).toContain('create table machine_identities');
    expect(sql).toContain('create table machine_connection_requests');
    expect(sql).toContain('create table machine_connection_rate_events');
    expect(sql).toContain('machine_identities_current_credential_fk');
    expect(sql).toContain('create table if not exists github_catalog_cache');
    expect(sql).toContain('primary key (user_id, scope)');
    expect(sql).toContain('github_issue_creation_operations');
    expect(sql).toContain('primary key (owner_user_id, repository_full_name, operation_id)');
    expect(sql).toContain('create table roadmap_plans');
    expect(sql).toContain('create table roadmap_dependency_snapshots');
    expect(sql).toContain('primary key (repository_id, principal_id)');
    expect(sql).toContain('revision bigint not null default 0');
    expect(sql).toContain('create table pull_request_dev_server_leases');
    expect(sql).toContain('pull_request_dev_server_leases_current_scope_idx');
  });

  test('applies pending migrations once under a transaction and records checksums', async () => {
    const client = new MigrationTestClient();
    const alreadyApplied = databaseMigrations[0];
    client.applied.set(alreadyApplied.id, migrationChecksum(alreadyApplied));

    await runDatabaseMigrations(client);

    expect(client.calls[0]?.sql).toBe('begin');
    expect(client.calls.some((call) => call.sql.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(client.calls.some((call) => call.sql.includes('project_space_schema_migrations'))).toBe(
      true
    );
    expect(client.calls.some((call) => call.sql === alreadyApplied.sql)).toBe(false);
    expect(client.calls.some((call) => call.sql === databaseMigrations[1].sql)).toBe(true);
    expect(client.calls.some((call) => call.sql === databaseMigrations[2].sql)).toBe(true);
    expect(client.calls.some((call) => call.sql === databaseMigrations[3].sql)).toBe(true);
    expect(client.calls.some((call) => call.sql === databaseMigrations[4].sql)).toBe(true);
    expect(client.calls.some((call) => call.sql === databaseMigrations[5].sql)).toBe(true);
    expect(client.calls.some((call) => call.sql === databaseMigrations[6].sql)).toBe(true);
    expect(client.calls.some((call) => call.sql === databaseMigrations[7].sql)).toBe(true);
    expect(client.calls.some((call) => call.sql === databaseMigrations[8].sql)).toBe(true);
    expect(client.calls.some((call) => call.sql === databaseMigrations[9].sql)).toBe(true);
    expect(client.calls.some((call) => call.sql === databaseMigrations[10].sql)).toBe(true);
    expect(client.calls.at(-1)?.sql).toBe('commit');
    expect(client.applied).toEqual(
      new Map(databaseMigrations.map((migration) => [migration.id, migrationChecksum(migration)]))
    );

    const firstRunCallCount = client.calls.length;
    await runDatabaseMigrations(client);

    const secondRunCalls = client.calls.slice(firstRunCallCount);
    expect(
      secondRunCalls.some((call) =>
        databaseMigrations.some((migration) => migration.sql === call.sql)
      )
    ).toBe(false);
  });

  test('rolls back when an applied migration was modified', async () => {
    const client = new MigrationTestClient();
    client.applied.set(databaseMigrations[0].id, 'unexpected-checksum');

    await expect(runDatabaseMigrations(client)).rejects.toThrow(
      'Database migration 0001_github_oauth_tokens changed after it was applied.'
    );
    expect(client.calls.at(-1)?.sql).toBe('rollback');
  });
});
