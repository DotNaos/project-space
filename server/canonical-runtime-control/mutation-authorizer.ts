import type { TaskExecutionStore } from '../task-execution/contracts';
import type {
  CanonicalRuntimeControlAuthorizer,
  CanonicalRuntimeControlTarget
} from './contracts';

export function createCanonicalRuntimeControlAuthorizer(options: {
  taskExecutions: Pick<TaskExecutionStore, 'read' | 'readWorkspace'>;
}): CanonicalRuntimeControlAuthorizer {
  return {
    async authorize(input) {
      if (!input.actor.ownerUserId || !input.actor.actorId) return false;
      if (input.actor.actorKind !== 'human' && input.actor.actorKind !== 'agent') return false;
      if (input.phase === 'coarse') return true;

      switch (input.safeInput.operation) {
        case 'git.stage':
        case 'git.unstage':
        case 'git.commit':
          return input.safeInput.expectedHead === input.target.commit;
        case 'task.start':
          return taskStartAuthorized(
            options.taskExecutions,
            input.actor.ownerUserId,
            input.safeInput.taskExecutionId,
            input.safeInput.workspaceLeaseId,
            input.target
          );
        default:
          return true;
      }
    }
  };
}

async function taskStartAuthorized(
  store: Pick<TaskExecutionStore, 'read' | 'readWorkspace'>,
  ownerUserId: string,
  executionId: string,
  workspaceLeaseId: string,
  target: CanonicalRuntimeControlTarget
) {
  const [execution, workspace] = await Promise.all([
    store.read(ownerUserId, executionId),
    store.readWorkspace(ownerUserId, executionId)
  ]);
  if (!execution || !workspace) return false;
  return (execution.state === 'preparing_workspace' || execution.state === 'starting_agent') &&
    execution.environmentId === target.environmentId &&
    execution.id === executionId &&
    execution.source.branch === target.branch &&
    execution.source.commit === target.commit &&
    execution.source.repositoryId === workspace.repositoryId &&
    workspace.branch === target.branch &&
    workspace.commit === target.commit &&
    workspace.executionId === executionId &&
    workspace.id === workspaceLeaseId &&
    workspace.id === target.workspaceId &&
    workspace.state === 'ready';
}
