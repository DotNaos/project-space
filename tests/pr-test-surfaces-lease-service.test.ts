import { describe, expect, test } from 'bun:test';

import {
  createPullRequestDevServerLeaseService,
  InMemoryPullRequestDevServerLeaseStore,
  PullRequestDevServerLeaseError,
  prDevServerHeartbeatIntervalMs,
  prDevServerLeaseDurationMs,
  type PullRequestDevServerActor,
  type PullRequestDevServerRegistration,
  type PullRequestDevServerScopeEvidence
} from '../server/pr-test-surfaces/lease-service';

const initialNow = new Date('2026-07-27T12:00:00.000Z');
const commitSha = 'a'.repeat(40);
const threadId = '019fa483-564c-7b01-9d89-5f8ef37af7d0';

function actor(input: Partial<PullRequestDevServerActor> = {}): PullRequestDevServerActor {
  return {
    connectorId: 'connector-a',
    machineId: '11111111-1111-4111-8111-111111111111',
    userId: 'user-a',
    ...input
  };
}

function registration(
  checkedAt: string,
  input: Partial<PullRequestDevServerRegistration> = {}
): PullRequestDevServerRegistration {
  return {
    branchName: 'issue-356-prototypes',
    codexThreadId: threadId,
    commitSha,
    projectId: 'connector-a:project-space',
    pullRequestNumber: 356,
    repositoryFullName: 'DotNaos/project-space',
    runtime: {
      checkedAt,
      state: 'running',
      tailscaleIpv4: '100.80.135.9',
      tailscalePort: 44_419
    },
    servedSurface: 'mobile-prototype',
    serverId: 'prototype',
    worktreeId: 'wt-356',
    ...input
  };
}

function evidence(
  selectedActor: PullRequestDevServerActor,
  value: PullRequestDevServerRegistration,
  input: Partial<PullRequestDevServerScopeEvidence> = {}
): PullRequestDevServerScopeEvidence {
  return {
    branchName: value.branchName,
    checkedAt: value.runtime.checkedAt,
    commitSha: value.commitSha,
    connectorId: selectedActor.connectorId,
    machineId: selectedActor.machineId,
    projectId: value.projectId,
    pullRequestNumber: value.pullRequestNumber,
    repositoryFullName: value.repositoryFullName,
    servedSurface: value.servedSurface,
    serverId: value.serverId,
    state: 'verified',
    worktreeId: value.worktreeId,
    ...input
  };
}

function fixture() {
  let current = new Date(initialNow);
  let nextId = 1;
  const store = new InMemoryPullRequestDevServerLeaseStore();
  const service = createPullRequestDevServerLeaseService({
    createId: () => `lease-${nextId++}`,
    now: () => new Date(current),
    store,
    verifyScope: async (selectedActor, value) => evidence(
      selectedActor,
      { ...value, runtime: { checkedAt: current.toISOString(), state: 'running' } }
    )
  });
  return {
    advance(milliseconds: number) {
      current = new Date(current.getTime() + milliseconds);
    },
    now: () => new Date(current),
    service,
    store
  };
}

async function expectLeaseError(
  promise: Promise<unknown>,
  code: PullRequestDevServerLeaseError['code']
) {
  try {
    await promise;
    throw new Error(`Expected lease error ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(PullRequestDevServerLeaseError);
    expect((error as PullRequestDevServerLeaseError).code).toBe(code);
  }
}

describe('PR Dev Server lease service', () => {
  test('registers a canonical 45 second lease and advertises a 15 second heartbeat', async () => {
    const test = fixture();
    const result = await test.service.register(
      actor(),
      registration(test.now().toISOString())
    );

    expect(result.heartbeatIntervalSeconds).toBe(prDevServerHeartbeatIntervalMs / 1_000);
    expect(result.leaseDurationSeconds).toBe(prDevServerLeaseDurationMs / 1_000);
    expect(result.lease).toMatchObject({
      expiresAt: '2026-07-27T12:00:45.000Z',
      generation: 1,
      heartbeatAt: initialNow.toISOString(),
      id: 'lease-1',
      tailscaleUrl: 'http://100.80.135.9:44419/prototype/mobile/'
    });
  });

  test('renews only with fresh healthy evidence and releases immediately', async () => {
    const test = fixture();
    const registered = await test.service.register(
      actor(),
      registration(test.now().toISOString())
    );
    test.advance(15_000);
    const renewed = await test.service.heartbeat({
      actor: actor(),
      generation: registered.lease.generation,
      leaseId: registered.lease.id,
      runtime: registration(test.now().toISOString()).runtime,
      servedSurface: 'mobile-prototype'
    });
    expect(renewed.lease).toMatchObject({
      expiresAt: '2026-07-27T12:01:00.000Z',
      heartbeatAt: '2026-07-27T12:00:15.000Z'
    });

    test.advance(1_000);
    const released = await test.service.release({
      actor: actor(),
      generation: renewed.lease.generation,
      leaseId: renewed.lease.id
    });
    expect(released.lease.revokedAt).toBe('2026-07-27T12:00:16.000Z');
    await expect(test.store.readCurrent({
      ownerUserId: actor().userId,
      pullRequestNumber: 356,
      repositoryFullName: 'DotNaos/project-space'
    })).resolves.toBeNull();
  });

  test('does not revive an expired lease with a late heartbeat', async () => {
    const test = fixture();
    const registered = await test.service.register(
      actor(),
      registration(test.now().toISOString())
    );
    test.advance(prDevServerLeaseDurationMs);
    await expectLeaseError(
      test.service.heartbeat({
        actor: actor(),
        generation: registered.lease.generation,
        leaseId: registered.lease.id,
        runtime: registration(test.now().toISOString()).runtime,
        servedSurface: 'mobile-prototype'
      }),
      'heartbeat-expired'
    );
  });

  test('rejects stale heartbeats, stopped servers, and mismatched scope proof', async () => {
    const test = fixture();
    const stale = registration(
      new Date(test.now().getTime() - prDevServerHeartbeatIntervalMs - 1).toISOString()
    );
    await expectLeaseError(
      test.service.register(actor(), stale),
      'invalid-evidence'
    );
    await expectLeaseError(
      test.service.register(actor(), registration(test.now().toISOString(), {
        runtime: {
          checkedAt: test.now().toISOString(),
          state: 'stopped'
        }
      })),
      'server-stopped'
    );

    const store = new InMemoryPullRequestDevServerLeaseStore();
    const mismatchService = createPullRequestDevServerLeaseService({
      now: test.now,
      store,
      verifyScope: async (selectedActor, value) =>
        evidence(
          selectedActor,
          { ...value, runtime: registration(test.now().toISOString()).runtime },
          { commitSha: 'b'.repeat(40) }
        )
    });
    await expectLeaseError(
      mismatchService.register(actor(), registration(test.now().toISOString())),
      'registration-mismatch'
    );
  });

  test('supersedes a prior machine atomically and fences its later heartbeat', async () => {
    const test = fixture();
    const firstActor = actor();
    const first = await test.service.register(
      firstActor,
      registration(test.now().toISOString())
    );
    test.advance(1_000);
    const secondActor = actor({
      connectorId: 'connector-b',
      machineId: '22222222-2222-4222-8222-222222222222'
    });
    const second = await test.service.register(
      secondActor,
      registration(test.now().toISOString(), {
        projectId: 'connector-b:project-space',
        servedSurface: 'desktop-prototype',
        worktreeId: 'wt-356-b'
      })
    );

    expect(second.lease.generation).toBe(2);
    expect(test.store.readForTest(first.lease.id)?.revokedAt).toBe(
      '2026-07-27T12:00:01.000Z'
    );
    await expectLeaseError(
      test.service.heartbeat({
        actor: firstActor,
        generation: first.lease.generation,
        leaseId: first.lease.id,
        runtime: registration(test.now().toISOString()).runtime,
        servedSurface: 'mobile-prototype'
      }),
      'lease-superseded'
    );
  });

  test('does not let another user heartbeat or release a lease', async () => {
    const test = fixture();
    const registered = await test.service.register(
      actor(),
      registration(test.now().toISOString())
    );
    const otherUser = actor({ userId: 'user-b' });
    await expectLeaseError(
      test.service.heartbeat({
        actor: otherUser,
        generation: registered.lease.generation,
        leaseId: registered.lease.id,
        runtime: registration(test.now().toISOString()).runtime,
        servedSurface: 'mobile-prototype'
      }),
      'forbidden'
    );
    await expectLeaseError(
      test.service.release({
        actor: otherUser,
        generation: registered.lease.generation,
        leaseId: registered.lease.id
      }),
      'forbidden'
    );
  });
});
