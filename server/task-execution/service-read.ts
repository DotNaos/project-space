import type { CodexMachineTaskReadResult } from '../../src/shared/codex-machine-tasks-api';
import {
  TASK_EXECUTION_MCP_API_VERSION,
  type GetTaskExecutionRequest,
  type ListTaskExecutionsRequest,
  type TaskExecutionActivityProjection,
  type TaskExecutionListResult,
  type TaskExecutionProjection,
  type TaskExecutionResult,
  type TaskExecutionWaitResult,
  type WaitTaskExecutionRequest
} from '../../src/shared/task-execution-mcp-api';
import type { TaskExecutionServiceDependencies, TaskExecutionActor } from './service-contracts';
import { TaskExecutionConflictError, TaskExecutionNotFoundError } from './service-contracts';
import {
  decodeTaskExecutionCursor,
  encodeTaskExecutionCursor
} from './service-identity';
import { transitionTaskExecution } from './service-state';
import type { StoredTaskExecution } from './contracts';

const wakeStates = new Set([
  'blocked', 'cancelled', 'completed', 'failed', 'uncertain',
  'waiting_for_approval', 'waiting_for_input'
]);
const terminalStates = new Set(['archived', 'cancelled', 'completed', 'failed']);

export function createTaskExecutionReader(dependencies: TaskExecutionServiceDependencies) {
  const now = dependencies.now ?? (() => new Date());

  async function get(
    actor: TaskExecutionActor,
    request: GetTaskExecutionRequest
  ): Promise<TaskExecutionResult> {
    let execution = await dependencies.store.read(actor.userId, request.executionId);
    if (!execution) throw new TaskExecutionNotFoundError();
    const binding = await dependencies.store.readExecutorBinding(actor.userId, execution.id);
    let activity: TaskExecutionActivityProjection | undefined;
    if (binding && !terminalStates.has(execution.state)) {
      const refreshed = await refreshCodexExecution(actor, execution, binding.externalId, request.limit);
      execution = refreshed.execution;
      activity = refreshed.activity;
    }
    const [workspace, events] = await Promise.all([
      dependencies.store.readWorkspace(actor.userId, execution.id),
      dependencies.store.listEvents(
        actor.userId,
        execution.id,
        request.afterCursor,
        request.limit
      )
    ]);
    return {
      ...(activity ? { activity } : {}),
      apiVersion: TASK_EXECUTION_MCP_API_VERSION,
      events,
      execution: projectTaskExecution(execution, binding, workspace),
      message: messageFor(execution),
      ...(events.at(-1) ? { nextCursor: events.at(-1)!.cursor } : {})
    };
  }

  async function list(
    actor: TaskExecutionActor,
    request: ListTaskExecutionsRequest
  ): Promise<TaskExecutionListResult> {
    const before = decodeTaskExecutionCursor(request.cursor);
    if (request.cursor && !before) throw new TaskExecutionConflictError('The pagination cursor is invalid.');
    const limit = request.limit ?? 25;
    const records = await dependencies.store.list({
      agent: request.agent,
      before,
      environmentId: request.environmentId,
      includeArchived: request.includeArchived ?? false,
      limit: limit + 1,
      ownerUserId: actor.userId,
      state: request.state,
      taskId: request.taskId
    });
    const page = records.slice(0, limit);
    const executions = await Promise.all(page.map(async (execution) => projectTaskExecution(
      execution,
      await dependencies.store.readExecutorBinding(actor.userId, execution.id),
      await dependencies.store.readWorkspace(actor.userId, execution.id)
    )));
    return {
      apiVersion: TASK_EXECUTION_MCP_API_VERSION,
      executions,
      ...(records.length > limit && page.at(-1)
        ? { nextCursor: encodeTaskExecutionCursor(page.at(-1)!) }
        : {})
    };
  }

  async function wait(
    actor: TaskExecutionActor,
    request: WaitTaskExecutionRequest
  ): Promise<TaskExecutionWaitResult> {
    const deadline = Date.now() + (request.timeoutSeconds ?? 20) * 1_000;
    let results: TaskExecutionResult[] = [];
    do {
      results = await Promise.all(request.executions.map((target) => get(actor, {
        afterCursor: target.afterCursor,
        executionId: target.executionId,
        limit: 100
      })));
      if (results.some((result) => wakeStates.has(result.execution.state))) {
        return { apiVersion: TASK_EXECUTION_MCP_API_VERSION, executions: results, timedOut: false };
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, deadline - Date.now())));
    } while (Date.now() < deadline);
    return { apiVersion: TASK_EXECUTION_MCP_API_VERSION, executions: results, timedOut: true };
  }

  async function readByExecutor(
    actor: TaskExecutionActor,
    externalId: string,
    afterCursor?: number,
    limit?: number
  ) {
    const execution = await dependencies.store.readByExecutor(actor.userId, 'codex', externalId);
    return execution ? get(actor, { afterCursor, executionId: execution.id, limit }) : undefined;
  }

  async function refreshCodexExecution(
    actor: TaskExecutionActor,
    execution: StoredTaskExecution,
    threadId: string,
    limit?: number
  ) {
    let read: CodexMachineTaskReadResult;
    try {
      read = await dependencies.codex.service.read(actor, {
        connectorId: execution.connectorBinding?.connectorId,
        environmentId: execution.environmentId,
        last: limit,
        threadId
      });
    } catch {
      const blocked = await transitionTaskExecution({
        execution, message: 'Fresh executor evidence is unavailable.', now: now(),
        reason: 'connector_stale', state: 'blocked', store: dependencies.store
      });
      return { execution: blocked };
    }
    if (read.state !== 'confirmed') {
      const blocked = await transitionTaskExecution({
        execution, message: 'Fresh executor evidence is unavailable.', now: now(),
        reason: read.reason === 'connector_required' ? 'connector_required' : 'connector_stale',
        state: 'blocked', store: dependencies.store
      });
      return { execution: blocked };
    }
    const attention = read.result.session.attention;
    const nextState = attention === 'approval'
      ? 'waiting_for_approval' as const
      : attention === 'input'
        ? 'waiting_for_input' as const
        : ['waiting_for_approval', 'waiting_for_input', 'blocked'].includes(execution.state)
          ? 'running' as const
          : execution.state;
    const refreshed = nextState === execution.state
      ? execution
      : await transitionTaskExecution({
          execution,
          message: attention ? `The executor requires ${attention}.` : 'The executor is running.',
          now: now(),
          state: nextState,
          store: dependencies.store
        });
    return { activity: projectActivity(read.result, now()), execution: refreshed };
  }

  return { get, list, readByExecutor, wait };
}

export function projectTaskExecution(
  execution: StoredTaskExecution,
  binding?: Awaited<ReturnType<TaskExecutionServiceDependencies['store']['readExecutorBinding']>>,
  workspace?: Awaited<ReturnType<TaskExecutionServiceDependencies['store']['readWorkspace']>>
): TaskExecutionProjection {
  const providerTaskId = execution.source.taskId.slice(execution.source.taskId.lastIndexOf(':') + 1);
  return {
    agent: execution.agent.kind,
    ...(execution.state === 'waiting_for_approval'
      ? { attention: { kind: 'approval' as const, state: 'required' as const } }
      : execution.state === 'waiting_for_input'
        ? { attention: { kind: 'input' as const, state: 'required' as const } }
        : {}),
    ...(execution.blockedReason ? { blockedReason: execution.blockedReason } : {}),
    ...(execution.connectorBinding ? {
      connector: {
        generation: execution.connectorBinding.generation,
        id: execution.connectorBinding.connectorId
      }
    } : {}),
    createdAt: execution.createdAt,
    environmentId: execution.environmentId,
    ...(binding ? { executor: { externalId: binding.externalId, turnId: binding.turnId } } : {}),
    handoff: execution.handoff,
    id: execution.id,
    source: {
      branch: execution.source.branch,
      commit: execution.source.commit,
      provider: 'github',
      providerTaskId,
      repositoryId: execution.source.repositoryId,
      taskId: execution.source.taskId
    },
    state: execution.state,
    updatedAt: execution.updatedAt,
    version: execution.version,
    ...(workspace ? { workspace: {
      branch: workspace.branch, commit: workspace.commit, id: workspace.id,
      kind: workspace.kind, repositoryId: workspace.repositoryId, state: workspace.state
    } } : {})
  };
}

function projectActivity(
  read: Extract<CodexMachineTaskReadResult, { state: 'confirmed' }>['result'],
  checkedAt: Date
): TaskExecutionActivityProjection {
  return {
    checkedAt: checkedAt.toISOString(),
    cursor: read.streamCursor,
    ...(read.pendingRequests?.length ? {
      pendingRequests: read.pendingRequests.map((request) => request.type === 'approval-requested'
        ? {
            ...(request.approvalId ? { approvalId: request.approvalId } : {}),
            ...(request.canAllow !== undefined ? { canAllow: request.canAllow } : {}),
            ...(request.command ? { command: request.command } : {}),
            ...(request.itemId ? { itemId: request.itemId } : {}),
            kind: request.kind,
            ...(request.permissionSummary ? { permissionSummary: request.permissionSummary } : {}),
            requestId: request.requestId,
            turnId: request.turnId,
            type: 'approval' as const
          }
        : {
            questions: request.questions,
            requestId: request.requestId,
            turnId: request.turnId,
            type: 'input' as const
          })
    } : {}),
    session: {
      attention: read.session.attention,
      lastActivityAt: read.session.lastActivityAt,
      status: read.session.status,
      title: read.session.title
    },
    turns: read.turns.map((turn) => ({
      completedAt: turn.completedAt,
      id: turn.id,
      items: turn.items.map((item) => ({
        detail: item.detail, id: item.id,
        ...(item.images ? { images: item.images.map(({ id, mediaType }) => ({ id, mediaType })) } : {}),
        kind: item.kind, status: item.status, text: item.text
      })),
      startedAt: turn.startedAt,
      status: turn.status
    }))
  };
}

function messageFor(execution: StoredTaskExecution) {
  if (execution.state === 'blocked') return `Task Execution is blocked: ${execution.blockedReason}.`;
  if (execution.state === 'uncertain') return 'Task Execution requires reconciliation.';
  return `Task Execution is ${execution.state}.`;
}
