import type { ProjectSpaceBackend } from '../../src/shared/project-space-api';
import type { DatabaseQueryClient } from '../database/client';
import { getMachineConnectionDatabaseClient } from '../local-database-store';
import { PostgresTaskExecutionOperationStore } from '../task-execution/operation-store';
import type { TaskExecutionOperationStore } from '../task-execution/contracts';
import type { TaskExecutionService } from '../task-execution/service';
import type { TaskDeliveryProvider, TaskDeliveryStore } from './contracts';
import {
  createConfiguredTaskDeliveryPolicyResolver,
  type TaskDeliveryCompletionPolicyResolver
} from './completion-policy';
import { createGitHubTaskDeliveryProvider } from './github-provider';
import { createTaskDeliveryService, type TaskDeliveryService } from './service';
import { PostgresTaskDeliveryStore } from './store';

type ConfiguredTaskDeliveryBackend = Pick<
  ProjectSpaceBackend,
  'getDeployedEnvironmentStatus' | 'getGitHubCatalog' | 'getGitHubRepositoryDetails'
>;

export interface ConfiguredTaskDeliveryOptions {
  backend: ConfiguredTaskDeliveryBackend;
  completionPolicyFor?: TaskDeliveryCompletionPolicyResolver;
  database?: DatabaseQueryClient;
  operations?: TaskExecutionOperationStore;
  provider?: TaskDeliveryProvider;
  store?: TaskDeliveryStore;
  taskExecutions: TaskExecutionService;
}

export async function createConfiguredTaskDeliveryService(
  options: ConfiguredTaskDeliveryOptions
): Promise<TaskDeliveryService> {
  const database = options.database ?? (
    options.operations && options.store ? undefined : await getMachineConnectionDatabaseClient()
  );
  const github = options.provider ?? createGitHubTaskDeliveryProvider({ backend: options.backend });
  return createTaskDeliveryService({
    completionPolicyFor: options.completionPolicyFor ??
      createConfiguredTaskDeliveryPolicyResolver({ backend: options.backend }),
    operations: options.operations ?? new PostgresTaskExecutionOperationStore(database!),
    providerFor: (kind) => kind === 'github' ? github : undefined,
    store: options.store ?? new PostgresTaskDeliveryStore(database!),
    taskExecutions: options.taskExecutions
  });
}
