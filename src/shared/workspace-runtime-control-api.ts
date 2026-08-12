import type {
  CanonicalRuntimeControlOperation,
  CanonicalRuntimeControlPayloadValue
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
  workspaceId: string;
}

export type WorkspaceRuntimeControlCommand = WorkspaceRuntimeControlBinding & {
  operation: CanonicalRuntimeControlOperation;
  payload?: Record<string, CanonicalRuntimeControlPayloadValue>;
  type: 'runtime.control.command';
};

export type WorkspaceRuntimeControlMessage =
  | (WorkspaceRuntimeControlBinding & {
      acceptedCommandSequence: number;
      replayed: boolean;
      type: 'runtime.control.command-accepted';
    })
  | (WorkspaceRuntimeControlBinding & {
      output?: Record<string, CanonicalRuntimeControlPayloadValue>;
      state: 'completed' | 'failed';
      type: 'runtime.control.result';
    })
  | (WorkspaceRuntimeControlBinding & {
      code: 'invalid_command' | 'runtime_stopping' | 'unavailable' | 'uncertain';
      message: string;
      type: 'runtime.control.error';
    });
