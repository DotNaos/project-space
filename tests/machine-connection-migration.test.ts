import { describe, expect, test } from 'bun:test';

import { machineConnectionMigrationSql } from '../server/database/machine-connection-migration';

function normalizedSql() {
  return machineConnectionMigrationSql.replace(/\s+/g, ' ').trim().toLowerCase();
}

describe('machine connection database migration', () => {
  test('defines the request, identity, and privacy-preserving rate-limit tables', () => {
    const sql = normalizedSql();

    expect(sql).toContain('create table machine_identities');
    expect(sql).toContain('create table machine_connection_requests');
    expect(sql).toContain('create table machine_connection_rate_events');
    expect(sql).toContain("check (requester_hash ~ '^[0-9a-f]{64}$')");
    expect(sql).not.toContain('ip_address');
    expect(sql).not.toContain('remote_address');
  });

  test('binds the current machine credential to the same machine', () => {
    const sql = normalizedSql();

    expect(sql).toContain(
      'add constraint connector_credentials_id_machine_unique unique (id, machine_id)'
    );
    expect(sql).toContain(
      'foreign key (current_credential_id, id) references connector_credentials (id, machine_id) deferrable initially deferred'
    );
    expect(sql).toContain(
      'foreign key (id, owner_user_id) references machine_memberships (machine_id, user_id) deferrable initially deferred'
    );
  });

  test('matches the store state machine and bounded cleanup access paths', () => {
    const sql = normalizedSql();

    for (const status of ['pending', 'approved', 'denied', 'consumed', 'expired']) {
      expect(sql).toContain(`'${status}'`);
    }
    expect(sql).toContain('machine_connection_requests_public_key_idx');
    expect(sql).toContain('machine_connection_requests_cleanup_idx');
    expect(sql).toContain('machine_connection_rate_events_requester_idx');
    expect(sql).toContain('machine_connection_rate_events_cleanup_idx');
  });
});
