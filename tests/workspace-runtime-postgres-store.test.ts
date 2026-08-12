import { describe, expect, test } from 'bun:test';

import type { DatabaseQueryClient } from '../server/database/client';
import { PostgresRuntimeSessionStore } from '../server/workspace-runtime-session/postgres-store';

const ownerUserId = 'owner-one';
const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const environmentId = '11111111-1111-4111-8111-111111111111';
const generation = '22222222-2222-4222-8222-222222222222';
const credentialId = '33333333-3333-4333-8333-333333333333';
const sessionId = '44444444-4444-4444-8444-444444444444';

describe('Workspace Runtime PostgreSQL authority boundary', () => {
  test('rechecks revocation and refreshes heartbeat freshness when reconnecting', async () => {
    const database = new RuntimeSessionClient();
    const store = new PostgresRuntimeSessionStore(database);
    const receivedAt = '2026-08-12T10:00:40.000Z';
    const result = await store.register(scope(), sessionId, receivedAt, {
      branch: 'issue-625', commit: 'a'.repeat(40), environmentId, generation,
      manifestDigest: 'b'.repeat(64), resumeAfterSequence: 0, runtimeVersion: '0.4.66',
      schemaVersion: 1, type: 'runtime.register', workspaceId
    });
    expect(result.snapshot.lastHeartbeatAt).toBe(receivedAt);
    const authority = database.calls.find((call) => call.sql.includes('for update'))?.sql ?? '';
    expect(authority).toContain('c.revoked_at is null');
    expect(authority).toContain('c.workspace_id = g.workspace_id');
    expect(authority).toContain('c.environment_id = g.environment_id');
    expect(authority).toContain('c.generation = g.generation');
    const registration = database.calls.find((call) => call.sql.includes("connection_state = 'online'"))?.sql ?? '';
    expect(registration).toContain('last_heartbeat_at = $7::timestamptz');
  });

  test('hides credentials that have not registered a concrete session', async () => {
    const database = new RuntimeSessionClient();
    const store = new PostgresRuntimeSessionStore(database);
    expect(await store.list(ownerUserId)).toEqual([]);
    expect(database.calls.at(-1)?.sql ?? '').toContain('g.current_session_id is not null');
  });

  test('binds credential issuance to one durable launch operation before replacement', async () => {
    const database = new CredentialIssueClient();
    const store = new PostgresRuntimeSessionStore(
      database,
      () => credentialId,
      () => 'A'.repeat(43)
    );
    const input = {
      branch: 'issue-625', capabilities: ['runtime.lifecycle', 'runtime.heartbeat'] as const,
      commit: 'a'.repeat(40), environmentId, generation, manifestDigest: 'b'.repeat(64),
      operationId: 'workspace-start:625', ownerUserId, requestedCapabilities: [] as const,
      runtimeVersion: '0.4.66', workspaceId
    };
    await expect(store.issue(input)).resolves.toMatchObject({ credential: { credentialId } });
    const insertion = database.calls.find((call) => call.sql.includes('insert into workspace_runtime_credentials'));
    expect(insertion?.sql).toContain('operation_id');
    expect(insertion?.values).toContain(input.operationId);
    await expect(store.issue(input)).rejects.toMatchObject({ code: 'operation_in_progress' });
    expect(database.calls.filter((call) => call.sql.includes('insert into workspace_runtime_credentials'))).toHaveLength(1);
  });
});

class CredentialIssueClient implements DatabaseQueryClient {
  calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  issued = false;

  async transaction<Result>(operation: (client: DatabaseQueryClient) => Promise<Result>) {
    return operation(this);
  }

  async query<Row>(sql: string, values: readonly unknown[] = []) {
    this.calls.push({ sql, values });
    if (sql.includes('select pg_advisory')) return { rows: [] as Row[] };
    if (sql.includes('where c.owner_user_id = $1 and c.operation_id = $2')) {
      return { rows: (this.issued ? [{
        branch: 'issue-625', capabilities: ['runtime.lifecycle', 'runtime.heartbeat'],
        commit: 'a'.repeat(40), environment_id: environmentId, generation,
        manifest_digest: 'b'.repeat(64), requested_capabilities: [], runtime_version: '0.4.66', workspace_id: workspaceId
      }] : []) as Row[] };
    }
    if (sql.includes('where g.owner_user_id = $1 and g.workspace_id = $2')) return { rows: [] as Row[] };
    if (sql.includes('insert into workspace_runtime_credentials')) {
      this.issued = true;
      return { rows: [{ expires_at: '2026-08-12T10:05:00.000Z' }] as Row[] };
    }
    return { rows: [] as Row[] };
  }
}

class RuntimeSessionClient implements DatabaseQueryClient {
  calls: Array<{ sql: string; values: readonly unknown[] }> = [];

  async transaction<Result>(operation: (client: DatabaseQueryClient) => Promise<Result>) {
    return operation(this);
  }

  async query<Row>(sql: string, values: readonly unknown[] = []) {
    this.calls.push({ sql, values });
    if (sql.includes('select pg_advisory')) return { rows: [] as Row[] };
    if (sql.includes('for update')) return { rows: [row()] as Row[] };
    if (sql.includes("connection_state = 'online'")) {
      return { rows: [{ ...row(), current_session_id: sessionId, connection_state: 'online',
        last_event_at: values[6], last_heartbeat_at: values[6] }] as Row[] };
    }
    return { rows: [] as Row[] };
  }
}

function scope() {
  return {
    branch: 'issue-625', capabilities: ['runtime.lifecycle', 'runtime.heartbeat'] as const,
    commit: 'a'.repeat(40), credentialId, environmentId,
    expiresAt: '2026-08-12T10:05:00.000Z', generation, manifestDigest: 'b'.repeat(64),
    ownerUserId, runtimeVersion: '0.4.66', workspaceId
  };
}

function row() {
  return {
    branch: 'issue-625', capabilities: ['runtime.lifecycle', 'runtime.heartbeat'],
    commit: 'a'.repeat(40), connection_state: 'disconnected', current_credential_id: credentialId,
    current_session_id: null, dev_servers: [], environment_id: environmentId,
    expires_at: '2026-08-12T10:05:00.000Z', generation,
    last_event_at: '2026-08-12T10:00:00.000Z', last_heartbeat_at: '2026-08-12T10:00:00.000Z',
    last_sequence: 0, lifecycle_state: 'starting', log_pointer: null,
    manifest_digest: 'b'.repeat(64), owner_user_id: ownerUserId, runtime_version: '0.4.66',
    telemetry: null, workspace_id: workspaceId
  };
}
