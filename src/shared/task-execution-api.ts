export const TASK_EXECUTION_API_VERSION = 1 as const;

export type TaskHandoffMode = 'implement' | 'plan' | 'repair' | 'review';
export type TaskAgentKind = 'codex';

export interface TaskHandoffRequestedPermissions {
  delivery: 'none' | 'pull_request';
  network: 'none' | 'restricted' | 'open';
  repository: 'read' | 'write';
  task: 'read' | 'write';
  workspace: 'read' | 'write';
}

export interface TaskHandoffReference {
  id: string;
  revision: number;
}

export interface TaskHandoffArtifactRef {
  authorization: {
    kind: 'execution' | 'owner' | 'task';
    reference?: string;
  };
  digest: `sha256:${string}`;
  id: string;
  kind: 'decision' | 'design' | 'document' | 'other' | 'screenshot';
  mediaType: string;
  name: string;
  provenance: {
    kind: 'orchestrator' | 'provider' | 'user_upload';
    reference?: string;
  };
  sizeBytes: number;
  storage: {
    kind: 'github_attachment' | 'project_space_blob' | 'task_artifact';
    reference: string;
  };
  verification: {
    state: 'unavailable' | 'verified';
    verifiedAt?: string;
  };
}

export interface TaskHandoffRevision {
  acceptanceCriteria: string[];
  artifacts: TaskHandoffArtifactRef[];
  constraints: string[];
  context: string;
  createdAt: string;
  createdBy: {
    id: string;
    kind: 'agent' | 'human' | 'orchestrator';
  };
  decisions: string[];
  handoffId: string;
  objective: string;
  requestedMode: TaskHandoffMode;
  requestedPermissions: TaskHandoffRequestedPermissions;
  revision: number;
  taskId: string;
}

export type TaskExecutionState =
  | 'archived'
  | 'blocked'
  | 'cancelled'
  | 'completed'
  | 'delivering'
  | 'failed'
  | 'planned'
  | 'preparing_environment'
  | 'preparing_workspace'
  | 'running'
  | 'starting_agent'
  | 'uncertain'
  | 'verifying'
  | 'waiting_for_approval'
  | 'waiting_for_authorization'
  | 'waiting_for_connector'
  | 'waiting_for_input';

export type TaskExecutionBlockedReason =
  | 'agent_authorization_required'
  | 'agent_runtime_missing'
  | 'approval_required'
  | 'capacity_unavailable'
  | 'connector_required'
  | 'connector_stale'
  | 'delivery_unverified'
  | 'environment_not_running'
  | 'input_required'
  | 'provider_authorization_required'
  | 'required_check_failed'
  | 'review_required'
  | 'workspace_failure';

export interface TaskExecutionRecord {
  agent: { kind: TaskAgentKind };
  archivedAt?: string;
  blockedReason?: TaskExecutionBlockedReason;
  connectorBinding?: {
    connectorId: string;
    generation: number;
  };
  createdAt: string;
  environmentId: string;
  handoff: TaskHandoffReference;
  id: string;
  source: {
    branch: string;
    commit?: string;
    repositoryId: string;
    taskId: string;
  };
  state: TaskExecutionState;
  updatedAt: string;
  version: number;
}

export interface TaskExecutionExecutorBinding {
  agent: TaskAgentKind;
  createdAt: string;
  executionId: string;
  externalId: string;
  turnId?: string;
  updatedAt: string;
  version: number;
}

export type RunnerWorkspaceState =
  | 'failed'
  | 'missing'
  | 'preparing'
  | 'ready'
  | 'uncertain';

export interface RunnerWorkspaceRecord {
  branch: string;
  commit?: string;
  createdAt: string;
  executionId: string;
  id: string;
  kind: 'codespace' | 'worktree';
  repositoryId: string;
  state: RunnerWorkspaceState;
  target?: {
    kind: 'project_worktree';
    reference: string;
  };
  updatedAt: string;
  version: number;
}

export interface TaskExecutionEvent {
  actor?: { id: string; kind: 'agent' | 'human' | 'orchestrator' | 'system' };
  createdAt: string;
  cursor: number;
  executionId: string;
  handoffChange?: {
    from: TaskHandoffReference;
    to: TaskHandoffReference;
  };
  message?: string;
  state?: TaskExecutionState;
  type:
    | 'blocked'
    | 'created'
    | 'executor_bound'
    | 'handoff_updated'
    | 'state_changed'
    | 'workspace_bound';
}

export type TaskExecutionOperationState =
  | 'blocked'
  | 'completed'
  | 'confirmed'
  | 'dispatched'
  | 'reserved'
  | 'uncertain';

export interface TaskExecutionOperationRecord {
  action: string;
  createdAt: string;
  executionId?: string;
  expiresAt: string;
  fingerprint: string;
  operationId: string;
  result?: Record<string, unknown>;
  state: TaskExecutionOperationState;
  updatedAt: string;
}

export interface TaskExecutionCapacityLease {
  acquiredAt: string;
  environmentId: string;
  executionId: string;
  expiresAt: string;
  id: string;
  releasedAt?: string;
  state: 'active' | 'expired' | 'released';
}
