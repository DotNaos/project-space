import type { ProjectSpaceBackend } from '../../src/shared/project-space-api';
import { loadConfiguredComputeInventory } from '../configured-compute-inventory';
import type { DatabaseQueryClient } from '../database/client';
import { PostgresEnvironmentLifecycleStore } from '../execution-environment-lifecycle/store';
import type { GitHubCodespaceRunnerRuntime } from '../github-codespace-runner/configured-runtime';
import { getMachineConnectionDatabaseClient } from '../local-database-store';
import { PostgresTaskExecutionStore } from '../task-execution/execution-store';
import { PostgresTaskHandoffStore } from '../task-execution/handoff-store';
import { PostgresTaskExecutionOperationStore } from '../task-execution/operation-store';
import { createGitHubCodespaceRecoveryProvider } from './github-codespace-recovery';
import { createWorkspaceCommandService, type WorkspaceCommandService } from './service';
import { PostgresWorkspaceCommandStore } from './store';
import type {
  WorkspaceCommandConnectorActor,
  WorkspaceCommandConnectorOperation,
  WorkspaceCommandConnectorRequest,
  WorkspaceCommandConnectorResult
} from './connector-contract';

/**
 * Workspace commands previously crossed the retired Connector command channel.
 * Keep historical command reconciliation terminal and explicit without allowing
 * a configured server to revive that channel.
 */
export async function dispatchRetiredWorkspaceCommand(
  operation: WorkspaceCommandConnectorOperation,
  request: WorkspaceCommandConnectorRequest,
  actor: WorkspaceCommandConnectorActor
): Promise<WorkspaceCommandConnectorResult> {
  return {
    checkedAt: new Date().toISOString(),
    commandId: request.commandId,
    environmentId: request.environmentId,
    executionId: request.executionId,
    generation: actor.generation,
    machineId: request.machineId,
    operation,
    state: 'unsupported',
    stderr: '',
    stdout: '',
    truncated: false,
    workspaceId: request.workspaceId
  };
}

export async function createConfiguredWorkspaceCommandService(options: {
  backend: Pick<ProjectSpaceBackend, 'getConnectorOverview'>;
  database?: DatabaseQueryClient;
  githubCodespaceRunnerRuntime: GitHubCodespaceRunnerRuntime;
}): Promise<WorkspaceCommandService> {
  const database = options.database ?? await getMachineConnectionDatabaseClient();
  const lifecycle = new PostgresEnvironmentLifecycleStore(database);
  return createWorkspaceCommandService({
    commands: new PostgresWorkspaceCommandStore(database),
    dispatch: dispatchRetiredWorkspaceCommand,
    handoffs: new PostgresTaskHandoffStore(database),
    inventory: (userId) => loadConfiguredComputeInventory({ backend: options.backend, userId }),
    operations: new PostgresTaskExecutionOperationStore(database),
    recovery: createGitHubCodespaceRecoveryProvider({
      lifecycle, runner: options.githubCodespaceRunnerRuntime
    }),
    tasks: new PostgresTaskExecutionStore(database)
  });
}
