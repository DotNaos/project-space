import type { AgentRuntimeService } from '../agent-authorization/service';
import type { ConfiguredCodexMachineTasksRuntime } from '../codex-machine-tasks/configured-runtime';
import type { ConfiguredComputeInventoryResult } from '../configured-compute-inventory';
import type { ExecutionEnvironmentLifecycleService } from '../execution-environment-lifecycle/service';
import type {
  ArchiveTaskExecutionRequest,
  CancelTaskExecutionRequest,
  GetTaskExecutionRequest,
  ListTaskExecutionsRequest,
  RespondTaskExecutionApprovalRequest,
  RespondTaskExecutionInputRequest,
  SendTaskExecutionMessageRequest,
  StartTaskExecutionRequest,
  TaskExecutionDryRunResult,
  TaskExecutionListResult,
  TaskExecutionResult,
  TaskExecutionWaitResult,
  WaitTaskExecutionRequest
} from '../../src/shared/task-execution-mcp-api';
import type {
  StoredTaskExecution,
  TaskExecutionCapacityStore,
  TaskExecutionOperationStore,
  TaskExecutionStore,
  TaskHandoffStore
} from './contracts';
import type { TaskExecutionSourceProvider } from './source-provider';

export interface TaskExecutionActor {
  userId: string;
}

export interface TaskExecutionService {
  archive(actor: TaskExecutionActor, request: ArchiveTaskExecutionRequest): Promise<TaskExecutionResult>;
  cancel(actor: TaskExecutionActor, request: CancelTaskExecutionRequest): Promise<TaskExecutionResult>;
  get(actor: TaskExecutionActor, request: GetTaskExecutionRequest): Promise<TaskExecutionResult>;
  list(actor: TaskExecutionActor, request: ListTaskExecutionsRequest): Promise<TaskExecutionListResult>;
  readByExecutor(
    actor: TaskExecutionActor,
    agent: 'codex',
    externalId: string,
    afterCursor?: number,
    limit?: number
  ): Promise<TaskExecutionResult | undefined>;
  respondApproval(
    actor: TaskExecutionActor,
    request: RespondTaskExecutionApprovalRequest
  ): Promise<TaskExecutionResult>;
  respondInput(
    actor: TaskExecutionActor,
    request: RespondTaskExecutionInputRequest
  ): Promise<TaskExecutionResult>;
  send(actor: TaskExecutionActor, request: SendTaskExecutionMessageRequest): Promise<TaskExecutionResult>;
  start(
    actor: TaskExecutionActor,
    request: StartTaskExecutionRequest
  ): Promise<TaskExecutionDryRunResult | TaskExecutionResult>;
  wait(actor: TaskExecutionActor, request: WaitTaskExecutionRequest): Promise<TaskExecutionWaitResult>;
}

export interface TaskExecutionServiceDependencies {
  agentRuntime: AgentRuntimeService;
  capacity: TaskExecutionCapacityStore;
  codex: ConfiguredCodexMachineTasksRuntime;
  environmentLifecycle: ExecutionEnvironmentLifecycleService;
  handoffs: TaskHandoffStore;
  loadInventory(userId: string): Promise<ConfiguredComputeInventoryResult>;
  now?: () => Date;
  operations: TaskExecutionOperationStore;
  source: TaskExecutionSourceProvider;
  store: TaskExecutionStore;
}

export interface LoadedTaskExecution {
  execution: StoredTaskExecution;
  runtime: ConfiguredCodexMachineTasksRuntime;
}

export class TaskExecutionConflictError extends Error {
  constructor(message = 'The operation ID was already used for different input.') {
    super(message);
    this.name = 'TaskExecutionConflictError';
  }
}

export class TaskExecutionNotFoundError extends Error {
  constructor() {
    super('The Task Execution was not found.');
    this.name = 'TaskExecutionNotFoundError';
  }
}
