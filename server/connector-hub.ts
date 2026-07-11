import type {
  ConnectorProjectRegistryResult,
  MachineRecord,
  ProjectDiscoveryResult,
  ProjectNavigationItem,
  ProjectSpaceRecord,
  ProjectStructureViolationRecord
} from '../src/shared/project-space-api';
import { isConnectorProjectRegistryPayload } from './connector-command-protocol';

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

function connectorScopedId(kind: 'group' | 'item' | 'project' | 'violation', machineId: string, id: string) {
  return `connector-${kind}:${Buffer.from(machineId).toString('base64url')}:${Buffer.from(id).toString('base64url')}`;
}

function normalizeProject(machineId: string, project: ProjectSpaceRecord): ProjectSpaceRecord {
  return {
    ...project,
    groupId: project.groupId
      ? connectorScopedId('group', machineId, project.groupId)
      : undefined,
    id: connectorScopedId('project', machineId, project.id),
    machineId
  };
}

function normalizeRootItem(
  machineId: string,
  item: ProjectNavigationItem
): ProjectNavigationItem {
  if (item.kind === 'group') {
    return {
      ...item,
      groupId: connectorScopedId('group', machineId, item.groupId),
      id: connectorScopedId('item', machineId, item.id)
    };
  }

  return {
    ...item,
    id: connectorScopedId('item', machineId, item.id),
    projectId: connectorScopedId('project', machineId, item.projectId)
  };
}

function normalizeStructureViolation(
  machineId: string,
  violation: ProjectStructureViolationRecord
): ProjectStructureViolationRecord {
  return {
    ...violation,
    id: connectorScopedId('violation', machineId, violation.id),
    machineId
  };
}

export function registerConnectorProjectRegistry(registry: ConnectorProjectRegistryResult) {
  if (!isConnectorProjectRegistryPayload(registry)) {
    throw new Error('Connector registry payload is invalid.');
  }
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
    battery: registry.connector.battery,
    connector: {
      installCommand: 'project-space-connector',
      lastSeen: receivedAt,
      origin: registry.connector.origin,
      serviceName: registry.connector.serviceName ?? 'project-space-connector',
      status: 'online'
    },
    id: registry.connector.machineId,
    kind: registry.connector.kind ?? 'connector',
    name: registry.connector.machineName,
    network: registry.connector.network ?? {},
    primaryUser: registry.connector.primaryUser,
    roles: ['connector'],
    sourcePath: 'connector-hub'
  }));
}

export function getRegisteredConnectorDiscovery(): ProjectDiscoveryResult {
  const entries = getRegisteredConnectorRegistries();
  const groups: ProjectDiscoveryResult['groups'] = [];
  const projects: ProjectSpaceRecord[] = [];
  const rootItems: ProjectNavigationItem[] = [];
  const structureViolations: ProjectStructureViolationRecord[] = [];

  for (const { registry } of entries) {
    const machineId = registry.connector.machineId;
    const nextProjects = registry.discovery.projects.map((project) =>
      normalizeProject(machineId, project)
    );

    groups.push(
      ...registry.discovery.groups.map((group) => ({
        ...group,
        childProjectIds: group.childProjectIds.map((id) =>
          connectorScopedId('project', machineId, id)
        ),
        id: connectorScopedId('group', machineId, group.id)
      }))
    );
    projects.push(...nextProjects);
    rootItems.push(
      ...registry.discovery.rootItems.map((item) => normalizeRootItem(machineId, item))
    );
    structureViolations.push(
      ...(registry.discovery.structureViolations ?? []).map((violation) =>
        normalizeStructureViolation(machineId, violation)
      )
    );
  }

  return {
    groups: groups.sort((left, right) => left.name.localeCompare(right.name)),
    projects: projects.sort((left, right) => left.name.localeCompare(right.name)),
    rootItems: rootItems.sort((left, right) => left.label.localeCompare(right.label)),
    rootPath: entries
      .map(({ registry }) => registry.discovery.rootPath)
      .filter(Boolean)
      .join(', '),
    structureViolations: structureViolations.sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath)
    )
  };
}
