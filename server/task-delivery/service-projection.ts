import type {
  TaskDeliveryProjection,
  TaskDeliveryLifecycleState
} from '../../src/shared/task-delivery-mcp-api';
import type {
  TaskDeliveryEvidence,
  TaskDeliveryProviderObservation,
  TaskDeliveryRecord,
  TaskDeliveryRevisionReview,
  TaskDeliveryStoredObservation
} from './contracts';

type Observation = TaskDeliveryProviderObservation | TaskDeliveryEvidence;

export function projectTaskDelivery(input: {
  delivery: TaskDeliveryRecord;
  evidenceRevision?: number;
  executionId?: string;
  observation?: Observation;
  review?: TaskDeliveryRevisionReview;
}): TaskDeliveryProjection {
  const { delivery, observation, review } = input;
  const checkedAt = observation?.observedAt ?? delivery.updatedAt;
  const pullRequest = observation?.pullRequest;
  const headCommit = pullRequest?.headCommit ?? observation?.sourceCommit;
  const exactReview = Boolean(
    pullRequest && review && review.pullRequestHeadCommit === pullRequest.headCommit
  );
  const state = lifecycleState(delivery, observation, exactReview ? review : undefined);
  return {
    branch: delivery.branch,
    checkedAt,
    ...(observation ? { checks: projectChecks(observation) } : {}),
    deployments: observation?.deployment
      ? [projectDeployment(delivery, observation, input.evidenceRevision)]
      : [],
    executionId: input.executionId ?? delivery.originExecutionId,
    ...(headCommit ? { headCommit } : {}),
    id: delivery.id,
    ...(pullRequest ? {
      merge: {
        checkedAt,
        headCommit: pullRequest.headCommit,
        ...(observation.mergeCommit ? { mergeCommit: observation.mergeCommit } : {}),
        state: pullRequest.state === 'merged'
          ? 'merged' as const
          : state === 'merge_ready'
            ? 'ready' as const
            : state === 'uncertain'
              ? 'uncertain' as const
              : 'not_started' as const
      },
      pullRequest: {
        baseBranch: pullRequest.baseBranch,
        checkedAt,
        headCommit: pullRequest.headCommit,
        id: String(pullRequest.number),
        number: pullRequest.number,
        state: pullRequest.state === 'open' && pullRequest.draft
          ? 'draft' as const
          : pullRequest.state,
        ...(providerUrl(pullRequest) ? { url: providerUrl(pullRequest) } : {})
      }
    } : {}),
    ...(observation?.preview.headCommit ? {
      preview: {
        checkedAt,
        commit: observation.preview.headCommit,
        state: projectPreviewState(observation.preview.state),
        ...(providerUrl(observation.preview) ? { url: providerUrl(observation.preview) } : {})
      }
    } : {}),
    repositoryId: delivery.repositoryId,
    ...(exactReview && review ? {
      review: {
        ...(providerUrl(pullRequest) ? { approvalUrl: providerUrl(pullRequest) } : {}),
        ...(review.decidedAt ? { approvedAt: review.decidedAt } : {}),
        id: review.id,
        requestedAt: review.requestedAt,
        revision: review.pullRequestHeadCommit,
        state: review.state === 'approved'
          ? 'approved' as const
          : review.state === 'rejected'
            ? 'changes_requested' as const
            : 'approval_required' as const
      }
    } : review ? {
      review: {
        id: review.id,
        requestedAt: review.requestedAt,
        revision: review.pullRequestHeadCommit,
        state: 'stale' as const
      }
    } : {}),
    rollback: {
      available: Boolean(observation?.mergeCommit),
      checkedAt,
      ...(observation?.mergeCommit ? { commit: observation.mergeCommit } : {})
    },
    state,
    taskId: delivery.taskId,
    updatedAt: later(delivery.updatedAt, checkedAt)
  };
}

function lifecycleState(
  delivery: TaskDeliveryRecord,
  observation: Observation | undefined,
  review: TaskDeliveryRevisionReview | undefined
): TaskDeliveryLifecycleState {
  if (!observation) return 'not_started';
  const pullRequest = observation.pullRequest;
  if (observation.taskState === 'completed') {
    if (pullRequest?.state !== 'merged') return 'completion_blocked';
    if (delivery.policy.kind === 'deployed_healthy' &&
        !deploymentSatisfied(delivery, observation)) return 'completion_blocked';
    return 'completed';
  }
  if (!pullRequest) return 'not_started';
  if (pullRequest.state === 'merged') {
    if (delivery.policy.kind !== 'deployed_healthy') return 'merged';
    return deploymentSatisfied(delivery, observation) ? 'delivered' : 'delivery_pending';
  }
  if (pullRequest.state === 'closed') return 'failed';
  if (pullRequest.draft) return 'pull_request_draft';
  if (observation.review.state === 'changes_requested' || review?.state === 'rejected') {
    return 'changes_requested';
  }
  if (!review) return 'review_required';
  if (review.state !== 'approved' && observation.review.state !== 'approved') {
    return 'approval_required';
  }
  if (observation.checks.state === 'failing') return 'failed';
  if (observation.checks.state !== 'passing' || observation.checks.commit !== pullRequest.headCommit) {
    return 'checks_pending';
  }
  return 'merge_ready';
}

function projectChecks(observation: TaskDeliveryStoredObservation) {
  return {
    checkedAt: observation.observedAt,
    checks: observation.checks.required.map((check) => ({
      id: check.id,
      name: check.name,
      state: check.state,
      ...(providerUrl(check) ? { url: providerUrl(check) } : {})
    })),
    commit: observation.checks.commit,
    state: observation.checks.state === 'unavailable'
      ? 'unverified' as const
      : observation.checks.state
  };
}

function projectDeployment(
  delivery: TaskDeliveryRecord,
  observation: Observation,
  evidenceRevision?: number
) {
  const deployment = observation.deployment!;
  const exact = deployment.deployedCommit === observation.mergeCommit;
  return {
    checkedAt: observation.observedAt,
    environment: deployment.environment,
    expectedCommit: observation.mergeCommit ?? observation.sourceCommit,
    health: deployment.health === 'healthy' ? 'healthy' as const
      : deployment.health === 'unavailable' ? 'unknown' as const
        : 'unhealthy' as const,
    id: `${delivery.id}:${evidenceRevision ?? ('revision' in observation
      ? observation.revision : observation.observedAt)}:deployment`,
    ...(providerUrl(deployment) ? { origin: providerUrl(deployment) } : {}),
    runningCommit: deployment.deployedCommit,
    state: exact && deployment.health === 'healthy' && deployment.originReachable
      ? 'running' as const
      : deployment.health === 'unavailable'
        ? 'unavailable' as const
        : 'failed' as const,
    ...(deployment.runningVersion ? { version: deployment.runningVersion } : {})
  };
}

export function deploymentEvidenceId(deliveryId: string, evidence: TaskDeliveryEvidence) {
  return `${deliveryId}:${evidence.revision}:deployment`;
}

function deploymentSatisfied(delivery: TaskDeliveryRecord, observation: Observation) {
  const deployment = observation.deployment;
  return delivery.policy.kind === 'deployed_healthy' && Boolean(
    deployment && deployment.environment === delivery.policy.deploymentEnvironment &&
    deployment.deployedCommit === observation.mergeCommit && deployment.runningVersion &&
    deployment.health === 'healthy' && deployment.originReachable
  );
}

function projectPreviewState(state: TaskDeliveryStoredObservation['preview']['state']) {
  return state === 'superseded' ? 'unavailable' as const : state;
}

function providerUrl(value: object | undefined) {
  if (!value || !('url' in value) || typeof value.url !== 'string') return undefined;
  return value.url;
}

function later(left: string, right: string) {
  return left.localeCompare(right) >= 0 ? left : right;
}
