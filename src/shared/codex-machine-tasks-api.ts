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
export const CODEX_MACHINE_TASK_DEFAULT_MODEL = 'gpt-5.6-luna';
export const CODEX_MACHINE_TASK_DEFAULT_REASONING_EFFORT = 'high';
export const CODEX_MACHINE_TASK_WORKER_SELECTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

export function normalizeCodexMachineTaskWorker(input: {
  model?: unknown;
  reasoningEffort?: unknown;
}): CodexMachineTaskWorkerSelection | undefined {
  const model = typeof input.model === 'string' ? input.model.trim() : input.model;
  const reasoningEffort = typeof input.reasoningEffort === 'string'
    ? input.reasoningEffort.trim()
    : input.reasoningEffort;
  if (model !== undefined && model !== '' &&
      (typeof model !== 'string' || !CODEX_MACHINE_TASK_WORKER_SELECTOR_PATTERN.test(model))) return undefined;
  if (reasoningEffort !== undefined && reasoningEffort !== '' &&
      (typeof reasoningEffort !== 'string' || !CODEX_MACHINE_TASK_WORKER_SELECTOR_PATTERN.test(reasoningEffort))) return undefined;
  return {
    model: model || CODEX_MACHINE_TASK_DEFAULT_MODEL,
    reasoningEffort: reasoningEffort || CODEX_MACHINE_TASK_DEFAULT_REASONING_EFFORT
  };
}

export interface CodexMachineTaskWorkerSelection {
  model: string;
  reasoningEffort: string;
}

/** The initiating task bound to worker progress and escalations.
 *
 * `initiator` is the honest server-side binding. `project-manager` remains a
 * compatibility value for callers that have already passed the Project
 * Manager gate (the gate itself is enforced by the caller-side #819 context
 * check, not inferred from this header).
 */
export interface CodexMachineTaskReportingTask {
  role: 'initiator' | 'project-manager';
  threadId: string;
}

export const CODEX_MACHINE_TASK_LEGACY_UNBOUND_REASON = 'legacy_unbound' as const;

export type CodexMachineTaskBlockedReason =
  | 'approval_required'
  | 'codex_start_failed'
  | 'connector_required'
  | 'input_required'
  | typeof CODEX_MACHINE_TASK_LEGACY_UNBOUND_REASON
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
  handoff?: {
    state: 'accepted';
    turnId: string;
  };
  issue: {
    number: number;
    url: string;
  };
  repository: {
    id: string;
    nameWithOwner: string;
  };
  reportingTask?: CodexMachineTaskReportingTask;
  threadId: string;
  worker: CodexMachineTaskWorkerSelection;
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
  model?: string;
  operationId: string;
  physicalMachineId?: string;
  physicalMachineName?: string;
  repositoryId?: string;
  reasoningEffort?: string;
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
  reportingTask?: CodexMachineTaskReportingTask;
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
  worker: CodexMachineTaskWorkerSelection;
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
