import type {
  GitHubBranchRecord,
  GitHubIssueRecord,
  GitHubPullRequestRecord
} from '@/shared/project-space-api';

export function branchNameForIssue(issue: GitHubIssueRecord) {
  const slug = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');

  return `issue-${issue.number}${slug ? `-${slug}` : ''}`;
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
