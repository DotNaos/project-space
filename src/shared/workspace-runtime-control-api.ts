import type {
  CanonicalRuntimeControlOperation,
  CanonicalRuntimeControlOutputByOperation,
  CanonicalRuntimeControlRequest,
  CanonicalRuntimeControlSafeInput
} from './canonical-runtime-control-api';
import { canonicalRuntimeControlSafeInput } from './canonical-runtime-control-api';

interface WorkspaceRuntimeControlBinding {
  actorId: string;
  actorKind: 'agent' | 'human' | 'orchestrator' | 'system';
  actorUserId: string;
  commandId: string;
  commandSequence: number;
  environmentId: string;
  generation: string;
  operationId: string;
  schemaVersion: 1;
  sessionId: string;
  targetIdentityRevision: string;
  workspaceId: string;
}

type WorkspaceRuntimeControlInput = CanonicalRuntimeControlSafeInput;

export type WorkspaceRuntimeControlCommand = WorkspaceRuntimeControlBinding &
  WorkspaceRuntimeControlInput & {
    type: 'runtime.control.command';
  };

type WorkspaceRuntimeControlResultMessage = {
  [Operation in CanonicalRuntimeControlOperation]: WorkspaceRuntimeControlBinding & {
    eventSequence: number;
    operation: Operation;
    output: CanonicalRuntimeControlOutputByOperation[Operation];
    state: 'completed';
    type: 'runtime.control.result';
  }
}[CanonicalRuntimeControlOperation] | (WorkspaceRuntimeControlBinding & {
  eventSequence: number;
  operation: CanonicalRuntimeControlOperation;
  state: 'failed';
  type: 'runtime.control.result';
});

export type WorkspaceRuntimeControlMessage =
  | (WorkspaceRuntimeControlBinding & {
      acceptedCommandSequence: number;
      eventSequence: number;
      operation: CanonicalRuntimeControlOperation;
      replayed: boolean;
      type: 'runtime.control.command-accepted';
    })
  | WorkspaceRuntimeControlResultMessage
  | (WorkspaceRuntimeControlBinding & {
      code:
        | 'blocked_dependency'
        | 'invalid_command'
        | 'runtime_stopping'
        | 'unavailable'
        | 'uncertain';
      eventSequence: number;
      message: string;
      operation: CanonicalRuntimeControlOperation;
      type: 'runtime.control.error';
    });

export function runtimeControlInput(
  request: CanonicalRuntimeControlRequest
): WorkspaceRuntimeControlInput {
  return canonicalRuntimeControlSafeInput(request);
}
