import { createHash } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import type { DatabaseQueryClient } from '../server/database/client';
import { ProjectSpaceDatabaseRepository } from '../server/database/repository';

interface QueryCall {
  sql: string;
  values: readonly unknown[];
}

type QueryHandler = (
  sql: string,
  values: readonly unknown[]
) => unknown[] | Promise<unknown[]>;

class ScriptedQueryClient implements DatabaseQueryClient {
  readonly calls: QueryCall[] = [];

  constructor(private readonly handler: QueryHandler) {}

  async query<Row>(sql: string, values: readonly unknown[] = []) {
    this.calls.push({ sql, values });
    return { rows: (await this.handler(sql, values)) as Row[] };
  }
}

const credentialId = '44444444-4444-4444-8444-444444444444';
const membershipId = '55555555-5555-4555-8555-555555555555';
const token = Buffer.alloc(32, 7).toString('base64url');
const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
const expiresAt = new Date('2026-08-10T01:00:00.000Z');

function createRepository(client: DatabaseQueryClient) {
  const ids = [credentialId, membershipId];

  return new ProjectSpaceDatabaseRepository(client, () => ids.shift() ?? membershipId, {
    createToken: () => token
  });
}

describe('connector credential repository', () => {
  test('replaces older pending enrollments and persists only a new token hash', async () => {
    const client = new ScriptedQueryClient((sql) => {
      if (sql.includes('insert into connector_credentials')) {
        return [{
          expires_at: expiresAt,
          id: credentialId,
          machine_id: null,
          owner_user_id: 'user-a'
        }];
      }

      return [];
    });
    const repository = createRepository(client);

    const created = await repository.createConnectorCredential({
      ttlSeconds: 86_400,
      userId: ' user-a '
    });

    expect(Buffer.from(created.token, 'base64url')).toHaveLength(32);
    expect(created).toEqual({
      expiresAt: expiresAt.toISOString(),
      id: credentialId,
      token,
      userId: 'user-a'
    });
    const pendingRevocation = client.calls.find((call) =>
      call.sql.includes('machine_id is null')
    );
    expect(pendingRevocation?.sql).toContain('revoked_at = coalesce(revoked_at, now())');
    expect(pendingRevocation?.values).toEqual(['user-a']);
    const insert = client.calls.find((call) =>
      call.sql.includes('insert into connector_credentials')
    );
    expect(insert?.values).toEqual([
      credentialId,
      'user-a',
      tokenHash,
      86_400
    ]);
    expect(client.calls[0]?.sql).toBe('begin');
    expect(client.calls.at(-1)?.sql).toBe('commit');
    expect(client.calls.some((call) => call.sql.includes('machine_memberships'))).toBe(false);
    expect(JSON.stringify(client.calls)).not.toContain(token);
    expect(insert?.sql).not.toContain(token);
  });

  test('atomically first-binds a valid token, creates owner membership, and updates last seen', async () => {
    const client = new ScriptedQueryClient((sql, values) => {
      if (sql.includes('from connector_credentials') && sql.includes('for update')) {
        expect(values).toEqual([tokenHash]);
        return [{
          expires_at: expiresAt,
          id: credentialId,
          machine_id: null,
          owner_user_id: 'user-a'
        }];
      }
      if (sql.includes('update connector_credentials')) {
        return [{
          id: credentialId,
          machine_id: 'macbook',
          owner_user_id: 'user-a'
        }];
      }

      return [];
    });
    const repository = createRepository(client);

    await expect(repository.authenticateConnectorCredential({
      machineId: ' macbook ',
      token
    })).resolves.toEqual({
      credentialId,
      machineId: 'macbook',
      userId: 'user-a'
    });

    expect(client.calls[0]?.sql).toBe('begin');
    expect(client.calls.some((call) => call.sql.includes('for update'))).toBe(true);
    expect(
      client.calls.some((call) => call.sql.includes('pg_advisory_xact_lock'))
    ).toBe(true);
    const membershipCall = client.calls.find((call) =>
      call.sql.includes('insert into machine_memberships')
    );
    expect(membershipCall?.sql).toContain('on conflict (machine_id, user_id) do update');
    expect(membershipCall?.sql).toContain("role = 'owner'");
    expect(membershipCall?.values.slice(1)).toEqual(['macbook', 'user-a']);
    const bindingCall = client.calls.find((call) =>
      call.sql.includes('update connector_credentials')
    );
    expect(bindingCall?.sql).toContain('last_seen_at = now()');
    expect(bindingCall?.sql).toContain('when machine_id is null');
    expect(bindingCall?.sql).toContain('and (machine_id is null or machine_id = $2)');
    expect(bindingCall?.values).toEqual([credentialId, 'macbook', 365 * 24 * 60 * 60]);
    expect(client.calls.at(-1)?.sql).toBe('commit');
    expect(JSON.stringify(client.calls)).not.toContain(token);
  });

  test('refuses a token that is already bound to a different machine', async () => {
    const client = new ScriptedQueryClient((sql) => {
      if (sql.includes('from connector_credentials') && sql.includes('for update')) {
        return [{
          expires_at: expiresAt,
          id: credentialId,
          machine_id: 'desktop',
          owner_user_id: 'user-a'
        }];
      }

      return [];
    });
    const repository = createRepository(client);

    await expect(repository.authenticateConnectorCredential({
      machineId: 'macbook',
      token
    })).resolves.toBeNull();
    expect(
      client.calls.some((call) => call.sql.includes('insert into machine_memberships'))
    ).toBe(false);
    expect(client.calls.at(-1)?.sql).toBe('commit');
  });

  test('returns null and rolls back if another user already owns the machine', async () => {
    const ownerConflict = Object.assign(new Error('owner conflict'), {
      code: '23505',
      constraint: 'machine_memberships_one_owner_per_machine'
    });
    const client = new ScriptedQueryClient((sql) => {
      if (sql.includes('from connector_credentials') && sql.includes('for update')) {
        return [{
          expires_at: expiresAt,
          id: credentialId,
          machine_id: null,
          owner_user_id: 'user-a'
        }];
      }
      if (sql.includes('insert into machine_memberships')) {
        throw ownerConflict;
      }

      return [];
    });
    const repository = createRepository(client);

    await expect(repository.authenticateConnectorCredential({
      machineId: 'macbook',
      token
    })).resolves.toBeNull();
    expect(client.calls.at(-1)?.sql).toBe('rollback');
    expect(
      client.calls.some((call) => call.sql.includes('update connector_credentials'))
    ).toBe(false);
  });

  test('rejects malformed tokens without querying or hashing unbounded input', async () => {
    const client = new ScriptedQueryClient(() => []);
    const repository = createRepository(client);

    await expect(repository.authenticateConnectorCredential({
      machineId: 'macbook',
      token: 'not-a-credential'
    })).resolves.toBeNull();
    expect(client.calls).toHaveLength(0);
  });

  test('lists only owner-scoped credential metadata without token hashes', async () => {
    const createdAt = new Date('2026-07-11T01:00:00.000Z');
    const lastSeenAt = new Date('2026-07-11T01:05:00.000Z');
    const client = new ScriptedQueryClient((sql, values) => {
      if (sql.includes('from connector_credentials')) {
        expect(values).toEqual(['user-a']);
        return [{
          created_at: createdAt,
          expires_at: expiresAt,
          id: credentialId,
          last_seen_at: lastSeenAt,
          machine_id: 'macbook',
          owner_user_id: 'user-a',
          revoked_at: null,
          status: 'active'
        }];
      }
      return [];
    });
    const repository = createRepository(client);

    await expect(repository.listConnectorCredentials(' user-a ')).resolves.toEqual([{
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      id: credentialId,
      lastSeenAt: lastSeenAt.toISOString(),
      machineId: 'macbook',
      revokedAt: undefined,
      status: 'active'
    }]);
    expect(client.calls[0]?.sql).toContain('where owner_user_id = $1');
    expect(client.calls[0]?.sql).toContain('limit 100');
    expect(client.calls[0]?.sql).not.toContain('token_hash');
  });

  test('revokes only a credential owned by the requesting user', async () => {
    const client = new ScriptedQueryClient((sql) =>
      sql.includes('update connector_credentials') ? [{ id: credentialId }] : []
    );
    const repository = createRepository(client);

    await expect(repository.revokeConnectorCredential({
      credentialId,
      userId: 'user-a'
    })).resolves.toBe(true);
    expect(client.calls[0]?.sql).toContain('revoked_at = coalesce(revoked_at, now())');
    expect(client.calls[0]?.sql).toContain('owner_user_id = $2');
    expect(client.calls[0]?.values).toEqual([credentialId, 'user-a']);
  });
});
