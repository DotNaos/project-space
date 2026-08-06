import type { ProjectSpaceBackend } from '../../src/shared/project-space-api';
import { issueBranchName } from '../../src/shared/issue-branch-name';
import { runWithAuthSession } from '../local-auth-store';
import type { CodexMachineTaskBlockedReason } from '../../src/shared/codex-machine-tasks-api';

export class CodexMachineTaskIssueError extends Error {
  constructor(readonly reason: Extract<
    CodexMachineTaskBlockedReason,
    'offline' | 'unauthorized' | 'worktree_failure'
  >, message: string) {
    super(message);
    this.name = 'CodexMachineTaskIssueError';
  }
}

export function createCodexMachineTaskIssueProvider(
  backend: Pick<
    ProjectSpaceBackend,
    'createGitHubBranch' | 'getGitHubCatalog' | 'getGitHubRepositoryDetails'
  >
) {
  return async function prepare(input: {
    expectedBranch?: string;
    expectedCommit?: string;
    expectedPullRequestNumber?: number;
    issue: number;
    repositoryId?: string;
    userId: string;
  }) {
    return runWithAuthSession(machineSession(input.userId), async () => {
      const catalog = await backend.getGitHubCatalog();
      if (catalog.status !== 'connected') {
        throw new CodexMachineTaskIssueError('unauthorized', 'GitHub authorization is unavailable.');
      }
      const repository = catalog.repositories.find((candidate) => (
        input.repositoryId
          ? String(candidate.id) === input.repositoryId || candidate.fullName === input.repositoryId
          : false
      ));
      if (!repository) {
        throw new CodexMachineTaskIssueError('unauthorized', 'Select an exact authorized repository.');
      }
      const details = await backend.getGitHubRepositoryDetails(repository.fullName);
      if (details.status !== 'connected') {
        throw new CodexMachineTaskIssueError('offline', 'Repository details are unavailable.');
      }
      const issue = details.issues.find((candidate) => candidate.number === input.issue);
      if (!issue || issue.state !== 'open') {
        throw new CodexMachineTaskIssueError('unauthorized', 'The GitHub issue is not available and open.');
      }
      const expectedPullRequest = input.expectedPullRequestNumber
        ? details.pullRequests.find(
            (candidate) => candidate.number === input.expectedPullRequestNumber
          )
        : undefined;
      if (
        input.expectedPullRequestNumber &&
        (
          !input.expectedBranch ||
          !input.expectedCommit ||
          !expectedPullRequest ||
          expectedPullRequest.state !== 'open' ||
          !expectedPullRequest.linkedIssueNumbers?.includes(issue.number) ||
          expectedPullRequest.headBranch !== input.expectedBranch ||
          expectedPullRequest.headSha?.toLowerCase() !== input.expectedCommit.toLowerCase()
        )
      ) {
        throw new CodexMachineTaskIssueError(
          'worktree_failure',
          'The requested pull request no longer matches the issue branch and exact head.'
        );
      }
      const branchName = expectedPullRequest?.headBranch ??
        issueBranchName(issue.number, issue.title);
      let branch = details.branches.find((candidate) => candidate.name === branchName);
      if (!branch) {
        if (expectedPullRequest) {
          throw new CodexMachineTaskIssueError(
            'worktree_failure',
            'The requested pull request branch is unavailable.'
          );
        }
        const created = await backend.createGitHubBranch({
          fullName: repository.fullName,
          issueNumber: issue.number,
          name: branchName,
          sourceBranch: repository.defaultBranch
        });
        if (created.status !== 'connected' || !created.branch) {
          throw new CodexMachineTaskIssueError(
            'worktree_failure',
            'The issue branch could not be prepared.'
          );
        }
        branch = created.branch;
        if (!branch.commitSha) {
          const refreshed = await backend.getGitHubRepositoryDetails(repository.fullName);
          if (refreshed.status === 'connected') {
            branch = refreshed.branches.find((candidate) => candidate.name === branch?.name) ?? branch;
          }
        }
      }
      if (!branch.commitSha || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(branch.commitSha)) {
        throw new CodexMachineTaskIssueError(
          'worktree_failure',
          'The issue branch does not have an exact commit.'
        );
      }
      if (
        (input.expectedBranch && branch.name !== input.expectedBranch) ||
        (input.expectedCommit &&
          branch.commitSha.toLowerCase() !== input.expectedCommit.toLowerCase())
      ) {
        throw new CodexMachineTaskIssueError(
          'worktree_failure',
          'The issue branch no longer matches the requested pull request head.'
        );
      }
      return {
        branch: branch.name,
        commit: branch.commitSha,
        issue: { number: issue.number, url: issue.url },
        repository: { id: String(repository.id), nameWithOwner: repository.fullName }
      };
    });
  };
}

function machineSession(userId: string) {
  return { login: 'project-cli', role: 'user' as const, userId };
}
