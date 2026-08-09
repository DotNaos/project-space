import type {
  CreateTaskHandoffRequest,
  GetTaskHandoffRequest,
  TaskExecutionHandoffUpdateResult,
  TaskHandoffResult,
  UpdateTaskExecutionHandoffRequest
} from '../../src/shared/task-handoff-mcp-api';
import { TASK_HANDOFF_MCP_API_VERSION } from '../../src/shared/task-handoff-mcp-api';
import type { StoredTaskExecution, StoredTaskHandoffRevision } from './contracts';
import {
  persistTaskHandoffArtifacts,
  prepareTaskHandoffArtifacts,
  projectTaskHandoffArtifacts
} from './handoff-artifacts';
import type {
  TaskExecutionActor,
  TaskExecutionServiceDependencies
} from './service-contracts';
import {
  TaskExecutionConflictError,
  TaskExecutionNotFoundError
} from './service-contracts';
import {
  deterministicTaskExecutionId,
  taskExecutionFingerprint
} from './service-identity';
import { projectTaskExecution } from './service-read';

const createAction = 'create_task_handoff';
const updateAction = 'update_task_execution_handoff';
const safeUpdateStates = new Set<StoredTaskExecution['state']>([
  'blocked', 'planned', 'preparing_environment', 'preparing_workspace',
  'waiting_for_authorization', 'waiting_for_connector'
]);

export function createTaskHandoffService(dependencies: TaskExecutionServiceDependencies) {
  const now = dependencies.now ?? (() => new Date());

  async function create(
    actor: TaskExecutionActor,
    request: CreateTaskHandoffRequest
  ): Promise<TaskHandoffResult> {
    const source = await dependencies.source.resolve(actor, request.task);
    const handoffId = request.handoffId ?? deterministicTaskExecutionId(
      'task-handoff', actor.userId, request.operationId
    );
    const revision = request.handoffId ? (request.baseRevision ?? 0) + 1 : 1;
    if ((request.handoffId === undefined) !== (request.baseRevision === undefined) ||
        revision <= 0) throw new TaskExecutionConflictError('The Handoff revision is invalid.');
    if (request.handoffId) {
      const latest = await dependencies.handoffs.read(actor.userId, handoffId);
      if (!latest || latest.taskId !== source.taskId || latest.revision !== request.baseRevision) {
        throw new TaskExecutionConflictError('The Handoff base revision changed or is unavailable.');
      }
    }

    const verifiedAt = now().toISOString();
    const prepared = await prepareTaskHandoffArtifacts({
      actor,
      artifacts: request.artifacts ?? [],
      blobs: dependencies.artifacts,
      handoffId,
      handoffs: dependencies.handoffs,
      revision,
      taskId: source.taskId,
      verifiedAt
    });
    const identity = {
      acceptanceCriteria: request.acceptanceCriteria ?? [],
      artifacts: prepared.map(({ reference }) => reference),
      constraints: request.constraints ?? [],
      context: request.context ?? '',
      decisions: request.decisions ?? [],
      handoffId,
      objective: request.objective,
      requestedMode: request.requestedMode,
      requestedPermissions: request.requestedPermissions,
      revision,
      taskId: source.taskId
    };
    const fingerprint = taskExecutionFingerprint({
      ...identity,
      artifacts: identity.artifacts.map(({ verification: _, ...artifact }) => artifact)
    });
    const reservation = await dependencies.operations.reserve({
      action: createAction,
      fingerprint,
      operationId: request.operationId,
      ownerUserId: actor.userId
    });
    if (reservation.kind === 'conflict') throw new TaskExecutionConflictError();
    const existing = await dependencies.handoffs.read(actor.userId, handoffId, revision);
    if (existing) {
      if (existing.fingerprint !== fingerprint || existing.taskId !== source.taskId) {
        throw new TaskExecutionConflictError('The Handoff revision identity conflicts.');
      }
      await completeCreateOperation(dependencies, actor, request.operationId, fingerprint, existing);
      return projectHandoffResult(dependencies, actor, existing, request.operationId, true);
    }
    if (reservation.kind === 'replayed') {
      throw new TaskExecutionConflictError('The completed Handoff revision is unavailable.');
    }
    await claimLocalOperation(dependencies, actor, request.operationId, createAction, fingerprint);

    try {
      await persistTaskHandoffArtifacts(dependencies.artifacts, prepared);
      const createdBy = prepared[0]?.reference.provenance.reference ??
        `mcp:${taskExecutionFingerprint(actor.clientId ?? actor.userId).slice(0, 48)}`;
      const stored: StoredTaskHandoffRevision = {
        ...identity,
        createdAt: verifiedAt,
        createdBy: { id: createdBy, kind: 'orchestrator' },
        fingerprint,
        ownerUserId: actor.userId
      };
      const written = revision === 1
        ? await dependencies.handoffs.create(stored)
        : await dependencies.handoffs.appendRevision(stored);
      if (written.kind === 'conflict') {
        throw new TaskExecutionConflictError('The Handoff revision changed concurrently.');
      }
      await completeCreateOperation(
        dependencies, actor, request.operationId, fingerprint, written.revision
      );
      return projectHandoffResult(
        dependencies,
        actor,
        written.revision,
        request.operationId,
        written.kind === 'replayed'
      );
    } catch (error) {
      await markUncertain(dependencies, actor, request.operationId, createAction, fingerprint);
      throw error;
    }
  }

  async function get(
    actor: TaskExecutionActor,
    request: GetTaskHandoffRequest
  ): Promise<TaskHandoffResult> {
    const handoff = await dependencies.handoffs.read(
      actor.userId,
      request.handoffId,
      request.revision
    );
    if (!handoff) throw new TaskHandoffNotFoundError();
    return projectHandoffResult(dependencies, actor, handoff);
  }

  async function updateExecution(
    actor: TaskExecutionActor,
    request: UpdateTaskExecutionHandoffRequest
  ): Promise<TaskExecutionHandoffUpdateResult> {
    let execution = await dependencies.store.read(actor.userId, request.executionId);
    if (!execution) throw new TaskExecutionNotFoundError();
    const handoff = await dependencies.handoffs.read(
      actor.userId,
      request.handoffId,
      request.revision
    );
    if (!handoff || handoff.taskId !== execution.source.taskId) throw new TaskHandoffNotFoundError();
    const fingerprint = taskExecutionFingerprint({ action: updateAction, request });
    const reservation = await dependencies.operations.reserve({
      action: updateAction,
      executionId: execution.id,
      fingerprint,
      operationId: request.operationId,
      ownerUserId: actor.userId
    });
    if (reservation.kind === 'conflict') throw new TaskExecutionConflictError();
    if (reservation.kind === 'replayed') {
      return projectUpdateResult(dependencies, actor, execution, request, 'updated', true);
    }
    if (execution.handoff.id === request.handoffId &&
        execution.handoff.revision === request.revision) {
      await completeUpdateOperation(dependencies, actor, request, fingerprint, 'updated');
      return projectUpdateResult(dependencies, actor, execution, request, 'updated', true);
    }
    const binding = await dependencies.store.readExecutorBinding(actor.userId, execution.id);
    if (binding || !safeUpdateStates.has(execution.state)) {
      await completeUpdateOperation(dependencies, actor, request, fingerprint, 'blocked');
      return projectUpdateResult(dependencies, actor, execution, request, 'blocked');
    }
    await claimLocalOperation(
      dependencies,
      actor,
      request.operationId,
      updateAction,
      fingerprint,
      execution.id
    );
    const updated = await dependencies.store.updateHandoff({
      executionId: execution.id,
      expectedVersion: execution.version,
      handoff: { id: request.handoffId, revision: request.revision },
      ownerUserId: actor.userId,
      updatedAt: now().toISOString()
    });
    if (updated.kind === 'conflict') {
      execution = updated.current ?? execution;
      if (execution.handoff.id !== request.handoffId ||
          execution.handoff.revision !== request.revision) {
        await completeUpdateOperation(dependencies, actor, request, fingerprint, 'blocked');
        return projectUpdateResult(dependencies, actor, execution, request, 'blocked');
      }
    } else {
      execution = updated.execution;
    }
    await completeUpdateOperation(dependencies, actor, request, fingerprint, 'updated');
    return projectUpdateResult(dependencies, actor, execution, request, 'updated');
  }

  return { create, get, updateExecution };
}

async function projectHandoffResult(
  dependencies: TaskExecutionServiceDependencies,
  actor: TaskExecutionActor,
  stored: StoredTaskHandoffRevision,
  operationId?: string,
  replayed?: boolean
): Promise<TaskHandoffResult> {
  const { fingerprint: _, ownerUserId: __, artifacts, ...handoff } = stored;
  return {
    apiVersion: TASK_HANDOFF_MCP_API_VERSION,
    handoff: {
      ...handoff,
      artifacts: await projectTaskHandoffArtifacts(actor.userId, artifacts, dependencies.artifacts)
    },
    message: replayed
      ? 'The exact Task Handoff revision was replayed.'
      : 'The Task Handoff revision is verified and available.',
    ...(operationId ? { operationId } : {}),
    ...(replayed ? { replayed: true } : {})
  };
}

async function projectUpdateResult(
  dependencies: TaskExecutionServiceDependencies,
  actor: TaskExecutionActor,
  execution: StoredTaskExecution,
  request: UpdateTaskExecutionHandoffRequest,
  state: 'blocked' | 'updated',
  replayed?: boolean
): Promise<TaskExecutionHandoffUpdateResult> {
  const [binding, workspace] = await Promise.all([
    dependencies.store.readExecutorBinding(actor.userId, execution.id),
    dependencies.store.readWorkspace(actor.userId, execution.id)
  ]);
  return {
    apiVersion: TASK_HANDOFF_MCP_API_VERSION,
    execution: projectTaskExecution(execution, binding, workspace),
    message: state === 'updated'
      ? 'The Task Execution now uses the exact requested Handoff revision.'
      : 'The Handoff cannot change after the executor starts or while execution is active.',
    operationId: request.operationId,
    ...(replayed ? { replayed: true } : {}),
    state
  };
}

async function claimLocalOperation(
  dependencies: TaskExecutionServiceDependencies,
  actor: TaskExecutionActor,
  operationId: string,
  action: string,
  fingerprint: string,
  executionId?: string
) {
  const current = await dependencies.operations.read(actor.userId, operationId);
  if (current && !['reserved', 'confirmed'].includes(current.state)) {
    await dependencies.operations.transition({
      action,
      ...(executionId ? { executionId } : {}),
      fingerprint,
      operationId,
      ownerUserId: actor.userId,
      state: 'confirmed'
    });
  }
  const claim = await dependencies.operations.claimDispatch({
    action,
    ...(executionId ? { executionId } : {}),
    fingerprint,
    operationId,
    ownerUserId: actor.userId
  });
  if (claim === 'conflict') throw new TaskExecutionConflictError();
}

async function completeCreateOperation(
  dependencies: TaskExecutionServiceDependencies,
  actor: TaskExecutionActor,
  operationId: string,
  fingerprint: string,
  handoff: StoredTaskHandoffRevision
) {
  await dependencies.operations.transition({
    action: createAction,
    fingerprint,
    operationId,
    ownerUserId: actor.userId,
    result: {
      handoffId: handoff.handoffId,
      message: 'Task Handoff revision verified.',
      revision: handoff.revision,
      state: 'completed'
    },
    state: 'completed'
  });
}

async function completeUpdateOperation(
  dependencies: TaskExecutionServiceDependencies,
  actor: TaskExecutionActor,
  request: UpdateTaskExecutionHandoffRequest,
  fingerprint: string,
  state: 'blocked' | 'updated'
) {
  await dependencies.operations.transition({
    action: updateAction,
    executionId: request.executionId,
    fingerprint,
    operationId: request.operationId,
    ownerUserId: actor.userId,
    result: {
      executionId: request.executionId,
      handoffId: request.handoffId,
      message: state === 'updated' ? 'Task Handoff updated.' : 'Task Handoff update blocked.',
      revision: request.revision,
      state
    },
    state: state === 'updated' ? 'completed' : 'blocked'
  });
}

async function markUncertain(
  dependencies: TaskExecutionServiceDependencies,
  actor: TaskExecutionActor,
  operationId: string,
  action: string,
  fingerprint: string
) {
  try {
    await dependencies.operations.transition({
      action,
      fingerprint,
      operationId,
      ownerUserId: actor.userId,
      result: { message: 'Task Handoff storage requires reconciliation.', state: 'uncertain' },
      state: 'uncertain'
    });
  } catch {
    // Preserve the original error when the operation already reached a terminal state.
  }
}

export class TaskHandoffNotFoundError extends Error {
  constructor() {
    super('The Task Handoff was not found.');
    this.name = 'TaskHandoffNotFoundError';
  }
}
