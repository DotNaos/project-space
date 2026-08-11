import type {
  ComputeEnvironmentRecord,
  ComputeInventorySnapshot,
  ResourceProfile
} from '../../src/shared/compute-environment-api';
import type {
  ProjectCliAccessRoute,
  ProjectCliComputeInventory,
  ProjectCliEnvironmentInstance,
  ProjectCliHostCapabilities,
  ProjectCliInventoryResourceSummary
} from '../../src/shared/compute-inventory-cli-api';
import { projectCliInventorySchemaVersion } from '../../src/shared/compute-inventory-cli-api';
import type { MachineRecord } from '../../src/shared/project-space-api';

interface BuildProjectCliInventoryInput {
  checkedAt: string;
  connectors: readonly MachineRecord[];
  snapshot: ComputeInventorySnapshot;
}

export function buildProjectCliComputeInventory(
  input: BuildProjectCliInventoryInput
): ProjectCliComputeInventory {
  const connectorsById = new Map(input.connectors.map((connector) => [connector.id, connector]));
  const routesByEnvironment = new Map<string, ProjectCliAccessRoute[]>();
  for (const association of input.snapshot.connectors) {
    const connector = connectorsById.get(association.connectorId);
    if (!connector) continue;
    const routes = routesByEnvironment.get(association.environmentId) ?? [];
    routes.push(connectorRoute(connector));
    routesByEnvironment.set(association.environmentId, routes);
  }

  const platforms = input.snapshot.platforms.map((platform) => ({
    alias: selectorAlias(platform.name),
    id: platform.id,
    kind: platform.kind,
    name: platform.name
  })).sort(byNameThenId);

  const hosts = input.snapshot.hosts.map((host) => ({
    alias: selectorAlias(host.name),
    capabilities: hostCapabilities(host.id, input.snapshot.environments, routesByEnvironment),
    id: host.id,
    name: host.name,
    platformId: host.platformId,
    ...(host.resources ? { resources: resourceSummary(host.resources) } : {})
  })).sort(byNameThenId);

  const environmentInstances = input.snapshot.environments.map((environment) => {
    const routes = [...(routesByEnvironment.get(environment.id) ?? [])].sort(routeOrder);
    const hostId = associatedHostId(environment);
    const alias = selectorAlias(environment.name);
    const reference = [
      environment.platformId,
      hostId || 'provider',
      environment.id
    ].join('/');
    return {
      accessRoutes: routes,
      alias,
      environmentDefinitionId: environment.environmentDefinitionId,
      ...(hostId ? { hostId } : {}),
      hostResolution: environment.hostAssociation.resolution,
      hostd: {
        state: routes.some((route) => route.available && route.capabilities.includes('hostd'))
          ? 'available'
          : routes.some((route) => route.capabilities.includes('hostd'))
            ? 'unavailable'
            : 'unknown'
      },
      id: environment.id,
      kind: environment.kind,
      name: environment.name,
      ...(environment.parentEnvironmentId
        ? { parentEnvironmentInstanceId: environment.parentEnvironmentId }
        : {}),
      platformId: environment.platformId,
      providerLifecycleState: 'unknown',
      reference,
      resourceMode: environment.resourceMode,
      ...(environment.resources ? { resources: resourceSummary(environment.resources) } : {}),
      workspaceInventory: { state: 'unavailable' as const },
      workspaces: []
    } satisfies ProjectCliEnvironmentInstance;
  }).sort((left, right) => left.reference.localeCompare(right.reference) || left.id.localeCompare(right.id));

  return {
    checkedAt: input.checkedAt,
    environmentCatalog: input.snapshot.environmentDefinitions.map((definition) => ({
      ...definition,
      supportedArchitectures: [...definition.supportedArchitectures].sort()
    })).sort((left, right) => left.slug.localeCompare(right.slug) || left.id.localeCompare(right.id)),
    environmentInstances,
    hosts,
    inventoryState: input.snapshot.violations.length > 0 ? 'conflict' : 'ready',
    platforms,
    schemaVersion: projectCliInventorySchemaVersion,
    violations: input.snapshot.violations.map((violation) => ({
      code: violation.code,
      message: `Compute inventory reported ${violation.code}.`
    })).sort((left, right) => left.code.localeCompare(right.code) || left.message.localeCompare(right.message))
  };
}

function associatedHostId(environment: ComputeEnvironmentRecord) {
  return 'hostId' in environment.hostAssociation
    ? environment.hostAssociation.hostId
    : undefined;
}

function connectorRoute(connector: MachineRecord): ProjectCliAccessRoute {
  return {
    available: connector.connector.status === 'local' || connector.connector.status === 'online',
    capabilities: [...new Set(connector.connector.capabilities ?? [])].sort(),
    connectorStatus: connector.connector.status,
    ...(connector.connector.lastSeen ? { lastSeen: connector.connector.lastSeen } : {}),
    type: 'connector'
  };
}

function hostCapabilities(
  hostId: string,
  environments: readonly ComputeEnvironmentRecord[],
  routesByEnvironment: ReadonlyMap<string, readonly ProjectCliAccessRoute[]>
): ProjectCliHostCapabilities {
  const routes = environments
    .filter((environment) => associatedHostId(environment) === hostId)
    .flatMap((environment) => routesByEnvironment.get(environment.id) ?? []);
  const capabilities = routes.flatMap((route) => route.capabilities);
  const relevantRoutes = routes.filter((route) => route.capabilities.some((capability) =>
    capability.startsWith('console:') || capability.startsWith('power:')
  ));
  return {
    console: capabilityValues(capabilities, 'console:'),
    power: capabilityValues(capabilities, 'power:'),
    state: relevantRoutes.some((route) => route.available)
      ? 'available'
      : relevantRoutes.length > 0
        ? 'unavailable'
        : 'unknown'
  };
}

function capabilityValues(capabilities: readonly string[], prefix: string) {
  return [...new Set(capabilities
    .filter((capability) => capability.startsWith(prefix) && capability.length > prefix.length)
    .map((capability) => capability.slice(prefix.length)))].sort();
}

function resourceSummary(resource: ResourceProfile): ProjectCliInventoryResourceSummary {
  return {
    architecture: resource.architecture,
    cpuCores: resource.cpu.cores,
    ...(resource.cpu.limit === undefined ? {} : { cpuLimit: resource.cpu.limit }),
    ...(resource.memory.availableBytes === undefined
      ? {}
      : { memoryAvailableBytes: resource.memory.availableBytes }),
    ...(resource.memory.limitBytes === undefined
      ? {}
      : { memoryLimitBytes: resource.memory.limitBytes }),
    memoryTotalBytes: resource.memory.totalBytes,
    operatingSystem: resource.operatingSystem,
    reportedAt: resource.reportedAt,
    source: resource.source,
    ...(resource.storage.availableBytes === undefined
      ? {}
      : { storageAvailableBytes: resource.storage.availableBytes }),
    storageTotalBytes: resource.storage.totalBytes
  };
}

function selectorAlias(value: string) {
  return value.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unnamed';
}

function byNameThenId(left: { id: string; name: string }, right: { id: string; name: string }) {
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

function routeOrder(left: ProjectCliAccessRoute, right: ProjectCliAccessRoute) {
  return left.type.localeCompare(right.type) ||
    left.connectorStatus.localeCompare(right.connectorStatus) ||
    String(left.lastSeen ?? '').localeCompare(String(right.lastSeen ?? '')) ||
    JSON.stringify(left).localeCompare(JSON.stringify(right));
}
