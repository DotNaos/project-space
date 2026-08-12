import {
  MemoryConnectorRuntimeOperationStore,
  type ConnectorRuntimeOperationStore
} from './connector-runtime-operation-store';
import { getConnectorRuntimeOperationStore } from './local-database-store';

const memoryStore = new MemoryConnectorRuntimeOperationStore();

async function configuredStore(): Promise<ConnectorRuntimeOperationStore> {
  return await getConnectorRuntimeOperationStore() ?? memoryStore;
}

export class ConfiguredConnectorRuntimeOperationStore
  implements ConnectorRuntimeOperationStore {
  async claimQueued(...args: Parameters<ConnectorRuntimeOperationStore['claimQueued']>) {
    return (await configuredStore()).claimQueued(...args);
  }

  async coalesceQueuedUpdate(
    ...args: Parameters<ConnectorRuntimeOperationStore['coalesceQueuedUpdate']>
  ) {
    return (await configuredStore()).coalesceQueuedUpdate(...args);
  }

  async createAccepted(...args: Parameters<ConnectorRuntimeOperationStore['createAccepted']>) {
    return (await configuredStore()).createAccepted(...args);
  }

  async latest(...args: Parameters<ConnectorRuntimeOperationStore['latest']>) {
    return (await configuredStore()).latest(...args);
  }

  async listActive(...args: Parameters<ConnectorRuntimeOperationStore['listActive']>) {
    return (await configuredStore()).listActive(...args);
  }

  async recordRejection(...args: Parameters<ConnectorRuntimeOperationStore['recordRejection']>) {
    return (await configuredStore()).recordRejection(...args);
  }

  async transition(...args: Parameters<ConnectorRuntimeOperationStore['transition']>) {
    return (await configuredStore()).transition(...args);
  }
}
