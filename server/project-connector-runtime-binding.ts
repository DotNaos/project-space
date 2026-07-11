import {
  connectorRegistrationTokenForTarget,
  resolveProjectConnectorTargets,
  type ProjectConnectorHubTarget
} from './project-connector-config';
import type { ConnectorRuntimeCredential } from './connector-runtime-credential';
import type {
  ConnectorProjectRegistryResult,
  ProjectSpaceBackend
} from '../src/shared/project-space-api';

const defaultReconnectDelayMs = 5_000;
const defaultRegistryIntervalMs = 30_000;

export interface ProjectConnectorConnectionOptions {
  hubHttpUrl?: string;
  hubUrl?: string;
  reconnectDelayMs?: number;
  registryIntervalMs?: number;
  runtimeCredential?: ConnectorRuntimeCredential;
}

function bindConnectorRegistryToMachine(
  registry: ConnectorProjectRegistryResult,
  machineId: string
): ConnectorProjectRegistryResult {
  return {
    ...registry,
    connector: { ...registry.connector, machineId },
    discovery: {
      ...registry.discovery,
      projects: registry.discovery.projects.map((project) => ({ ...project, machineId })),
      structureViolations: (registry.discovery.structureViolations ?? []).map((violation) => ({
        ...violation,
        machineId
      }))
    }
  };
}

function runtimeConnectorTarget(
  credential: ConnectorRuntimeCredential
): ProjectConnectorHubTarget {
  const url = new URL(credential.backendUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/api/connectors/socket';
  url.search = '';
  url.hash = '';
  return { name: 'authenticated-runtime', wsUrl: url.toString() };
}

export function resolveProjectConnectorConnection(
  options: ProjectConnectorConnectionOptions
) {
  const reconnectDelayMs = options.reconnectDelayMs ?? defaultReconnectDelayMs;
  const registryIntervalMs = options.registryIntervalMs ?? defaultRegistryIntervalMs;
  if (
    !Number.isSafeInteger(reconnectDelayMs) ||
    reconnectDelayMs < 0 ||
    !Number.isSafeInteger(registryIntervalMs) ||
    registryIntervalMs <= 0
  ) {
    throw new Error('Connector timing values are invalid.');
  }
  const runtimeCredential = options.runtimeCredential;
  const targets = runtimeCredential
    ? [runtimeConnectorTarget(runtimeCredential)]
    : resolveProjectConnectorTargets(options);

  return {
    reconnectDelayMs,
    registrationToken(target: ProjectConnectorHubTarget) {
      return runtimeCredential?.credential ?? connectorRegistrationTokenForTarget(target);
    },
    async registry(backend: Pick<ProjectSpaceBackend, 'getConnectorProjectRegistry'>) {
      const registry = await backend.getConnectorProjectRegistry();
      return runtimeCredential
        ? bindConnectorRegistryToMachine(registry, runtimeCredential.machineId)
        : registry;
    },
    registryIntervalMs,
    targets
  };
}
