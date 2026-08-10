import {
  TASK_DELIVERY_MCP_API_VERSION,
  type GetTaskDeliveryStatusRequest,
  type TaskDeliveryProjection,
  type TaskDeliveryStatusResult
} from '../../src/shared/task-delivery-mcp-api';
import type {
  TaskDeliveryEvidence,
  TaskDeliveryProviderObservation,
  TaskDeliveryRecord
} from './contracts';
import {
  decodeTaskDeliveryCursor,
  encodeTaskDeliveryCursor,
  loadTaskDeliveryContext
} from './service-context';
import { persistTaskDeliveryObservation, synchronizeTaskDeliveryReview } from './service-evidence';
import type {
  TaskDeliveryActor,
  TaskDeliveryServiceDependencies
} from './service-contracts';
import { projectTaskDelivery } from './service-projection';

export function createTaskDeliveryStatusReader(
  dependencies: TaskDeliveryServiceDependencies
) {
  return async function getStatus(
    actor: TaskDeliveryActor,
    request: GetTaskDeliveryStatusRequest
  ): Promise<TaskDeliveryStatusResult> {
    if (request.executionId) {
      const context = await loadTaskDeliveryContext(
        dependencies,
        actor,
        request.executionId,
        'read'
      );
      return {
        apiVersion: TASK_DELIVERY_MCP_API_VERSION,
        deliveries: context.delivery
          ? [await refreshProjection(dependencies, actor, context.delivery, request.executionId)]
          : []
      };
    }
    if (!request.taskId) {
      throw new Error('Select exactly one Task delivery target.');
    }
    const limit = request.limit ?? 50;
    const records = await dependencies.store.listByTask({
      before: decodeTaskDeliveryCursor(request.cursor),
      limit: limit + 1,
      ownerUserId: actor.userId,
      taskId: request.taskId
    });
    const page = records.slice(0, limit);
    return {
      apiVersion: TASK_DELIVERY_MCP_API_VERSION,
      deliveries: await Promise.all(page.map((delivery) => (
        refreshProjection(dependencies, actor, delivery, delivery.originExecutionId)
      ))),
      ...(records.length > limit && page.at(-1) ? {
        nextCursor: encodeTaskDeliveryCursor(page.at(-1)!)
      } : {})
    };
  };
}

export async function refreshProjection(
  dependencies: TaskDeliveryServiceDependencies,
  actor: TaskDeliveryActor,
  delivery: TaskDeliveryRecord,
  executionId: string
): Promise<TaskDeliveryProjection> {
  const provider = dependencies.providerFor(delivery.providerKind);
  let observation: TaskDeliveryProviderObservation | TaskDeliveryEvidence | undefined;
  let evidenceRevision: number | undefined;
  if (provider) {
    try {
      const fresh = await provider.observe(delivery);
      observation = fresh;
      const providerPullRequest = fresh.pullRequest?.number;
      if (delivery.pullRequestNumber === providerPullRequest) {
        const persisted = await persistTaskDeliveryObservation({
          delivery,
          dependencies,
          executionId,
          observation: fresh,
          ownerUserId: actor.userId
        });
        delivery = persisted.delivery;
        evidenceRevision = persisted.evidence.revision;
      }
    } catch {
      observation = undefined;
    }
  }
  if (!observation) {
    const stored = await dependencies.store.latestEvidence(actor.userId, delivery.id);
    observation = stored;
    evidenceRevision = stored?.revision;
  }
  const head = observation?.pullRequest?.headCommit;
  let review = head
    ? await dependencies.store.readReview(actor.userId, delivery.id, head)
    : undefined;
  if (observation && 'url' in (observation.pullRequest ?? {})) {
    review = await synchronizeTaskDeliveryReview({
      delivery,
      dependencies,
      observation: observation as TaskDeliveryProviderObservation,
      ownerUserId: actor.userId,
      review
    });
  }
  return projectTaskDelivery({ delivery, evidenceRevision, executionId, observation, review });
}
