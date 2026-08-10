import { describe, expect, test } from 'bun:test';
import type {
  GitHubBranchRecord,
  GitHubIssueRecord,
  GitHubPullRequestRecord
} from '../src/shared/project-space-api';
import {
  canChooseIssueCodingDestination,
  issueDevelopmentTaskProbeBranch,
  resolveIssueDevelopmentHead
} from '../src/features/project-desktop/components/issue-development-head';

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

function branches(...values: GitHubBranchRecord[]) {
  return [{ commitSha: 'f'.repeat(40), isDefault: true, name: 'main' }, ...values];
}

function pullRequest(
  number = 500,
  overrides: Partial<GitHubPullRequestRecord> = {}
): GitHubPullRequestRecord {
  return {
    baseBranch: 'main',
    headBranch: 'issue-408-graph',
    headRefPresent: true,
    headRepositoryFullName: repositoryFullName,
    headSha,
    isCrossRepository: false,
    isDraft: true,
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
      branches: branches(),
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

  test('falls back to one verified linked branch when no open PR exists', () => {
    const issue473 = { ...issue, number: 473 };
    const issue473Head = 'e'.repeat(40);
    const result = resolveIssueDevelopmentHead({
      branches: branches({
        commitSha: issue473Head,
        isDefault: false,
        linkedIssueNumbers: [473],
        name: 'issue-473-release-tag-queue-no-conflicts'
      }),
      issue: issue473,
      pullRequests: [],
      repositoryFullName
    });

    expect(result).toMatchObject({
      branch: {
        commitSha: issue473Head,
        name: 'issue-473-release-tag-queue-no-conflicts'
      },
      expectedHeadSha: issue473Head,
      source: 'linked-branch',
      state: 'verified'
    });
  });

  test('blocks ambiguous branch and pull request linkage', () => {
    expect(resolveIssueDevelopmentHead({
      branches: branches(),
      issue,
      pullRequests: [pullRequest(500), pullRequest(501)],
      repositoryFullName
    }).state).toBe('ambiguous');

    expect(resolveIssueDevelopmentHead({
      branches: branches(branch(), branch('another-408-branch', 'b'.repeat(40))),
      issue,
      pullRequests: [],
      repositoryFullName
    }).state).toBe('ambiguous');

    expect(resolveIssueDevelopmentHead({
      branches: branches(branch('conflicting-branch')),
      issue,
      pullRequests: [pullRequest()],
      repositoryFullName
    }).state).toBe('ambiguous');

    expect(resolveIssueDevelopmentHead({
      branches: branches(branch('Issue-408-Graph')),
      issue,
      pullRequests: [pullRequest()],
      repositoryFullName
    }).state).toBe('ambiguous');
  });

  test('prefers the verified PR snapshot when the same branch SHA is briefly skewed', () => {
    const result = resolveIssueDevelopmentHead({
      branches: branches(branch('issue-408-graph', 'b'.repeat(40))),
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
      branches: branches(),
      issue,
      pullRequests: [pullRequest(500, { headRefPresent: false })],
      repositoryFullName
    }).state).toBe('deleted');

    expect(resolveIssueDevelopmentHead({
      branches: branches(),
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
      branches: branches(branch('issue-408-graph', '')),
      issue,
      pullRequests: [],
      repositoryFullName
    }).state).toBe('unavailable');
  });

  test('fails closed when PR provenance metadata is incomplete', () => {
    expect(resolveIssueDevelopmentHead({
      branches: branches(),
      issue,
      pullRequests: [pullRequest(500, {
        headRefPresent: undefined,
        headRepositoryFullName: undefined,
        isCrossRepository: undefined
      })],
      repositoryFullName
    }).state).toBe('unavailable');
  });

  test('unlocks coding destinations for a verified branch with or without a pull request', () => {
    const ready = resolveIssueDevelopmentHead({
      branches: branches(),
      issue,
      pullRequests: [pullRequest()],
      repositoryFullName
    });
    const unknownDraft = resolveIssueDevelopmentHead({
      branches: branches(),
      issue,
      pullRequests: [pullRequest(500, { isDraft: undefined })],
      repositoryFullName
    });
    const branchOnly = resolveIssueDevelopmentHead({
      branches: branches(branch()),
      issue,
      pullRequests: [],
      repositoryFullName
    });

    expect(canChooseIssueCodingDestination(ready)).toBe(true);
    expect(canChooseIssueCodingDestination(branchOnly)).toBe(true);
    expect(canChooseIssueCodingDestination(unknownDraft)).toBe(false);
    expect(canChooseIssueCodingDestination({ state: 'none' })).toBe(false);
  });

  test('keeps the historical PR head available for read-only task discovery', () => {
    const merged = pullRequest(500, {
      headRefPresent: false,
      state: 'merged'
    });

    expect(issueDevelopmentTaskProbeBranch(undefined, merged)).toBe('issue-408-graph');
    expect(issueDevelopmentTaskProbeBranch(branch('refs/heads/current-work'), merged))
      .toBe('current-work');
  });
});
