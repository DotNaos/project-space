import type {
  GitHubBranchRecord,
  GitHubPullRequestRecord,
  ProjectWorktreeRecord
} from '@/shared/project-space-api';

export type RepositoryBranchFilter = 'all' | 'checked-out' | 'pull-request' | 'attention';

export interface RepositoryBranchViewModel {
  branch: GitHubBranchRecord;
  pullRequest?: GitHubPullRequestRecord;
  worktrees: ProjectWorktreeRecord[];
}

function normalizeBranchName(value: string | undefined) {
  return value?.trim().replace(/^refs\/heads\//, '').toLowerCase() ?? '';
}

function pullRequestPriority(pullRequest: GitHubPullRequestRecord) {
  if (pullRequest.state === 'open') return pullRequest.isDraft ? 2 : 3;
  if (pullRequest.state === 'merged') return 1;
  return 0;
}

export function repositoryBranchViewModels({
  branches,
  pullRequests,
  worktrees
}: {
  branches: GitHubBranchRecord[];
  pullRequests: GitHubPullRequestRecord[];
  worktrees: ProjectWorktreeRecord[];
}): RepositoryBranchViewModel[] {
  return branches.map((branch) => {
    const branchName = normalizeBranchName(branch.name);
    const matchingPullRequests = pullRequests
      .filter((pullRequest) => normalizeBranchName(pullRequest.headBranch) === branchName)
      .sort((left, right) => pullRequestPriority(right) - pullRequestPriority(left));

    return {
      branch,
      pullRequest: matchingPullRequests[0],
      worktrees: worktrees.filter(
        (worktree) => normalizeBranchName(worktree.branchName) === branchName
      )
    };
  });
}

export function filterRepositoryBranches({
  branches,
  filter,
  query
}: {
  branches: RepositoryBranchViewModel[];
  filter: RepositoryBranchFilter;
  query: string;
}) {
  const normalizedQuery = query.trim().toLowerCase();

  return branches.filter((entry) => {
    const matchesFilter =
      filter === 'all' ||
      (filter === 'checked-out' && entry.worktrees.length > 0) ||
      (filter === 'pull-request' && Boolean(entry.pullRequest)) ||
      (filter === 'attention' && Boolean(entry.pullRequest?.isDraft));
    const searchable = [
      entry.branch.name,
      entry.branch.commitSha,
      entry.pullRequest?.number,
      entry.pullRequest?.title,
      ...entry.worktrees.map((worktree) => worktree.path)
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return matchesFilter && searchable.includes(normalizedQuery);
  });
}
