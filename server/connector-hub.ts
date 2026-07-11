import type {
  ConnectorProjectRegistryResult,
  MachineRecord,
  ProjectDiscoveryResult,
  ProjectNavigationItem,
  ProjectSpaceRecord,
  ProjectStructureViolationRecord
} from '../src/shared/project-space-api';
import { isConnectorProjectRegistryPayload } from './connector-command-protocol';
import { getConnectorMachineSnapshotStore } from './local-database-store';

interface RegisteredConnector {
  firstSeenAt: string;
  receivedAt: string;
  registry: ConnectorProjectRegistryResult;
}

const registryTtlMs = 2 * 60 * 1000;
const registries = new Map<string, RegisteredConnector>();
export const connectorHubSourcePath = 'connector-hub';

export function isConnectorHubMachine(machine: Pick<MachineRecord, 'sourcePath'>) {
  return machine.sourcePath === connectorHubSourcePath;
}

export function isHubLocalMachine(machine: Pick<MachineRecord, 'connector' | 'sourcePath'>) {
  return !isConnectorHubMachine(machine) && machine.connector.status === 'local';
}

function nowIso() {
  return new Date().toISOString();
}

function isFresh(entry: RegisteredConnector) {
  return Date.now() - Date.parse(entry.receivedAt) <= registryTtlMs;
}

function connectorScopedId(
  kind: 'group' | 'item' | 'project' | 'violation',
  machineId: string,
  id: string
) {
  return `connector-${kind}:${Buffer.from(machineId).toString('base64url')}:${Buffer.from(id).toString('base64url')}`;
}

function normalizeProject(machineId: string, project: ProjectSpaceRecord): ProjectSpaceRecord {
  return {
    ...project,
    groupId: project.groupId ? connectorScopedId('group', machineId, project.groupId) : undefined,
    id: connectorScopedId('project', machineId, project.id),
    machineId
  };
}

function normalizeRootItem(machineId: string, item: ProjectNavigationItem): ProjectNavigationItem {
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

export async function registerConnectorProjectRegistry(registry: ConnectorProjectRegistryResult) {
  if (!isConnectorProjectRegistryPayload(registry)) {
    throw new Error('Connector registry payload is invalid.');
  }
  const machineId = registry.connector.machineId.trim();

  if (!machineId) {
    throw new Error('Connector registry is missing connector.machineId.');
  }

  const receivedAt = nowIso();
  const existing = registries.get(machineId);
  const entry = {
    firstSeenAt: existing?.firstSeenAt ?? receivedAt,
    receivedAt,
    registry: structuredClone(registry)
  };
  const store = await getConnectorMachineSnapshotStore();
  await store?.upsert(entry.registry, receivedAt);
  registries.set(machineId, entry);
}

export async function getRegisteredConnectorRegistries() {
  const store = await getConnectorMachineSnapshotStore();
  if (store) {
    const persisted = new Map<string, RegisteredConnector>();
    for (const snapshot of await store.list()) {
      if (!isConnectorProjectRegistryPayload(snapshot.registry)) {
        continue;
      }
      const machineId = snapshot.registry.connector.machineId.trim();
      persisted.set(machineId, {
        firstSeenAt: snapshot.firstSeenAt,
        receivedAt: snapshot.lastSeenAt,
        registry: structuredClone(snapshot.registry)
      });
    }
    registries.clear();
    for (const [machineId, entry] of persisted) {
      registries.set(machineId, entry);
    }
  }

  return [...registries.values()].sort((left, right) =>
    left.registry.connector.machineName.localeCompare(right.registry.connector.machineName)
  );
}

export async function getRegisteredConnectorMachines(): Promise<MachineRecord[]> {
  return (await getRegisteredConnectorRegistries()).map(({ receivedAt, registry }) => ({
    battery: registry.connector.battery,
    connector: {
      installCommand: 'project-space-connector',
      lastSeen: receivedAt,
      origin: registry.connector.origin,
      serviceName: registry.connector.serviceName ?? 'project-space-connector',
      status: isFresh({ firstSeenAt: receivedAt, receivedAt, registry }) ? 'online' : 'offline'
    },
    id: registry.connector.machineId,
    kind: 'connector',
    name: registry.connector.machineName,
    network: {},
    primaryUser: registry.connector.primaryUser,
    roles: ['connector'],
    sourcePath: connectorHubSourcePath
  }));
}

export async function getRegisteredConnectorDiscovery(): Promise<ProjectDiscoveryResult> {
  const entries = await getRegisteredConnectorRegistries();
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
