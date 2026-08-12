import type {
  CodexSessionApprovalRequest,
  CodexSessionContinueRequest,
  CodexSessionInterruptRequest,
  CodexSessionOperationResult,
  CodexSessionReadResult,
  CodexSessionSettingsRequest,
  CodexSessionStreamEvent,
  CodexSessionUserInputResponse
} from './codex-sessions-api';

/** Reserved until a generation-local shared executor is available on the runtime host. */
export const workspaceRuntimeCodexCapability = 'runtime.codex.v1' as const;

interface WorkspaceRuntimeCodexBinding {
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

export type WorkspaceRuntimeCodexCommand = WorkspaceRuntimeCodexBinding & {
  type: 'runtime.codex.command';
} & (
  | { kind: 'approval'; request: CodexSessionApprovalRequest }
  | { kind: 'continue'; request: CodexSessionContinueRequest }
  | { kind: 'input'; request: CodexSessionUserInputResponse }
  | { kind: 'interrupt'; request: CodexSessionInterruptRequest }
  | { kind: 'settings'; request: CodexSessionSettingsRequest }
  | { kind: 'status'; request: { threadId: string } }
  | { kind: 'runtime-start'; request: { operationId: string } }
  | { kind: 'runtime-stop'; request: { operationId: string; reason?: string } }
);

export type WorkspaceRuntimeCodexMessage =
  | (WorkspaceRuntimeCodexBinding & {
      acceptedCommandSequence: number;
      type: 'runtime.codex.command-accepted';
    })
  | (WorkspaceRuntimeCodexBinding & {
      event: CodexSessionStreamEvent;
      eventSequence: number;
      type: 'runtime.codex.event';
    })
  | (WorkspaceRuntimeCodexBinding & {
      result: CodexSessionOperationResult;
      type: 'runtime.codex.result';
    })
  | (WorkspaceRuntimeCodexBinding & {
      result: CodexSessionReadResult;
      type: 'runtime.codex.status';
    })
  | (WorkspaceRuntimeCodexBinding & {
      code: 'invalid_command' | 'runtime_stopping' | 'unavailable' | 'uncertain';
      message: string;
      type: 'runtime.codex.error';
    });
