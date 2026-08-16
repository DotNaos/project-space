import type {
  CodexSessionApprovalRequest,
  CodexSessionContinueRequest,
  CodexSessionInspectRequest,
  CodexSessionInspectResult,
  CodexSessionInterruptRequest,
  CodexSessionListRequest,
  CodexSessionListResult,
  CodexSessionOperationResult,
  CodexSessionReadRequest,
  CodexSessionReadResult,
  CodexSessionSettingsRequest,
  CodexSessionStartRequest,
  CodexSessionStartResult,
  CodexSessionStreamEvent,
  CodexSessionUserInputResponse
} from './codex-sessions-api';

/** Advertised only after the generation-local controller reports ready. */
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
  targetThreadId?: string;
  workspaceId: string;
}

export type WorkspaceRuntimeCodexCommand = WorkspaceRuntimeCodexBinding & {
  type: 'runtime.codex.command';
} & (
  | { kind: 'approval'; request: CodexSessionApprovalRequest }
  | { kind: 'continue'; request: CodexSessionContinueRequest }
  | { kind: 'input'; request: CodexSessionUserInputResponse }
  | { kind: 'inspect'; request: CodexSessionInspectRequest }
  | { kind: 'interrupt'; request: CodexSessionInterruptRequest }
  | { kind: 'list'; request: CodexSessionListRequest }
  | { kind: 'read'; request: CodexSessionReadRequest }
  | { kind: 'settings'; request: CodexSessionSettingsRequest }
  | { kind: 'start'; request: CodexSessionStartRequest }
  | { kind: 'stream-start'; request: CodexSessionReadRequest & { afterSequence?: number } }
  | { kind: 'stream-stop'; request: { machineId: string; threadId: string } }
  | { kind: 'runtime-start'; request: { operationId: string } }
  | { kind: 'runtime-stop'; request: { operationId: string; reason?: string } }
);

export type WorkspaceRuntimeCodexResult =
  | CodexSessionInspectResult
  | CodexSessionListResult
  | CodexSessionOperationResult
  | CodexSessionReadResult
  | CodexSessionStartResult
  | { state: 'ready' | 'stopped' | 'streaming' };

export type WorkspaceRuntimeCodexMessage =
  | (WorkspaceRuntimeCodexBinding & {
      acceptedCommandSequence: number;
      replayed: boolean;
      type: 'runtime.codex.command-accepted';
    })
  | (WorkspaceRuntimeCodexBinding & {
      event: CodexSessionStreamEvent;
      eventSequence: number;
      type: 'runtime.codex.event';
    })
  | (WorkspaceRuntimeCodexBinding & {
      result: WorkspaceRuntimeCodexResult;
      type: 'runtime.codex.result';
    })
  | (WorkspaceRuntimeCodexBinding & {
      code: 'invalid_command' | 'runtime_stopping' | 'unavailable' | 'uncertain';
      message: string;
      type: 'runtime.codex.error';
    });
