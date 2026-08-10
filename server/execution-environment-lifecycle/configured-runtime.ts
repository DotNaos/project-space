import type { ProjectSpaceBackend } from '../../src/shared/project-space-api';
import type { ConfiguredCodexMachineTasksRuntime } from '../codex-machine-tasks/configured-runtime';
import { loadConfiguredComputeInventory } from '../configured-compute-inventory';
import type { DatabaseQueryClient } from '../database/client';
import type { GitHubCodespaceRunnerRuntime } from '../github-codespace-runner/configured-runtime';
import { getMachineConnectionDatabaseClient } from '../local-database-store';
import { resolveGitHubRepository, resolveGitHubTask } from '../project-space-mcp/github-resolver';
import { createGitHubCodespacesLifecycleProvider } from './github-codespaces-provider';
import {
  createExecutionEnvironmentLifecycleService,
  type ExecutionEnvironmentActiveExecutionGuard,
  type ExecutionEnvironmentLifecycleService
} from './service';
import {
  PostgresEnvironmentLifecycleStore,
  type EnvironmentLifecycleStore
} from './store';

type AuthorizedLifecycleBackend = Pick<
  ProjectSpaceBackend,
  'getConnectorOverview' | 'getGitHubCatalog' | 'getGitHubRepositoryDetails'
>;

export interface ConfiguredExecutionEnvironmentLifecycleOptions {
  backend: AuthorizedLifecycleBackend;
  createCodexRuntime(): Promise<ConfiguredCodexMachineTasksRuntime>;
  database?: DatabaseQueryClient;
  executionGuard?: ExecutionEnvironmentActiveExecutionGuard;
  githubCodespaceRunnerRuntime: GitHubCodespaceRunnerRuntime;
  loadComputeInventory?: typeof loadConfiguredComputeInventory;
  store?: EnvironmentLifecycleStore;
}

export async function createConfiguredExecutionEnvironmentLifecycle(
  options: ConfiguredExecutionEnvironmentLifecycleOptions
): Promise<ExecutionEnvironmentLifecycleService> {
  const database = options.database ?? (
    options.store && options.executionGuard
      ? undefined
      : await getMachineConnectionDatabaseClient()
  );
  return createExecutionEnvironmentLifecycleService({
    authorization: {
      async authorizeBinding({ binding }) {
        const { repository } = await resolveGitHubRepository(
          options.backend,
          binding.repositoryFullName
        );
        return repository?.fullName.toLowerCase() === binding.repositoryFullName.toLowerCase();
      },
      async resolveProvision({ request }) {
        const resolved = await resolveGitHubTask(
          options.backend,
          request.repositoryId,
          request.task
        );
        if (resolved.details?.status !== 'connected' || !resolved.repository ||
            resolved.task?.state !== 'open') return undefined;
        const branch = resolved.details.branches.find((candidate) => (
          candidate.name === request.branch &&
          candidate.linkedIssueNumbers?.includes(request.task)
        ));
        return branch ? { repositoryFullName: resolved.repository.fullName } : undefined;
      }
    },
    executionGuard: options.executionGuard ?? createActiveExecutionGuard(options, database!),
    providers: [createGitHubCodespacesLifecycleProvider(
      options.githubCodespaceRunnerRuntime
    )],
    store: options.store ?? new PostgresEnvironmentLifecycleStore(database!)
  });
}

function createActiveExecutionGuard(
  options: ConfiguredExecutionEnvironmentLifecycleOptions,
  database: DatabaseQueryClient
): ExecutionEnvironmentActiveExecutionGuard {
  return {
    async check({ action, actor, binding, providerStateConfirmed }) {
      if (!binding.environmentId) return { state: 'uncertain' };
      if (!providerStateConfirmed) return { state: 'uncertain' };
      const inventory = await (options.loadComputeInventory ?? loadConfiguredComputeInventory)({
        backend: options.backend,
        userId: actor.userId
      });
      if (inventory.snapshot.violations.length > 0) return { state: 'uncertain' };
      const connectorIds = inventory.snapshot.connectors
        .filter(({ environmentId }) => environmentId === binding.environmentId)
        .map(({ connectorId }) => connectorId);
      if (await hasUnresolvedExecution(
        database,
        actor.userId,
        binding.environmentId,
        connectorIds
      )) return { state: 'uncertain' };
      if (['deleted', 'missing', 'stopped'].includes(binding.lifecycleState)) {
        return { state: 'safe' };
      }
      if (connectorIds.length === 0) return { state: 'uncertain' };

      const runtime = await options.createCodexRuntime();
      for (const connectorId of connectorIds) {
        let result;
        try {
          result = await runtime.sessions.service.list({ userId: actor.userId }, {
            includeArchived: action === 'delete',
            machineId: connectorId
          });
        } catch {
          return { state: 'uncertain' };
        }
        if (result.inventoryState !== 'live') return { state: 'uncertain' };
        const blocks = action === 'delete'
          ? result.sessions.some((session) => !session.archived && session.status !== 'missing')
          : result.sessions.some((session) => !session.archived && session.status === 'active');
        if (blocks) return { state: 'active' };
      }
      return { state: 'safe' };
    }
  };
}

async function hasUnresolvedExecution(
  database: DatabaseQueryClient,
  userId: string,
  environmentId: string,
  connectorIds: string[]
) {
  const result = await database.query<{ blocked: boolean }>(
    `select (
       exists (
         select 1 from codex_machine_task_starts
          where owner_user_id = $1 and physical_machine_id = $2
            and state in ('pending', 'uncertain')
       ) or exists (
         select 1 from codex_machine_task_sends
          where owner_user_id = $1 and connector_id = any($3::text[])
            and state in ('pending', 'uncertain')
       ) or exists (
         select 1 from codex_session_operations
          where owner_user_id = $1 and machine_id = any($3::text[])
            and state in ('pending', 'ambiguous')
       )
     ) as blocked`,
    [userId, environmentId, connectorIds]
  );
  return result.rows[0]?.blocked !== false;
}
