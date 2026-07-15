import { describe, expect, test } from 'bun:test';
import { resolveDelivery, resolveIssue } from '../../src/features/project-topology/project-topology-evidence';
import { buildProjectTopology } from '../../src/features/project-topology/project-topology-model';
import {
  checkedAt,
  inventory,
  machine,
  project,
  repositoryDetails,
  session,
  snapshot,
  worktrees
} from './project-topology-test-fixtures';

describe('project topology case-sensitive branch truth', () => {
  test('does not attach an issue from a case-distinct branch', () => {
    const details = repositoryDetails('feature/issue-177');

    expect(resolveIssue(
      details.branches,
      details.issues,
      'Feature/Issue-177',
      'Task without issue number'
    )).toBeUndefined();
  });

  test('does not claim merged from case-distinct delivery evidence', () => {
    const candidate = {
      ...session('machine-a', 'thread-case-merge', '/worktrees/issue-177'),
      lastActivityAt: '2026-07-13T23:59:00.000Z'
    };
    const headSha = 'a'.repeat(40);
    const mergeSha = 'b'.repeat(40);

    expect(resolveDelivery(
      [{
        headBranch: 'feature/issue-177',
        linkedIssueNumbers: [177],
        mergeCommitHash: mergeSha,
        number: 201,
        state: 'merged',
        title: 'Case-distinct PR',
        url: 'https://github.com/DotNaos/project-space/pull/201'
      }],
      undefined,
      'DotNaos/project-space',
      'Feature/Issue-177',
      headSha,
      candidate,
      {
        delivery: {
          branchName: 'feature/issue-177',
          headSha,
          mergeCommitHash: mergeSha,
          observedAt: '2026-07-13T23:59:30.000Z',
          pullRequestNumber: 201,
          sessionLastActivityAt: candidate.lastActivityAt,
          source: 'github-pull-request'
        },
        machineId: candidate.machineId,
        threadId: candidate.id
      },
      checkedAt
    )).toBe('unknown');
  });

  test('does not call case-distinct machine checkouts synchronized', () => {
    const result = snapshot(buildProjectTopology(inventory({
      machines: [machine('machine-a'), machine('machine-b')],
      projects: [
        project('project-a', 'machine-a', '/a/project-space'),
        project('project-b', 'machine-b', '/b/project-space')
      ],
      worktreesByProject: {
        'project-a': worktrees('/a/project-space', [{
          branchName: 'Feature/Issue-177',
          headSha: 'a'.repeat(40),
          id: 'wt_caseaaaaaaaaaaaaaaaaaaaa',
          isBase: true,
          path: '/a/project-space'
        }]),
        'project-b': worktrees('/b/project-space', [{
          branchName: 'feature/issue-177',
          headSha: 'a'.repeat(40),
          id: 'wt_casebbbbbbbbbbbbbbbbbbbb',
          isBase: true,
          path: '/b/project-space'
        }])
      }
    })));

    expect(result.projects[0]!.multiMachineState).toBe('ambiguous');
  });
});
