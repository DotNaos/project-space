export const WORKSPACE_COMMAND_API_VERSION = 1 as const;

export type WorkspaceCommandState =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'uncertain'
  | 'unsupported';

export type WorkspaceCommandScope = 'workspace' | 'environment_recovery';

export interface StartWorkspaceCommandRequest {
  command: string;
  executionId: string;
  maxOutputBytes?: number;
  operationId: string;
  timeoutSeconds?: number;
}

export interface StartEnvironmentRecoveryCommandRequest {
  command: string;
  environmentId: string;
  maxOutputBytes?: number;
  operationId: string;
  timeoutSeconds?: number;
}

export interface GetWorkspaceCommandRequest {
  afterCursor?: number;
  commandId: string;
}

export interface CancelWorkspaceCommandRequest {
  commandId: string;
  operationId: string;
}

export interface WorkspaceCommandOutputChunk {
  cursor: number;
  stderr?: string;
  stdout?: string;
}

export interface WorkspaceCommandResult {
  apiVersion: typeof WORKSPACE_COMMAND_API_VERSION;
  auditId: string;
  checkedAt: string;
  commandId: string;
  environmentId: string;
  executionId?: string;
  exitCode?: number;
  finishedAt?: string;
  message: string;
  nextCursor: number;
  output: WorkspaceCommandOutputChunk[];
  scope: WorkspaceCommandScope;
  startedAt?: string;
  state: WorkspaceCommandState;
  target: {
    kind: 'connector_workspace' | 'github_codespace_recovery';
  };
  truncated: boolean;
}
