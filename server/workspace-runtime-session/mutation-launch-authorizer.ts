import type { TaskExecutionStore } from '../task-execution/contracts';
import type { WorkspaceRuntimeStartAuthority } from './launch-service';

export function createWorkspaceRuntimeMutationLaunchAuthorizer(
  store: Pick<TaskExecutionStore, 'readByExecutor' | 'readWorkspace'>
) {
  return async (input: WorkspaceRuntimeStartAuthority) => {
    if (input.profile !== 'mutation' || !input.worktreeOwnerThreadId) return false;
    const execution = await store.readByExecutor(
      input.ownerUserId,
      'codex',
      input.worktreeOwnerThreadId
    );
    if (!execution || execution.environmentId !== input.environmentId ||
      execution.source.branch !== input.branch || execution.source.commit !== input.commit ||
      (execution.state !== 'preparing_workspace' && execution.state !== 'starting_agent')) return false;
    const workspace = await store.readWorkspace(input.ownerUserId, execution.id);
    return Boolean(workspace && workspace.id === input.workspaceId &&
      workspace.executionId === execution.id && workspace.repositoryId === execution.source.repositoryId &&
      workspace.branch === input.branch && workspace.commit === input.commit && workspace.state === 'ready');
  };
}
