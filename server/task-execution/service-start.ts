import {
  type StartTaskExecutionRequest,
  type TaskExecutionDryRunResult,
  type TaskExecutionResult
} from '../../src/shared/task-execution-mcp-api';
import type { StoredTaskExecution } from './contracts';
import type {
  TaskExecutionActor,
  TaskExecutionServiceDependencies
} from './service-contracts';
import { TaskExecutionConflictError } from './service-contracts';
import {
  deterministicTaskExecutionId,
  nestedOperationId,
  taskExecutionFingerprint
} from './service-identity';
import {
  bindTaskExecutionConnector,
  bindTaskExecutionExecutor,
  bindTaskExecutionWorkspace,
  taskExecutionWorkspaceKind
} from './service-state';
import { TaskExecutionSourceError } from './source-provider';
import {
  block,
  codexBlockedReason,
  completeStartOperation,
  dryRunResult,
  ensureExecution,
  ensureHandoff,
  inspectPrerequisites,
  move,
  pauseStartOperation,
  prepareEnvironment,
  requireHandoff
} from './service-start-preparation';

const capacityDurationSeconds = 6 * 60 * 60;

export function createTaskExecutionStarter(
  dependencies: TaskExecutionServiceDependencies,
  readResult: (
    actor: TaskExecutionActor,
    executionId: string,
    operationId: string,
    replayed?: boolean
  ) => Promise<TaskExecutionResult>
) {
  const now = dependencies.now ?? (() => new Date());

  return async function start(
    actor: TaskExecutionActor,
    request: StartTaskExecutionRequest
  ): Promise<TaskExecutionDryRunResult | TaskExecutionResult> {
    const handoffKind = request.handoff ? 'existing' : request.briefing ? 'inline' : 'generated';
    if (request.dryRun) {
      const source = await dependencies.source.resolve(actor, request.task);
      if (request.handoff) await requireHandoff(dependencies, actor, request.handoff, source.taskId);
      const prerequisites = await inspectPrerequisites(dependencies, actor, request.environmentId);
      return dryRunResult(request, source, prerequisites, handoffKind);
    }

    const fingerprint = taskExecutionFingerprint({
      agent: request.agent ?? 'codex', briefing: request.briefing,
      environmentId: request.environmentId, handoff: request.handoff, task: request.task
    });
    const executionId = deterministicTaskExecutionId('task-execution', actor.userId, request.operationId);
    const existing = await dependencies.store.read(actor.userId, executionId);
    const recorded = await dependencies.operations.read(actor.userId, request.operationId);
    if (recorded && (recorded.action !== 'start_task_execution' ||
        recorded.executionId !== executionId || recorded.fingerprint !== fingerprint)) {
      throw new TaskExecutionConflictError();
    }
    let execution: StoredTaskExecution;
    if (existing && recorded) {
      execution = existing;
    } else {
      const source = await dependencies.source.resolve(actor, request.task);
      const handoff = await ensureHandoff(dependencies, actor, request, source, executionId, now());
      execution = await ensureExecution(
        dependencies, actor, request, source, handoff, executionId, now()
      );
    }
    const reservation = await dependencies.operations.reserve({
      action: 'start_task_execution', executionId, fingerprint,
      operationId: request.operationId, ownerUserId: actor.userId
    });
    if (reservation.kind === 'conflict') throw new TaskExecutionConflictError();
    if (reservation.kind === 'replayed') {
      return readResult(actor, executionId, request.operationId, true);
    }
    if (reservation.kind === 'in_progress' && reservation.operation.state === 'uncertain') {
      await dependencies.operations.transition({
        action: 'start_task_execution', executionId, fingerprint,
        operationId: request.operationId, ownerUserId: actor.userId, state: 'confirmed'
      });
    }
    const claim = await dependencies.operations.claimDispatch({
      action: 'start_task_execution', executionId, fingerprint,
      operationId: request.operationId, ownerUserId: actor.userId
    });
    if (claim === 'conflict') throw new TaskExecutionConflictError();
    if (claim === 'in_progress') {
      return readResult(actor, executionId, request.operationId);
    }

    try {
      if (!execution.source.commit) {
      const prepared = await dependencies.source.prepare(actor, request.task);
      const updated = await dependencies.store.updateSource({
        branch: prepared.branch,
        commit: requireCommit(prepared.commit),
        executionId,
        expectedVersion: execution.version,
        ownerUserId: actor.userId,
        repositoryId: prepared.repositoryId,
        updatedAt: now().toISOString()
      });
      if (updated.kind === 'conflict') {
        throw new TaskExecutionConflictError('The prepared Task source no longer matches the Execution.');
      }
      execution = updated.execution;
      }
      if (execution.state === 'running') {
      const result = await readResult(actor, executionId, request.operationId, true);
      await completeStartOperation(dependencies, actor, request, fingerprint, result);
      return result;
      }

      const capacity = await dependencies.capacity.acquire({
      durationSeconds: capacityDurationSeconds,
      environmentId: execution.environmentId,
      executionId,
      id: deterministicTaskExecutionId('capacity-lease', executionId),
      ownerUserId: actor.userId
    });
      if (capacity.kind === 'conflict' || capacity.kind === 'unavailable') {
      execution = await block(dependencies, execution, 'capacity_unavailable', now(),
        'The Environment is already reserved by another Task Execution.');
      return pauseStartOperation(dependencies, readResult, actor, request, fingerprint, execution);
      }

      if (!['preparing_workspace', 'starting_agent'].includes(execution.state)) {
      execution = await prepareEnvironment(dependencies, actor, execution, request.operationId, now());
      if (execution.state === 'uncertain') {
        await dependencies.operations.transition({
          action: 'start_task_execution', executionId, fingerprint,
          operationId: request.operationId, ownerUserId: actor.userId, state: 'uncertain'
        });
        return readResult(actor, executionId, request.operationId);
      }
      if (execution.state === 'blocked') {
        return pauseStartOperation(dependencies, readResult, actor, request, fingerprint, execution);
      }
      }

      if (execution.state !== 'starting_agent') {
      execution = await move(dependencies, execution, 'preparing_workspace', now(),
        'Preparing the exact runner workspace.');
      execution = await move(dependencies, execution, 'starting_agent', now(),
        'Starting the selected agent.');
      }
      const started = await dependencies.codex.service.start(actor, {
      connectorId: execution.connectorBinding?.connectorId,
      environmentId: execution.environmentId,
      expectedBranch: execution.source.branch,
      expectedCommit: execution.source.commit,
      issue: request.task.number,
      operationId: nestedOperationId(request.operationId, 'codex-start'),
      repositoryId: request.task.repositoryId
    });
      if (started.state === 'uncertain') {
      execution = await move(dependencies, execution, 'uncertain', now(), started.message);
      await dependencies.operations.transition({
        action: 'start_task_execution', executionId, fingerprint,
        operationId: request.operationId, ownerUserId: actor.userId, state: 'uncertain'
      });
      return readResult(actor, executionId, request.operationId);
      }
      if (started.state === 'blocked') {
      execution = await block(
        dependencies, execution, codexBlockedReason(started.reason), now(), started.message
      );
      return pauseStartOperation(dependencies, readResult, actor, request, fingerprint, execution);
      }
      if (started.state === 'ready') {
      execution = await move(
        dependencies, execution, 'uncertain', now(),
        'The executor returned validation evidence instead of a started Task.'
      );
      await dependencies.operations.transition({
        action: 'start_task_execution', executionId, fingerprint,
        operationId: request.operationId, ownerUserId: actor.userId, state: 'uncertain'
      });
      return readResult(actor, executionId, request.operationId);
      }
      const targetEnvironmentId = started.task.environment?.id;
      if (targetEnvironmentId && targetEnvironmentId !== execution.environmentId) {
      throw new TaskExecutionConflictError('The executor started in a different Environment.');
      }
      execution = await bindTaskExecutionConnector({
      connector: {
        generation: started.task.connector.generation,
        id: started.task.connector.id
      },
      execution, now: now(), store: dependencies.store
    });
      const timestamp = now().toISOString();
      await bindTaskExecutionWorkspace({
      now: now(), ownerUserId: actor.userId, store: dependencies.store,
      workspace: {
        branch: execution.source.branch,
        commit: execution.source.commit,
        createdAt: timestamp,
        executionId,
        id: deterministicTaskExecutionId('runner-workspace', executionId, started.task.worktree.id),
        kind: await taskExecutionWorkspaceKind(dependencies, actor, execution.environmentId),
        repositoryId: execution.source.repositoryId,
        state: 'ready',
        updatedAt: timestamp,
        version: 1
      }
    });
      await bindTaskExecutionExecutor({
      binding: {
        agent: 'codex', createdAt: timestamp, executionId,
        externalId: started.task.threadId, updatedAt: timestamp, version: 1
      },
      now: now(), ownerUserId: actor.userId, store: dependencies.store
    });
      execution = await move(dependencies, execution, 'running', now(), 'The agent is running.');
      const result = await readResult(actor, executionId, request.operationId);
      await completeStartOperation(dependencies, actor, request, fingerprint, result);
      return result;
    } catch (error) {
      const latest = await dependencies.store.read(actor.userId, executionId) ?? execution;
      if (error instanceof TaskExecutionSourceError) {
        const blocked = await block(dependencies, latest, error.reason, now(), error.message);
        return pauseStartOperation(dependencies, readResult, actor, request, fingerprint, blocked);
      }
      const uncertain = await move(
        dependencies, latest, 'uncertain', now(),
        'The Task Execution start outcome requires reconciliation.'
      );
      await dependencies.operations.transition({
        action: 'start_task_execution', executionId, fingerprint,
        operationId: request.operationId, ownerUserId: actor.userId, state: 'uncertain'
      });
      return readResult(actor, uncertain.id, request.operationId);
    }
  };
}

function requireCommit(commit: string | undefined) {
  if (!commit || !/^[0-9a-f]{40}$/i.test(commit)) {
    throw new TaskExecutionConflictError('The Task branch does not have an exact commit.');
  }
  return commit.toLowerCase();
}
