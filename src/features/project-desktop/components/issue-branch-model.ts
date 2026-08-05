import type {
  GitHubBranchRecord,
  GitHubIssueRecord,
  GitHubPullRequestRecord
} from '@/shared/project-space-api';
import { issueBranchName } from '../../../shared/issue-branch-name';

export function branchNameForIssue(issue: GitHubIssueRecord) {
  return issueBranchName(issue.number, issue.title);
}

export function issueBranchesForIssue({
  branches,
  issue
}: {
  branches: GitHubBranchRecord[];
  issue: GitHubIssueRecord;
}) {
  return branches
    .filter((branch) => branch.linkedIssueNumbers?.includes(issue.number))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function issuePullRequestsForIssue({
  issue,
  pullRequests
}: {
  issue: GitHubIssueRecord;
  pullRequests: GitHubPullRequestRecord[];
}) {
  return pullRequests
    .filter((pullRequest) => pullRequest.linkedIssueNumbers?.includes(issue.number))
    .sort((left, right) => right.number - left.number);
}
