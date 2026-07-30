import type {
  CodexMachineTaskSendResult,
  CodexMachineTaskStartResult
} from '../../src/shared/codex-machine-tasks-api';
import type {
  CodexSessionOperationResult,
  CodexSessionReadResult,
  CodexSessionStreamEvent
} from '../../src/shared/codex-sessions-api';
import type { MachineRecord, PhysicalMachineRecord } from '../../src/shared/project-space-api';
import type { MachineRuntimeStatusResult } from '../../src/shared/connector-runtime-api';

export interface CodexMachineTaskStartPayload {
  branch: string;
  commit: string;
  issue: { number: number; url: string };
  repository: { id: string; nameWithOwner: string };
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
  | { durableOperations: boolean; generation: number; kind: 'pending'; sameOperation: boolean }
  | { durableOperations: boolean; generation: number; kind: 'uncertain'; sameOperation: boolean }
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

export interface CodexMachineTaskSendOperation {
  connectorId: string;
  durableOperations: boolean;
  fingerprint: string;
  generation: number;
  operationId: string;
  threadId: string;
  userId: string;
}

export type CodexMachineTaskSendReservation =
  | { kind: 'new' }
  | { kind: 'conflict' }
  | { kind: 'fenced' }
  | { durableOperations: boolean; generation: number; kind: 'pending' }
  | { durableOperations: boolean; generation: number; kind: 'uncertain' }
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
  lookupStart(input: {
    fingerprint: string;
    operationId: string;
    userId: string;
  }): Promise<CodexMachineTaskStartLookup>;
  releaseSend(operation: CodexMachineTaskSendOperation): Promise<void>;
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
    connectors: MachineRecord[];
    physicalMachines: PhysicalMachineRecord[];
    runtimeStatuses?: ReadonlyMap<string, MachineRuntimeStatusResult>;
  }>;
  issue(input: {
    expectedBranch?: string;
    expectedCommit?: string;
    expectedPullRequestNumber?: number;
    issue: number;
    repositoryId?: string;
    userId: string;
  }): Promise<CodexMachineTaskStartPayload>;
  sessions: {
    read(input: {
      connectorId: string;
      generation: number;
      threadId: string;
      userId: string;
    }): Promise<CodexSessionReadResult>;
    reconcileSend?(input: {
      connectorId: string;
      durableOperations: boolean;
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
      | { state: 'confirmed'; threadId: string; worktreeId: string }
      | { state: 'offline' }
      | { message: string; state: 'worktree_failure' }
      | { state: 'uncertain' };
  }>;
  store: CodexMachineTasksStore;
  taskUrl(connectorId: string, threadId: string): string;
  userCanUseConnector?(userId: string, connectorId: string): boolean;
}
