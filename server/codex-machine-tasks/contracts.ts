import type {
  CodexMachineTaskSendResult,
  CodexMachineTaskStartPlan,
  CodexMachineTaskStartResult
} from '../../src/shared/codex-machine-tasks-api';
import type {
  CodexSessionOperationResult,
  CodexSessionReadResult,
  CodexSessionStreamEvent
} from '../../src/shared/codex-sessions-api';
import type { MachineRecord, PhysicalMachineRecord } from '../../src/shared/project-space-api';
import type { MachineRuntimeStatusResult } from '../../src/shared/connector-runtime-api';
import type { ComputeInventorySnapshot } from '../../src/shared/compute-environment-api';

export interface CodexMachineTaskStartPayload {
  branch: string;
  commit: string;
  issue: { number: number; url: string };
  repository: { id: string; nameWithOwner: string };
}

export interface CodexMachineTaskWorkspaceBinding {
  branch: string;
  commit: string;
  id: string;
  path?: string;
}

export interface CodexMachineTaskStartOperation {
  associationKey: string;
  connectorId: string;
  durableOperations: boolean;
  fingerprint: string;
  generation: number;
  operationId: string;
  physicalMachineId: string;
  result?: CodexMachineTaskStartResult;
  startPayload: CodexMachineTaskStartPayload;
  state: 'completed' | 'pending' | 'uncertain';
  userId: string;
}

export type CodexMachineTaskStartReservation =
  | { kind: 'new' }
  | { kind: 'conflict' }
  | { kind: 'fenced' }
  | {
      dispatchOperationId: string;
      durableOperations: boolean;
      generation: number;
      kind: 'pending';
      sameOperation: boolean;
      startPayload: CodexMachineTaskStartPayload;
    }
  | {
      dispatchOperationId: string;
      durableOperations: boolean;
      generation: number;
      kind: 'uncertain';
      sameOperation: boolean;
      startPayload: CodexMachineTaskStartPayload;
    }
  | { kind: 'replayed'; result: CodexMachineTaskStartResult };

export type CodexMachineTaskStartLookup =
  | { kind: 'missing' }
  | { kind: 'conflict' }
  | {
      connectorId: string;
      durableOperations: boolean;
      generation: number;
      kind: 'reserved';
      physicalMachineId: string;
      startPayload?: CodexMachineTaskStartPayload;
      state: 'pending' | 'uncertain';
    }
  | { kind: 'replayed'; result: CodexMachineTaskStartResult };

export type CodexMachineTaskAssociationLookup =
  | { kind: 'missing' }
  | { kind: 'pending' }
  | { kind: 'uncertain' }
  | { kind: 'confirmed'; result: CodexMachineTaskStartResult };

export interface CodexMachineTaskSendOperation {
  connectorId: string;
  delivery: 'auto' | 'new-turn' | 'queue' | 'steer';
  dispatchDelivery: 'new-turn' | 'steer';
  durableOperations: boolean;
  expectedTurnId?: string;
  fingerprint: string;
  generation: number;
  message: string;
  operationId: string;
  queuedResult?: Extract<CodexMachineTaskSendResult, { state: 'queued' }>;
  requestFingerprint: string;
  threadId: string;
  userId: string;
}

export interface CodexMachineTaskQueuedSend {
  dispatchAttempt: number;
  operation: CodexMachineTaskSendOperation;
  result: Extract<CodexMachineTaskSendResult, { state: 'queued' }>;
  state: 'pending' | 'queued' | 'uncertain';
}

export type CodexMachineTaskSendReservation =
  | { kind: 'new' }
  | { kind: 'conflict' }
  | { kind: 'fenced' }
  | {
      dispatchDelivery: 'new-turn' | 'steer';
      durableOperations: boolean;
      expectedTurnId?: string;
      generation: number;
      kind: 'pending';
    }
  | {
      dispatchDelivery: 'new-turn' | 'steer';
      durableOperations: boolean;
      expectedTurnId?: string;
      generation: number;
      kind: 'uncertain';
    }
  | {
      dispatchAttempt: number;
      kind: 'queued';
      result: Extract<CodexMachineTaskSendResult, { state: 'queued' }>;
      state: 'pending' | 'queued' | 'uncertain';
    }
  | { kind: 'replayed'; result: CodexMachineTaskSendResult };

export type CodexMachineTaskSendLookup =
  | { kind: 'missing' }
  | { kind: 'conflict' }
  | {
      dispatchAttempt: number;
      kind: 'queued';
      result: Extract<CodexMachineTaskSendResult, { state: 'queued' }>;
      state: 'pending' | 'queued' | 'uncertain';
    }
  | {
      connectorId: string;
      dispatchDelivery: 'new-turn' | 'steer';
      durableOperations: boolean;
      expectedTurnId?: string;
      generation: number;
      kind: 'reserved';
      state: 'pending' | 'uncertain';
    }
  | { kind: 'replayed'; result: CodexMachineTaskSendResult };

export interface CodexMachineTasksStore {
  completeSend(
    operation: CodexMachineTaskSendOperation,
    result: CodexMachineTaskSendResult
  ): Promise<void>;
  completeStart(
    operation: CodexMachineTaskStartOperation,
    result: CodexMachineTaskStartResult
  ): Promise<void>;
  markStartUncertain(operation: CodexMachineTaskStartOperation): Promise<void>;
  markSendUncertain(operation: CodexMachineTaskSendOperation): Promise<void>;
  queueSend(
    operation: CodexMachineTaskSendOperation,
    result: CodexMachineTaskSendResult
  ): Promise<void>;
  lookupStart(input: {
    fingerprint: string;
    operationId: string;
    userId: string;
  }): Promise<CodexMachineTaskStartLookup>;
  lookupSend(input: {
    connectorId: string;
    fingerprint: string;
    operationId: string;
    threadId: string;
    userId: string;
  }): Promise<CodexMachineTaskSendLookup>;
  lookupSendRequest(input: {
    fingerprint: string;
    operationId: string;
    userId: string;
  }): Promise<CodexMachineTaskSendLookup>;
  listQueuedSends(): Promise<CodexMachineTaskQueuedSend[]>;
  findStart?(input: {
    connectorId: string;
    issue: number;
    repositoryId: string;
    userId: string;
  }): Promise<CodexMachineTaskAssociationLookup>;
  releaseUncertainStart(input: {
    fingerprint: string;
    operationId: string;
    userId: string;
  }): Promise<'conflict' | 'missing' | 'not_uncertain' | 'released'>;
  releaseSend(operation: CodexMachineTaskSendOperation): Promise<void>;
  resumeQueuedSend(operation: CodexMachineTaskSendOperation): Promise<number | undefined>;
  rebindQueuedSend(
    operation: CodexMachineTaskSendOperation,
    generation: number
  ): Promise<boolean>;
  releaseStart(operation: CodexMachineTaskStartOperation): Promise<void>;
  reserveStart(operation: CodexMachineTaskStartOperation): Promise<CodexMachineTaskStartReservation>;
  reserveSend(operation: CodexMachineTaskSendOperation): Promise<CodexMachineTaskSendReservation>;
}

export interface CodexMachineTasksServiceOptions {
  attachments?: {
    issue(input: {
      callerMachineId: string;
      connectorId: string;
      generation: number;
      operationId: string;
      threadId: string;
      userId: string;
    }): { endpointPath: string; expiresAt: string; token: string };
  };
  generationFor(connectorId: string): number | undefined;
  durableGenerationFor?(connectorId: string, generation: number): boolean;
  inventory(userId: string): Promise<{
    computeInventory?: ComputeInventorySnapshot;
    connectors: MachineRecord[];
    physicalMachines: PhysicalMachineRecord[];
    runtimeStatuses?: ReadonlyMap<string, MachineRuntimeStatusResult>;
  }>;
  issue(input: {
    dryRun?: boolean;
    expectedBranch?: string;
    expectedCommit?: string;
    expectedPullRequestNumber?: number;
    issue: number;
    repositoryId?: string;
    userId: string;
  }): Promise<CodexMachineTaskStartPayload>;
  workspace?(input: {
    branch: string;
    commit: string;
    connectorId: string;
    generation: number;
    userId: string;
  }): Promise<CodexMachineTaskWorkspaceBinding>;
  plan?(input: {
    branch: string;
    commit: string;
    connectorId: string;
    generation: number;
    issue: { number: number; url: string };
    operationId: string;
    physicalMachineId: string;
    repository: { id: string; nameWithOwner: string };
    userId: string;
  }): Promise<{
    plan?: Pick<CodexMachineTaskStartPlan, 'workspace' | 'worktree' | 'environment'>;
    state: 'ready' | 'uncertain' | 'unavailable';
    message?: string;
  }>;
  queueRetryDelay?(): Promise<void>;
  sessions: {
    read(input: {
      connectorId: string;
      generation: number;
      threadId: string;
      userId: string;
    }): Promise<CodexSessionReadResult>;
    reconcileSend?(input: {
      connectorId: string;
      delivery: 'new-turn' | 'steer';
      durableOperations: boolean;
      expectedTurnId?: string;
      generation: number;
      message: string;
      operationId: string;
      threadId: string;
      userId: string;
    }): Promise<{
      generation: number;
      result: CodexSessionOperationResult;
    }>;
    send(input: {
      connectorId: string;
      delivery: 'new-turn' | 'steer';
      expectedTurnId?: string;
      generation: number;
      message: string;
      operationId: string;
      threadId: string;
      userId: string;
    }): Promise<CodexSessionOperationResult>;
    wait(input: {
      afterSequence?: number;
      connectorId: string;
      generation: number;
      start(): Promise<CodexSessionOperationResult>;
      threadId: string;
      userId: string;
    }): Promise<{
      event?: CodexSessionStreamEvent;
      result: CodexSessionOperationResult;
      sequence?: number;
    }>;
    stream?(input: {
      afterSequence?: number;
      connectorId: string;
      generation: number;
      emit(event: CodexSessionStreamEvent, sequence?: number): void;
      onReady?(): void;
      signal: AbortSignal;
      threadId: string;
      userId: string;
    }): Promise<void>;
  };
  start(input: {
    branch: string;
    commit: string;
    connectorId: string;
    durableOperations: boolean;
    generation: number;
    issue: { number: number; url: string };
    operationId: string;
    physicalMachineId: string;
    reconcile: boolean;
    repository: { id: string; nameWithOwner: string };
    userId: string;
  }): Promise<{
    generation: number;
    result:
      | {
          state: 'confirmed';
          threadId: string;
          worktreeId?: string;
          workspace?: {
            branch: string;
            commit: string;
            id: string;
            path?: string;
          };
        }
      | { message: string; state: 'codex_failure' }
      | { state: 'offline' }
      | { message: string; state: 'worktree_failure' }
      | { state: 'uncertain' };
  }>;
  store: CodexMachineTasksStore;
  taskUrl(connectorId: string, threadId: string): string;
  userCanUseConnector?(userId: string, connectorId: string): boolean;
}
