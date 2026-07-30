import { describe, expect, test } from 'bun:test';
import type {
  GitHubBranchRecord,
  GitHubIssueRecord,
  GitHubPullRequestRecord
} from '../src/shared/project-space-api';
import { resolveIssueDevelopmentHead } from '../src/features/project-desktop/components/issue-development-head';

const issue: GitHubIssueRecord = {
  labels: [],
  number: 408,
  state: 'open',
  title: 'Show branch position',
  url: 'https://github.com/DotNaos/project-space/issues/408'
};
const repositoryFullName = 'DotNaos/project-space';
const headSha = 'a'.repeat(40);

function branch(name = 'issue-408-graph', sha = headSha): GitHubBranchRecord {
  return {
    commitSha: sha,
    isDefault: false,
    linkedIssueNumbers: [408],
    name
  };
}

function pullRequest(
  number = 500,
  overrides: Partial<GitHubPullRequestRecord> = {}
): GitHubPullRequestRecord {
  return {
    headBranch: 'issue-408-graph',
    headRefPresent: true,
    headRepositoryFullName: repositoryFullName,
    headSha,
    isCrossRepository: false,
    linkedIssueNumbers: [408],
    number,
    state: 'open',
    title: 'Show branch position',
    url: `https://github.com/DotNaos/project-space/pull/${number}`,
    ...overrides
  };
}

describe('issue development head resolution', () => {
  test('uses the verified open pull request head as the single identity', () => {
    const result = resolveIssueDevelopmentHead({
      branches: [],
      issue,
      pullRequests: [pullRequest()],
      repositoryFullName
    });

    expect(result).toMatchObject({
      branch: { commitSha: headSha, name: 'issue-408-graph' },
      expectedHeadSha: headSha,
      source: 'pull-request',
      state: 'verified'
    });
  });

  test('falls back to one verified linked branch when no PR exists', () => {
    const result = resolveIssueDevelopmentHead({
      branches: [branch()],
      issue,
      pullRequests: [],
      repositoryFullName
    });

    expect(result).toMatchObject({
      branch: { commitSha: headSha, name: 'issue-408-graph' },
      source: 'linked-branch',
      state: 'verified'
    });
  });

  test('shows the exact existing branch from merged PR #396 for issue #394', () => {
    const historicalIssue: GitHubIssueRecord = {
      labels: [],
      number: 394,
      state: 'closed',
      title: 'List and open every PR prototype from the changelog',
      url: 'https://github.com/DotNaos/project-space/issues/394'
    };
    const historicalBranch =
      'issue-394-list-and-open-every-pr-prototype-from-the-changelog';
    const result = resolveIssueDevelopmentHead({
      branches: [],
      issue: historicalIssue,
      pullRequests: [pullRequest(396, {
        headBranch: historicalBranch,
        linkedIssueNumbers: [394],
        state: 'merged'
      })],
      repositoryFullName
    });

    expect(result).toMatchObject({
      branch: { name: historicalBranch },
      pullRequest: { number: 396, state: 'merged' },
      source: 'pull-request',
      state: 'verified'
    });
  });

  test('uses an explicit branch to reconcile historical PRs, then the newest merged PR', () => {
    const older = pullRequest(498, {
      headBranch: 'older-branch',
      state: 'merged'
    });
    const newer = pullRequest(499, {
      headBranch: 'newer-branch',
      state: 'merged'
    });

    expect(resolveIssueDevelopmentHead({
      branches: [branch('older-branch')],
      issue,
      pullRequests: [newer, older],
      repositoryFullName
    })).toMatchObject({
      branch: { name: 'older-branch' },
      pullRequest: { number: 498 },
      state: 'verified'
    });

    expect(resolveIssueDevelopmentHead({
      branches: [],
      issue,
      pullRequests: [older, newer],
      repositoryFullName
    })).toMatchObject({
      branch: { name: 'newer-branch' },
      pullRequest: { number: 499 },
      state: 'verified'
    });
  });

  test('keeps an explicit follow-up branch when historical PRs use another branch', () => {
    const result = resolveIssueDevelopmentHead({
      branches: [branch('issue-408-follow-up')],
      issue,
      pullRequests: [pullRequest(499, {
        headBranch: 'issue-408-original',
        state: 'merged'
      })],
      repositoryFullName
    });

    expect(result).toMatchObject({
      branch: { name: 'issue-408-follow-up' },
      source: 'linked-branch',
      state: 'verified'
    });
    expect(result).not.toHaveProperty('pullRequest');
  });

  test('blocks ambiguous branch and pull request linkage', () => {
    expect(resolveIssueDevelopmentHead({
      branches: [],
      issue,
      pullRequests: [pullRequest(500), pullRequest(501)],
      repositoryFullName
    }).state).toBe('ambiguous');

    expect(resolveIssueDevelopmentHead({
      branches: [branch(), branch('another-408-branch', 'b'.repeat(40))],
      issue,
      pullRequests: [],
      repositoryFullName
    }).state).toBe('ambiguous');

    expect(resolveIssueDevelopmentHead({
      branches: [branch('conflicting-branch')],
      issue,
      pullRequests: [pullRequest()],
      repositoryFullName
    }).state).toBe('ambiguous');

    expect(resolveIssueDevelopmentHead({
      branches: [branch('Issue-408-Graph')],
      issue,
      pullRequests: [pullRequest()],
      repositoryFullName
    }).state).toBe('ambiguous');
  });

  test('prefers the verified PR snapshot when the same branch SHA is briefly skewed', () => {
    const result = resolveIssueDevelopmentHead({
      branches: [branch('issue-408-graph', 'b'.repeat(40))],
      issue,
      pullRequests: [pullRequest()],
      repositoryFullName
    });

    expect(result).toMatchObject({
      expectedHeadSha: headSha,
      source: 'pull-request',
      state: 'verified'
    });
  });

  test('reports deleted and forked PR heads without guessing', () => {
    expect(resolveIssueDevelopmentHead({
      branches: [],
      issue,
      pullRequests: [pullRequest(500, { headRefPresent: false })],
      repositoryFullName
    }).state).toBe('deleted');

    expect(resolveIssueDevelopmentHead({
      branches: [],
      issue,
      pullRequests: [pullRequest(500, {
        headRepositoryFullName: 'someone/project-space',
        isCrossRepository: true
      })],
      repositoryFullName
    }).state).toBe('forked');
  });

  test('requires an exact SHA for a branch-only resolution', () => {
    expect(resolveIssueDevelopmentHead({
      branches: [branch('issue-408-graph', '')],
      issue,
      pullRequests: [],
      repositoryFullName
    }).state).toBe('unavailable');
  });

  test('fails closed when PR provenance metadata is incomplete', () => {
    expect(resolveIssueDevelopmentHead({
      branches: [],
      issue,
      pullRequests: [pullRequest(500, {
        headRefPresent: undefined,
        headRepositoryFullName: undefined,
        isCrossRepository: undefined
      })],
      repositoryFullName
    }).state).toBe('unavailable');
  });
});
