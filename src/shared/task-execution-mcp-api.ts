import type {
  RunnerWorkspaceRecord,
  TaskAgentKind,
  TaskExecutionBlockedReason,
  TaskExecutionEvent,
  TaskExecutionState,
  TaskHandoffMode,
  TaskHandoffReference
} from './task-execution-api';

export const TASK_EXECUTION_MCP_API_VERSION = 1 as const;

export interface GitHubTaskLocator {
  number: number;
  provider: 'github';
  repositoryId: string;
}

export interface InlineTaskHandoffDraft {
  acceptanceCriteria?: string[];
  constraints?: string[];
  context?: string;
  decisions?: string[];
  objective: string;
  requestedMode?: TaskHandoffMode;
}

export interface StartTaskExecutionRequest {
  agent?: TaskAgentKind;
  briefing?: InlineTaskHandoffDraft;
  dryRun?: boolean;
  environmentId: string;
  handoff?: TaskHandoffReference;
  operationId: string;
  task: GitHubTaskLocator;
}

export interface ListTaskExecutionsRequest {
  agent?: TaskAgentKind;
  cursor?: string;
  environmentId?: string;
  includeArchived?: boolean;
  limit?: number;
  state?: TaskExecutionState;
  taskId?: string;
}

export interface GetTaskExecutionRequest {
  afterCursor?: number;
  executionId: string;
  limit?: number;
}

export interface WaitTaskExecutionTarget {
  afterCursor?: number;
  executionId: string;
}

export interface WaitTaskExecutionRequest {
  executions: WaitTaskExecutionTarget[];
  timeoutSeconds?: number;
}

export interface TaskExecutionMutationRequest {
  executionId: string;
  operationId: string;
}

export type TaskExecutionMessageDelivery = 'auto' | 'new-turn' | 'queue' | 'steer';

export interface SendTaskExecutionMessageRequest extends TaskExecutionMutationRequest {
  delivery?: TaskExecutionMessageDelivery;
  expectedTurnId?: string;
  message: string;
  wait?: boolean;
}

export interface RespondTaskExecutionApprovalRequest extends TaskExecutionMutationRequest {
  approvalId?: string;
  decision: 'allow-once' | 'deny';
  itemId?: string;
  requestId: string;
  turnId: string;
}

export interface TaskExecutionInputAnswer {
  questionId: string;
  value: string;
}

export interface RespondTaskExecutionInputRequest extends TaskExecutionMutationRequest {
  answers: TaskExecutionInputAnswer[];
  requestId: string;
  turnId: string;
}

export interface CancelTaskExecutionRequest extends TaskExecutionMutationRequest {
  reason?: string;
}

export interface ArchiveTaskExecutionRequest extends TaskExecutionMutationRequest {}

export interface TaskExecutionSourceProjection {
  branch: string;
  commit?: string;
  provider: 'github';
  providerTaskId: string;
  repositoryId: string;
  taskId: string;
}

export interface TaskExecutionAttentionProjection {
  kind: 'approval' | 'input';
  state: 'required';
}

export interface TaskExecutionConversationItem {
  detail?: string;
  id: string;
  images?: Array<{ id: string; mediaType: 'image/jpeg' | 'image/png' }>;
  kind: string;
  status?: string;
  text?: string;
}

export interface TaskExecutionConversationTurn {
  completedAt?: string;
  id: string;
  items: TaskExecutionConversationItem[];
  startedAt?: string;
  status: string;
}

export interface TaskExecutionActivityProjection {
  checkedAt: string;
  cursor?: number;
  pendingRequests?: TaskExecutionAttentionRequestProjection[];
  session: {
    attention?: 'approval' | 'input';
    lastActivityAt: string;
    status: string;
    title: string;
  };
  turns: TaskExecutionConversationTurn[];
}

export type TaskExecutionAttentionRequestProjection =
  | {
      approvalId?: string;
      canAllow?: boolean;
      command?: string;
      itemId?: string;
      kind: 'command' | 'file-change' | 'permissions';
      permissionSummary?: string[];
      requestId: string;
      turnId: string;
      type: 'approval';
    }
  | {
      questions: Array<{
        choices?: Array<{ label: string; value: string }>;
        id: string;
        prompt: string;
      }>;
      requestId: string;
      turnId: string;
      type: 'input';
    };

export interface TaskExecutionProjection {
  agent: TaskAgentKind;
  attention?: TaskExecutionAttentionProjection;
  blockedReason?: TaskExecutionBlockedReason;
  connector?: { generation: number; id: string };
  createdAt: string;
  environmentId: string;
  executor?: { externalId: string; turnId?: string };
  handoff: TaskHandoffReference;
  id: string;
  source: TaskExecutionSourceProjection;
  state: TaskExecutionState;
  updatedAt: string;
  version: number;
  workspace?: Pick<
    RunnerWorkspaceRecord,
    'branch' | 'commit' | 'id' | 'kind' | 'repositoryId' | 'state'
  >;
}

export interface TaskExecutionResult {
  activity?: TaskExecutionActivityProjection;
  apiVersion: typeof TASK_EXECUTION_MCP_API_VERSION;
  events: TaskExecutionEvent[];
  execution: TaskExecutionProjection;
  message: string;
  nextCursor?: number;
  operationId?: string;
  replayed?: boolean;
}

export interface TaskExecutionListResult {
  apiVersion: typeof TASK_EXECUTION_MCP_API_VERSION;
  executions: TaskExecutionProjection[];
  nextCursor?: string;
}

export interface TaskExecutionDryRunResult {
  apiVersion: typeof TASK_EXECUTION_MCP_API_VERSION;
  blockedReason?: TaskExecutionBlockedReason;
  dryRun: true;
  environmentId: string;
  handoff: { kind: 'existing' | 'generated' | 'inline' };
  message: string;
  operationId: string;
  prerequisites: {
    agentAuthorization: string;
    agentRuntime: string;
    capacity: string;
    connector: string;
    environment: string;
    providerLifecycle: string;
  };
  source: TaskExecutionSourceProjection;
  state: 'blocked' | 'ready';
}

export interface TaskExecutionWaitResult {
  apiVersion: typeof TASK_EXECUTION_MCP_API_VERSION;
  executions: TaskExecutionResult[];
  timedOut: boolean;
}
