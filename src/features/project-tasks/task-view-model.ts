import type {
  GitHubBranchRecord,
  GitHubIssueCommentRecord,
  GitHubIssueRecord,
  GitHubPullRequestRecord,
  GitHubWorkflowRunSummary
} from '@/shared/project-space-api';
import { resolveIssueDevelopmentHead } from '../project-desktop/components/issue-development-head';

export type ProjectTaskState = 'active' | 'backlog' | 'completed' | 'review';
export type ProjectTaskHealth = 'attention' | 'healthy' | 'unknown';

export interface ProjectTaskViewModel {
  branch?: GitHubBranchRecord;
  comments: GitHubIssueCommentRecord[];
  health: ProjectTaskHealth;
  issue: GitHubIssueRecord;
  pipeline?: GitHubWorkflowRunSummary;
  pullRequest?: GitHubPullRequestRecord;
  state: ProjectTaskState;
  workflowMessage?: string;
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
  if (pullRequest?.state === 'merged') {
    return issue.state === 'closed' ? 'completed' : 'review';
  }
  if (pullRequest?.state === 'open' && pullRequest.isDraft === true) return 'active';
  if (pullRequest?.state === 'open' && pullRequest.isDraft === false) return 'review';
  return 'backlog';
}

export function projectTaskWorkflowMessage(
  issue: GitHubIssueRecord,
  branch?: GitHubBranchRecord,
  pullRequest?: GitHubPullRequestRecord
) {
  if (pullRequest?.state === 'merged' && issue.state !== 'closed') {
    return 'The pull request is merged, but the issue is still open.';
  }
  if (issue.state === 'closed' && pullRequest?.state !== 'merged') {
    return 'The issue is closed without a verified merged pull request.';
  }
  if (pullRequest?.state === 'open' && pullRequest.isDraft === undefined) {
    return 'The pull request draft state could not be verified.';
  }
  if (branch && !pullRequest) {
    return 'The linked branch is waiting for its draft pull request.';
  }
  return undefined;
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
  repositoryFullName,
  runs = []
}: {
  branches: GitHubBranchRecord[];
  commentsByIssue?: ReadonlyMap<number, GitHubIssueCommentRecord[]>;
  issues: GitHubIssueRecord[];
  pullRequests: GitHubPullRequestRecord[];
  repositoryFullName?: string;
  runs?: GitHubWorkflowRunSummary[];
}): ProjectTaskViewModel[] {
  return issues.map((issue) => {
    const pullRequest = linkedPullRequest(issue, pullRequests);
    const developmentHead = resolveIssueDevelopmentHead({
      branches,
      issue,
      pullRequests,
      repositoryFullName
    });
    const branch = developmentHead.state === 'verified'
      ? developmentHead.branch
      : linkedBranch(issue, pullRequest, branches);
    const pipeline = projectTaskPipeline(pullRequest, runs);
    const state = pullRequest?.state === 'merged'
      ? projectTaskState(issue, pullRequest)
      : developmentHead.state === 'verified' && developmentHead.pullRequest
        ? projectTaskState(issue, developmentHead.pullRequest)
        : 'backlog';
    const workflowMessage = developmentHead.state !== 'verified' && developmentHead.state !== 'none'
      ? developmentHead.message
      : projectTaskWorkflowMessage(issue, branch, pullRequest);
    return {
      branch,
      comments: commentsByIssue.get(issue.number) ?? [],
      health: projectTaskHealth(pipeline),
      issue,
      pipeline,
      pullRequest,
      state,
      workflowMessage
    };
  });
}
