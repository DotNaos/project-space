import { createTaskDeliveryMutations } from './service-mutations';
import { createTaskDeliveryStatusReader } from './service-status';
import type {
  TaskDeliveryService,
  TaskDeliveryServiceDependencies
} from './service-contracts';

export type {
  TaskDeliveryActor,
  TaskDeliveryService,
  TaskDeliveryServiceDependencies
} from './service-contracts';
export { TaskDeliveryTargetUnavailableError } from './service-contracts';

export function createTaskDeliveryService(
  dependencies: TaskDeliveryServiceDependencies
): TaskDeliveryService {
  const mutations = createTaskDeliveryMutations(dependencies);
  return {
    completeTask: mutations.completeTask,
    createOrUpdatePullRequest: mutations.createOrUpdatePullRequest,
    getStatus: createTaskDeliveryStatusReader(dependencies),
    mergePullRequest: mutations.mergePullRequest,
    requestReview: mutations.requestReview
  };
}
