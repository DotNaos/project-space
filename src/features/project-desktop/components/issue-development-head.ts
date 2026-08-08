import type {
  GitHubBranchRecord,
  GitHubIssueRecord,
  GitHubPullRequestRecord
} from '@/shared/project-space-api';
import {
  issueBranchesForIssue
} from './issue-branch-model';

const fullSha = /^[0-9a-f]{40}$/i;

function normalizeBranch(value?: string) {
  return value?.trim().replace(/^refs\/heads\//, '') ?? '';
}

function sameBranch(left?: string, right?: string) {
  return Boolean(normalizeBranch(left) && normalizeBranch(left) === normalizeBranch(right));
}

function pullRequestMatchesIssue(
  pullRequest: GitHubPullRequestRecord,
  issue: GitHubIssueRecord,
  linkedBranches: GitHubBranchRecord[]
) {
  return Boolean(
    pullRequest.linkedIssueNumbers?.includes(issue.number) ||
    linkedBranches.some((branch) => sameBranch(branch.name, pullRequest.headBranch))
  );
}

export type IssueDevelopmentHeadResolution =
  | {
      branch: GitHubBranchRecord;
      expectedHeadSha?: string;
      pullRequest?: GitHubPullRequestRecord;
      source: 'pull-request' | 'linked-branch';
      state: 'verified';
    }
  | {
      message: string;
      state: 'ambiguous' | 'deleted' | 'forked' | 'unavailable';
    }
  | {
      state: 'none';
    };

export function canChooseIssueCodingDestination(
  resolution: IssueDevelopmentHeadResolution
) {
  return resolution.state === 'verified';
}

export function resolveIssueDevelopmentHead(input: {
  branches: GitHubBranchRecord[];
  issue: GitHubIssueRecord;
  pullRequests: GitHubPullRequestRecord[];
  repositoryFullName?: string;
}): IssueDevelopmentHeadResolution {
  const linkedBranches = issueBranchesForIssue(input);
  const defaultBranch = input.branches.find((branch) => branch.isDefault)?.name;
  const openPullRequests = input.pullRequests
    .filter((pullRequest) => pullRequest.state === 'open')
    .filter((pullRequest) => pullRequestMatchesIssue(pullRequest, input.issue, linkedBranches));

  if (openPullRequests.length > 1) {
    return {
      message: 'Multiple open pull requests are linked. Branch position is ambiguous.',
      state: 'ambiguous'
    };
  }

  const pullRequest = openPullRequests[0];
  if (pullRequest) {
    if (
      pullRequest.isCrossRepository ||
      (
        pullRequest.headRepositoryFullName &&
        input.repositoryFullName &&
        pullRequest.headRepositoryFullName.toLowerCase() !== input.repositoryFullName.toLowerCase()
      )
    ) {
      return {
        message: 'The pull request head belongs to a fork. Branch position is unavailable here.',
        state: 'forked'
      };
    }
    if (
      pullRequest.headRefPresent === false
    ) {
      return {
        message: 'The pull request head branch no longer exists.',
        state: 'deleted'
      };
    }
    if (
      pullRequest.headRefPresent !== true ||
      pullRequest.isCrossRepository !== false ||
      !pullRequest.headRepositoryFullName ||
      !input.repositoryFullName
    ) {
      return {
        message: 'The pull request head repository could not be verified.',
        state: 'unavailable'
      };
    }
    if (
      !pullRequest.headBranch ||
      !pullRequest.headSha ||
      !fullSha.test(pullRequest.headSha)
    ) {
      return {
        message: 'The pull request head branch could not be verified.',
        state: 'unavailable'
      };
    }
    if (typeof pullRequest.isDraft !== 'boolean') {
      return {
        message: 'The pull request draft state could not be verified.',
        state: 'unavailable'
      };
    }
    if (!defaultBranch || pullRequest.baseBranch !== defaultBranch) {
      return {
        message: 'The pull request does not target the repository default branch.',
        state: 'unavailable'
      };
    }
    if (
      linkedBranches.length > 1 ||
      (
        linkedBranches.length === 1 &&
        !sameBranch(linkedBranches[0]?.name, pullRequest.headBranch)
      )
    ) {
      return {
        message: 'The linked branch conflicts with the open pull request head.',
        state: 'ambiguous'
      };
    }

    return {
      branch: {
        commitSha: pullRequest.headSha,
        isDefault: false,
        linkedIssueNumbers: [input.issue.number],
        name: pullRequest.headBranch
      },
      expectedHeadSha: pullRequest.headSha,
      pullRequest,
      source: 'pull-request',
      state: 'verified'
    };
  }

  if (linkedBranches.length > 1) {
    return {
      message: 'Multiple branches are linked. Branch position is ambiguous.',
      state: 'ambiguous'
    };
  }

  const branch = linkedBranches[0];
  if (!branch) {
    return { state: 'none' };
  }
  if (!branch.commitSha || !fullSha.test(branch.commitSha)) {
    return {
      message: 'The linked branch could not be verified on GitHub.',
      state: 'unavailable'
    };
  }

  return {
    branch,
    expectedHeadSha: branch.commitSha,
    source: 'linked-branch',
    state: 'verified'
  };
}
