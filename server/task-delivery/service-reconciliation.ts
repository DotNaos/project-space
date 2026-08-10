import {
  TASK_DELIVERY_MCP_API_VERSION,
  type RequestTaskReviewRequest,
  type TaskDeliveryMutationResult
} from '../../src/shared/task-delivery-mcp-api';
import type {
  TaskDeliveryProviderObservation,
  TaskDeliveryRecord
} from './contracts';
import { persistTaskDeliveryObservation } from './service-evidence';
import {
  transitionTaskDeliveryOperation,
  type TaskDeliveryOperationIdentity
} from './service-operation';
import { projectTaskDelivery } from './service-projection';
import type {
  TaskDeliveryActor,
  TaskDeliveryServiceDependencies
} from './service-contracts';
import { taskDeliveryFingerprint } from './service-context';

export async function matchingReview(
  dependencies: TaskDeliveryServiceDependencies,
  actor: TaskDeliveryActor,
  delivery: TaskDeliveryRecord,
  request: RequestTaskReviewRequest
) {
  const review = await dependencies.store.readReview(
    actor.userId, delivery.id, request.expectedHeadCommit
  );
  return review && review.pullRequestNumber === Number(request.expectedPullRequestId) &&
    review.summaryFingerprint === taskDeliveryFingerprint(request.summary) &&
    review.requestedBy.id === (actor.clientId ?? actor.userId)
    ? review
    : undefined;
}

export async function persistObservedSafely(
  dependencies: TaskDeliveryServiceDependencies,
  actor: TaskDeliveryActor,
  delivery: TaskDeliveryRecord,
  identity: TaskDeliveryOperationIdentity,
  observation: TaskDeliveryProviderObservation
) {
  try {
    return await persistTaskDeliveryObservation({
      delivery,
      dependencies,
      executionId: identity.executionId,
      observation,
      ownerUserId: actor.userId
    });
  } catch {
    return undefined;
  }
}

export async function uncertainMutationResult(
  dependencies: TaskDeliveryServiceDependencies,
  actor: TaskDeliveryActor,
  delivery: TaskDeliveryRecord,
  identity: TaskDeliveryOperationIdentity,
  observation: TaskDeliveryProviderObservation | undefined,
  replayed: boolean
): Promise<TaskDeliveryMutationResult> {
  const current = await dependencies.operations.read(actor.userId, identity.operationId);
  if (current?.state === 'completed' || current?.state === 'blocked') {
    const evidence = await dependencies.store.latestEvidence(actor.userId, delivery.id);
    const review = evidence?.pullRequest?.headCommit
      ? await dependencies.store.readReview(
        actor.userId, delivery.id, evidence.pullRequest.headCommit
      )
      : undefined;
    return {
      apiVersion: TASK_DELIVERY_MCP_API_VERSION,
      ...(current.state === 'blocked' && typeof current.result?.blockedReason === 'string'
        ? { blockedReason: current.result.blockedReason as TaskDeliveryMutationResult['blockedReason'] }
        : {}),
      delivery: projectTaskDelivery({
        delivery,
        evidenceRevision: evidence?.revision,
        executionId: identity.executionId,
        observation: evidence,
        review
      }),
      message: typeof current.result?.message === 'string'
        ? current.result.message
        : 'The delivery operation was replayed.',
      operationId: identity.operationId,
      replayed: true,
      state: current.state
    };
  }
  await transitionTaskDeliveryOperation(dependencies.operations, identity, 'uncertain');
  const evidence = observation
    ? undefined
    : await dependencies.store.latestEvidence(actor.userId, delivery.id);
  const projectedObservation = observation ?? evidence;
  const review = projectedObservation?.pullRequest?.headCommit
    ? await dependencies.store.readReview(
      actor.userId, delivery.id, projectedObservation.pullRequest.headCommit
    )
    : undefined;
  return {
    apiVersion: TASK_DELIVERY_MCP_API_VERSION,
    delivery: projectTaskDelivery({
      delivery,
      evidenceRevision: evidence?.revision,
      executionId: identity.executionId,
      observation: projectedObservation,
      review
    }),
    message: 'The provider outcome is uncertain and must be reconciled.',
    operationId: identity.operationId,
    replayed,
    state: 'uncertain'
  };
}
