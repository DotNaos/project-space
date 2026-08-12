import type {
  CanonicalRuntimeControlAccessMode,
  CanonicalRuntimeControlOperation,
  CanonicalRuntimeControlResult,
  CanonicalRuntimeControlSafeInput
} from '../../src/shared/canonical-runtime-control-api';

export type CanonicalRuntimeControlOperationState =
  | 'blocked_dependency'
  | 'reserved'
  | 'dispatching'
  | 'completed'
  | 'failed'
  | 'uncertain';

export type CanonicalRuntimeControlFailureCode =
  | 'authorization_denied'
  | 'blocked_dependency'
  | 'dispatch_outcome_unknown'
  | 'invalid_request'
  | 'runtime_failed'
  | 'runtime_stopping'
  | 'target_changed'
  | 'target_unavailable'
  | 'unavailable';

export interface CanonicalRuntimeControlOperationIdentity {
  actorId: string;
  actorKind: 'agent' | 'human' | 'orchestrator' | 'system';
  actorUserId: string;
  accessMode: CanonicalRuntimeControlAccessMode;
  compatibilityAlias: boolean;
  environmentId: string;
  generation: string;
  operation: CanonicalRuntimeControlOperation;
  operationId: string;
  ownerUserId: string;
  safeInput: CanonicalRuntimeControlSafeInput;
  sessionId: string;
  targetIdentityRevision: string;
  workspaceId: string;
}

export interface CanonicalRuntimeControlCommandCorrelation {
  commandId: string;
  commandSequence: number;
}

export interface CanonicalRuntimeControlOperationRecord {
  acceptedCommandSequence?: number;
  acceptedEventSequence?: number;
  command?: CanonicalRuntimeControlCommandCorrelation;
  completedAt?: string;
  failureCode?: CanonicalRuntimeControlFailureCode;
  fingerprint: string;
  identity: CanonicalRuntimeControlOperationIdentity;
  result?: CanonicalRuntimeControlResult;
  resultEventSequence?: number;
  state: CanonicalRuntimeControlOperationState;
}

export interface CanonicalRuntimeControlReservationInput {
  fingerprint: string;
  identity: CanonicalRuntimeControlOperationIdentity;
  reservedAt: string;
  reservedUntil: string;
}

export type CanonicalRuntimeControlReservationResult =
  | { kind: 'conflict' | 'in_progress' }
  | { kind: 'new'; record: CanonicalRuntimeControlOperationRecord }
  | { kind: 'replayed'; record: CanonicalRuntimeControlOperationRecord };

export interface CanonicalRuntimeControlTerminalInput {
  command: CanonicalRuntimeControlCommandCorrelation;
  completedAt: string;
  failureCode?: Exclude<CanonicalRuntimeControlFailureCode, 'dispatch_outcome_unknown'>;
  fingerprint: string;
  identity: CanonicalRuntimeControlOperationIdentity;
  result: CanonicalRuntimeControlResult;
  resultEventSequence: number;
}

export interface CanonicalRuntimeControlPredispatchFailureInput {
  completedAt: string;
  failureCode: Exclude<CanonicalRuntimeControlFailureCode,
    'dispatch_outcome_unknown' | 'runtime_failed' | 'runtime_stopping'>;
  fingerprint: string;
  identity: CanonicalRuntimeControlOperationIdentity;
  result: CanonicalRuntimeControlResult & { state: 'failed' };
}

export interface CanonicalRuntimeControlOperationStore {
  accept(input: {
    acceptedAt: string;
    acceptedCommandSequence: number;
    command: CanonicalRuntimeControlCommandCorrelation;
    eventSequence: number;
    fingerprint: string;
    identity: CanonicalRuntimeControlOperationIdentity;
  }): Promise<CanonicalRuntimeControlOperationRecord>;
  complete(input: CanonicalRuntimeControlTerminalInput): Promise<CanonicalRuntimeControlOperationRecord>;
  failReserved(input: CanonicalRuntimeControlPredispatchFailureInput): Promise<
    CanonicalRuntimeControlOperationRecord
  >;
  markDispatchAttempted(input: {
    commandId: string;
    dispatchedAt: string;
    dispatchedUntil: string;
    fingerprint: string;
    identity: CanonicalRuntimeControlOperationIdentity;
  }): Promise<CanonicalRuntimeControlOperationRecord>;
  markUncertain(input: {
    command: CanonicalRuntimeControlCommandCorrelation;
    completedAt: string;
    fingerprint: string;
    identity: CanonicalRuntimeControlOperationIdentity;
    resultEventSequence?: number;
  }): Promise<CanonicalRuntimeControlOperationRecord>;
  read(ownerUserId: string, operationId: string): Promise<
    CanonicalRuntimeControlOperationRecord | undefined
  >;
  rebindSession(input: {
    command: CanonicalRuntimeControlCommandCorrelation;
    fingerprint: string;
    identity: CanonicalRuntimeControlOperationIdentity;
    sessionId: string;
  }): Promise<CanonicalRuntimeControlOperationRecord>;
  reconcile(input: CanonicalRuntimeControlTerminalInput): Promise<CanonicalRuntimeControlOperationRecord>;
  reserve(input: CanonicalRuntimeControlReservationInput): Promise<
    CanonicalRuntimeControlReservationResult
  >;
  unresolved(ownerUserId: string, workspaceId: string, generation: string): Promise<
    CanonicalRuntimeControlOperationRecord[]
  >;
  watermarks(ownerUserId: string, workspaceId: string, generation: string): Promise<{
    commandSequence: number;
    eventSequence: number;
  } | undefined>;
}
