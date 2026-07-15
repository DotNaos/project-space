import { describe, expect, test } from 'bun:test';
import { resolveDelivery, resolveIssue } from '../../src/features/project-topology/project-topology-evidence';
import {
  checkedAt,
  repositoryDetails,
  session
} from './project-topology-test-fixtures';

describe('project topology issue and delivery truth', () => {
  test('accepts a title issue only when a multi-issue branch explicitly links it', () => {
    const details = repositoryDetails('issue-177-and-191');
    const branches = [{
      ...details.branches[0]!,
      linkedIssueNumbers: [177, 191]
    }];
    const issues = [
      ...details.issues,
      {
        ...details.issues[0]!,
        number: 191,
        title: 'Connector recovery'
      },
      {
        ...details.issues[0]!,
        number: 999,
        title: 'Unrelated title issue'
      }
    ];

    expect(resolveIssue(branches, issues, 'issue-177-and-191', '#191 · Real task')?.number)
      .toBe(191);
    expect(resolveIssue(branches, issues, 'issue-177-and-191', '#999 · Unrelated task'))
      .toBeUndefined();
    expect(resolveIssue(branches, issues, 'issue-177-and-191', '#189 · Missing task'))
      .toBeUndefined();
  });

  test('rejects malformed commit identities before merge or deployment claims', () => {
    const branchName = 'issue-177';
    const headSha = 'a'.repeat(40);
    const mergeSha = 'b'.repeat(40);
    const candidate = {
      ...session('machine-a', 'thread-a', '/worktrees/project-space/issue-177'),
      lastActivityAt: '2026-07-13T23:59:00.000Z'
    };
    const pullRequest = {
      headBranch: branchName,
      linkedIssueNumbers: [177],
      mergeCommitHash: mergeSha,
      number: 201,
      state: 'merged' as const,
      title: 'Implement topology command center',
      url: 'https://github.com/DotNaos/project-space/pull/201'
    };
    const evidence = {
      delivery: {
        branchName,
        headSha,
        mergeCommitHash: mergeSha,
        observedAt: '2026-07-13T23:59:30.000Z',
        pullRequestNumber: 201,
        sessionLastActivityAt: candidate.lastActivityAt,
        source: 'github-pull-request' as const
      },
      machineId: candidate.machineId,
      threadId: candidate.id
    };
    const malformedDeployment = {
      checkedAt,
      data: {
        checkedAt,
        environments: [{
          deployedSha: 'not-a-commit',
          displayName: 'Production',
          id: 'prod',
          liveUrlState: 'available' as const,
          verification: 'healthy' as const
        }],
        repositoryFullName: 'DotNaos/project-space',
        status: 'available' as const
      },
      state: 'ready' as const
    };

    expect(resolveDelivery(
      [pullRequest],
      undefined,
      'DotNaos/project-space',
      branchName,
      'short-sha',
      candidate,
      { ...evidence, delivery: { ...evidence.delivery, headSha: 'short-sha' } },
      checkedAt
    )).toBe('unknown');
    expect(resolveDelivery(
      [],
      undefined,
      'DotNaos/project-space',
      branchName,
      'short-sha',
      candidate,
      {
        machineId: candidate.machineId,
        threadId: candidate.id,
        verification: {
          headSha: 'short-sha',
          sessionLastActivityAt: candidate.lastActivityAt,
          verifiedAt: '2026-07-13T23:59:30.000Z'
        }
      },
      checkedAt
    )).toBe('unknown');
    expect(resolveDelivery(
      [pullRequest],
      undefined,
      'DotNaos/project-space',
      branchName,
      headSha,
      candidate,
      { ...evidence, delivery: { ...evidence.delivery, mergeCommitHash: 'short-sha' } },
      checkedAt
    )).toBe('unknown');
    expect(resolveDelivery(
      [pullRequest],
      malformedDeployment,
      'DotNaos/project-space',
      branchName,
      headSha,
      candidate,
      evidence,
      checkedAt
    )).toBe('merged');
    for (const verifiedAt of ['not-a-timestamp', '2099-01-01T00:00:00.000Z']) {
      expect(resolveDelivery(
        [pullRequest],
        {
          ...malformedDeployment,
          data: {
            ...malformedDeployment.data,
            environments: [{
              ...malformedDeployment.data.environments[0]!,
              deployedSha: mergeSha,
              verifiedAt
            }]
          }
        },
        'DotNaos/project-space',
        branchName,
        headSha,
        candidate,
        evidence,
        checkedAt
      )).toBe('merged');
    }
  });

  test('does not call an active task deployed from a coincidental checkout SHA', () => {
    const headSha = 'd'.repeat(40);
    const candidate = {
      ...session('machine-a', 'thread-active', '/projects/project-space', 'active'),
      lastActivityAt: '2026-07-13T23:59:00.000Z'
    };
    const deployment = {
      checkedAt,
      data: {
        checkedAt,
        environments: [{
          deployedSha: headSha,
          displayName: 'Production',
          id: 'prod',
          liveUrlState: 'available' as const,
          verification: 'healthy' as const
        }],
        repositoryFullName: 'DotNaos/project-space',
        status: 'available' as const
      },
      state: 'ready' as const
    };

    expect(resolveDelivery(
      [],
      deployment,
      'DotNaos/project-space',
      'issue-177',
      headSha,
      candidate,
      undefined,
      checkedAt
    )).toBe('unknown');
  });
});
