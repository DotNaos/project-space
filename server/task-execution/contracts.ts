import type {
  RunnerWorkspaceRecord,
  TaskExecutionCapacityLease,
  TaskExecutionEvent,
  TaskExecutionExecutorBinding,
  TaskExecutionOperationRecord,
  TaskExecutionOperationState,
  TaskExecutionRecord,
  TaskExecutionState,
  TaskHandoffRevision
} from '../../src/shared/task-execution-api';

export interface StoredTaskHandoffRevision extends TaskHandoffRevision {
  fingerprint: string;
  ownerUserId: string;
}

export type TaskHandoffWriteResult =
  | { kind: 'conflict' }
  | { kind: 'created'; revision: StoredTaskHandoffRevision }
  | { kind: 'replayed'; revision: StoredTaskHandoffRevision };

export interface TaskHandoffStore {
  appendRevision(input: StoredTaskHandoffRevision): Promise<TaskHandoffWriteResult>;
  archive(ownerUserId: string, handoffId: string, archivedAt: string): Promise<boolean>;
  create(input: StoredTaskHandoffRevision): Promise<TaskHandoffWriteResult>;
  read(
    ownerUserId: string,
    handoffId: string,
    revision?: number
  ): Promise<StoredTaskHandoffRevision | undefined>;
}

export interface StoredTaskExecution extends TaskExecutionRecord {
  ownerUserId: string;
}

export interface TaskExecutionTransition {
  blockedReason?: TaskExecutionRecord['blockedReason'];
  expectedVersion: number;
  executionId: string;
  ownerUserId: string;
  state: TaskExecutionState;
  updatedAt: string;
}

export type TaskExecutionTransitionResult =
  | { kind: 'conflict'; current?: StoredTaskExecution }
  | { execution: StoredTaskExecution; kind: 'updated' };

export interface UpdateTaskExecutionHandoffInput {
  executionId: string;
  expectedVersion: number;
  handoff: TaskExecutionRecord['handoff'];
  ownerUserId: string;
  updatedAt: string;
}

export interface AppendTaskExecutionEventInput {
  actor?: TaskExecutionEvent['actor'];
  createdAt: string;
  executionId: string;
  handoffChange?: TaskExecutionEvent['handoffChange'];
  message?: string;
  ownerUserId: string;
  state?: TaskExecutionState;
  type: TaskExecutionEvent['type'];
}

export interface TaskExecutionStore {
  appendEvent(input: AppendTaskExecutionEventInput): Promise<TaskExecutionEvent>;
  archive(
    ownerUserId: string,
    executionId: string,
    expectedVersion: number,
    archivedAt: string
  ): Promise<TaskExecutionTransitionResult>;
  bindExecutor(
    ownerUserId: string,
    binding: TaskExecutionExecutorBinding
  ): Promise<'created' | 'replayed' | 'conflict'>;
  bindWorkspace(
    ownerUserId: string,
    workspace: RunnerWorkspaceRecord
  ): Promise<'created' | 'replayed' | 'conflict'>;
  create(input: StoredTaskExecution): Promise<'created' | 'replayed' | 'conflict'>;
  listEvents(
    ownerUserId: string,
    executionId: string,
    afterCursor?: number,
    limit?: number
  ): Promise<TaskExecutionEvent[]>;
  list(input: {
    agent?: StoredTaskExecution['agent']['kind'];
    before?: { createdAt: string; id: string };
    environmentId?: string;
    includeArchived: boolean;
    limit: number;
    ownerUserId: string;
    state?: TaskExecutionState;
    taskId?: string;
  }): Promise<StoredTaskExecution[]>;
  read(ownerUserId: string, executionId: string): Promise<StoredTaskExecution | undefined>;
  readByExecutor(
    ownerUserId: string,
    agent: TaskExecutionExecutorBinding['agent'],
    externalId: string
  ): Promise<StoredTaskExecution | undefined>;
  readExecutorBinding(
    ownerUserId: string,
    executionId: string
  ): Promise<TaskExecutionExecutorBinding | undefined>;
  readWorkspace(
    ownerUserId: string,
    executionId: string
  ): Promise<RunnerWorkspaceRecord | undefined>;
  updateExecutorTurn(input: {
    expectedVersion: number;
    executionId: string;
    ownerUserId: string;
    turnId: string;
    updatedAt: string;
  }): Promise<TaskExecutionExecutorBinding | undefined>;
  updateSource(input: {
    branch: string;
    commit: string;
    executionId: string;
    expectedVersion: number;
    ownerUserId: string;
    repositoryId: string;
    updatedAt: string;
  }): Promise<TaskExecutionTransitionResult>;
  updateWorkspace(input: {
    commit?: string;
    expectedVersion: number;
    executionId: string;
    ownerUserId: string;
    state: RunnerWorkspaceRecord['state'];
    updatedAt: string;
  }): Promise<RunnerWorkspaceRecord | undefined>;
  transition(input: TaskExecutionTransition): Promise<TaskExecutionTransitionResult>;
  updateConnectorBinding(input: {
    connectorBinding: NonNullable<TaskExecutionRecord['connectorBinding']>;
    executionId: string;
    expectedConnectorBinding?: TaskExecutionRecord['connectorBinding'];
    expectedVersion: number;
    ownerUserId: string;
    updatedAt: string;
  }): Promise<TaskExecutionTransitionResult>;
  updateHandoff(input: UpdateTaskExecutionHandoffInput): Promise<TaskExecutionTransitionResult>;
}

export interface ReserveTaskExecutionOperationInput {
  action: string;
  executionId?: string;
  fingerprint: string;
  operationId: string;
  ownerUserId: string;
  scopeKey?: string;
}

export type TaskExecutionOperationReservation =
  | { kind: 'conflict' }
  | { kind: 'in_progress'; operation: TaskExecutionOperationRecord }
  | { kind: 'new'; operation: TaskExecutionOperationRecord }
  | { kind: 'replayed'; operation: TaskExecutionOperationRecord };

export interface TaskExecutionOperationStore {
  claimDispatch(
    input: ReserveTaskExecutionOperationInput
  ): Promise<'claimed' | 'conflict' | 'in_progress'>;
  read(ownerUserId: string, operationId: string): Promise<TaskExecutionOperationRecord | undefined>;
  reserve(input: ReserveTaskExecutionOperationInput): Promise<TaskExecutionOperationReservation>;
  transition(input: {
    action: string;
    executionId?: string;
    fingerprint: string;
    ownerUserId: string;
    operationId: string;
    scopeKey?: string;
    state: Exclude<TaskExecutionOperationState, 'reserved'>;
    result?: Record<string, unknown>;
  }): Promise<TaskExecutionOperationRecord>;
}

export interface AcquireTaskExecutionCapacityInput {
  durationSeconds: number;
  environmentId: string;
  executionId: string;
  id: string;
  ownerUserId: string;
}

export type TaskExecutionCapacityReservation =
  | { kind: 'acquired' | 'replayed'; lease: TaskExecutionCapacityLease }
  | { kind: 'conflict'; lease: TaskExecutionCapacityLease }
  | { kind: 'unavailable'; lease: TaskExecutionCapacityLease };

export interface TaskExecutionCapacityStore {
  acquire(input: AcquireTaskExecutionCapacityInput): Promise<TaskExecutionCapacityReservation>;
  read(ownerUserId: string, environmentId: string): Promise<TaskExecutionCapacityLease | undefined>;
  release(
    ownerUserId: string,
    leaseId: string,
    executionId: string
  ): Promise<TaskExecutionCapacityLease | undefined>;
  renew(
    ownerUserId: string,
    leaseId: string,
    executionId: string,
    durationSeconds: number
  ): Promise<TaskExecutionCapacityLease | undefined>;
}
