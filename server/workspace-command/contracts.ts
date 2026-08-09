import type {
  WorkspaceCommandScope,
  WorkspaceCommandState
} from '../../src/shared/workspace-command-api';

interface StoredWorkspaceCommandBase {
  auditId: string;
  commandId: string;
  commandSha256: string;
  createdAt: string;
  environmentId: string;
  exitCode?: number;
  finishedAt?: string;
  maxOutputBytes: number;
  outputCursor: number;
  ownerUserId: string;
  scope: WorkspaceCommandScope;
  startOperationFingerprint: string;
  startOperationId: string;
  startedAt?: string;
  state: WorkspaceCommandState;
  stderr: string;
  stdout: string;
  timeoutSeconds: number;
  truncated: boolean;
  updatedAt: string;
}

export type StoredWorkspaceCommand = StoredWorkspaceCommandBase & (
  | {
      allowNetwork: boolean;
      connectorGeneration: number;
      connectorId: string;
      expectedHeadSha: string;
      executionId: string;
      projectId: string;
      providerKind?: never;
      providerResourceId?: never;
      repositoryWritable: boolean;
      scope: 'workspace';
      targetReference: string;
      workspaceId: string;
      workspaceWritable: boolean;
    }
  | {
      allowNetwork?: never;
      connectorGeneration?: never;
      connectorId?: never;
      expectedHeadSha?: never;
      executionId?: never;
      projectId?: never;
      providerKind: 'github_codespaces';
      providerResourceId: string;
      repositoryWritable?: never;
      scope: 'environment_recovery';
      targetReference?: never;
      workspaceId?: never;
      workspaceWritable?: never;
    }
);

export interface WorkspaceCommandStore {
  create(command: StoredWorkspaceCommand): Promise<'created' | 'replayed' | 'conflict'>;
  read(ownerUserId: string, commandId: string): Promise<StoredWorkspaceCommand | undefined>;
  update(input: {
    checkedAt: string;
    commandId: string;
    exitCode?: number;
    finishedAt?: string;
    ownerUserId: string;
    startedAt?: string;
    state: WorkspaceCommandState;
    stderr?: string;
    stdout?: string;
    truncated?: boolean;
  }): Promise<StoredWorkspaceCommand | undefined>;
}
