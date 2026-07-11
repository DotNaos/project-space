import { describe, expect, test } from 'bun:test';

import type { DatabaseQueryClient } from '../server/database/client';
import { ProjectSpaceDatabaseRepository } from '../server/database/repository';

interface QueryCall {
  sql: string;
  values: readonly unknown[];
}

class QueueQueryClient implements DatabaseQueryClient {
  readonly calls: QueryCall[] = [];

  constructor(private readonly responses: unknown[][]) {}

  async query<Row>(sql: string, values: readonly unknown[] = []) {
    this.calls.push({ sql, values });
    return { rows: (this.responses.shift() ?? []) as Row[] };
  }
}

const createdAt = new Date('2026-07-11T01:00:00.000Z');
const updatedAt = new Date('2026-07-11T01:05:00.000Z');

function membershipRow() {
  return {
    created_at: createdAt,
    id: '11111111-1111-4111-8111-111111111111',
    machine_id: 'macbook',
    role: 'owner',
    updated_at: updatedAt,
    user_id: 'user-a'
  };
}

function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    created_at: createdAt,
    id: '33333333-3333-4333-8333-333333333333',
    last_error: null,
    last_seen_at: updatedAt,
    local_port: 5173,
    machine_id: 'macbook',
    owner_user_id: 'user-a',
    project_id: 'project-space',
    run_target: 'dev',
    runtime_generation: '1',
    started_at: updatedAt,
    state: 'running',
    stopped_at: null,
    tailscale_port: 45173,
    tailscale_url: 'http://100.64.0.1:45173',
    updated_at: updatedAt,
    worktree_id: 'worktree-main',
    ...overrides
  };
}

function projectsState(selectedProjectId: string) {
  return {
    activeGroupId: '',
    pinnedProjectIds: [selectedProjectId],
    recentProjectIds: [selectedProjectId],
    selectedExplorerTarget: { kind: 'workspace' as const },
    selectedLauncherAppId: '',
    selectedProjectId
  };
}

describe('ProjectSpaceDatabaseRepository', () => {
  test('claims the first machine membership atomically and returns a public UUID record', async () => {
    const client = new QueueQueryClient([[membershipRow()]]);
    const repository = new ProjectSpaceDatabaseRepository(
      client,
      () => '11111111-1111-4111-8111-111111111111'
    );

    const membership = await repository.claimMachineMembership({
      machineId: ' macbook ',
      userId: ' user-a '
    });

    expect(membership).toEqual({
      createdAt: createdAt.toISOString(),
      id: '11111111-1111-4111-8111-111111111111',
      machineId: 'macbook',
      role: 'owner',
      updatedAt: updatedAt.toISOString(),
      userId: 'user-a'
    });
    expect(client.calls[0]?.sql).toContain('where not exists');
    expect(client.calls[0]?.sql).toContain('on conflict do nothing');
    expect(client.calls[0]?.values).toEqual([
      '11111111-1111-4111-8111-111111111111',
      'macbook',
      'user-a'
    ]);
  });

  test('re-reads an idempotent claim after a concurrent request wins', async () => {
    const client = new QueueQueryClient([[], [membershipRow()]]);
    const repository = new ProjectSpaceDatabaseRepository(client);

    const membership = await repository.claimMachineMembership({
      machineId: 'macbook',
      userId: 'user-a'
    });

    expect(membership?.role).toBe('owner');
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1]?.sql).toContain('where machine_id = $1 and user_id = $2');
  });

  test('checks whether a machine is claimed without creating a membership', async () => {
    const client = new QueueQueryClient([[{ claimed: true }]]);
    const repository = new ProjectSpaceDatabaseRepository(client);

    await expect(repository.isMachineClaimed(' macbook ')).resolves.toBe(true);
    expect(client.calls[0]?.sql).toContain('select exists');
    expect(client.calls[0]?.sql).not.toContain('insert into');
    expect(client.calls[0]?.values).toEqual(['macbook']);
  });

  test('keeps run settings user-scoped and normalizes allowed hosts', async () => {
    const client = new QueueQueryClient([[
      {
        allowed_hosts: ['100.64.0.1', 'device.tailnet.ts.net'],
        created_at: createdAt,
        id: '22222222-2222-4222-8222-222222222222',
        machine_id: 'macbook',
        preferred_worktree_id: 'worktree-main',
        project_id: 'project-space',
        run_target: 'dev',
        updated_at: updatedAt,
        user_id: 'user-a'
      }
    ]]);
    const repository = new ProjectSpaceDatabaseRepository(
      client,
      () => '22222222-2222-4222-8222-222222222222'
    );

    const settings = await repository.upsertProjectRunSettings({
      allowedHosts: [' 100.64.0.1 ', 'DEVICE.TAILNET.TS.NET', '100.64.0.1'],
      machineId: 'macbook',
      preferredWorktreeId: 'worktree-main',
      projectId: 'project-space',
      userId: 'user-a'
    });

    expect(settings.allowedHosts).toEqual(['100.64.0.1', 'device.tailnet.ts.net']);
    expect(client.calls[0]?.sql).toContain(
      'on conflict (user_id, machine_id, project_id) do update'
    );
    expect(client.calls[0]?.values.at(-1)).toEqual([
      '100.64.0.1',
      'device.tailnet.ts.net'
    ]);
  });

  test('reads projects state only through the requested user id', async () => {
    const client = new QueueQueryClient([
      [{ state: projectsState('project-a') }],
      [{ state: projectsState('project-b') }]
    ]);
    const repository = new ProjectSpaceDatabaseRepository(client);

    await expect(repository.readUserProjectsState('user-a')).resolves.toEqual(
      projectsState('project-a')
    );
    await expect(repository.readUserProjectsState('user-b')).resolves.toEqual(
      projectsState('project-b')
    );
    expect(client.calls.map((call) => call.values)).toEqual([['user-a'], ['user-b']]);
    expect(client.calls.every((call) => call.sql.includes('where user_id = $1'))).toBe(true);
  });

  test('upserts projects state under one user key and validates its shape', async () => {
    const state = projectsState('project-a');
    const client = new QueueQueryClient([[{ state }]]);
    const repository = new ProjectSpaceDatabaseRepository(client);

    await expect(
      repository.upsertUserProjectsState({ state, userId: ' user-a ' })
    ).resolves.toEqual(state);
    expect(client.calls[0]?.sql).toContain('on conflict (user_id) do update');
    expect(client.calls[0]?.values).toEqual(['user-a', state]);

    await expect(
      repository.upsertUserProjectsState({
        state: { ...state, pinnedProjectIds: ['ok', 42] } as never,
        userId: 'user-a'
      })
    ).rejects.toThrow('pinnedProjectIds[1] must be a string');
    expect(client.calls).toHaveLength(1);
  });

  test('lists sessions only for their owner and supports narrow filters', async () => {
    const client = new QueueQueryClient([[sessionRow()]]);
    const repository = new ProjectSpaceDatabaseRepository(client);

    const sessions = await repository.listDevServerSessions('user-a', {
      activeOnly: true,
      machineId: 'macbook',
      worktreeId: 'worktree-main'
    });

    expect(sessions[0]).toMatchObject({
      generation: 1,
      ownerUserId: 'user-a',
      state: 'running',
      tailscaleUrl: 'http://100.64.0.1:45173'
    });
    expect(client.calls[0]?.sql).toContain('owner_user_id = $1');
    expect(client.calls[0]?.sql).toContain('machine_id = $2');
    expect(client.calls[0]?.sql).toContain('worktree_id = $3');
    expect(client.calls[0]?.sql).toContain("state in ('starting', 'running', 'stopping')");
    expect(client.calls[0]?.values).toEqual(['user-a', 'macbook', 'worktree-main']);
  });

  test('uses owner and generation as the optimistic transition guard', async () => {
    const client = new QueueQueryClient([[
      sessionRow({ runtime_generation: 2, state: 'stopping', stopped_at: null })
    ]]);
    const repository = new ProjectSpaceDatabaseRepository(client);

    const session = await repository.transitionDevServerSession({
      expectedGeneration: 1,
      lastError: null,
      sessionId: '33333333-3333-4333-8333-333333333333',
      state: 'stopping',
      tailscaleUrl: null,
      userId: 'user-a'
    });

    expect(session?.generation).toBe(2);
    expect(session?.state).toBe('stopping');
    expect(client.calls[0]?.sql).toContain('runtime_generation = runtime_generation + 1');
    expect(client.calls[0]?.sql).toContain('owner_user_id = $2');
    expect(client.calls[0]?.sql).toContain('runtime_generation = $3');
    expect(client.calls[0]?.sql).toContain('tailscale_url = $5');
    expect(client.calls[0]?.sql).toContain('last_error = $6');
    expect(client.calls[0]?.values).toEqual([
      '33333333-3333-4333-8333-333333333333',
      'user-a',
      1,
      'stopping',
      null,
      null
    ]);
  });

  test('returns null when a generation transition loses the race', async () => {
    const repository = new ProjectSpaceDatabaseRepository(new QueueQueryClient([[]]));

    await expect(repository.transitionDevServerSession({
      expectedGeneration: 4,
      sessionId: '33333333-3333-4333-8333-333333333333',
      state: 'running',
      userId: 'user-a'
    })).resolves.toBeNull();
  });

  test('rejects an invalid generation before querying the database', async () => {
    const client = new QueueQueryClient([]);
    const repository = new ProjectSpaceDatabaseRepository(client);

    await expect(repository.transitionDevServerSession({
      expectedGeneration: -1,
      sessionId: '33333333-3333-4333-8333-333333333333',
      state: 'running',
      userId: 'user-a'
    })).rejects.toThrow('expectedGeneration must be a non-negative integer.');
    expect(client.calls).toHaveLength(0);
  });
});
