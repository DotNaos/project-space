import {
  TASK_EXECUTION_MCP_API_VERSION,
  type StartTaskExecutionRequest,
  type TaskExecutionDryRunResult,
  type TaskExecutionResult
} from '../../src/shared/task-execution-mcp-api';
import type { TaskExecutionBlockedReason } from '../../src/shared/task-execution-api';
import type { StoredTaskExecution, StoredTaskHandoffRevision } from './contracts';
import type { TaskExecutionActor, TaskExecutionServiceDependencies } from './service-contracts';
import { TaskExecutionConflictError } from './service-contracts';
import {
  compactOperationResult,
  deterministicTaskExecutionId,
  nestedOperationId,
  taskExecutionFingerprint
} from './service-identity';
import { bindTaskExecutionConnector, transitionTaskExecution } from './service-state';
import type { TaskExecutionSource } from './source-provider';

export async function completeStartOperation(
  dependencies: TaskExecutionServiceDependencies,
  actor: TaskExecutionActor,
  request: StartTaskExecutionRequest,
  fingerprint: string,
  result: TaskExecutionResult
) {
  await dependencies.operations.transition({
    action: 'start_task_execution', executionId: result.execution.id, fingerprint,
    operationId: request.operationId, ownerUserId: actor.userId,
    result: compactOperationResult({
      executionId: result.execution.id, message: result.message,
      state: result.execution.state, version: result.execution.version
    }),
    state: 'completed'
  });
}

export async function pauseStartOperation(
  dependencies: TaskExecutionServiceDependencies,
  readResult: (
    actor: TaskExecutionActor,
    executionId: string,
    operationId: string
  ) => Promise<TaskExecutionResult>,
  actor: TaskExecutionActor,
  request: StartTaskExecutionRequest,
  fingerprint: string,
  execution: StoredTaskExecution
) {
  const result = await readResult(actor, execution.id, request.operationId);
  await dependencies.operations.transition({
    action: 'start_task_execution', executionId: execution.id, fingerprint,
    operationId: request.operationId, ownerUserId: actor.userId,
    result: compactOperationResult({
      executionId: result.execution.id, message: result.message,
      state: result.execution.state, version: result.execution.version
    }),
    state: 'confirmed'
  });
  return result;
}

export async function ensureHandoff(
  dependencies: TaskExecutionServiceDependencies,
  actor: TaskExecutionActor,
  request: StartTaskExecutionRequest,
  source: TaskExecutionSource,
  executionId: string,
  now: Date
) {
  if (request.handoff) {
    await requireHandoff(dependencies, actor, request.handoff, source.taskId);
    return request.handoff;
  }
  const draft = request.briefing ?? {
    acceptanceCriteria: [], constraints: [], context: source.body ?? '', decisions: [],
    objective: `Implement Task ${source.providerTaskId}: ${source.title}`,
    requestedMode: 'implement' as const
  };
  const revision: StoredTaskHandoffRevision = {
    acceptanceCriteria: draft.acceptanceCriteria ?? [], artifacts: [],
    constraints: draft.constraints ?? [], context: draft.context ?? '',
    createdAt: now.toISOString(), createdBy: { id: actor.userId, kind: 'orchestrator' },
    decisions: draft.decisions ?? [], fingerprint: taskExecutionFingerprint(draft),
    handoffId: deterministicTaskExecutionId('task-handoff', executionId),
    objective: draft.objective, ownerUserId: actor.userId,
    requestedMode: draft.requestedMode ?? 'implement', revision: 1, taskId: source.taskId
  };
  const written = await dependencies.handoffs.create(revision);
  if (written.kind === 'conflict') {
    throw new TaskExecutionConflictError('The Handoff identity conflicts.');
  }
  return { id: revision.handoffId, revision: 1 };
}

export async function requireHandoff(
  dependencies: TaskExecutionServiceDependencies,
  actor: TaskExecutionActor,
  handoff: { id: string; revision: number },
  taskId: string
) {
  const stored = await dependencies.handoffs.read(actor.userId, handoff.id, handoff.revision);
  if (!stored || stored.taskId !== taskId) {
    throw new TaskExecutionConflictError('The Handoff does not belong to the selected Task.');
  }
  return stored;
}

export async function ensureExecution(
  dependencies: TaskExecutionServiceDependencies,
  actor: TaskExecutionActor,
  request: StartTaskExecutionRequest,
  source: TaskExecutionSource,
  handoff: { id: string; revision: number },
  executionId: string,
  now: Date
) {
  const existing = await dependencies.store.read(actor.userId, executionId);
  if (existing) {
    if (existing.source.taskId !== source.taskId ||
        existing.source.repositoryId !== source.repositoryId ||
        existing.source.branch !== source.branch ||
        existing.environmentId !== request.environmentId ||
        existing.agent.kind !== (request.agent ?? 'codex') ||
        existing.handoff.id !== handoff.id || existing.handoff.revision !== handoff.revision) {
      throw new TaskExecutionConflictError('The Task Execution identity conflicts.');
    }
    return existing;
  }
  const record: StoredTaskExecution = {
    agent: { kind: request.agent ?? 'codex' }, createdAt: now.toISOString(),
    environmentId: request.environmentId, handoff, id: executionId,
    ownerUserId: actor.userId,
    source: {
      branch: source.branch, commit: source.commit,
      repositoryId: source.repositoryId, taskId: source.taskId
    },
    state: 'planned', updatedAt: now.toISOString(), version: 1
  };
  const created = await dependencies.store.create(record);
  if (created === 'conflict') {
    throw new TaskExecutionConflictError('The Task Execution identity conflicts.');
  }
  if (created === 'created') {
    await dependencies.store.appendEvent({
      actor: { id: actor.userId, kind: 'orchestrator' }, createdAt: now.toISOString(),
      executionId, message: 'Task Execution was created.', ownerUserId: actor.userId,
      state: 'planned', type: 'created'
    });
  }
  return await dependencies.store.read(actor.userId, executionId) ?? record;
}

export async function prepareEnvironment(
  dependencies: TaskExecutionServiceDependencies,
  actor: TaskExecutionActor,
  execution: StoredTaskExecution,
  operationId: string,
  now: Date
) {
  const reconciling = execution.state === 'uncertain';
  let current = await move(dependencies, execution, 'preparing_environment', now,
    'Checking the selected Environment.');
  const inventory = await dependencies.loadInventory(actor.userId);
  if (inventory.snapshot.violations.length > 0) {
    return move(dependencies, current, 'uncertain', now, 'Environment inventory is ambiguous.');
  }
  const environment = inventory.snapshot.environments.find(({ id }) => id === current.environmentId);
  if (!environment) return block(dependencies, current, 'environment_not_running', now,
    'The selected Environment was not found.');
  const binding = (await dependencies.environmentLifecycle.list(actor.userId))
    .find((candidate) => candidate.environmentId === current.environmentId);
  if (reconciling && binding && binding.lifecycle.normalized !== 'running') {
    current = await startManagedEnvironment(
      dependencies, actor, current, operationId, now
    );
    if (current.state === 'blocked' || current.state === 'uncertain') return current;
  }
  let connectors = currentConnectors(inventory, current.environmentId);
  if (connectors.length === 0) {
    if (!reconciling && binding?.lifecycle.normalized === 'stopped') {
      current = await startManagedEnvironment(dependencies, actor, current, operationId, now);
      if (current.state === 'blocked' || current.state === 'uncertain') return current;
    }
    const refreshed = await dependencies.loadInventory(actor.userId);
    connectors = currentConnectors(refreshed, current.environmentId);
    if (connectors.length === 0) {
      return block(dependencies, current,
        binding ? 'connector_required' : 'environment_not_running', now,
        binding ? 'The Environment is starting and its connector is not ready yet.'
          : 'The Environment has no current connector.');
    }
  }
  if (connectors.length !== 1) {
    return block(dependencies, current, 'connector_stale', now,
      'The Environment does not have one exact current connector.');
  }
  current = await bindTaskExecutionConnector({
    connector: connectors[0]!, execution: current, now, store: dependencies.store
  });
  const status = await dependencies.agentRuntime.status(actor, {
    agent: current.agent.kind,
    environmentId: current.environmentId
  });
  if (status.runtime.state === 'ambiguous' || status.runtime.state === 'uncertain') {
    return move(dependencies, current, 'uncertain', now, status.message);
  }
  if (status.runtime.state !== 'ready') {
    return block(dependencies, current, 'agent_runtime_missing', now, status.message);
  }
  if (status.runtime.authorization.state !== 'ready') {
    return block(dependencies, current, 'agent_authorization_required', now,
      'The agent requires managed device authorization in this Environment.');
  }
  return current;
}

async function startManagedEnvironment(
  dependencies: TaskExecutionServiceDependencies,
  actor: TaskExecutionActor,
  execution: StoredTaskExecution,
  operationId: string,
  now: Date
) {
  const started = await dependencies.environmentLifecycle.start(actor, {
    environmentId: execution.environmentId,
    operationId: nestedOperationId(operationId, 'environment-start')
  });
  if (started.reconciliation.state === 'uncertain' ||
      started.lifecycle.normalized === 'uncertain' ||
      started.blocked?.reason === 'execution_state_uncertain' ||
      started.blocked?.reason === 'operation_conflict') {
    return move(dependencies, execution, 'uncertain', now, started.message);
  }
  if (started.blocked) {
    return block(
      dependencies, execution, environmentBlockedReason(started.blocked.reason), now,
      started.message
    );
  }
  if (['failed', 'missing', 'deleted', 'deleting', 'stopped', 'stopping']
    .includes(started.lifecycle.normalized)) {
    return block(dependencies, execution, 'environment_not_running', now, started.message);
  }
  return execution;
}

function currentConnectors(
  inventory: Awaited<ReturnType<TaskExecutionServiceDependencies['loadInventory']>>,
  environmentId: string
) {
  return inventory.snapshot.connectors
    .filter((association) => association.environmentId === environmentId)
    .flatMap((association) => {
      const connector = inventory.connectors.find(({ id }) => id === association.connectorId);
      const generation = inventory.generations.get(association.connectorId);
      return connector && generation && ['local', 'online'].includes(connector.connector.status)
        ? [{ generation, id: connector.id }]
        : [];
    });
}

export async function move(
  dependencies: TaskExecutionServiceDependencies,
  execution: StoredTaskExecution,
  state: StoredTaskExecution['state'],
  now: Date,
  message: string
) {
  return transitionTaskExecution({ execution, message, now, state, store: dependencies.store });
}

export async function block(
  dependencies: TaskExecutionServiceDependencies,
  execution: StoredTaskExecution,
  reason: TaskExecutionBlockedReason,
  now: Date,
  message: string
) {
  return transitionTaskExecution({ execution, message, now, reason, state: 'blocked', store: dependencies.store });
}

export function codexBlockedReason(reason: string): TaskExecutionBlockedReason {
  if (reason === 'approval_required') return 'approval_required';
  if (reason === 'input_required') return 'input_required';
  if (reason === 'worktree_failure') return 'workspace_failure';
  if (reason === 'connector_required') return 'connector_required';
  if (reason === 'stale_connector' || reason === 'offline') return 'connector_stale';
  return 'agent_runtime_missing';
}

function environmentBlockedReason(reason: string): TaskExecutionBlockedReason {
  if (reason === 'provider_reauthorization_required' || reason === 'not_authorized') {
    return 'provider_authorization_required';
  }
  if (reason === 'connector_approval_required') return 'connector_required';
  if (reason === 'agent_authorization_required') return 'agent_authorization_required';
  return 'environment_not_running';
}

export function dryRunResult(
  request: StartTaskExecutionRequest,
  source: TaskExecutionSource,
  prerequisites: Awaited<ReturnType<typeof inspectPrerequisites>>,
  handoff: 'existing' | 'generated' | 'inline'
): TaskExecutionDryRunResult {
  const blockedReason = prerequisites.blockedReason;
  return {
    apiVersion: TASK_EXECUTION_MCP_API_VERSION,
    ...(blockedReason ? { blockedReason } : {}),
    dryRun: true,
    environmentId: request.environmentId,
    handoff: { kind: handoff },
    message: blockedReason ? 'The Execution is not ready to start.' : 'The Execution can be started.',
    operationId: request.operationId,
    prerequisites: prerequisites.evidence,
    source: sourceProjection(source),
    state: blockedReason ? 'blocked' : 'ready'
  };
}

export async function inspectPrerequisites(
  dependencies: TaskExecutionServiceDependencies,
  actor: TaskExecutionActor,
  environmentId: string
) {
  const inventory = await dependencies.loadInventory(actor.userId);
  const exists = inventory.snapshot.environments.some(({ id }) => id === environmentId);
  const connectors = exists && inventory.snapshot.violations.length === 0
    ? currentConnectors(inventory, environmentId) : [];
  const capacity = exists
    ? await dependencies.capacity.read(actor.userId, environmentId)
    : undefined;
  const providerBinding = exists
    ? (await dependencies.environmentLifecycle.list(actor.userId))
      .find((binding) => binding.environmentId === environmentId)
    : undefined;
  let providerLifecycle = providerBinding?.lifecycle.normalized ?? 'unmanaged';
  let providerBlockedReason: TaskExecutionBlockedReason | undefined;
  if (providerBinding) {
    try {
      const providerStatus = await dependencies.environmentLifecycle.status(actor, environmentId);
      providerLifecycle = providerStatus.lifecycle.normalized;
      providerBlockedReason = providerStatus.blocked
        ? environmentBlockedReason(providerStatus.blocked.reason)
        : providerLifecycle !== 'running'
          ? 'environment_not_running'
          : undefined;
    } catch {
      providerLifecycle = 'uncertain';
      providerBlockedReason = 'environment_not_running';
    }
  }
  const status = exists ? await dependencies.agentRuntime.status(actor, {
    agent: 'codex', environmentId
  }) : undefined;
  const blockedReason: TaskExecutionBlockedReason | undefined = !exists
    ? 'environment_not_running'
    : capacity?.state === 'active'
      ? 'capacity_unavailable'
      : providerBlockedReason
        ? providerBlockedReason
        : connectors.length !== 1
          ? 'connector_required'
          : status?.runtime.state !== 'ready'
            ? 'agent_runtime_missing'
            : status.runtime.authorization.state !== 'ready'
              ? 'agent_authorization_required'
              : undefined;
  return {
    blockedReason,
    evidence: {
      agentAuthorization: status?.runtime.authorization.state ?? 'unknown',
      agentRuntime: status?.runtime.state ?? 'unknown',
      capacity: capacity?.state === 'active' ? 'unavailable' : 'available',
      connector: connectors.length === 1 ? 'ready' : connectors.length === 0 ? 'missing' : 'ambiguous',
      environment: exists ? 'found' : 'missing',
      providerLifecycle
    }
  };
}

function sourceProjection(source: TaskExecutionSource) {
  return {
    branch: source.branch, commit: source.commit, provider: source.provider,
    providerTaskId: source.providerTaskId, repositoryId: source.repositoryId,
    taskId: source.taskId
  };
}
