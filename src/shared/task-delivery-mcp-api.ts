export const TASK_DELIVERY_MCP_API_VERSION = 1 as const;

export const taskDeliveryLifecycleStates = [
  'not_started', 'pull_request_draft', 'review_required', 'approval_required',
  'approved', 'changes_requested', 'checks_pending', 'merge_ready', 'merging',
  'merged', 'delivery_pending', 'delivered', 'completion_blocked', 'completed',
  'uncertain', 'failed'
] as const;
export type TaskDeliveryLifecycleState = (typeof taskDeliveryLifecycleStates)[number];

export const taskDeliveryOperationStates = ['completed', 'blocked', 'uncertain'] as const;
export type TaskDeliveryOperationState = (typeof taskDeliveryOperationStates)[number];

export const taskDeliveryBlockedReasons = [
  'target_unavailable', 'operation_conflict', 'provider_authorization_required',
  'unsupported_provider', 'pull_request_missing', 'pull_request_ambiguous',
  'head_mismatch', 'review_required', 'approval_required', 'approval_stale',
  'changes_requested', 'checks_pending', 'checks_failed', 'checks_unverified',
  'unresolved_review', 'merge_conflict', 'merge_queue_required',
  'delivery_unverified', 'deployment_pending', 'deployment_unhealthy',
  'running_commit_mismatch', 'completion_policy_mismatch',
  'completion_policy_unsatisfied'
] as const;
export type TaskDeliveryBlockedReason = (typeof taskDeliveryBlockedReasons)[number];

export const taskCompletionPolicies = [
  'merged_pull_request', 'verified_deployment'
] as const;
export type TaskCompletionPolicy = (typeof taskCompletionPolicies)[number];

export const taskPullRequestMergeMethods = ['merge', 'squash', 'rebase'] as const;
export type TaskPullRequestMergeMethod = (typeof taskPullRequestMergeMethods)[number];

export type GetTaskDeliveryStatusRequest =
  | { executionId: string; cursor?: never; limit?: never; taskId?: never }
  | { cursor?: string; executionId?: never; limit?: number; taskId: string };

export type TaskPullRequestPresentation =
  | { mode: 'generated' }
  | { body?: string; mode: 'provided'; title: string };

export interface CreateOrUpdateTaskPullRequestRequest {
  executionId: string;
  expectedHeadCommit: string;
  expectedPullRequestId?: string;
  operationId: string;
  presentation: TaskPullRequestPresentation;
  state: 'draft' | 'ready';
}

export interface RequestTaskReviewRequest {
  executionId: string;
  expectedHeadCommit: string;
  expectedPullRequestId: string;
  operationId: string;
  summary: string;
}

export interface MergeTaskPullRequestRequest {
  executionId: string;
  expectedApprovedRevision: string;
  expectedHeadCommit: string;
  expectedPullRequestId: string;
  mergeMethod: TaskPullRequestMergeMethod;
  operationId: string;
  reviewRequestId: string;
}

export interface CompleteTaskEvidenceReference {
  deliveryId: string;
  deploymentEvidenceIds?: string[];
  mergeOperationId: string;
}

export interface CompleteTaskRequest {
  completionPolicy: TaskCompletionPolicy;
  evidence: CompleteTaskEvidenceReference;
  executionId: string;
  operationId: string;
  taskId: string;
}

export interface TaskDeliveryPullRequestProjection {
  baseBranch: string;
  checkedAt: string;
  headCommit: string;
  id: string;
  number?: number;
  state: 'draft' | 'open' | 'closed' | 'merged';
  url?: string;
}

export interface TaskDeliveryReviewProjection {
  approvalUrl?: string;
  approvedAt?: string;
  id: string;
  requestedAt: string;
  revision: string;
  state: 'approval_required' | 'approved' | 'changes_requested' | 'stale';
}

export interface TaskDeliveryChecksProjection {
  checkedAt: string;
  checks: Array<{
    id: string;
    name: string;
    state: 'pending' | 'passing' | 'failing' | 'unavailable';
    url?: string;
  }>;
  commit: string;
  state: 'pending' | 'passing' | 'failing' | 'unverified';
}

export interface TaskDeliveryDeploymentProjection {
  checkedAt: string;
  environment: string;
  expectedCommit: string;
  health: 'healthy' | 'unhealthy' | 'unknown';
  id: string;
  origin?: string;
  runningCommit?: string;
  state: 'pending' | 'running' | 'failed' | 'unavailable';
  version?: string;
}

export interface TaskDeliveryProjection {
  branch: string;
  checkedAt: string;
  checks?: TaskDeliveryChecksProjection;
  deployments: TaskDeliveryDeploymentProjection[];
  executionId: string;
  headCommit?: string;
  id: string;
  merge?: {
    checkedAt: string;
    headCommit: string;
    mergeCommit?: string;
    state: 'not_started' | 'ready' | 'merging' | 'merged' | 'blocked' | 'uncertain' | 'failed';
  };
  preview?: {
    checkedAt: string;
    commit: string;
    state: 'not_required' | 'pending' | 'ready' | 'failed' | 'unavailable';
    url?: string;
  };
  pullRequest?: TaskDeliveryPullRequestProjection;
  repositoryId: string;
  review?: TaskDeliveryReviewProjection;
  rollback?: { available: boolean; checkedAt: string; commit?: string };
  state: TaskDeliveryLifecycleState;
  taskId: string;
  updatedAt: string;
}

export interface TaskDeliveryStatusResult {
  apiVersion: typeof TASK_DELIVERY_MCP_API_VERSION;
  deliveries: TaskDeliveryProjection[];
  nextCursor?: string;
}

export interface TaskDeliveryMutationResult {
  apiVersion: typeof TASK_DELIVERY_MCP_API_VERSION;
  blockedReason?: TaskDeliveryBlockedReason;
  delivery?: TaskDeliveryProjection;
  message: string;
  operationId: string;
  replayed: boolean;
  state: TaskDeliveryOperationState;
}

export interface TaskCompletionResult extends TaskDeliveryMutationResult {
  completion?: {
    completedAt?: string;
    evidence: CompleteTaskEvidenceReference;
    policy: TaskCompletionPolicy;
    state: 'blocked' | 'completed';
  };
  task?: { id: string; state: 'open' | 'completed' };
}
