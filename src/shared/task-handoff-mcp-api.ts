import type {
  TaskHandoffArtifactRef,
  TaskHandoffMode,
  TaskHandoffRequestedPermissions,
  TaskHandoffRevision
} from './task-execution-api';
import type { GitHubTaskLocator, TaskExecutionProjection } from './task-execution-mcp-api';

export const TASK_HANDOFF_MCP_API_VERSION = 1 as const;

export interface InlineTaskHandoffArtifactInput {
  digest: `sha256:${string}`;
  id: string;
  kind: TaskHandoffArtifactRef['kind'];
  mediaType: string;
  name: string;
  sizeBytes: number;
  source: {
    data: string;
    encoding: 'base64' | 'utf8';
    kind: 'inline';
  };
}

export interface ExistingTaskHandoffArtifactInput {
  id: string;
  source: {
    artifactId: string;
    handoffId: string;
    kind: 'handoff';
    revision: number;
  };
}

export type TaskHandoffArtifactInput =
  | ExistingTaskHandoffArtifactInput
  | InlineTaskHandoffArtifactInput;

export interface CreateTaskHandoffRequest {
  acceptanceCriteria?: string[];
  artifacts?: TaskHandoffArtifactInput[];
  baseRevision?: number;
  constraints?: string[];
  context?: string;
  decisions?: string[];
  handoffId?: string;
  objective: string;
  operationId: string;
  requestedMode: TaskHandoffMode;
  requestedPermissions: TaskHandoffRequestedPermissions;
  task: GitHubTaskLocator;
}

export interface GetTaskHandoffRequest {
  handoffId: string;
  revision?: number;
}

export interface UpdateTaskExecutionHandoffRequest {
  executionId: string;
  handoffId: string;
  operationId: string;
  revision: number;
}

export interface TaskHandoffArtifactContent {
  data: string;
  encoding: 'base64' | 'utf8';
}

export interface TaskHandoffArtifactProjection extends TaskHandoffArtifactRef {
  content: TaskHandoffArtifactContent;
}

export interface TaskHandoffProjection extends Omit<TaskHandoffRevision, 'artifacts'> {
  artifacts: TaskHandoffArtifactProjection[];
}

export interface TaskHandoffResult {
  apiVersion: typeof TASK_HANDOFF_MCP_API_VERSION;
  handoff: TaskHandoffProjection;
  message: string;
  operationId?: string;
  replayed?: boolean;
}

export interface TaskExecutionHandoffUpdateResult {
  apiVersion: typeof TASK_HANDOFF_MCP_API_VERSION;
  execution: TaskExecutionProjection;
  message: string;
  operationId: string;
  replayed?: boolean;
  state: 'blocked' | 'updated';
}
