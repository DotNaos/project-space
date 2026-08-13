import type { MachineRecord, ProjectDiscoveryResult } from '../src/shared/project-space-api';
import type { ConnectorProjectRegistryResult } from '../src/shared/project-space-api';
import type { MachineConnectorProfile } from './machine-connection-contract';

/**
 * Compatibility-only exports for code that still understands the retired
 * Connector channel. Canonical Environment and Workspace Runtime paths do not
 * use this module. In particular, these functions never read or write legacy
 * Connector state.
 */
export const connectorHubSourcePath = 'connector-hub';

export function isConnectorHubMachine(machine: Pick<MachineRecord, 'sourcePath'>) {
  return machine.sourcePath === connectorHubSourcePath;
}

export function isHubLocalMachine(machine: Pick<MachineRecord, 'connector' | 'sourcePath'>) {
  return !isConnectorHubMachine(machine) && machine.connector.status === 'local';
}

const retiredConnectorError =
  'The permanent Project Space Connector has been retired. Use a canonical Environment and Workspace Runtime.';

export async function registerConnectorProjectRegistry(
  _registry: ConnectorProjectRegistryResult,
  _connectorProfile?: MachineConnectorProfile,
  _now?: number
): Promise<never> {
  throw new Error(retiredConnectorError);
}

export async function getRegisteredConnectorRegistries(): Promise<never[]> {
  return [];
}

export async function getRegisteredConnectorMachines(
  _now?: number
): Promise<MachineRecord[]> {
  return [];
}

export function connectorMachineForRegistry(
  _registry: ConnectorProjectRegistryResult,
  _connectorProfile?: MachineConnectorProfile,
  _receivedAt?: string
): never {
  throw new Error(retiredConnectorError);
}

export async function getRegisteredConnectorDiscovery(): Promise<ProjectDiscoveryResult> {
  return {
    groups: [],
    projects: [],
    rootItems: [],
    rootPath: '',
    structureViolations: []
  };
}
