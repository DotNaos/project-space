export type TaskCompletionPolicy =
  | { kind: 'execution_verified' }
  | { kind: 'merged' }
  | { deploymentEnvironment: string; kind: 'deployed_healthy' };

export interface TaskDeliveryProviderTarget {
  branch: string;
  providerKind: string;
  repositoryId: string;
  taskId: string;
}

export interface TaskDeliveryDeploymentEvidence {
  deployedCommit: string;
  environment: string;
  health: 'healthy' | 'inconsistent' | 'unavailable' | 'unhealthy';
  originFingerprint: string;
  originReachable: boolean;
  runningVersion?: string;
}

export interface TaskDeliveryRequiredCheck {
  checkedAt: string;
  commit: string;
  id: string;
  name: string;
  requiredAppId?: number;
  state: 'failing' | 'passing' | 'pending';
}

export interface TaskDeliveryCheckEvidence {
  commit: string;
  fingerprint?: string;
  required: TaskDeliveryRequiredCheck[];
  state: 'failing' | 'passing' | 'pending' | 'unavailable';
}

export interface TaskDeliveryReviewEvidence {
  checkedAt?: string;
  commit?: string;
  fingerprint?: string;
  requestFingerprint?: string;
  state: 'approved' | 'changes_requested' | 'required' | 'unavailable';
  unresolvedThreads?: number;
}

export interface TaskDeliveryPullRequestEvidence {
  baseBranch: string;
  draft: boolean;
  headCommit: string;
  number: number;
  state: 'closed' | 'merged' | 'open';
}

export interface TaskDeliveryPreviewEvidence {
  headCommit?: string;
  state: 'failed' | 'pending' | 'ready' | 'superseded' | 'unavailable';
}

export interface TaskDeliveryStoredObservation {
  checks: TaskDeliveryCheckEvidence;
  deployment?: TaskDeliveryDeploymentEvidence;
  mergeCommit?: string;
  observedAt: string;
  preview: TaskDeliveryPreviewEvidence;
  pullRequest?: TaskDeliveryPullRequestEvidence;
  review: TaskDeliveryReviewEvidence;
  sourceCommit: string;
  taskState: 'completed' | 'open';
}

export interface TaskDeliveryProviderObservation
  extends Omit<TaskDeliveryStoredObservation, 'checks' | 'deployment' | 'preview' | 'pullRequest'> {
  checks: Omit<TaskDeliveryCheckEvidence, 'required'> & {
    required: Array<TaskDeliveryRequiredCheck & { url?: string }>;
  };
  completionPolicy?: TaskCompletionPolicy;
  deployment?: TaskDeliveryDeploymentEvidence & { origin?: string };
  preview: TaskDeliveryPreviewEvidence & { url?: string };
  pullRequest?: TaskDeliveryPullRequestEvidence & { url: string };
}

export type TaskDeliveryProviderMutationResult =
  | { kind: 'blocked'; reason: string }
  | { kind: 'confirmed'; observation: TaskDeliveryProviderObservation }
  | { kind: 'uncertain'; reason: string };

export interface TaskDeliveryProvider {
  completeTask(input: {
    expectedState: 'open';
    target: TaskDeliveryProviderTarget;
  }): Promise<TaskDeliveryProviderMutationResult>;
  createOrUpdatePullRequest(input: {
    body?: string;
    draft: boolean;
    expectedHeadCommit: string;
    title: string;
    target: TaskDeliveryProviderTarget;
  }): Promise<TaskDeliveryProviderMutationResult>;
  merge(input: {
    expectedHeadCommit: string;
    method: 'merge' | 'rebase' | 'squash';
    pullRequestNumber: number;
    target: TaskDeliveryProviderTarget;
  }): Promise<TaskDeliveryProviderMutationResult>;
  observe(target: TaskDeliveryProviderTarget): Promise<TaskDeliveryProviderObservation>;
  requestReview(input: {
    expectedHeadCommit: string;
    pullRequestNumber: number;
    summary: string;
    target: TaskDeliveryProviderTarget;
  }): Promise<TaskDeliveryProviderMutationResult>;
}

export interface TaskDeliveryRecord extends TaskDeliveryProviderTarget {
  createdAt: string;
  id: string;
  originExecutionId: string;
  ownerUserId: string;
  policy: TaskCompletionPolicy;
  pullRequestNumber?: number;
  updatedAt: string;
  version: number;
}

export interface TaskDeliveryEvidence extends TaskDeliveryStoredObservation {
  deliveryId: string;
  fingerprint: string;
  observingExecutionId: string;
  ownerUserId: string;
  revision: number;
}

export interface TaskDeliveryRevisionReview {
  decidedAt?: string;
  decidedBy?: { id: string; kind: 'human' | 'provider' };
  deliveryId: string;
  evidenceRevision: number;
  id: string;
  ownerUserId: string;
  pullRequestHeadCommit: string;
  pullRequestNumber: number;
  requestedAt: string;
  requestedBy: { id: string; kind: 'agent' | 'human' | 'orchestrator' };
  state: 'approved' | 'rejected' | 'requested';
  summaryFingerprint: string;
}

export type TaskDeliveryWriteResult =
  | { kind: 'conflict' }
  | { delivery: TaskDeliveryRecord; kind: 'created' | 'replayed' | 'updated' };

export interface TaskDeliveryStore {
  appendEvidence(input: Omit<TaskDeliveryEvidence, 'revision'>): Promise<TaskDeliveryEvidence>;
  bindPullRequest(input: {
    deliveryId: string;
    expectedVersion: number;
    ownerUserId: string;
    pullRequestNumber: number;
    updatedAt: string;
  }): Promise<TaskDeliveryWriteResult>;
  decideReview(input: {
    decidedAt: string;
    decidedBy: NonNullable<TaskDeliveryRevisionReview['decidedBy']>;
    deliveryId: string;
    ownerUserId: string;
    pullRequestHeadCommit: string;
    reviewId: string;
    state: 'approved' | 'rejected';
  }): Promise<'conflict' | 'replayed' | 'updated'>;
  ensure(input: TaskDeliveryRecord): Promise<TaskDeliveryWriteResult>;
  latestEvidence(
    ownerUserId: string,
    deliveryId: string
  ): Promise<TaskDeliveryEvidence | undefined>;
  listByTask(input: {
    before?: { createdAt: string; id: string };
    limit: number;
    ownerUserId: string;
    taskId: string;
  }): Promise<TaskDeliveryRecord[]>;
  readByExecution(
    ownerUserId: string,
    originExecutionId: string
  ): Promise<TaskDeliveryRecord | undefined>;
  readById(ownerUserId: string, deliveryId: string): Promise<TaskDeliveryRecord | undefined>;
  readByTarget(
    ownerUserId: string,
    target: TaskDeliveryProviderTarget
  ): Promise<TaskDeliveryRecord | undefined>;
  readReview(
    ownerUserId: string,
    deliveryId: string,
    pullRequestHeadCommit: string
  ): Promise<TaskDeliveryRevisionReview | undefined>;
  readReviewById(
    ownerUserId: string,
    deliveryId: string,
    reviewId: string
  ): Promise<TaskDeliveryRevisionReview | undefined>;
  requestReview(input: TaskDeliveryRevisionReview): Promise<'conflict' | 'created' | 'replayed'>;
}
