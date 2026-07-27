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
import type { MachineConnectorProfile } from './machine-connection-contract';

interface RegisteredConnector {
  connectorProfile?: MachineConnectorProfile;
  firstSeenAt: string;
  receivedAt: string;
  registry: ConnectorProjectRegistryResult;
}

const registryTtlMs = 2 * 60 * 1000;
const registries = new Map<string, RegisteredConnector>();
export const connectorHubSourcePath = 'connector-hub';

function connectorReportedOsFamily(registry: ConnectorProjectRegistryResult) {
  const value = registry.connector.runtime?.platform ?? registry.connector.kind?.toLowerCase();
  if (value === 'darwin' || value === 'macos') return 'macos';
  if (value === 'ubuntu') return 'ubuntu';
  if (value === 'windows' || value === 'win32') return 'windows';
  if (value === 'linux' || value === 'unix') return 'linux';
  return undefined;
}

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

function assertConnectorProfile(
  registry: ConnectorProjectRegistryResult,
  connectorProfile: MachineConnectorProfile | undefined
) {
  const runtime = registry.connector.runtime;
  if (connectorProfile) {
    if (
      !runtime ||
      runtime.channel !== connectorProfile.channel ||
      runtime.source !== connectorProfile.source
    ) {
      throw new Error('Connector registry does not match its enrolled connector profile.');
    }
    return;
  }
  if (runtime?.channel === 'dev' || runtime?.source === 'source') {
    throw new Error('Development source connectors require a bound enrollment profile.');
  }
}

export async function registerConnectorProjectRegistry(
  registry: ConnectorProjectRegistryResult,
  connectorProfile?: MachineConnectorProfile
) {
  if (!isConnectorProjectRegistryPayload(registry)) {
    throw new Error('Connector registry payload is invalid.');
  }
  const machineId = registry.connector.machineId.trim();

  if (!machineId) {
    throw new Error('Connector registry is missing connector.machineId.');
  }
  assertConnectorProfile(registry, connectorProfile);

  const receivedAt = nowIso();
  const existing = registries.get(machineId);
  const entry = {
    connectorProfile,
    firstSeenAt: existing?.firstSeenAt ?? receivedAt,
    receivedAt,
    registry: structuredClone(registry)
  };
  const store = await getConnectorMachineSnapshotStore();
  await store?.upsert(entry.registry, receivedAt, connectorProfile);
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
        connectorProfile: snapshot.connectorProfile,
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

function registeredConnectorMachine({
  connectorProfile,
  receivedAt,
  registry
}: RegisteredConnector): MachineRecord {
  const online = isFresh({ firstSeenAt: receivedAt, receivedAt, registry });
  const capabilities = registry.connector.capabilities ?? [];
  const supportsRuntimeMaintenance = Boolean(registry.connector.runtime) &&
    capabilities.includes('runtime.restart') &&
    capabilities.includes('runtime.update');
  const reportedOsFamily = connectorReportedOsFamily(registry);
  return {
    battery: registry.connector.battery,
    connector: {
      capabilities,
      daemon: registry.connector.daemon,
      installCommand: 'project-space-connector',
      lastSeen: receivedAt,
      origin: registry.connector.origin,
      profile: connectorProfile,
      runtime: registry.connector.runtime,
      serviceName: registry.connector.serviceName ?? 'project-space-connector',
      status: online ? 'online' : 'offline',
      update: {
        state: online
          ? supportsRuntimeMaintenance
            ? 'checking'
            : 'unsupported'
          : 'offline'
      }
    },
    id: registry.connector.machineId,
    environment: registry.connector.environment,
    executionScopeId: registry.connector.executionScopeId,
    kind: 'connector',
    name: registry.connector.machineName,
    network: {},
    os: reportedOsFamily ? { family: reportedOsFamily } : undefined,
    primaryUser: registry.connector.primaryUser,
    roles: ['connector'],
    sourcePath: connectorHubSourcePath
  };
}

export function connectorMachineForRegistry(
  registry: ConnectorProjectRegistryResult,
  connectorProfile?: MachineConnectorProfile,
  receivedAt = nowIso()
) {
  return registeredConnectorMachine({
    connectorProfile,
    firstSeenAt: receivedAt,
    receivedAt,
    registry
  });
}

export async function getRegisteredConnectorMachines(): Promise<MachineRecord[]> {
  return (await getRegisteredConnectorRegistries()).map(registeredConnectorMachine);
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
