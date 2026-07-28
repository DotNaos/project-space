import { describe, expect, test } from 'bun:test';

import type { DatabaseQueryClient } from '../server/database/client';
import type {
  PullRequestDevServerActor,
  PullRequestDevServerLease
} from '../server/pr-test-surfaces/lease-service';
import {
  PostgresPullRequestDevServerLeaseStore
} from '../server/pr-test-surfaces/postgres-lease-store';

interface QueryCall {
  sql: string;
  values: readonly unknown[];
}

class QueueDatabase implements DatabaseQueryClient {
  readonly calls: QueryCall[] = [];
  transactionCalls = 0;

  constructor(private readonly responses: unknown[][]) {}

  async query<Row>(sql: string, values: readonly unknown[] = []) {
    this.calls.push({ sql, values });
    const rows = this.responses.shift();
    if (!rows) {
      throw new Error(`Unexpected database query: ${sql}`);
    }
    return { rows: rows as Row[] };
  }

  async transaction<Result>(
    operation: (client: DatabaseQueryClient) => Promise<Result>
  ) {
    this.transactionCalls += 1;
    return operation(this);
  }

  assertExhausted() {
    expect(this.responses).toHaveLength(0);
  }
}

const at = '2026-07-27T12:00:00.000Z';
const expiresAt = '2026-07-27T12:00:45.000Z';
const actor: PullRequestDevServerActor = {
  connectorId: 'connector-a',
  machineId: '11111111-1111-4111-8111-111111111111',
  userId: 'user-a'
};

function leaseRow(input: Partial<Record<string, unknown>> = {}) {
  return {
    branch_name: 'issue-356-prototypes',
    codex_thread_id: '019fa483-564c-7b01-9d89-5f8ef37af7d0',
    commit_sha: 'a'.repeat(40),
    connector_id: actor.connectorId,
    created_at: new Date(at),
    expires_at: expiresAt,
    heartbeat_at: at,
    id: '11111111-2222-4333-8444-555555555555',
    lease_generation: '4',
    owner_user_id: actor.userId,
    physical_machine_id: actor.machineId,
    project_id: 'connector-a:project-space',
    pull_request_number: '356',
    repository_full_name: 'DotNaos/project-space',
    revoked_at: null,
    served_surface: 'mobile-prototype',
    server_id: 'prototype',
    tailscale_ipv4: '100.80.135.9',
    tailscale_port: '44419',
    tailscale_url: 'http://100.80.135.9:44419/prototype/mobile/',
    updated_at: at,
    worktree_id: 'wt-356',
    ...input
  };
}

function registration(): Omit<
  PullRequestDevServerLease,
  'createdAt' | 'generation' | 'heartbeatAt' | 'id' | 'ownerUserId' | 'updatedAt'
> {
  return {
    branchName: 'issue-356-prototypes',
    codexThreadId: '019fa483-564c-7b01-9d89-5f8ef37af7d0',
    commitSha: 'a'.repeat(40),
    connectorId: actor.connectorId,
    expiresAt,
    machineId: actor.machineId,
    projectId: 'connector-a:project-space',
    pullRequestNumber: 356,
    repositoryFullName: 'DotNaos/project-space',
    servedSurface: 'mobile-prototype',
    serverId: 'prototype',
    tailscaleIpv4: '100.80.135.9',
    tailscalePort: 44_419,
    tailscaleUrl: 'http://100.80.135.9:44419/prototype/mobile/',
    worktreeId: 'wt-356'
  };
}

describe('PostgresPullRequestDevServerLeaseStore', () => {
  test('maps the current scoped lease without hiding an expired row', async () => {
    const database = new QueueDatabase([[leaseRow({
      codex_thread_id: null,
      expires_at: '2026-07-27T11:59:59.000Z'
    })]]);
    const store = new PostgresPullRequestDevServerLeaseStore(database);

    await expect(store.readCurrent({
      ownerUserId: actor.userId,
      pullRequestNumber: 356,
      repositoryFullName: 'dotnaos/PROJECT-space'
    })).resolves.toEqual({
      branchName: 'issue-356-prototypes',
      commitSha: 'a'.repeat(40),
      connectorId: actor.connectorId,
      createdAt: at,
      expiresAt: '2026-07-27T11:59:59.000Z',
      generation: 4,
      heartbeatAt: at,
      id: '11111111-2222-4333-8444-555555555555',
      machineId: actor.machineId,
      ownerUserId: actor.userId,
      projectId: 'connector-a:project-space',
      pullRequestNumber: 356,
      repositoryFullName: 'DotNaos/project-space',
      servedSurface: 'mobile-prototype',
      serverId: 'prototype',
      tailscaleIpv4: '100.80.135.9',
      tailscalePort: 44_419,
      tailscaleUrl: 'http://100.80.135.9:44419/prototype/mobile/',
      updatedAt: at,
      worktreeId: 'wt-356'
    });
    expect(database.calls[0]?.sql).toContain('lower(repository_full_name) = lower($2)');
    database.assertExhausted();
  });

  test('supersedes the scoped lease under an advisory transaction lock', async () => {
    const replacement = leaseRow({
      id: '22222222-3333-4444-8555-666666666666',
      lease_generation: '5'
    });
    const database = new QueueDatabase([
      [],
      [leaseRow()],
      [],
      [replacement]
    ]);
    const store = new PostgresPullRequestDevServerLeaseStore(database);

    await expect(store.supersede({
      actor,
      at,
      createId: () => String(replacement.id),
      registration: registration()
    })).resolves.toMatchObject({
      generation: 5,
      id: replacement.id
    });

    expect(database.transactionCalls).toBe(1);
    expect(database.calls[0]?.sql).toContain('pg_advisory_xact_lock');
    expect(database.calls[0]?.values[0]).toBe(JSON.stringify([
      'project-space:pr-dev-server-lease',
      'user-a',
      'dotnaos/project-space',
      356
    ]));
    expect(database.calls[1]?.sql).toContain('for update');
    expect(database.calls[2]?.sql).toContain('set expires_at = $2');
    expect(database.calls[3]?.sql).toContain('insert into pull_request_dev_server_leases');
    expect(database.calls[3]?.values[16]).toBe(5);
    database.assertExhausted();
  });

  test('renews a current live lease while holding its scope lock', async () => {
    const current = leaseRow();
    const renewed = leaseRow({
      expires_at: '2026-07-27T12:01:00.000Z',
      heartbeat_at: '2026-07-27T12:00:15.000Z',
      updated_at: '2026-07-27T12:00:15.000Z'
    });
    const database = new QueueDatabase([
      [current],
      [],
      [current],
      [current],
      [renewed]
    ]);
    const store = new PostgresPullRequestDevServerLeaseStore(database);

    await expect(store.heartbeat({
      actor,
      expiresAt: '2026-07-27T12:01:00.000Z',
      generation: 4,
      heartbeatAt: '2026-07-27T12:00:15.000Z',
      leaseId: String(current.id),
      tailscaleIpv4: '100.80.135.9',
      tailscalePort: 44_419,
      tailscaleUrl: 'http://100.80.135.9:44419/prototype/mobile/'
    })).resolves.toMatchObject({
      lease: {
        expiresAt: '2026-07-27T12:01:00.000Z',
        heartbeatAt: '2026-07-27T12:00:15.000Z'
      },
      state: 'updated'
    });

    expect(database.transactionCalls).toBe(1);
    expect(database.calls[1]?.sql).toContain('pg_advisory_xact_lock');
    expect(database.calls[2]?.sql).toContain('for update');
    expect(database.calls[4]?.sql).toContain('set heartbeat_at = $2');
    database.assertExhausted();
  });

  test('classifies expired, forbidden, and superseded heartbeats safely', async () => {
    const expired = leaseRow({ expires_at: '2026-07-27T12:00:15.000Z' });
    const expiredDatabase = new QueueDatabase([
      [expired],
      [],
      [expired],
      [expired]
    ]);
    const expiredStore = new PostgresPullRequestDevServerLeaseStore(expiredDatabase);
    await expect(expiredStore.heartbeat({
      actor,
      expiresAt,
      generation: 4,
      heartbeatAt: '2026-07-27T12:00:15.000Z',
      leaseId: String(expired.id),
      tailscaleIpv4: '100.80.135.9',
      tailscalePort: 44_419,
      tailscaleUrl: 'http://100.80.135.9:44419/prototype/mobile/'
    })).resolves.toEqual({ state: 'expired' });
    expiredDatabase.assertExhausted();

    const forbidden = leaseRow();
    const forbiddenDatabase = new QueueDatabase([[forbidden], [], [forbidden]]);
    const forbiddenStore = new PostgresPullRequestDevServerLeaseStore(forbiddenDatabase);
    await expect(forbiddenStore.heartbeat({
      actor: { ...actor, userId: 'other-user' },
      expiresAt,
      generation: 4,
      heartbeatAt: '2026-07-27T12:00:15.000Z',
      leaseId: String(forbidden.id),
      tailscaleIpv4: '100.80.135.9',
      tailscalePort: 44_419,
      tailscaleUrl: 'http://100.80.135.9:44419/prototype/mobile/'
    })).resolves.toEqual({ state: 'forbidden' });
    forbiddenDatabase.assertExhausted();

    const revoked = leaseRow({ revoked_at: '2026-07-27T12:00:01.000Z' });
    const replacement = leaseRow({ id: 'new-current', lease_generation: '5' });
    const supersededDatabase = new QueueDatabase([
      [revoked],
      [],
      [revoked],
      [replacement]
    ]);
    const supersededStore = new PostgresPullRequestDevServerLeaseStore(
      supersededDatabase
    );
    await expect(supersededStore.heartbeat({
      actor,
      expiresAt,
      generation: 4,
      heartbeatAt: '2026-07-27T12:00:15.000Z',
      leaseId: String(revoked.id),
      tailscaleIpv4: '100.80.135.9',
      tailscalePort: 44_419,
      tailscaleUrl: 'http://100.80.135.9:44419/prototype/mobile/'
    })).resolves.toEqual({ state: 'superseded' });
    supersededDatabase.assertExhausted();
  });

  test('releases the current lease immediately and rejects non-transactional mutations', async () => {
    const current = leaseRow();
    const released = leaseRow({
      expires_at: '2026-07-27T12:00:10.000Z',
      revoked_at: '2026-07-27T12:00:10.000Z',
      updated_at: '2026-07-27T12:00:10.000Z'
    });
    const database = new QueueDatabase([
      [current],
      [],
      [current],
      [current],
      [released]
    ]);
    const store = new PostgresPullRequestDevServerLeaseStore(database);

    await expect(store.release({
      actor,
      generation: 4,
      leaseId: String(current.id),
      revokedAt: '2026-07-27T12:00:10.000Z'
    })).resolves.toMatchObject({
      lease: { revokedAt: '2026-07-27T12:00:10.000Z' },
      state: 'updated'
    });
    expect(database.calls[4]?.sql).toContain('set expires_at = $2');
    database.assertExhausted();

    const noTransactions: DatabaseQueryClient = {
      async query<Row>() {
        return { rows: [] as Row[] };
      }
    };
    await expect(new PostgresPullRequestDevServerLeaseStore(noTransactions).release({
      actor,
      generation: 4,
      leaseId: String(current.id),
      revokedAt: at
    })).rejects.toThrow('require transaction support');
  });
});
