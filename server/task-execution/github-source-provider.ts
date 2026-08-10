import type { ProjectSpaceBackend } from '../../src/shared/project-space-api';
import { issueBranchName } from '../../src/shared/issue-branch-name';
import { createCodexMachineTaskIssueProvider } from '../codex-machine-tasks/issue-provider';
import { resolveGitHubTask } from '../project-space-mcp/github-resolver';
import type { TaskExecutionSourceProvider } from './source-provider';
import { TaskExecutionSourceError } from './source-provider';

type GitHubSourceBackend = Pick<
  ProjectSpaceBackend,
  'createGitHubBranch' | 'getGitHubCatalog' | 'getGitHubRepositoryDetails'
>;

export function createGitHubTaskExecutionSourceProvider(
  backend: GitHubSourceBackend
): TaskExecutionSourceProvider {
  const prepareIssue = createCodexMachineTaskIssueProvider(backend);
  const resolve: TaskExecutionSourceProvider['resolve'] = async (_actor, locator) => {
    const resolved = await resolveGitHubTask(backend, locator.repositoryId, locator.number);
    if (!resolved.repository || resolved.details?.status !== 'connected') {
      throw new TaskExecutionSourceError(
        'provider_authorization_required',
        'The Task repository is unavailable to the signed-in user.'
      );
    }
    if (!resolved.task || resolved.task.state !== 'open') {
      throw new TaskExecutionSourceError(
        'provider_authorization_required',
        'The selected Task was not found or is no longer open.'
      );
    }
    const branchName = issueBranchName(resolved.task.number, resolved.task.title);
    const branch = resolved.details.branches.find(({ name }) => name === branchName);
    return {
      body: resolved.task.body,
      branch: branchName,
      branchExists: Boolean(branch),
      commit: validCommit(branch?.commitSha),
      provider: 'github',
      providerTaskId: String(resolved.task.number),
      repositoryId: String(resolved.repository.id),
      repositoryName: resolved.repository.fullName,
      taskId: `github:${resolved.repository.fullName}:${resolved.task.number}`,
      title: resolved.task.title
    };
  };

  return {
    resolve,
    async prepare(actor, locator) {
      const source = await resolve(actor, locator);
      try {
        const prepared = await prepareIssue({
          issue: locator.number,
          repositoryId: locator.repositoryId,
          userId: actor.userId
        });
        return {
          ...source,
          branch: prepared.branch,
          branchExists: true,
          commit: prepared.commit,
          repositoryId: prepared.repository.id,
          repositoryName: prepared.repository.nameWithOwner,
          taskId: `github:${prepared.repository.nameWithOwner}:${prepared.issue.number}`
        };
      } catch (error) {
        throw new TaskExecutionSourceError(
          'workspace_failure',
          error instanceof Error ? error.message : 'The Task branch could not be prepared.'
        );
      }
    }
  };
}

function validCommit(value: string | undefined) {
  return value && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : undefined;
}
