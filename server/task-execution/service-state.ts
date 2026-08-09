import type {
  RunnerWorkspaceRecord,
  TaskExecutionExecutorBinding,
  TaskExecutionState
} from '../../src/shared/task-execution-api';
import type { StoredTaskExecution, TaskExecutionStore } from './contracts';
import type { TaskExecutionActor, TaskExecutionServiceDependencies } from './service-contracts';
import { TaskExecutionConflictError } from './service-contracts';

export async function taskExecutionWorkspaceKind(
  dependencies: TaskExecutionServiceDependencies,
  actor: TaskExecutionActor,
  environmentId: string
) {
  const inventory = await dependencies.loadInventory(actor.userId);
  return inventory.snapshot.environments.find(({ id }) => id === environmentId)?.kind ===
    'github_codespace'
    ? 'codespace' as const
    : 'worktree' as const;
}

export async function transitionTaskExecution(input: {
  actorId?: string;
  message: string;
  now: Date;
  reason?: StoredTaskExecution['blockedReason'];
  state: TaskExecutionState;
  store: TaskExecutionStore;
  execution: StoredTaskExecution;
}) {
  if (input.execution.state === input.state &&
      input.execution.blockedReason === input.reason) return input.execution;
  const result = await input.store.transition({
    blockedReason: input.reason,
    executionId: input.execution.id,
    expectedVersion: input.execution.version,
    ownerUserId: input.execution.ownerUserId,
    state: input.state,
    updatedAt: input.now.toISOString()
  });
  if (result.kind === 'conflict') {
    if (result.current?.state === input.state &&
        result.current.blockedReason === input.reason) return result.current;
    throw new TaskExecutionConflictError('The Task Execution changed while it was being updated.');
  }
  await input.store.appendEvent({
    ...(input.actorId ? { actor: { id: input.actorId, kind: 'orchestrator' } } : {}),
    createdAt: input.now.toISOString(),
    executionId: input.execution.id,
    message: input.message,
    ownerUserId: input.execution.ownerUserId,
    state: input.state,
    type: input.state === 'blocked' ? 'blocked' : 'state_changed'
  });
  return result.execution;
}

export async function bindTaskExecutionConnector(input: {
  connector: { generation: number; id: string };
  execution: StoredTaskExecution;
  now: Date;
  store: TaskExecutionStore;
}) {
  if (input.execution.connectorBinding?.connectorId === input.connector.id &&
      input.execution.connectorBinding.generation === input.connector.generation) {
    return input.execution;
  }
  const result = await input.store.updateConnectorBinding({
    connectorBinding: {
      connectorId: input.connector.id,
      generation: input.connector.generation
    },
    executionId: input.execution.id,
    expectedConnectorBinding: input.execution.connectorBinding,
    expectedVersion: input.execution.version,
    ownerUserId: input.execution.ownerUserId,
    updatedAt: input.now.toISOString()
  });
  if (result.kind === 'conflict') {
    if (result.current?.connectorBinding?.connectorId === input.connector.id &&
        result.current.connectorBinding.generation === input.connector.generation) {
      return result.current;
    }
    throw new TaskExecutionConflictError('The connector binding changed during preparation.');
  }
  return result.execution;
}

export async function bindTaskExecutionWorkspace(input: {
  now: Date;
  ownerUserId: string;
  store: TaskExecutionStore;
  workspace: RunnerWorkspaceRecord;
}) {
  const result = await input.store.bindWorkspace(input.ownerUserId, input.workspace);
  if (result === 'conflict') {
    throw new TaskExecutionConflictError('The executor returned a different workspace identity.');
  }
  if (result === 'created') {
    await input.store.appendEvent({
      createdAt: input.now.toISOString(), executionId: input.workspace.executionId,
      message: 'The exact runner workspace was bound.', ownerUserId: input.ownerUserId,
      type: 'workspace_bound'
    });
  }
}

export async function bindTaskExecutionExecutor(input: {
  binding: TaskExecutionExecutorBinding;
  now: Date;
  ownerUserId: string;
  store: TaskExecutionStore;
}) {
  const result = await input.store.bindExecutor(input.ownerUserId, input.binding);
  if (result === 'conflict') {
    throw new TaskExecutionConflictError('The executor returned a different Task identity.');
  }
  if (result === 'created') {
    await input.store.appendEvent({
      createdAt: input.now.toISOString(), executionId: input.binding.executionId,
      message: 'The executor identity was bound.', ownerUserId: input.ownerUserId,
      type: 'executor_bound'
    });
  }
}
