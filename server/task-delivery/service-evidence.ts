import { randomUUID } from 'node:crypto';

import type {
  TaskCompletionPolicy,
  TaskDeliveryEvidence,
  TaskDeliveryProviderObservation,
  TaskDeliveryProviderTarget,
  TaskDeliveryRecord,
  TaskDeliveryRevisionReview,
  TaskDeliveryStoredObservation
} from './contracts';
import type { TaskDeliveryServiceDependencies } from './service-contracts';
import { TaskDeliveryTargetUnavailableError } from './service-contracts';
import { taskDeliveryFingerprint } from './service-context';

export async function ensureTaskDelivery(input: {
  completionPolicy: TaskCompletionPolicy | undefined;
  dependencies: TaskDeliveryServiceDependencies;
  executionId: string;
  observation: TaskDeliveryProviderObservation;
  ownerUserId: string;
  target: TaskDeliveryProviderTarget;
}): Promise<TaskDeliveryRecord> {
  const { dependencies, observation, target } = input;
  const existing = await dependencies.store.readByTarget(input.ownerUserId, target);
  if (existing) return existing;
  if (!input.completionPolicy) {
    throw new TaskDeliveryTargetUnavailableError();
  }
  const now = (dependencies.now ?? (() => new Date()))().toISOString();
  const record: TaskDeliveryRecord = {
    branch: target.branch,
    createdAt: now,
    id: (dependencies.createId ?? randomUUID)(),
    originExecutionId: input.executionId,
    ownerUserId: input.ownerUserId,
    policy: input.completionPolicy,
    providerKind: target.providerKind,
    repositoryId: target.repositoryId,
    taskId: target.taskId,
    updatedAt: now,
    version: 1
  };
  const written = await dependencies.store.ensure(record);
  if (written.kind === 'conflict') throw new TaskDeliveryTargetUnavailableError();
  return written.delivery;
}

export async function persistTaskDeliveryObservation(input: {
  delivery: TaskDeliveryRecord;
  dependencies: TaskDeliveryServiceDependencies;
  executionId: string;
  observation: TaskDeliveryProviderObservation;
  ownerUserId: string;
}): Promise<{ delivery: TaskDeliveryRecord; evidence: TaskDeliveryEvidence }> {
  let { delivery } = input;
  const providerPullRequest = input.observation.pullRequest?.number;
  if (providerPullRequest !== undefined && delivery.pullRequestNumber === undefined) {
    const bound = await input.dependencies.store.bindPullRequest({
      deliveryId: delivery.id,
      expectedVersion: delivery.version,
      ownerUserId: input.ownerUserId,
      pullRequestNumber: providerPullRequest,
      updatedAt: input.observation.observedAt
    });
    if (bound.kind === 'conflict') throw new TaskDeliveryTargetUnavailableError();
    delivery = bound.delivery;
  }
  if (delivery.pullRequestNumber !== providerPullRequest) {
    throw new TaskDeliveryTargetUnavailableError();
  }
  const stored = storedObservation(input.observation);
  const evidence = await input.dependencies.store.appendEvidence({
    ...stored,
    deliveryId: delivery.id,
    fingerprint: taskDeliveryFingerprint(stored),
    observingExecutionId: input.executionId,
    ownerUserId: input.ownerUserId
  });
  return { delivery, evidence };
}

export async function synchronizeTaskDeliveryReview(input: {
  delivery: TaskDeliveryRecord;
  dependencies: TaskDeliveryServiceDependencies;
  observation: TaskDeliveryProviderObservation;
  ownerUserId: string;
  review?: TaskDeliveryRevisionReview;
}) {
  const head = input.observation.pullRequest?.headCommit;
  const review = input.review ?? (head
    ? await input.dependencies.store.readReview(input.ownerUserId, input.delivery.id, head)
    : undefined);
  if (!review || !head || review.pullRequestHeadCommit !== head || review.state !== 'requested') {
    return review;
  }
  const state = input.observation.review.state;
  if (input.observation.review.commit !== head || !['approved', 'changes_requested'].includes(state)) {
    return review;
  }
  const decidedAt = input.observation.review.checkedAt ?? input.observation.observedAt;
  const result = await input.dependencies.store.decideReview({
    decidedAt,
    decidedBy: {
      id: input.observation.review.fingerprint ?? 'provider-verified-review',
      kind: 'provider'
    },
    deliveryId: input.delivery.id,
    ownerUserId: input.ownerUserId,
    pullRequestHeadCommit: head,
    reviewId: review.id,
    state: state === 'approved' ? 'approved' : 'rejected'
  });
  return result === 'conflict'
    ? review
    : input.dependencies.store.readReviewById(input.ownerUserId, input.delivery.id, review.id);
}

function storedObservation(
  observation: TaskDeliveryProviderObservation
): TaskDeliveryStoredObservation {
  return {
    checks: {
      commit: observation.checks.commit,
      ...(observation.checks.fingerprint ? { fingerprint: observation.checks.fingerprint } : {}),
      required: observation.checks.required.map(({ url: _, ...check }) => check),
      state: observation.checks.state
    },
    ...(observation.deployment ? {
      deployment: {
        deployedCommit: observation.deployment.deployedCommit,
        environment: observation.deployment.environment,
        health: observation.deployment.health,
        originFingerprint: observation.deployment.originFingerprint,
        originReachable: observation.deployment.originReachable,
        ...(observation.deployment.runningVersion
          ? { runningVersion: observation.deployment.runningVersion }
          : {})
      }
    } : {}),
    ...(observation.mergeCommit ? { mergeCommit: observation.mergeCommit } : {}),
    observedAt: observation.observedAt,
    preview: {
      ...(observation.preview.headCommit ? { headCommit: observation.preview.headCommit } : {}),
      state: observation.preview.state
    },
    ...(observation.pullRequest ? {
      pullRequest: {
        baseBranch: observation.pullRequest.baseBranch,
        draft: observation.pullRequest.draft,
        headCommit: observation.pullRequest.headCommit,
        number: observation.pullRequest.number,
        state: observation.pullRequest.state
      }
    } : {}),
    review: structuredClone(observation.review),
    sourceCommit: observation.sourceCommit,
    taskState: observation.taskState
  };
}
