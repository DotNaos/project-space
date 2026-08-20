import type {
  CodexSessionReadResult,
  CodexSessionStreamEvent
} from './codex-sessions-api';

export const CODEX_MACHINE_TASKS_API_VERSION = 1 as const;
export const CODEX_MACHINE_TASKS_CONNECTOR_CAPABILITY = 'codex.machine-tasks.v1';
export const CODEX_AUTHORIZATION_REQUIRED_CONNECTOR_CAPABILITY =
  'codex.authorization-required.v1';
export const CODEX_RUNTIME_CONNECTOR_CAPABILITY = 'codex.runtime.v1';
export const CODEX_MACHINE_TASKS_DURABLE_OPERATIONS_CAPABILITY =
  'codex.machine-tasks.durable-operations.v1';

export type CodexMachineTaskBlockedReason =
  | 'approval_required'
  | 'codex_start_failed'
  | 'connector_required'
  | 'input_required'
  | 'machine_not_ready'
  | 'offline'
  | 'stale_connector'
  | 'thread_active'
  | 'unauthorized'
  | 'worktree_failure';

export type CodexMachineTaskMessageDelivery = 'auto' | 'new-turn' | 'queue' | 'steer';

export interface CodexMachineTaskTarget {
  connector: {
    environment?: string;
    generation: number;
    id: string;
    name: string;
  };
  environment?: {
    id: string;
    name: string;
  };
  /** @deprecated Compatibility projection for v1 clients. */
  physicalMachine: {
    id: string;
    name: string;
  };
}

export interface CodexMachineTaskIdentity extends CodexMachineTaskTarget {
  base?: {
    branch: string;
    commit: string;
  };
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
  workspace?: {
    branch: string;
    commit?: string;
    id: string;
    path?: string;
  };
  worktree?: {
    branch: string;
    id: string;
  };
}

export interface CodexMachineTaskStartRequest {
  connectorId?: string;
  environmentId?: string;
  dryRun?: boolean;
  expectedBranch?: string;
  expectedCommit?: string;
  expectedPullRequestNumber?: number;
  issue: number;
  operationId: string;
  physicalMachineId?: string;
  physicalMachineName?: string;
  repositoryId?: string;
}

export interface CodexMachineTaskExistingRequest {
  connectorId: string;
  issue: number;
  repositoryId: string;
}

export type CodexMachineTaskExistingResult =
  | {
      apiVersion: typeof CODEX_MACHINE_TASKS_API_VERSION;
      state: 'missing';
    }
  | {
      apiVersion: typeof CODEX_MACHINE_TASKS_API_VERSION;
      message: string;
      state: 'attention';
    }
  | {
      action: 'continue' | 'open-running' | 'resolve';
      apiVersion: typeof CODEX_MACHINE_TASKS_API_VERSION;
      session?: CodexSessionReadResult['session'];
      state: 'confirmed';
      task: CodexMachineTaskIdentity;
    };

export interface CodexMachineTaskStartRecoveryResult {
  apiVersion: typeof CODEX_MACHINE_TASKS_API_VERSION;
  operationId: string;
  state: 'released';
}

export interface CodexMachineTaskStartPlan {
  base: {
    branch: string;
    commit: string;
  };
  environment: {
    id: string;
    name: string;
  };
  issue: {
    number: number;
    url: string;
  };
  operation: {
    id: string;
    state: 'ready';
  };
  repository: {
    id: string;
    nameWithOwner: string;
  };
  workspace: {
    branch: string;
    commit: string;
    id: string;
    path?: string;
  };
  worktree?: {
    branch: string;
    id: string;
  };
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
      state: 'codex_failure';
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
      plan: CodexMachineTaskStartPlan;
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
  environmentId?: string;
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
  delivery?: CodexMachineTaskMessageDelivery;
  expectedTurnId?: string;
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
  | {
      apiVersion: typeof CODEX_MACHINE_TASKS_API_VERSION;
      operationId: string;
      queuedAt: string;
      state: 'queued';
      target: CodexMachineTaskTarget;
      threadId: string;
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
