import type { TaskExecutionStore } from '../task-execution/contracts';
import type { SshGatewayWorktreeAuthorizer } from './contracts';

export function createSshWorktreeAuthorizer(
  store: Pick<TaskExecutionStore, 'readByExecutor' | 'readWorkspace'>
): SshGatewayWorktreeAuthorizer {
  return {
    async authorize(actor, request) {
      if (actor.kind !== 'machine' || request.operation !== 'worktree.prepare.v1' ||
        !request.worktreeOwnerThreadId || !request.workspaceId || !request.repository ||
        !request.branch || !request.commit) return false;
      const execution = await store.readByExecutor(
        actor.ownerUserId,
        'codex',
        request.worktreeOwnerThreadId
      );
      if (!execution || execution.environmentId !== request.environmentId ||
        execution.source.taskId.indexOf(`github:${request.repository}:`) !== 0 ||
        execution.source.branch !== request.branch || execution.source.commit !== request.commit ||
        execution.state !== 'preparing_workspace') return false;
      const workspace = await store.readWorkspace(actor.ownerUserId, execution.id);
      return Boolean(workspace && workspace.id === request.workspaceId &&
        workspace.executionId === execution.id && workspace.repositoryId === execution.source.repositoryId &&
        workspace.branch === request.branch && workspace.commit === request.commit &&
        workspace.state === 'preparing');
    }
  };
}
