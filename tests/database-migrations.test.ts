import { describe, expect, test } from 'bun:test';

import type { DatabaseQueryClient } from '../server/database/client';
import {
  databaseMigrations,
  migrationChecksum,
  runDatabaseMigrations
} from '../server/database/migrations';

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
      '0012_project_chat_name_registry'
    ]);

    const sql = databaseMigrations.map((migration) => migration.sql).join('\n');

    expect(sql).toContain('create table if not exists github_oauth_tokens');
    expect(sql).toContain('create table if not exists machine_memberships');
    expect(sql).toContain('create table project_chat_name_claims');
    expect(sql).toContain('create table if not exists user_project_run_settings');
    expect(sql).toContain('allowed_hosts text[]');
    expect(sql).toContain('foreign key (machine_id, user_id)');
    expect(sql).toContain('create table if not exists dev_server_sessions');
    expect(sql).toContain('foreign key (machine_id, owner_user_id)');
    expect(sql).toContain('add column expected_machine_id text');
    expect(sql).toContain("'revoked-enrollment-' || id::text");
    expect(sql).toContain('alter column expected_machine_id set not null');
    expect(sql).toContain('connector_credentials_expected_machine_id_not_blank');
    expect(sql).toContain('connector_credentials_machine_matches_expected');
    expect(sql).toContain('connector_machine_snapshots');
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
