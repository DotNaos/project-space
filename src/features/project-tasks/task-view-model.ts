import type {
  GitHubBranchRecord,
  GitHubIssueCommentRecord,
  GitHubIssueRecord,
  GitHubPullRequestRecord,
  GitHubWorkflowRunSummary
} from '@/shared/project-space-api';

export type ProjectTaskState = 'backlog' | 'done' | 'in-progress' | 'started';
export type ProjectTaskHealth = 'attention' | 'healthy' | 'unknown';

export interface ProjectTaskViewModel {
  branch?: GitHubBranchRecord;
  comments: GitHubIssueCommentRecord[];
  health: ProjectTaskHealth;
  issue: GitHubIssueRecord;
  pipeline?: GitHubWorkflowRunSummary;
  pullRequest?: GitHubPullRequestRecord;
  state: ProjectTaskState;
}

function linkedPullRequest(
  issue: GitHubIssueRecord,
  pullRequests: GitHubPullRequestRecord[]
) {
  return pullRequests
    .filter((pullRequest) => pullRequest.linkedIssueNumbers?.includes(issue.number))
    .sort((left, right) => {
      const rank = (state: GitHubPullRequestRecord['state']) => (
        state === 'open' ? 3 : state === 'merged' ? 2 : 1
      );
      return rank(right.state) - rank(left.state)
        || Date.parse(right.updatedAt ?? '') - Date.parse(left.updatedAt ?? '');
    })[0];
}

function linkedBranch(
  issue: GitHubIssueRecord,
  pullRequest: GitHubPullRequestRecord | undefined,
  branches: GitHubBranchRecord[]
) {
  if (pullRequest?.headBranch) {
    const pullRequestBranch = branches.find((branch) => branch.name === pullRequest.headBranch);
    if (pullRequestBranch) return pullRequestBranch;
  }

  return branches.find((branch) => branch.linkedIssueNumbers?.includes(issue.number));
}

export function projectTaskState(
  issue: GitHubIssueRecord,
  pullRequest?: GitHubPullRequestRecord
): ProjectTaskState {
  if (pullRequest?.state === 'merged') return 'done';
  if (pullRequest?.state === 'open') return pullRequest.isDraft ? 'started' : 'in-progress';
  if (issue.state === 'closed') return 'done';
  return 'backlog';
}

export function projectTaskHealth(pipeline?: GitHubWorkflowRunSummary): ProjectTaskHealth {
  if (!pipeline) return 'unknown';
  if (pipeline.status !== 'completed') return 'unknown';
  return pipeline.conclusion === 'success' || pipeline.conclusion === 'neutral'
    ? 'healthy'
    : 'attention';
}

export function projectTaskPipeline(
  pullRequest: GitHubPullRequestRecord | undefined,
  runs: GitHubWorkflowRunSummary[]
) {
  if (!pullRequest) return undefined;
  if (pullRequest.headSha) {
    return runs.find((run) => run.headSha === pullRequest.headSha);
  }
  return runs.find((run) => (
    Boolean(pullRequest.headBranch) && run.branch === pullRequest.headBranch
  ));
}

export function createProjectTaskViewModels({
  branches,
  commentsByIssue = new Map(),
  issues,
  pullRequests,
  runs = []
}: {
  branches: GitHubBranchRecord[];
  commentsByIssue?: ReadonlyMap<number, GitHubIssueCommentRecord[]>;
  issues: GitHubIssueRecord[];
  pullRequests: GitHubPullRequestRecord[];
  runs?: GitHubWorkflowRunSummary[];
}): ProjectTaskViewModel[] {
  return issues.map((issue) => {
    const pullRequest = linkedPullRequest(issue, pullRequests);
    const pipeline = projectTaskPipeline(pullRequest, runs);
    return {
      branch: linkedBranch(issue, pullRequest, branches),
      comments: commentsByIssue.get(issue.number) ?? [],
      health: projectTaskHealth(pipeline),
      issue,
      pipeline,
      pullRequest,
      state: projectTaskState(issue, pullRequest)
    };
  });
}
