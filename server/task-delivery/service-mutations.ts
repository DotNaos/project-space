import { randomUUID } from 'node:crypto';

import {
  type CompleteTaskRequest,
  type CreateOrUpdateTaskPullRequestRequest,
  type MergeTaskPullRequestRequest,
  type RequestTaskReviewRequest,
  type TaskCompletionResult,
  type TaskDeliveryBlockedReason,
  type TaskDeliveryMutationResult
} from '../../src/shared/task-delivery-mcp-api';
import type {
  TaskDeliveryProvider,
  TaskDeliveryProviderMutationResult,
  TaskDeliveryRecord,
  TaskDeliveryRevisionReview
} from './contracts';
import { taskDeliveryFingerprint } from './service-context';
import {
  persistTaskDeliveryObservation,
  synchronizeTaskDeliveryReview
} from './service-evidence';
import {
  matchingReview,
  persistObservedSafely,
  uncertainMutationResult
} from './service-reconciliation';
import { taskDeliveryReviewRequestFingerprint } from './review-fingerprint';
import {
  beginTaskDeliveryOperation,
  transitionTaskDeliveryOperation,
  type TaskDeliveryOperationIdentity,
  type TaskDeliveryOperationStart
} from './service-operation';
import {
  earlyTaskDeliveryMutationResult,
  finishTaskDeliveryBlocked,
  finishTaskDeliveryConfirmed,
  finishTaskDeliveryMutation,
  prepareTaskDeliveryMutation,
  taskDeliveryOperationIdentity
} from './service-mutation-support';
import { deploymentEvidenceId } from './service-projection';
import { generatedTaskDeliveryPresentation } from './service-presentation';
import type {
  TaskDeliveryActor,
  TaskDeliveryServiceDependencies
} from './service-contracts';

export function createTaskDeliveryMutations(dependencies: TaskDeliveryServiceDependencies) {
  return {
    completeTask: (actor: TaskDeliveryActor, request: CompleteTaskRequest) => (
      completeTask(dependencies, actor, request)
    ),
    createOrUpdatePullRequest: (
      actor: TaskDeliveryActor,
      request: CreateOrUpdateTaskPullRequestRequest
    ) => createOrUpdatePullRequest(dependencies, actor, request),
    mergePullRequest: (actor: TaskDeliveryActor, request: MergeTaskPullRequestRequest) => (
      mergePullRequest(dependencies, actor, request)
    ),
    requestReview: (actor: TaskDeliveryActor, request: RequestTaskReviewRequest) => (
      requestReview(dependencies, actor, request)
    )
  };
}

async function createOrUpdatePullRequest(
  dependencies: TaskDeliveryServiceDependencies,
  actor: TaskDeliveryActor,
  request: CreateOrUpdateTaskPullRequestRequest
) {
  const loaded = await prepareTaskDeliveryMutation(
    dependencies, actor, request.executionId, 'repository_write'
  );
  const presentation = request.presentation.mode === 'provided'
    ? { body: request.presentation.body, title: request.presentation.title }
    : generatedTaskDeliveryPresentation(loaded.objective, loaded.delivery, request.expectedHeadCommit);
  const identity = taskDeliveryOperationIdentity(actor, request.operationId, 'pull-request', request.executionId, loaded.delivery, {
    expectedHeadCommit: request.expectedHeadCommit,
    expectedPullRequestId: request.expectedPullRequestId,
    presentation,
    state: request.state
  });
  const start = await beginTaskDeliveryOperation(dependencies.operations, identity);
  const early = await earlyTaskDeliveryMutationResult(dependencies, actor, loaded.delivery, identity, start);
  if (early) return early;
  const observation = ('observation' in loaded ? loaded.observation : undefined) ??
    await loaded.provider.observe(loaded.delivery);
  const observedPullRequestId = observation.pullRequest
    ? String(observation.pullRequest.number)
    : undefined;
  if (start.kind === 'reconcile') {
    return reconcileCreateOrUpdate(
      dependencies, actor, loaded.delivery, identity, observation, request, start
    );
  }
  if (request.expectedPullRequestId && (
    request.expectedPullRequestId !== observedPullRequestId ||
    (loaded.delivery.pullRequestNumber !== undefined &&
      request.expectedPullRequestId !== String(loaded.delivery.pullRequestNumber))
  )) {
    return finishTaskDeliveryBlocked(dependencies, actor, loaded.delivery, identity, 'pull_request_missing', start.replayed);
  }
  const providerResult = await loaded.provider.createOrUpdatePullRequest({
    ...presentation,
    draft: request.state === 'draft',
    expectedHeadCommit: request.expectedHeadCommit,
    target: loaded.delivery
  });
  return finishTaskDeliveryMutation(dependencies, actor, loaded.delivery, identity, providerResult, start.replayed);
}

async function requestReview(
  dependencies: TaskDeliveryServiceDependencies,
  actor: TaskDeliveryActor,
  request: RequestTaskReviewRequest
) {
  const loaded = await prepareTaskDeliveryMutation(
    dependencies, actor, request.executionId, 'repository_write'
  );
  const identity = taskDeliveryOperationIdentity(actor, request.operationId, 'review', request.executionId, loaded.delivery, request);
  const start = await beginTaskDeliveryOperation(dependencies.operations, identity);
  const early = await earlyTaskDeliveryMutationResult(dependencies, actor, loaded.delivery, identity, start);
  if (early) return early;
  const observation = ('observation' in loaded ? loaded.observation : undefined) ??
    await loaded.provider.observe(loaded.delivery);
  const current = observation.pullRequest;
  if (!current || String(current.number) !== request.expectedPullRequestId) {
    if (start.kind === 'reconcile') return uncertainMutationResult(
      dependencies, actor, loaded.delivery, identity, observation, true
    );
    return finishTaskDeliveryBlocked(dependencies, actor, loaded.delivery, identity, 'pull_request_missing', start.replayed);
  }
  if (current.headCommit !== request.expectedHeadCommit) {
    if (start.kind === 'reconcile') return uncertainMutationResult(
      dependencies, actor, loaded.delivery, identity, observation, true
    );
    return finishTaskDeliveryBlocked(dependencies, actor, loaded.delivery, identity, 'head_mismatch', start.replayed);
  }
  let providerResult: TaskDeliveryProviderMutationResult;
  if (start.kind === 'reconcile') {
    const existing = await matchingReview(dependencies, actor, loaded.delivery, request);
    if (existing) {
      const persisted = await persistObservedSafely(
        dependencies, actor, loaded.delivery, identity, observation
      );
      if (!persisted) return uncertainMutationResult(
        dependencies, actor, loaded.delivery, identity, observation, true
      );
      await synchronizeTaskDeliveryReview({
        delivery: persisted.delivery,
        dependencies,
        observation,
        ownerUserId: actor.userId,
        review: existing
      });
      return finishTaskDeliveryConfirmed(
        dependencies, actor, persisted.delivery, identity,
        observation, persisted.evidence.revision, true
      );
    }
    const exactProviderRequest = observation.review.requestFingerprint ===
      taskDeliveryReviewRequestFingerprint({
        headCommit: request.expectedHeadCommit,
        summary: request.summary
      });
    if (start.operation.state !== 'confirmed' && !exactProviderRequest) {
      return uncertainMutationResult(
        dependencies, actor, loaded.delivery, identity, observation, true
      );
    }
    providerResult = { kind: 'confirmed', observation };
  } else {
    providerResult = await loaded.provider.requestReview({
      expectedHeadCommit: request.expectedHeadCommit,
      pullRequestNumber: current.number,
      summary: request.summary,
      target: loaded.delivery
    });
  }
  if (providerResult.kind !== 'confirmed') {
    return finishTaskDeliveryMutation(dependencies, actor, loaded.delivery, identity, providerResult, start.replayed);
  }
  try {
    await transitionTaskDeliveryOperation(dependencies.operations, identity, 'confirmed');
    const persisted = await persistTaskDeliveryObservation({
      delivery: loaded.delivery,
      dependencies,
      executionId: request.executionId,
      observation: providerResult.observation,
      ownerUserId: actor.userId
    });
    const requestedAt = (dependencies.now ?? (() => new Date()))().toISOString();
    const candidate: TaskDeliveryRevisionReview = {
      deliveryId: persisted.delivery.id,
      evidenceRevision: persisted.evidence.revision,
      id: (dependencies.createId ?? randomUUID)(),
      ownerUserId: actor.userId,
      pullRequestHeadCommit: request.expectedHeadCommit,
      pullRequestNumber: current.number,
      requestedAt,
      requestedBy: { id: actor.clientId ?? actor.userId, kind: 'orchestrator' },
      state: 'requested',
      summaryFingerprint: taskDeliveryFingerprint(request.summary)
    };
    const written = await dependencies.store.requestReview(candidate);
    if (written === 'conflict') {
      return finishTaskDeliveryBlocked(dependencies, actor, persisted.delivery, identity, 'operation_conflict', start.replayed);
    }
    const review = await dependencies.store.readReview(
      actor.userId,
      persisted.delivery.id,
      request.expectedHeadCommit
    );
    await synchronizeTaskDeliveryReview({
      delivery: persisted.delivery,
      dependencies,
      observation: providerResult.observation,
      ownerUserId: actor.userId,
      review
    });
    return finishTaskDeliveryConfirmed(
      dependencies,
      actor,
      persisted.delivery,
      identity,
      providerResult.observation,
      persisted.evidence.revision,
      start.replayed
    );
  } catch {
    return uncertainMutationResult(
      dependencies, actor, loaded.delivery, identity, providerResult.observation, start.replayed
    );
  }
}

async function mergePullRequest(
  dependencies: TaskDeliveryServiceDependencies,
  actor: TaskDeliveryActor,
  request: MergeTaskPullRequestRequest
) {
  const loaded = await prepareTaskDeliveryMutation(
    dependencies, actor, request.executionId, 'repository_write'
  );
  const identity = taskDeliveryOperationIdentity(actor, request.operationId, 'merge', request.executionId, loaded.delivery, request);
  const start = await beginTaskDeliveryOperation(dependencies.operations, identity);
  const early = await earlyTaskDeliveryMutationResult(dependencies, actor, loaded.delivery, identity, start);
  if (early) return early;
  const observation = ('observation' in loaded ? loaded.observation : undefined) ??
    await loaded.provider.observe(loaded.delivery);
  const current = observation.pullRequest;
  if (!current || String(current.number) !== request.expectedPullRequestId) {
    if (start.kind === 'reconcile') return uncertainMutationResult(
      dependencies, actor, loaded.delivery, identity, observation, true
    );
    return finishTaskDeliveryBlocked(dependencies, actor, loaded.delivery, identity, 'pull_request_missing', start.replayed);
  }
  if (current.headCommit !== request.expectedHeadCommit ||
      request.expectedApprovedRevision !== request.expectedHeadCommit) {
    if (start.kind === 'reconcile') return uncertainMutationResult(
      dependencies, actor, loaded.delivery, identity, observation, true
    );
    return finishTaskDeliveryBlocked(dependencies, actor, loaded.delivery, identity, 'head_mismatch', start.replayed);
  }
  if (start.kind === 'reconcile') {
    if (current.state === 'merged' && observation.mergeCommit) {
      return finishObservedMutation(
        dependencies, actor, loaded.delivery, identity, observation, true
      );
    }
    return uncertainMutationResult(
      dependencies, actor, loaded.delivery, identity, observation, true
    );
  }
  let review = await dependencies.store.readReviewById(
    actor.userId,
    loaded.delivery.id,
    request.reviewRequestId
  );
  review = await synchronizeTaskDeliveryReview({
    delivery: loaded.delivery,
    dependencies,
    observation,
    ownerUserId: actor.userId,
    review
  });
  if (!review || review.pullRequestHeadCommit !== request.expectedApprovedRevision) {
    return finishTaskDeliveryBlocked(dependencies, actor, loaded.delivery, identity, 'approval_stale', start.replayed);
  }
  if (review.state === 'rejected') {
    return finishTaskDeliveryBlocked(dependencies, actor, loaded.delivery, identity, 'changes_requested', start.replayed);
  }
  if (review.state !== 'approved') {
    return finishTaskDeliveryBlocked(dependencies, actor, loaded.delivery, identity, 'approval_required', start.replayed);
  }
  const gate = mergeGate(observation, request.expectedHeadCommit);
  if (gate) return finishTaskDeliveryBlocked(dependencies, actor, loaded.delivery, identity, gate, start.replayed);
  return finishTaskDeliveryMutation(dependencies, actor, loaded.delivery, identity, await loaded.provider.merge({
    expectedHeadCommit: request.expectedHeadCommit,
    method: request.mergeMethod,
    pullRequestNumber: current.number,
    target: loaded.delivery
  }), start.replayed);
}

async function completeTask(
  dependencies: TaskDeliveryServiceDependencies,
  actor: TaskDeliveryActor,
  request: CompleteTaskRequest
): Promise<TaskCompletionResult> {
  const loaded = await prepareTaskDeliveryMutation(
    dependencies, actor, request.executionId, 'task_write'
  );
  const identity = taskDeliveryOperationIdentity(actor, request.operationId, 'complete', request.executionId, loaded.delivery, request);
  const start = await beginTaskDeliveryOperation(dependencies.operations, identity);
  const early = await earlyTaskDeliveryMutationResult(dependencies, actor, loaded.delivery, identity, start);
  if (early) return completionResult(early, request);
  const observation = ('observation' in loaded ? loaded.observation : undefined) ??
    await loaded.provider.observe(loaded.delivery);
  if (loaded.delivery.id !== request.evidence.deliveryId || loaded.delivery.taskId !== request.taskId ||
      !completionPolicyMatches(loaded.delivery, request)) {
    return completionResult(await finishTaskDeliveryBlocked(
      dependencies, actor, loaded.delivery, identity, 'completion_policy_mismatch', start.replayed
    ), request);
  }
  const mergeOperation = await dependencies.operations.read(actor.userId, request.evidence.mergeOperationId);
  if (!mergeOperation || mergeOperation.action !== 'task-delivery.merge' ||
      mergeOperation.state !== 'completed' ||
      mergeOperation.result?.deliveryId !== loaded.delivery.id) {
    return completionResult(await finishTaskDeliveryBlocked(
      dependencies, actor, loaded.delivery, identity, 'delivery_unverified', start.replayed
    ), request);
  }
  const previousEvidence = await dependencies.store.latestEvidence(actor.userId, loaded.delivery.id);
  if (start.kind === 'reconcile' && observation.taskState !== 'completed') {
    return completionResult(await uncertainMutationResult(
      dependencies, actor, loaded.delivery, identity, observation, true
    ), request);
  }
  let persisted;
  try {
    persisted = await persistTaskDeliveryObservation({
      delivery: loaded.delivery,
      dependencies,
      executionId: request.executionId,
      observation,
      ownerUserId: actor.userId
    });
  } catch {
    return completionResult(await uncertainMutationResult(
      dependencies, actor, loaded.delivery, identity, observation, start.replayed
    ), request);
  }
  const policyBlock = completionGate(
    persisted.delivery, persisted.evidence, previousEvidence, request
  );
  if (policyBlock) {
    return completionResult(await finishTaskDeliveryBlocked(
      dependencies, actor, persisted.delivery, identity, policyBlock, start.replayed
    ), request);
  }
  if (start.kind === 'reconcile') {
    return completionResult(await finishTaskDeliveryConfirmed(
      dependencies, actor, persisted.delivery, identity,
      observation, persisted.evidence.revision, true
    ), request);
  }
  const result = await finishTaskDeliveryMutation(
    dependencies,
    actor,
    persisted.delivery,
    identity,
    await loaded.provider.completeTask({ expectedState: 'open', target: persisted.delivery }),
    start.replayed
  );
  return completionResult(result, request);
}

async function reconcileCreateOrUpdate(
  dependencies: TaskDeliveryServiceDependencies,
  actor: TaskDeliveryActor,
  delivery: TaskDeliveryRecord,
  identity: TaskDeliveryOperationIdentity,
  observation: Parameters<typeof persistTaskDeliveryObservation>[0]['observation'],
  request: CreateOrUpdateTaskPullRequestRequest,
  start: Extract<TaskDeliveryOperationStart, { kind: 'reconcile' }>
) {
  const pullRequest = observation.pullRequest;
  const matches = pullRequest?.headCommit === request.expectedHeadCommit &&
    pullRequest.draft === (request.state === 'draft') &&
    (!request.expectedPullRequestId || String(pullRequest.number) === request.expectedPullRequestId);
  if (start.operation.state !== 'confirmed' || !matches) {
    return uncertainMutationResult(
      dependencies, actor, delivery, identity, observation, true
    );
  }
  return finishObservedMutation(
    dependencies, actor, delivery, identity, observation, true
  );
}

async function finishObservedMutation(
  dependencies: TaskDeliveryServiceDependencies,
  actor: TaskDeliveryActor,
  delivery: TaskDeliveryRecord,
  identity: TaskDeliveryOperationIdentity,
  observation: Parameters<typeof persistTaskDeliveryObservation>[0]['observation'],
  replayed: boolean
) {
  const persisted = await persistObservedSafely(
    dependencies, actor, delivery, identity, observation
  );
  if (!persisted) {
    return uncertainMutationResult(
      dependencies, actor, delivery, identity, observation, replayed
    );
  }
  return finishTaskDeliveryConfirmed(
    dependencies, actor, persisted.delivery, identity,
    observation, persisted.evidence.revision, replayed
  );
}

function mergeGate(
  observation: Awaited<ReturnType<TaskDeliveryProvider['observe']>>,
  head: string
): TaskDeliveryBlockedReason | undefined {
  if (observation.review.commit !== head || observation.review.state === 'unavailable') return 'approval_stale';
  if (observation.review.state === 'changes_requested') return 'changes_requested';
  if (observation.review.state !== 'approved') return 'approval_required';
  if (observation.checks.commit !== head || observation.checks.state === 'unavailable') return 'checks_unverified';
  if (observation.checks.state === 'pending') return 'checks_pending';
  if (observation.checks.state === 'failing') return 'checks_failed';
  return undefined;
}

function completionGate(
  delivery: TaskDeliveryRecord,
  evidence: Awaited<ReturnType<TaskDeliveryServiceDependencies['store']['appendEvidence']>>,
  previousEvidence: Awaited<ReturnType<TaskDeliveryServiceDependencies['store']['latestEvidence']>>,
  request: CompleteTaskRequest
): TaskDeliveryBlockedReason | undefined {
  if (evidence.pullRequest?.state !== 'merged' || !evidence.mergeCommit) return 'delivery_unverified';
  if (delivery.policy.kind !== 'deployed_healthy') return undefined;
  const requestedEvidence = [evidence, previousEvidence].find((candidate) => (
    candidate && request.evidence.deploymentEvidenceIds?.includes(
      deploymentEvidenceId(delivery.id, candidate)
    )
  ));
  if (!requestedEvidence || !deploymentSatisfiedForCompletion(delivery, requestedEvidence)) {
    return 'deployment_pending';
  }
  const deployment = evidence.deployment;
  if (!deployment) return 'deployment_pending';
  if (deployment.deployedCommit !== evidence.mergeCommit) return 'running_commit_mismatch';
  if (deployment.environment !== delivery.policy.deploymentEnvironment ||
      deployment.health !== 'healthy' || !deployment.originReachable || !deployment.runningVersion) {
    return 'deployment_unhealthy';
  }
  return undefined;
}

function deploymentSatisfiedForCompletion(
  delivery: TaskDeliveryRecord,
  evidence: Awaited<ReturnType<TaskDeliveryServiceDependencies['store']['appendEvidence']>>
) {
  const deployment = evidence.deployment;
  return Boolean(
    evidence.pullRequest?.state === 'merged' && evidence.mergeCommit && deployment &&
    deployment.deployedCommit === evidence.mergeCommit &&
    delivery.policy.kind === 'deployed_healthy' &&
    deployment.environment === delivery.policy.deploymentEnvironment &&
    deployment.health === 'healthy' && deployment.originReachable && deployment.runningVersion
  );
}

function completionPolicyMatches(delivery: TaskDeliveryRecord, request: CompleteTaskRequest) {
  return delivery.policy.kind === 'deployed_healthy'
    ? request.completionPolicy === 'verified_deployment'
    : request.completionPolicy === 'merged_pull_request';
}

function completionResult(
  result: TaskDeliveryMutationResult,
  request: CompleteTaskRequest
): TaskCompletionResult {
  if (result.state === 'uncertain') return result;
  return {
    ...result,
    completion: {
      evidence: request.evidence,
      policy: request.completionPolicy,
      state: result.state === 'completed' ? 'completed' : 'blocked'
    },
    task: { id: request.taskId, state: result.state === 'completed' ? 'completed' : 'open' }
  };
}
