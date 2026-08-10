import type { ProjectSpaceBackend } from '../../src/shared/project-space-api';
import type { CodexAuthorizationRuntime } from '../codex-authorization/configured-runtime';
import {
  loadConfiguredComputeInventory,
  type ConfiguredComputeInventoryResult
} from '../configured-compute-inventory';
import type { DatabaseQueryClient } from '../database/client';
import { getMachineConnectionDatabaseClient } from '../local-database-store';
import {
  createAgentRuntimeService,
  type AgentRuntimeService
} from './service';
import {
  PostgresAgentAuthorizationOperationStore,
  type AgentAuthorizationOperationStore
} from './store';

export async function createConfiguredAgentRuntime(options: {
  authorization: CodexAuthorizationRuntime;
  backend: Pick<ProjectSpaceBackend, 'getConnectorOverview'>;
  database?: DatabaseQueryClient;
  loadInventory?: (userId: string) => Promise<ConfiguredComputeInventoryResult>;
  store?: AgentAuthorizationOperationStore;
}): Promise<AgentRuntimeService> {
  const database = options.database ?? (
    options.store ? undefined : await getMachineConnectionDatabaseClient()
  );
  return createAgentRuntimeService({
    authorization: options.authorization,
    loadInventory: options.loadInventory ?? ((userId) => loadConfiguredComputeInventory({
      backend: options.backend,
      userId
    })),
    store: options.store ?? new PostgresAgentAuthorizationOperationStore(database!)
  });
}
