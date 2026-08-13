import type { WorkspaceRuntimePresentation } from '../../src/shared/workspace-runtime-session-api';
import type { ProjectSpaceBackend } from '../../src/shared/project-space-api';
import { runWithAuthSession } from '../local-auth-store';
import type { TaskExecutionStore } from '../task-execution/contracts';

type PresentationBackend = Pick<
  ProjectSpaceBackend,
  'getGitHubCatalog'
>;

export function createWorkspaceRuntimePresentationResolver(
  backend: PresentationBackend,
  executions: Pick<TaskExecutionStore, 'readByExecutor' | 'readWorkspace'>
) {
  return async function resolvePresentation(input: {
    branch: string;
    commit: string;
    environmentId: string;
    ownerUserId: string;
    workspaceId: string;
    worktreeOwnerThreadId: string;
  }): Promise<WorkspaceRuntimePresentation | undefined> {
    let execution: Awaited<ReturnType<typeof executions.readByExecutor>>;
    try {
      execution = await executions.readByExecutor(
        input.ownerUserId,
        'codex',
        input.worktreeOwnerThreadId
      );
    } catch {
      return undefined;
    }
    if (!execution || execution.environmentId !== input.environmentId ||
      execution.source.branch !== input.branch || execution.source.commit !== input.commit) {
      return undefined;
    }
    let workspace: Awaited<ReturnType<typeof executions.readWorkspace>>;
    try {
      workspace = await executions.readWorkspace(input.ownerUserId, execution.id);
    } catch {
      return undefined;
    }
    if (!workspace || workspace.id !== input.workspaceId ||
      workspace.executionId !== execution.id || workspace.repositoryId !== execution.source.repositoryId ||
      workspace.branch !== input.branch || workspace.commit !== input.commit || workspace.state !== 'ready') {
      return undefined;
    }
    let catalog: Awaited<ReturnType<PresentationBackend['getGitHubCatalog']>>;
    try {
      catalog = await runWithAuthSession(
        { login: 'project-cli', role: 'user', userId: input.ownerUserId },
        () => backend.getGitHubCatalog({ forceRefresh: false })
      );
    } catch {
      return undefined;
    }
    if (catalog.status !== 'connected') {
      return undefined;
    }
    const project = catalog.repositories.find(
      (candidate) => String(candidate.id) === execution.source.repositoryId
    );
    if (!project) {
      return undefined;
    }
    const taskNumber = boundTaskNumber(execution.source.taskId, project.fullName);
    return {
      repository: project.fullName,
      ...(taskNumber ? { task: { number: taskNumber } } : {})
    };
  };
}

function boundTaskNumber(taskId: string, repository: string) {
  const prefix = `github:${repository}:`;
  if (!taskId.toLowerCase().startsWith(prefix.toLowerCase())) return undefined;
  const value = taskId.slice(prefix.length);
  if (!/^[1-9][0-9]*$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}
