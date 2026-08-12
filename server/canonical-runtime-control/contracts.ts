import type { ComputeInventorySnapshot } from '../../src/shared/compute-environment-api';
import type {
  CanonicalRuntimeControlOperation,
  CanonicalRuntimeControlRequest,
  CanonicalRuntimeControlResult
} from '../../src/shared/canonical-runtime-control-api';
import type { WorkspaceRuntimeSessionSnapshot } from '../../src/shared/workspace-runtime-session-api';

export interface CanonicalRuntimeControlActor {
  actorId: string;
  actorKind: 'agent' | 'human' | 'orchestrator' | 'system';
  ownerUserId: string;
}

export interface CanonicalRuntimeControlTarget {
  environmentId: string;
  generation: string;
  sessionId: string;
  targetIdentityRevision: string;
  workspaceId: string;
}

export interface CanonicalRuntimeControlInventory {
  compute(ownerUserId: string): Promise<ComputeInventorySnapshot>;
  runtimes(ownerUserId: string): Promise<WorkspaceRuntimeSessionSnapshot[]>;
}

export interface CanonicalRuntimeControlAuthorizer {
  authorize(input: {
    actor: CanonicalRuntimeControlActor;
    operation: CanonicalRuntimeControlOperation;
    phase: 'target_resolution' | 'execution';
    target: Pick<CanonicalRuntimeControlTarget, 'environmentId' | 'workspaceId'>;
  }): Promise<boolean>;
}

export interface CanonicalRuntimeControlDispatcher {
  dispatch(input: {
    actor: CanonicalRuntimeControlActor;
    request: CanonicalRuntimeControlRequest;
    target: CanonicalRuntimeControlTarget;
  }): Promise<{
    output?: CanonicalRuntimeControlResult['output'];
    state: 'completed' | 'failed';
  }>;
}

export interface CanonicalRuntimeControlOperationRecord {
  fingerprint: string;
  result?: CanonicalRuntimeControlResult;
  state: 'dispatching' | 'finished' | 'uncertain';
}

export interface CanonicalRuntimeControlOperationStore {
  complete(ownerUserId: string, operationId: string, input: {
    fingerprint: string;
    result: CanonicalRuntimeControlResult;
  }): Promise<void>;
  markUncertain(ownerUserId: string, operationId: string, fingerprint: string): Promise<void>;
  reserve(ownerUserId: string, operationId: string, fingerprint: string): Promise<
    | { kind: 'conflict' }
    | { kind: 'new' }
    | { kind: 'replayed'; record: CanonicalRuntimeControlOperationRecord }
  >;
}

export class CanonicalRuntimeControlError extends Error {
  constructor(
    readonly code:
      | 'authorization_denied'
      | 'invalid_request'
      | 'operation_conflict'
      | 'operation_in_progress'
      | 'target_unavailable',
    message: string
  ) {
    super(message);
    this.name = 'CanonicalRuntimeControlError';
  }
}
