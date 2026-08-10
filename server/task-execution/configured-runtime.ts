import type { ProjectSpaceBackend } from '../../src/shared/project-space-api';
import type { AgentRuntimeService } from '../agent-authorization/service';
import type { ConfiguredCodexMachineTasksRuntime } from '../codex-machine-tasks/configured-runtime';
import { loadConfiguredComputeInventory } from '../configured-compute-inventory';
import type { DatabaseQueryClient } from '../database/client';
import type { ExecutionEnvironmentLifecycleService } from '../execution-environment-lifecycle/service';
import { getMachineConnectionDatabaseClient } from '../local-database-store';
import { PostgresTaskExecutionCapacityStore } from './capacity-store';
import {
  PostgresTaskHandoffArtifactBlobStore,
  type TaskHandoffArtifactBlobStore
} from './artifact-store';
import type {
  TaskExecutionCapacityStore,
  TaskExecutionOperationStore,
  TaskExecutionStore,
  TaskHandoffStore
} from './contracts';
import { PostgresTaskExecutionStore } from './execution-store';
import { createGitHubTaskExecutionSourceProvider } from './github-source-provider';
import { PostgresTaskHandoffStore } from './handoff-store';
import { PostgresTaskExecutionOperationStore } from './operation-store';
import {
  createTaskExecutionService,
  type TaskExecutionService
} from './service';
import type { TaskExecutionSourceProvider } from './source-provider';

type ConfiguredTaskExecutionBackend = Pick<
  ProjectSpaceBackend,
  | 'createGitHubBranch'
  | 'getConnectorOverview'
  | 'getGitHubCatalog'
  | 'getGitHubRepositoryDetails'
>;

export interface ConfiguredTaskExecutionOptions {
  agentRuntime: AgentRuntimeService;
  artifacts?: TaskHandoffArtifactBlobStore;
  backend: ConfiguredTaskExecutionBackend;
  capacity?: TaskExecutionCapacityStore;
  codex: ConfiguredCodexMachineTasksRuntime;
  database?: DatabaseQueryClient;
  environmentLifecycle: ExecutionEnvironmentLifecycleService;
  handoffs?: TaskHandoffStore;
  loadInventory?: typeof loadConfiguredComputeInventory;
  operations?: TaskExecutionOperationStore;
  source?: TaskExecutionSourceProvider;
  store?: TaskExecutionStore;
}

export async function createConfiguredTaskExecutionService(
  options: ConfiguredTaskExecutionOptions
): Promise<TaskExecutionService> {
  const database = options.database ?? (
    options.artifacts && options.capacity && options.handoffs && options.operations && options.store
      ? undefined
      : await getMachineConnectionDatabaseClient()
  );
  return createTaskExecutionService({
    agentRuntime: options.agentRuntime,
    artifacts: options.artifacts ?? new PostgresTaskHandoffArtifactBlobStore(database!),
    capacity: options.capacity ?? new PostgresTaskExecutionCapacityStore(database!),
    codex: options.codex,
    environmentLifecycle: options.environmentLifecycle,
    handoffs: options.handoffs ?? new PostgresTaskHandoffStore(database!),
    loadInventory: (userId) => (options.loadInventory ?? loadConfiguredComputeInventory)({
      backend: options.backend,
      userId
    }),
    operations: options.operations ?? new PostgresTaskExecutionOperationStore(database!),
    source: options.source ?? createGitHubTaskExecutionSourceProvider(options.backend),
    store: options.store ?? new PostgresTaskExecutionStore(database!)
  });
}
