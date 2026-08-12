import type {
  CanonicalRuntimeControlOperation,
  CanonicalRuntimeControlOutputByOperation,
  CanonicalRuntimeControlRequest
} from './canonical-runtime-control-api';

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

type WorkspaceRuntimeControlInput =
  | { operation: 'git.status' }
  | { operation: 'git.diff'; staged: boolean }
  | { operation: 'worktree.list' }
  | { operation: 'dev-server.inspect' };

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
      code: 'invalid_command' | 'runtime_stopping' | 'unavailable' | 'uncertain';
      eventSequence: number;
      message: string;
      operation: CanonicalRuntimeControlOperation;
      type: 'runtime.control.error';
    });

export function runtimeControlInput(
  request: CanonicalRuntimeControlRequest
): WorkspaceRuntimeControlInput {
  return request.operation === 'git.diff'
    ? { operation: request.operation, staged: request.staged }
    : { operation: request.operation };
}
