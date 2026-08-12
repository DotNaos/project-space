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
  authorize(input:
    | {
        actor: CanonicalRuntimeControlActor;
        operation: CanonicalRuntimeControlOperation;
        phase: 'coarse';
      }
    | {
        actor: CanonicalRuntimeControlActor;
        operation: CanonicalRuntimeControlOperation;
        phase: 'exact';
        target: CanonicalRuntimeControlTarget;
      }
  ): Promise<boolean>;
}

export interface CanonicalRuntimeControlDispatcher {
  replay(input: {
    actor: CanonicalRuntimeControlActor;
    fingerprint: string;
    request: CanonicalRuntimeControlRequest;
  }): Promise<CanonicalRuntimeControlResult | 'conflict' | 'in_progress' | undefined>;
  dispatch(input: {
    actor: CanonicalRuntimeControlActor;
    fingerprint: string;
    freshTarget(): Promise<CanonicalRuntimeControlTarget>;
    request: CanonicalRuntimeControlRequest;
    target: CanonicalRuntimeControlTarget;
  }): Promise<CanonicalRuntimeControlResult>;
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
