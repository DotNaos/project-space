import type { ComputeInventorySnapshot } from '../src/shared/compute-environment-api';
import type { MachineRecord, ProjectSpaceBackend } from '../src/shared/project-space-api';
import { computeInventoryFromConnectors } from './compute-inventory';
import {
  isDatabaseConfigured,
  listComputeInventory,
  reconcileConnectorComputeInventory
} from './local-database-store';

export interface ConfiguredComputeInventoryResult {
  checkedAt: string;
  connectors: readonly MachineRecord[];
  generations: ReadonlyMap<string, number>;
  snapshot: ComputeInventorySnapshot;
}

export async function loadConfiguredComputeInventory(input: {
  backend: Pick<ProjectSpaceBackend, 'getConnectorOverview'>;
  overview?: Awaited<ReturnType<ProjectSpaceBackend['getConnectorOverview']>>;
  userId: string;
}): Promise<ConfiguredComputeInventoryResult> {
  const overview = input.overview ?? await input.backend.getConnectorOverview();
  const generations = new Map<string, number>();
  if (!isDatabaseConfigured()) {
    return {
      checkedAt: new Date().toISOString(),
      connectors: overview.machines,
      generations,
      snapshot: computeInventoryFromConnectors({
        connectors: overview.machines,
        physicalMachines: overview.physicalMachines
      })
    };
  }

  await reconcileConnectorComputeInventory(input.userId, overview.machines);
  return {
    checkedAt: new Date().toISOString(),
    connectors: overview.machines,
    generations,
    snapshot: await listComputeInventory(input.userId)
  };
}
