import type {
  CodexSessionReadResult,
  CodexSessionStreamEvent
} from './codex-sessions-api';

export const CODEX_MACHINE_TASKS_API_VERSION = 1 as const;
export const CODEX_MACHINE_TASKS_CONNECTOR_CAPABILITY = 'codex.machine-tasks.v1';
export const CODEX_MACHINE_TASKS_DURABLE_OPERATIONS_CAPABILITY =
  'codex.machine-tasks.durable-operations.v1';

export type CodexMachineTaskBlockedReason =
  | 'approval_required'
  | 'connector_required'
  | 'input_required'
  | 'offline'
  | 'stale_connector'
  | 'thread_active'
  | 'unauthorized'
  | 'worktree_failure';

export interface CodexMachineTaskTarget {
  connector: {
    environment?: string;
    generation: number;
    id: string;
    name: string;
  };
  physicalMachine: {
    id: string;
    name: string;
  };
}

export interface CodexMachineTaskIdentity extends CodexMachineTaskTarget {
  canonicalTaskUrl: string;
  issue: {
    number: number;
    url: string;
  };
  repository: {
    id: string;
    nameWithOwner: string;
  };
  threadId: string;
  worktree: {
    branch: string;
    id: string;
  };
}

export interface CodexMachineTaskStartRequest {
  connectorId?: string;
  dryRun?: boolean;
  issue: number;
  operationId: string;
  physicalMachineId?: string;
  physicalMachineName?: string;
  repositoryId?: string;
}

export interface CodexMachineTaskConnectorStartRequest {
  branch: string;
  commit: string;
  initialPrompt: string;
  issueNumber: number;
  issueUrl: string;
  machineId: string;
  operationId: string;
  physicalMachineId: string;
  projectId: string;
  repositoryId: string;
  repositoryNameWithOwner: string;
}

export type CodexMachineTaskConnectorStartResult =
  | {
      state: 'confirmed';
      threadId: string;
      worktreeId: string;
    }
  | {
      message: string;
      state: 'worktree_failure';
    }
  | { state: 'uncertain' };

export type CodexMachineTaskStartResult =
  | {
      apiVersion: typeof CODEX_MACHINE_TASKS_API_VERSION;
      operationId: string;
      state: 'ready';
      target: CodexMachineTaskTarget;
    }
  | {
      apiVersion: typeof CODEX_MACHINE_TASKS_API_VERSION;
      operationId: string;
      state: 'confirmed';
      task: CodexMachineTaskIdentity;
    }
  | CodexMachineTaskBlockedResult
  | CodexMachineTaskUncertainResult;

export interface CodexMachineTaskBlockedResult {
  apiVersion: typeof CODEX_MACHINE_TASKS_API_VERSION;
  message: string;
  operationId: string;
  reason: CodexMachineTaskBlockedReason;
  state: 'blocked';
  target?: Partial<CodexMachineTaskTarget>;
}

export interface CodexMachineTaskUncertainResult {
  apiVersion: typeof CODEX_MACHINE_TASKS_API_VERSION;
  message: string;
  operationId: string;
  reconcile: 'required';
  state: 'uncertain';
  target?: CodexMachineTaskTarget;
}

export interface CodexMachineTaskReadRequest {
  connectorId?: string;
  last?: number;
  physicalMachineId?: string;
  physicalMachineName?: string;
  threadId: string;
}

export type CodexMachineTaskReadResult =
  | {
      apiVersion: typeof CODEX_MACHINE_TASKS_API_VERSION;
      result: CodexSessionReadResult;
      state: 'confirmed';
      target: CodexMachineTaskTarget;
    }
  | Omit<CodexMachineTaskBlockedResult, 'operationId'>;

export interface CodexMachineTaskSendRequest extends CodexMachineTaskReadRequest {
  message: string;
  operationId: string;
  wait?: boolean;
}

export type CodexMachineTaskSendResult =
  | {
      apiVersion: typeof CODEX_MACHINE_TASKS_API_VERSION;
      operationId: string;
      result?: CodexSessionReadResult;
      state: 'accepted' | 'completed';
      target: CodexMachineTaskTarget;
      threadId: string;
      turnId: string;
    }
  | CodexMachineTaskBlockedResult
  | CodexMachineTaskUncertainResult;

export type CodexMachineTaskProgressEvent =
  | {
      apiVersion: typeof CODEX_MACHINE_TASKS_API_VERSION;
      event: CodexSessionStreamEvent;
      sequence?: number;
      type: 'progress';
    }
  | { result: CodexMachineTaskSendResult; type: 'result' };

export interface CodexMachineTaskAttachRequest extends CodexMachineTaskReadRequest {
  operationId: string;
}

export type CodexMachineTaskAttachResult =
  | {
      apiVersion: typeof CODEX_MACHINE_TASKS_API_VERSION;
      endpointPath?: string;
      expiresAt: string;
      operationId: string;
      socketPath?: string;
      state: 'confirmed';
      target: CodexMachineTaskTarget;
      threadId: string;
      tokenEnvironmentVariable?: string;
      transport: 'local-unix' | 'websocket-tunnel';
    }
  | CodexMachineTaskBlockedResult;
