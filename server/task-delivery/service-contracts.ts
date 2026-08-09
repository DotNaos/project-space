import type {
  CompleteTaskRequest,
  CreateOrUpdateTaskPullRequestRequest,
  GetTaskDeliveryStatusRequest,
  MergeTaskPullRequestRequest,
  RequestTaskReviewRequest,
  TaskCompletionResult,
  TaskDeliveryMutationResult,
  TaskDeliveryStatusResult
} from '../../src/shared/task-delivery-mcp-api';
import type { TaskExecutionOperationStore } from '../task-execution/contracts';
import type { TaskExecutionService } from '../task-execution/service';
import type {
  TaskCompletionPolicy,
  TaskDeliveryProvider,
  TaskDeliveryProviderTarget,
  TaskDeliveryStore
} from './contracts';

export interface TaskDeliveryActor {
  clientId?: string;
  userId: string;
}

export interface TaskDeliveryService {
  completeTask(
    actor: TaskDeliveryActor,
    request: CompleteTaskRequest
  ): Promise<TaskCompletionResult>;
  createOrUpdatePullRequest(
    actor: TaskDeliveryActor,
    request: CreateOrUpdateTaskPullRequestRequest
  ): Promise<TaskDeliveryMutationResult>;
  getStatus(
    actor: TaskDeliveryActor,
    request: GetTaskDeliveryStatusRequest
  ): Promise<TaskDeliveryStatusResult>;
  mergePullRequest(
    actor: TaskDeliveryActor,
    request: MergeTaskPullRequestRequest
  ): Promise<TaskDeliveryMutationResult>;
  requestReview(
    actor: TaskDeliveryActor,
    request: RequestTaskReviewRequest
  ): Promise<TaskDeliveryMutationResult>;
}

export interface TaskDeliveryServiceDependencies {
  completionPolicyFor(
    target: TaskDeliveryProviderTarget
  ): Promise<TaskCompletionPolicy | undefined>;
  createId?: () => string;
  now?: () => Date;
  operations: TaskExecutionOperationStore;
  providerFor(kind: string): TaskDeliveryProvider | undefined;
  store: TaskDeliveryStore;
  taskExecutions: Pick<TaskExecutionService, 'get' | 'getHandoff'>;
}

export class TaskDeliveryTargetUnavailableError extends Error {
  constructor() {
    super('The Task delivery target is unavailable.');
    this.name = 'TaskDeliveryTargetUnavailableError';
  }
}
