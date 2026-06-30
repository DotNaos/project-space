import type {
  ConnectorProjectRegistryResult,
  MachineRecord,
  ProjectDiscoveryResult,
  ProjectNavigationItem,
  ProjectSpaceRecord
} from '../src/shared/project-space-api';

interface RegisteredConnector {
  receivedAt: string;
  registry: ConnectorProjectRegistryResult;
}

const registryTtlMs = 2 * 60 * 1000;
const registries = new Map<string, RegisteredConnector>();

function nowIso() {
  return new Date().toISOString();
}

function isFresh(entry: RegisteredConnector) {
  return Date.now() - Date.parse(entry.receivedAt) <= registryTtlMs;
}

function pruneStaleRegistries() {
  for (const [machineId, entry] of registries.entries()) {
    if (!isFresh(entry)) {
      registries.delete(machineId);
    }
  }
}

function normalizeProject(machineId: string, project: ProjectSpaceRecord): ProjectSpaceRecord {
  if (project.id.includes(':')) {
    return project;
  }

  return {
    ...project,
    id: `${machineId}:${project.id}`
  };
}

function normalizeRootItem(
  machineId: string,
  item: ProjectNavigationItem
): ProjectNavigationItem {
  if (item.kind !== 'project' || !item.projectId || item.projectId.includes(':')) {
    return item;
  }

  return {
    ...item,
    id: `${machineId}:${item.id}`,
    projectId: `${machineId}:${item.projectId}`
  };
}

export function registerConnectorProjectRegistry(registry: ConnectorProjectRegistryResult) {
  const machineId = registry.connector.machineId.trim();

  if (!machineId) {
    throw new Error('Connector registry is missing connector.machineId.');
  }

  registries.set(machineId, {
    receivedAt: nowIso(),
    registry
  });
}

export function getRegisteredConnectorRegistries() {
  pruneStaleRegistries();

  return [...registries.values()].sort((left, right) =>
    left.registry.connector.machineName.localeCompare(right.registry.connector.machineName)
  );
}

export function getRegisteredConnectorMachines(): MachineRecord[] {
  return getRegisteredConnectorRegistries().map(({ receivedAt, registry }) => ({
    connector: {
      installCommand: 'project-space-connector',
      lastSeen: receivedAt,
      origin: registry.connector.origin,
      serviceName: registry.connector.serviceName ?? 'project-space-connector',
      status: 'online'
    },
    id: registry.connector.machineId,
    kind: 'connector',
    name: registry.connector.machineName,
    network: {},
    roles: ['connector'],
    sourcePath: 'connector-hub'
  }));
}

export function getRegisteredConnectorDiscovery(): ProjectDiscoveryResult {
  const entries = getRegisteredConnectorRegistries();
  const projects: ProjectSpaceRecord[] = [];
  const rootItems: ProjectNavigationItem[] = [];

  for (const { registry } of entries) {
    const machineId = registry.connector.machineId;
    const nextProjects = registry.discovery.projects.map((project) =>
      normalizeProject(machineId, project)
    );

    projects.push(...nextProjects);
    rootItems.push(
      ...registry.discovery.rootItems.map((item) => normalizeRootItem(machineId, item))
    );
  }

  return {
    groups: [],
    projects: projects.sort((left, right) => left.name.localeCompare(right.name)),
    rootItems: rootItems.sort((left, right) => left.label.localeCompare(right.label)),
    rootPath: entries
      .map(({ registry }) => registry.discovery.rootPath)
      .filter(Boolean)
      .join(', ')
  };
}
