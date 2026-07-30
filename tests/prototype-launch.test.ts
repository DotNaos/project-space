import { describe, expect, test } from 'bun:test';

import {
  buildPrototypeReviewHref,
  parsePrototypeLaunchRouteIdentity,
  prototypeIdentityLinks,
  prototypeLaunchStatus,
  type PrototypeLaunchIdentity
} from '../src/shared/prototype-launch';
import type { PullRequestTestSurfacesResult } from '../src/shared/pr-preview-test-surfaces-api';

const headSha = 'a'.repeat(40);
const identity: PrototypeLaunchIdentity = {
  branchName: 'issue-381-prototype-launch',
  connectorId: 'connector-os-mac',
  headSha,
  issueNumber: 381,
  machineId: 'os-mac',
  projectId: 'project-space',
  pullRequestNumber: 382,
  repositoryFullName: 'DotNaos/project-space',
  surface: 'desktop-prototype',
  threadId: '019fae8d-1eae-7282-9278-b57771a9c877',
  worktreeId: 'issue-381'
};

function result(
  surface: PullRequestTestSurfacesResult['surfaces'][number]
): PullRequestTestSurfacesResult {
  return {
    checkedAt: '2026-07-29T10:00:00.000Z',
    feedback: { reasonCode: 'feedback-not-live', state: 'unavailable' },
    headSha,
    liveContext: {
      reasonCode: 'live-registration-missing',
      state: 'unavailable'
    },
    pullRequestNumber: 382,
    repositoryFullName: 'DotNaos/project-space',
    surfaces: [surface]
  };
}

describe('prototype launch contract', () => {
  test('round-trips the complete issue, PR, task, worktree, machine, and head identity', () => {
    const href = buildPrototypeReviewHref(identity);
    expect(parsePrototypeLaunchRouteIdentity(new URL(href, 'https://example.test').search))
      .toEqual(identity);
  });

  test('builds direct navigation without inventing missing identities', () => {
    expect(prototypeIdentityLinks(identity)).toEqual({
      issue: '/projects/project-space/issues/381',
      machine: '/machines/os-mac',
      pullRequest: 'https://github.com/DotNaos/project-space/pull/382',
      task: '/codex/machines/connector-os-mac/threads/019fae8d-1eae-7282-9278-b57771a9c877',
      worktree: '/projects/project-space/workspaces?worktree=issue-381'
    });
    expect(prototypeIdentityLinks({ ...identity, connectorId: undefined })).toMatchObject({
      machine: '/machines/os-mac',
      task: undefined
    });
    expect(prototypeIdentityLinks({ ...identity, machineId: undefined })).toMatchObject({
      machine: undefined,
      task: '/codex/machines/connector-os-mac/threads/019fae8d-1eae-7282-9278-b57771a9c877'
    });
    expect(prototypeIdentityLinks({ repositoryFullName: 'DotNaos/project-space' }))
      .toEqual({
        issue: undefined,
        machine: undefined,
        pullRequest: undefined,
        task: undefined,
        worktree: undefined
      });
  });

  test('preserves every visible lifecycle state', () => {
    expect(prototypeLaunchStatus({}).state).toBe('not-started');
    expect(prototypeLaunchStatus({ identity, isLoading: true }).state).toBe('starting');
    expect(prototypeLaunchStatus({
      identity,
      result: result({
        commitSha: headSha,
        kind: 'desktop-prototype',
        source: 'deployed',
        state: 'available',
        url: 'https://preview.example.test',
        verifiedAt: '2026-07-29T10:00:00.000Z'
      })
    }).state).toBe('ready');
    expect(prototypeLaunchStatus({
      identity,
      result: { ...result({ kind: 'desktop-prototype', reasonCode: 'deployment-pending', state: 'pending' }), headSha: 'b'.repeat(40) }
    }).state).toBe('stale');
    expect(prototypeLaunchStatus({
      identity,
      result: result({
        kind: 'desktop-prototype',
        reasonCode: 'deployment-unavailable',
        state: 'unavailable'
      })
    }).state).toBe('unavailable');
    expect(prototypeLaunchStatus({
      identity,
      result: result({
        kind: 'desktop-prototype',
        reasonCode: 'live-server-stopped',
        state: 'unavailable'
      })
    }).state).toBe('stopped');
  });

  test('rejects malformed identity fields at the review boundary', () => {
    expect(parsePrototypeLaunchRouteIdentity(
      '?repository=not-a-repo&pr=-1&issue=zero&head=xyz&project='
    )).toEqual({
      branchName: undefined,
      connectorId: undefined,
      headSha: undefined,
      issueNumber: undefined,
      machineId: undefined,
      projectId: undefined,
      pullRequestNumber: undefined,
      repositoryFullName: undefined,
      surface: undefined,
      threadId: undefined,
      worktreeId: undefined
    });
    expect(parsePrototypeLaunchRouteIdentity(
      '?repository=DotNaos/project-space%3Ftab%3Dsettings&pr=382'
    ).repositoryFullName).toBeUndefined();
  });
});
