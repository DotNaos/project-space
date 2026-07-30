import { describe, expect, test } from 'bun:test';

import type {
  PullRequestDevServerLease,
  PullRequestDevServerScopeEvidence
} from '../server/pr-test-surfaces/lease-service';
import {
  resolvePullRequestTestSurfaces,
  type PullRequestCodexTaskEvidence,
  type PullRequestTestSurfaceResolutionInput
} from '../server/pr-test-surfaces/state-resolver';

const checkedAt = '2026-07-27T12:00:00.000Z';
const commitSha = 'a'.repeat(40);
const threadId = '019fa483-564c-7b01-9d89-5f8ef37af7d0';

function lease(input: Partial<PullRequestDevServerLease> = {}): PullRequestDevServerLease {
  return {
    branchName: 'issue-356-prototypes',
    codexThreadId: threadId,
    commitSha,
    connectorId: 'connector-a',
    createdAt: '2026-07-27T11:59:30.000Z',
    expiresAt: '2026-07-27T12:00:15.000Z',
    generation: 1,
    heartbeatAt: '2026-07-27T11:59:30.000Z',
    id: 'lease-a',
    machineId: 'machine-a',
    ownerUserId: 'user-a',
    projectId: 'connector-a:project-space',
    pullRequestNumber: 356,
    repositoryFullName: 'DotNaos/project-space',
    servedSurface: 'mobile-prototype',
    serverId: 'prototype',
    tailscaleIpv4: '100.80.135.9',
    tailscalePort: 44_419,
    tailscaleUrl: 'http://100.80.135.9:44419/prototype/mobile/',
    updatedAt: '2026-07-27T11:59:30.000Z',
    worktreeId: 'wt-356',
    ...input
  };
}

function registrationEvidence(
  current: PullRequestDevServerLease
): PullRequestDevServerScopeEvidence {
  return {
    branchName: current.branchName,
    checkedAt,
    commitSha: current.commitSha,
    connectorId: current.connectorId,
    machineId: current.machineId,
    projectId: current.projectId,
    pullRequestNumber: current.pullRequestNumber,
    repositoryFullName: current.repositoryFullName,
    servedSurface: current.servedSurface,
    serverId: current.serverId,
    state: 'verified',
    worktreeId: current.worktreeId
  };
}

function taskEvidence(
  current: PullRequestDevServerLease
): PullRequestCodexTaskEvidence {
  return {
    branchName: current.branchName,
    checkedAt,
    commitSha: current.commitSha,
    connectorId: current.connectorId,
    machineId: current.machineId,
    state: 'available',
    threadId: current.codexThreadId!,
    worktreeId: current.worktreeId,
    writeCapabilityExpiresAt: '2026-07-27T12:01:00.000Z'
  };
}

function input(
  overrides: Partial<PullRequestTestSurfaceResolutionInput> = {}
): PullRequestTestSurfaceResolutionInput {
  const currentLease = overrides.lease ?? lease();
  return {
    checkedAt,
    deployedSurfaces: [
      {
        commitSha,
        kind: 'full-preview',
        state: 'available',
        url: 'https://pr-356.projects.os-home.net/',
        verifiedAt: '2026-07-27T11:58:00.000Z'
      },
      {
        commitSha,
        kind: 'mobile-prototype',
        state: 'available',
        url: 'https://pr-356.projects.os-home.net/prototype/mobile/',
        verifiedAt: '2026-07-27T11:58:00.000Z'
      },
      { kind: 'desktop-prototype', state: 'pending' }
    ],
    headSha: commitSha,
    lease: currentLease,
    machineEvidence: {
      checkedAt,
      connectorId: currentLease.connectorId,
      machineId: currentLease.machineId,
      state: 'online'
    },
    pullRequestNumber: 356,
    pullRequestState: 'open',
    registrationEvidence: registrationEvidence(currentLease),
    repositoryAccess: 'authorized',
    repositoryFullName: 'DotNaos/project-space',
    taskEvidence: taskEvidence(currentLease),
    ...overrides
  };
}

function surface(
  result: ReturnType<typeof resolvePullRequestTestSurfaces>,
  kind: string
) {
  return result.surfaces.find((candidate) => candidate.kind === kind);
}

describe('PR test-surface state resolver', () => {
  test('keeps deployed surfaces independent from live and feedback evidence', () => {
    const result = resolvePullRequestTestSurfaces(input({
      lease: undefined,
      machineEvidence: undefined,
      registrationEvidence: undefined,
      taskEvidence: undefined
    }));
    expect(surface(result, 'full-preview')).toMatchObject({
      state: 'available',
      url: 'https://pr-356.projects.os-home.net/'
    });
    expect(surface(result, 'mobile-prototype')).toMatchObject({
      state: 'available'
    });
    expect(surface(result, 'desktop-prototype')).toEqual({
      kind: 'desktop-prototype',
      reasonCode: 'deployment-pending',
      state: 'pending'
    });
    expect(surface(result, 'dev-server')).toEqual({
      kind: 'dev-server',
      reasonCode: 'live-registration-missing',
      state: 'unavailable'
    });
    expect(result.feedback).toEqual({
      reasonCode: 'feedback-not-live',
      state: 'unavailable'
    });
  });

  test('withholds every stale or mismatched live URL', () => {
    const cases: Array<[
      Partial<PullRequestTestSurfaceResolutionInput>,
      string
    ]> = [
      [{ lease: lease({ expiresAt: checkedAt }) }, 'live-heartbeat-expired'],
      [{
        machineEvidence: {
          checkedAt: '2026-07-27T11:58:00.000Z',
          connectorId: 'connector-a',
          machineId: 'machine-a',
          state: 'online'
        }
      }, 'live-machine-offline'],
      [{
        machineEvidence: {
          checkedAt,
          connectorId: 'connector-a',
          machineId: 'machine-a',
          state: 'offline'
        }
      }, 'live-machine-offline'],
      [{
        registrationEvidence: {
          ...registrationEvidence(lease()),
          commitSha: 'b'.repeat(40)
        }
      }, 'live-registration-mismatch'],
      [{ lease: lease({ commitSha: 'b'.repeat(40) }) }, 'live-registration-mismatch']
    ];
    for (const [overrides, reasonCode] of cases) {
      const result = resolvePullRequestTestSurfaces(input(overrides));
      const live = surface(result, 'dev-server');
      expect(live).toMatchObject({ reasonCode, state: 'stale' });
      expect(live).not.toHaveProperty('url');
      expect(surface(result, 'mobile-prototype')).toHaveProperty('state', 'available');
    }
  });

  test('exposes a healthy live link but gates feedback independently', () => {
    const healthy = resolvePullRequestTestSurfaces(input());
    expect(surface(healthy, 'dev-server')).toMatchObject({
      servedSurface: 'mobile-prototype',
      state: 'available',
      url: 'http://100.80.135.9:44419/prototype/mobile/'
    });
    expect(healthy.feedback).toEqual({
      state: 'available',
      threadId,
      verifiedAt: checkedAt
    });
    expect(healthy.liveContext).toEqual({
      branchName: 'issue-356-prototypes',
      connectorId: 'connector-a',
      heartbeatAt: '2026-07-27T11:59:30.000Z',
      leaseExpiresAt: '2026-07-27T12:00:15.000Z',
      machineId: 'machine-a',
      projectId: 'connector-a:project-space',
      servedSurface: 'mobile-prototype',
      state: 'available',
      verifiedAt: '2026-07-27T11:59:30.000Z',
      worktreeId: 'wt-356'
    });

    const unavailableTask = resolvePullRequestTestSurfaces(input({
      taskEvidence: { reason: 'unavailable', state: 'unavailable' }
    }));
    expect(surface(unavailableTask, 'dev-server')).toHaveProperty('state', 'available');
    expect(unavailableTask.feedback).toEqual({
      reasonCode: 'feedback-task-unavailable',
      state: 'stale'
    });

    const staleTask = resolvePullRequestTestSurfaces(input({
      taskEvidence: {
        ...taskEvidence(lease()),
        checkedAt: '2026-07-27T11:58:00.000Z'
      }
    }));
    expect(staleTask.feedback).toEqual({
      reasonCode: 'feedback-task-unavailable',
      state: 'stale'
    });
  });

  test('rejects a mismatched thread and an expired write capability', () => {
    const wrongThread = resolvePullRequestTestSurfaces(input({
      taskEvidence: {
        ...taskEvidence(lease()),
        threadId: '019fa483-564c-7b01-9d89-5f8ef37af7d1'
      }
    }));
    expect(wrongThread.feedback).toEqual({
      reasonCode: 'feedback-task-mismatch',
      state: 'unavailable'
    });

    const expired = resolvePullRequestTestSurfaces(input({
      taskEvidence: {
        ...taskEvidence(lease()),
        writeCapabilityExpiresAt: checkedAt
      }
    }));
    expect(expired.feedback).toEqual({
      reasonCode: 'feedback-write-capability-expired',
      state: 'stale'
    });
  });

  test('withholds stale deployed URLs and all private data from unauthorized users', () => {
    const staleDeploy = resolvePullRequestTestSurfaces(input({
      deployedSurfaces: [{
        commitSha: 'b'.repeat(40),
        kind: 'mobile-prototype',
        state: 'available',
        url: 'https://pr-356.projects.os-home.net/prototype/mobile/',
        verifiedAt: checkedAt
      }]
    }));
    expect(surface(staleDeploy, 'mobile-prototype')).toEqual({
      kind: 'mobile-prototype',
      reasonCode: 'deployment-head-mismatch',
      state: 'stale'
    });

    const unauthorized = resolvePullRequestTestSurfaces(input({
      repositoryAccess: 'unauthorized'
    }));
    expect(unauthorized.surfaces.every(
      (candidate) =>
        candidate.state === 'unavailable' &&
        candidate.reasonCode === 'repository-unauthorized' &&
        !('url' in candidate)
    )).toBe(true);
    expect(unauthorized.liveContext).toEqual({
      reasonCode: 'repository-unauthorized',
      state: 'unavailable'
    });
  });

  test('marks a closed PR unavailable even if previous evidence remains', () => {
    const result = resolvePullRequestTestSurfaces(input({
      pullRequestState: 'closed'
    }));
    expect(result.surfaces.every(
      (candidate) =>
        candidate.state === 'unavailable' &&
        candidate.reasonCode === 'pull-request-closed'
    )).toBe(true);
    expect(result.feedback).toEqual({
      reasonCode: 'feedback-not-live',
      state: 'unavailable'
    });
  });
});
