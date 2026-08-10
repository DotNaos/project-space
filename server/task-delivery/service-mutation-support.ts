import {
  TASK_DELIVERY_MCP_API_VERSION,
  taskDeliveryBlockedReasons,
  type TaskDeliveryBlockedReason,
  type TaskDeliveryMutationResult
} from '../../src/shared/task-delivery-mcp-api';
import type {
  TaskDeliveryProviderMutationResult,
  TaskDeliveryRecord
} from './contracts';
import { loadTaskDeliveryContext, taskDeliveryFingerprint } from './service-context';
import {
  ensureTaskDelivery,
  persistTaskDeliveryObservation
} from './service-evidence';
import {
  beginTaskDeliveryOperation,
  compactTaskDeliveryOperationResult,
  transitionTaskDeliveryOperation,
  type TaskDeliveryOperationIdentity,
  type TaskDeliveryOperationStart
} from './service-operation';
import { projectTaskDelivery } from './service-projection';
import { uncertainMutationResult } from './service-reconciliation';
import type {
  TaskDeliveryActor,
  TaskDeliveryServiceDependencies
} from './service-contracts';

export async function prepareTaskDeliveryMutation(
  dependencies: TaskDeliveryServiceDependencies,
  actor: TaskDeliveryActor,
  executionId: string,
  permission: 'repository_write' | 'task_write'
) {
  const context = await loadTaskDeliveryContext(dependencies, actor, executionId, permission);
  const provider = dependencies.providerFor(context.target.providerKind);
  if (!provider) throw new Error('Task Delivery provider is unavailable.');
  if (context.delivery) return { ...context, delivery: context.delivery, provider };
  const observation = await provider.observe(context.target);
  const completionPolicy = await dependencies.completionPolicyFor(context.target);
  if (!completionPolicy) throw new Error('Task Delivery completion policy is unavailable.');
  const delivery = await ensureTaskDelivery({
    completionPolicy,
    dependencies,
    executionId,
    observation,
    ownerUserId: actor.userId,
    target: context.target
  });
  return { ...context, delivery, observation, provider };
}

export function taskDeliveryOperationIdentity(
  actor: TaskDeliveryActor,
  operationId: string,
  action: 'complete' | 'merge' | 'pull-request' | 'review',
  executionId: string,
  delivery: TaskDeliveryRecord,
  request: unknown
): TaskDeliveryOperationIdentity {
  return {
    action: `task-delivery.${action}`,
    executionId,
    fingerprint: taskDeliveryFingerprint({ action, deliveryId: delivery.id, request }),
    operationId,
    ownerUserId: actor.userId,
    scopeKey: `delivery:${action}:${delivery.id}`
  };
}

export async function earlyTaskDeliveryMutationResult(
  dependencies: TaskDeliveryServiceDependencies,
  actor: TaskDeliveryActor,
  delivery: TaskDeliveryRecord,
  identity: TaskDeliveryOperationIdentity,
  start: TaskDeliveryOperationStart
): Promise<TaskDeliveryMutationResult | undefined> {
  if (start.kind === 'dispatch' || start.kind === 'reconcile') return undefined;
  if (start.kind === 'conflict') return blockedResult(identity.operationId, 'operation_conflict');
  const projection = await projectCurrent(dependencies, actor, delivery, identity.executionId);
  if (start.kind === 'in_progress') return {
    apiVersion: TASK_DELIVERY_MCP_API_VERSION,
    delivery: projection,
    message: 'The delivery operation is still being reconciled.',
    operationId: identity.operationId,
    replayed: true,
    state: 'uncertain'
  };
  const blockedReason = safeBlockedReason(start.operation.result?.blockedReason);
  return {
    apiVersion: TASK_DELIVERY_MCP_API_VERSION,
    ...(blockedReason ? { blockedReason } : {}),
    delivery: projection,
    message: typeof start.operation.result?.message === 'string'
      ? start.operation.result.message : 'The delivery operation was replayed.',
    operationId: identity.operationId,
    replayed: true,
    state: start.operation.state === 'blocked' ? 'blocked' : 'completed'
  };
}

export async function finishTaskDeliveryMutation(
  dependencies: TaskDeliveryServiceDependencies,
  actor: TaskDeliveryActor,
  delivery: TaskDeliveryRecord,
  identity: TaskDeliveryOperationIdentity,
  result: TaskDeliveryProviderMutationResult,
  replayed: boolean
): Promise<TaskDeliveryMutationResult> {
  if (result.kind === 'blocked') return finishTaskDeliveryBlocked(
    dependencies, actor, delivery, identity,
    safeBlockedReason(result.reason) ?? 'target_unavailable', replayed
  );
  if (result.kind === 'uncertain') {
    return uncertainMutationResult(dependencies, actor, delivery, identity, undefined, replayed);
  }
  try {
    await transitionTaskDeliveryOperation(dependencies.operations, identity, 'confirmed');
    const persisted = await persistTaskDeliveryObservation({
      delivery,
      dependencies,
      executionId: identity.executionId,
      observation: result.observation,
      ownerUserId: actor.userId
    });
    return finishTaskDeliveryConfirmed(
      dependencies, actor, persisted.delivery, identity,
      result.observation, persisted.evidence.revision, replayed
    );
  } catch {
    return uncertainMutationResult(
      dependencies, actor, delivery, identity, result.observation, replayed
    );
  }
}

export async function finishTaskDeliveryConfirmed(
  dependencies: TaskDeliveryServiceDependencies,
  actor: TaskDeliveryActor,
  delivery: TaskDeliveryRecord,
  identity: TaskDeliveryOperationIdentity,
  observation: Parameters<typeof persistTaskDeliveryObservation>[0]['observation'],
  evidenceRevision: number,
  replayed: boolean
): Promise<TaskDeliveryMutationResult> {
  const message = identity.action === 'task-delivery.complete' &&
      observation.taskState === 'completed'
    ? 'The Task is complete with verified delivery evidence.'
    : 'The delivery operation completed with fresh provider evidence.';
  const review = observation.pullRequest?.headCommit
    ? await dependencies.store.readReview(actor.userId, delivery.id, observation.pullRequest.headCommit)
    : undefined;
  await transitionTaskDeliveryOperation(dependencies.operations, identity, 'completed',
    compactTaskDeliveryOperationResult({
      deliveryId: delivery.id, evidenceRevision, message, outcome: 'completed',
      taskState: observation.taskState
    }));
  return {
    apiVersion: TASK_DELIVERY_MCP_API_VERSION,
    delivery: projectTaskDelivery({
      delivery, evidenceRevision, executionId: identity.executionId, observation, review
    }),
    message,
    operationId: identity.operationId,
    replayed,
    state: 'completed'
  };
}

export async function finishTaskDeliveryBlocked(
  dependencies: TaskDeliveryServiceDependencies,
  actor: TaskDeliveryActor,
  delivery: TaskDeliveryRecord,
  identity: TaskDeliveryOperationIdentity,
  reason: TaskDeliveryBlockedReason,
  replayed = false
) {
  const message = 'The delivery operation is blocked by current verified evidence.';
  await transitionTaskDeliveryOperation(dependencies.operations, identity, 'blocked',
    compactTaskDeliveryOperationResult({
      blockedReason: reason, deliveryId: delivery.id, message, outcome: 'blocked'
    }));
  return {
    ...blockedResult(identity.operationId, reason, replayed),
    delivery: await projectCurrent(dependencies, actor, delivery, identity.executionId)
  };
}

async function projectCurrent(
  dependencies: TaskDeliveryServiceDependencies,
  actor: TaskDeliveryActor,
  delivery: TaskDeliveryRecord,
  executionId?: string
) {
  const evidence = await dependencies.store.latestEvidence(actor.userId, delivery.id);
  const review = evidence?.pullRequest?.headCommit
    ? await dependencies.store.readReview(actor.userId, delivery.id, evidence.pullRequest.headCommit)
    : undefined;
  return projectTaskDelivery({
    delivery, evidenceRevision: evidence?.revision, executionId, observation: evidence, review
  });
}

function safeBlockedReason(value: unknown): TaskDeliveryBlockedReason | undefined {
  return typeof value === 'string' && taskDeliveryBlockedReasons.includes(value as TaskDeliveryBlockedReason)
    ? value as TaskDeliveryBlockedReason : undefined;
}

function blockedResult(
  operationId: string,
  blockedReason: TaskDeliveryBlockedReason,
  replayed = false
): TaskDeliveryMutationResult {
  return {
    apiVersion: TASK_DELIVERY_MCP_API_VERSION,
    blockedReason,
    message: 'The delivery operation is blocked by current verified evidence.',
    operationId,
    replayed,
    state: 'blocked'
  };
}
