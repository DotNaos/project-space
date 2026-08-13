import { createHash } from 'node:crypto';
import type {
  ComputeEnvironmentRecord,
  ComputeInventorySnapshot,
  ResourceProfile
} from '../../src/shared/compute-environment-api';
import type {
  ProjectCliAccessRoute,
  ProjectCliComputeInventory,
  ProjectCliEnvironmentInstance,
  ProjectCliInventoryResourceSummary
} from '../../src/shared/compute-inventory-cli-api';
import {
  projectCliInventoryLegacySchemaVersion,
  projectCliInventoryHostdSchemaVersion,
  projectCliInventorySchemaVersion,
  type ProjectCliInventorySchemaVersion
} from '../../src/shared/compute-inventory-cli-api';
import type { MachineRecord } from '../../src/shared/project-space-api';
import type {
  AccessRouteRecord,
  PrivateNetworkInventory,
  PrivateNetworkRecord
} from '../private-network/contracts';
import { targetIdentityRevision } from '../private-network/contracts';
import { routeEvidenceState } from '../private-network/route-resolver';
import type { ProjectHostdSnapshot } from '../../src/shared/project-hostd-api';
import type { WorkspaceRuntimeSessionSnapshot } from '../../src/shared/workspace-runtime-session-api';

interface BuildProjectCliInventoryInput {
  checkedAt: string;
  connectors: readonly MachineRecord[];
  hostdSnapshots?: readonly ProjectHostdSnapshot[];
  privateNetworkInventory?: PrivateNetworkInventory;
  runtimeSessions?: readonly WorkspaceRuntimeSessionSnapshot[];
  schemaVersion?: ProjectCliInventorySchemaVersion;
  snapshot: ComputeInventorySnapshot;
}

export function buildProjectCliComputeInventory(
  input: BuildProjectCliInventoryInput
): ProjectCliComputeInventory {
  const schemaVersion = input.schemaVersion ?? projectCliInventoryLegacySchemaVersion;
  const hasControlledInventory = schemaVersion !== projectCliInventoryLegacySchemaVersion;
  const hasHostdInventory = schemaVersion === projectCliInventoryHostdSchemaVersion;
  const privateNetworkInventory = input.privateNetworkInventory ?? { networks: [], routes: [] };
  const hasRuntimeInventory = input.runtimeSessions !== undefined;
  const networksById = new Map(privateNetworkInventory.networks.map((network) => [network.id, network]));
  const connectorsById = new Map(input.connectors.map((connector) => [connector.id, connector]));
  const routesByEnvironment = new Map<string, ProjectCliAccessRoute[]>();
  for (const association of input.snapshot.connectors) {
    const connector = connectorsById.get(association.connectorId);
    if (!connector) continue;
    const routes = routesByEnvironment.get(association.environmentId) ?? [];
    routes.push(connectorRoute(connector));
    routesByEnvironment.set(association.environmentId, routes);
  }

  const controlledRoutesByEnvironment = routesByTarget(privateNetworkInventory.routes, 'environment');
  const controlledRoutesByHost = routesByTarget(privateNetworkInventory.routes, 'host');

  const platforms = input.snapshot.platforms.map((platform) => ({
    alias: selectorAlias(platform.name),
    id: platform.id,
    kind: platform.kind,
    name: platform.name
  })).sort(byNameThenId);

  const hosts = input.snapshot.hosts.map((host) => {
    const controlledRoutes = hasControlledInventory
      ? projectControlledRoutes(
          controlledRoutesByHost.get(host.id) ?? [],
          networksById,
          targetIdentityRevision(host.identity),
          new Date(input.checkedAt)
        )
      : [];
    return {
      ...(hasControlledInventory
        ? { accessRoutes: controlledRoutes }
        : {}),
      alias: selectorAlias(host.name),
      capabilities: hasControlledInventory
        ? hostCapabilities(controlledRoutes)
        : { console: [], power: [], state: 'unknown' as const },
      id: host.id,
      name: host.name,
      platformId: host.platformId,
      ...(host.resources ? { resources: resourceSummary(host.resources) } : {})
    };
  }).sort(byNameThenId);

  const environmentInstances = input.snapshot.environments.map((environment) => {
    const controlledRoutes = hasControlledInventory
      ? projectControlledRoutes(
          controlledRoutesByEnvironment.get(environment.id) ?? [],
          networksById,
          targetIdentityRevision(environment.identity),
          new Date(input.checkedAt)
        )
      : [];
    const routes = [
      ...(routesByEnvironment.get(environment.id) ?? []),
      ...controlledRoutes
    ].sort(routeOrder);
    const hostId = associatedHostId(environment);
    const alias = selectorAlias(environment.name);
    const reference = [
      environment.platformId,
      hostId || 'provider',
      environment.id
    ].join('/');
    const hostd = hasHostdInventory
      ? uniqueHostdSnapshot(input.hostdSnapshots ?? [], environment.id, hostId)
      : undefined;
    const workspaces = projectWorkspaceSummaries(
      environment.id,
      input.runtimeSessions ?? [],
      hostd
    );
    return {
      accessRoutes: routes,
      accessSummary: accessSummary(
        routes,
        environment,
        controlledRoutesByEnvironment.get(environment.id) ?? []
      ),
      alias,
      environmentDefinitionId: environment.environmentDefinitionId,
      ...(hostId ? { hostId } : {}),
      hostResolution: environment.hostAssociation.resolution,
      hostd: hostdProjection(hostd, hasHostdInventory, controlledRoutes),
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
      ...(hostd
        ? { resources: hostdResourceSummary(hostd) }
        : environment.resources ? { resources: resourceSummary(environment.resources) } : {}),
      workspaceInventory: {
        state: hasRuntimeInventory ? 'available' as const : 'unavailable' as const
      },
      workspaces
    } satisfies ProjectCliEnvironmentInstance;
  }).sort((left, right) => left.reference.localeCompare(right.reference) || left.id.localeCompare(right.id));

  const base = {
    checkedAt: input.checkedAt,
    environmentCatalog: input.snapshot.environmentDefinitions.map((definition) => ({
      ...definition,
      supportedArchitectures: [...definition.supportedArchitectures].sort()
    })).sort((left, right) => left.slug.localeCompare(right.slug) || left.id.localeCompare(right.id)),
    environmentInstances,
    hosts,
    inventoryState: input.snapshot.violations.length > 0
      ? 'conflict' as const
      : 'ready' as const,
    platforms,
    violations: input.snapshot.violations.map((violation) => ({
      code: violation.code,
      message: `Compute inventory reported ${violation.code}.`
    })).sort((left, right) => left.code.localeCompare(right.code) || left.message.localeCompare(right.message))
  };
  if (schemaVersion === projectCliInventoryLegacySchemaVersion) {
    return { ...base, schemaVersion };
  }
  return {
    ...base,
    privateNetworks: privateNetworkInventory.networks.map((network) => ({
      approvalState: network.approvalState,
      id: safeProjectionId('network', network.id),
      ...(network.lastVerifiedAt ? { lastVerifiedAt: network.lastVerifiedAt } : {}),
      name: network.name,
      providerKind: network.providerKind,
      state: network.enabled ? network.availability : 'unavailable' as const
    })).sort(byNameThenId),
    schemaVersion
  };
}

function uniqueHostdSnapshot(
  snapshots: readonly ProjectHostdSnapshot[],
  environmentId: string,
  hostId: string | undefined
) {
  const matches = snapshots.filter((snapshot) => snapshot.environmentId === environmentId &&
    snapshot.hostId === hostId);
  return matches.length === 1 ? matches[0] : undefined;
}

function hostdProjection(
  snapshot: ProjectHostdSnapshot | undefined,
  enabled: boolean,
  routes: readonly ProjectCliAccessRoute[]
) {
  if (!enabled) return { state: capabilityState(routes.filter((route) =>
    route.type === 'hostd' && route.capabilities.includes('hostd_telemetry')
  )) };
  if (!snapshot) return { state: 'unknown' as const };
  return {
    health: snapshot.health,
    hostdVersion: snapshot.hostdVersion,
    lastSeenAt: snapshot.lastSeenAt,
    observedAt: snapshot.observedAt,
    partialMetrics: [...snapshot.partialMetrics],
    protocolVersion: snapshot.protocolVersion,
    state: snapshot.connectionState === 'online' ? 'available' as const : 'stale' as const
  };
}

function hostdResourceSummary(snapshot: ProjectHostdSnapshot): ProjectCliInventoryResourceSummary {
  const partial = new Set(snapshot.partialMetrics);
  return {
    architecture: snapshot.resources.architecture,
    cpuCores: snapshot.resources.cpu.cores,
    ...(!partial.has('cpu') ? { cpuUsedPercent: snapshot.resources.cpu.usedPercent } : {}),
    ...(!partial.has('gpu') && snapshot.resources.gpu
      ? { gpu: snapshot.resources.gpu.map((gpu) => ({ ...gpu })) }
      : {}),
    ...(!partial.has('memory')
      ? { memoryAvailableBytes: snapshot.resources.memory.availableBytes }
      : {}),
    memoryTotalBytes: snapshot.resources.memory.totalBytes,
    operatingSystem: snapshot.resources.operatingSystem,
    reportedAt: snapshot.observedAt,
    source: 'hostd',
    ...(!partial.has('storage')
      ? { storageAvailableBytes: snapshot.resources.storage.availableBytes }
      : {}),
    storageTotalBytes: snapshot.resources.storage.totalBytes
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
    routeState(left).localeCompare(routeState(right)) ||
    JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function routeState(route: ProjectCliAccessRoute) {
  return route.type === 'connector'
    ? `${route.connectorStatus}:${route.lastSeen ?? ''}`
    : `${route.state}:${String(route.priority).padStart(4, '0')}:${route.id}`;
}

function routesByTarget(routes: readonly AccessRouteRecord[], kind: 'environment' | 'host') {
  const grouped = new Map<string, AccessRouteRecord[]>();
  for (const route of routes) {
    if (route.target.kind !== kind) continue;
    const current = grouped.get(route.target.id) ?? [];
    current.push(route);
    grouped.set(route.target.id, current);
  }
  return grouped;
}

function projectControlledRoutes(
  routes: readonly AccessRouteRecord[],
  networksById: ReadonlyMap<string, PrivateNetworkRecord>,
  identityRevision: string,
  now: Date
): ProjectCliAccessRoute[] {
  return routes.map((route) => ({
    capabilities: [...new Set(route.capabilities)].sort(),
    id: safeProjectionId('route', route.id),
    ...(route.lastVerifiedAt ? { lastVerifiedAt: route.lastVerifiedAt } : {}),
    priority: route.priority,
    ...(route.providerKind ? { providerKind: route.providerKind } : {}),
    state: routeEvidenceState({
      network: route.privateNetworkId ? networksById.get(route.privateNetworkId) : undefined,
      now,
      route,
      targetIdentityRevision: identityRevision
    }),
    type: route.routeKind
  })).sort(routeOrder);
}

function hostCapabilities(routes: readonly ProjectCliAccessRoute[]) {
  const consoleRoutes = routes.filter((route) =>
    route.type === 'host_console' && route.capabilities.includes('host_console')
  );
  const powerRoutes = routes.filter((route) =>
    route.type === 'host_console' && route.capabilities.includes('host_power')
  );
  return {
    console: consoleRoutes.length > 0 ? ['access-route'] : [],
    power: powerRoutes.length > 0 ? ['access-route'] : [],
    state: capabilityState([...consoleRoutes, ...powerRoutes]),
    summary: {
      console: capabilityState(consoleRoutes),
      power: capabilityState(powerRoutes),
      provider: 'unknown' as const,
      reset: 'unavailable' as const,
      wakeOnLan: 'unavailable' as const
    }
  };
}

function accessSummary(
  routes: readonly ProjectCliAccessRoute[],
  environment: ComputeEnvironmentRecord,
  rawRoutes: readonly AccessRouteRecord[]
) {
  const controlled = routes.filter((route) => route.type !== 'connector');
  const sshRoutes = controlled.filter((route) => route.type === 'ssh_private_network');
  const sshProjectCli = sshRoutes.find((route) => route.capabilities.includes('project_cli'));
  const ssh = sshProjectCli ?? sshRoutes[0];
  const provider = controlled.find((route) => route.type === 'provider_native');
  const providerProjectCli = controlled.find((route) =>
    route.type === 'provider_native' && route.capabilities.includes('project_cli')
  );
  const projectCliRoute = sshProjectCli ?? providerProjectCli;
  const rawSsh = ssh?.id
    ? rawRoutes.find((route) => safeProjectionId('route', route.id) === ssh.id)
    : undefined;
  return {
    providerKind: provider
      ? 'provider_native' as const
      : ssh?.providerKind ?? (environment.hostAssociation.resolution === 'not_applicable'
        ? 'provider_native' as const
        : 'none' as const),
    route: evidenceState(controlled),
    ssh: {
      hostKey: ssh
        ? rawSsh?.hostKeySha256 ? 'verified' as const : 'unknown' as const
        : 'unknown' as const,
      projectCli: projectCliRoute && projectCliRoute.capabilities.includes('project_cli')
        ? evidenceState([projectCliRoute])
        : 'unavailable' as const,
      readiness: ssh ? evidenceState([ssh]) : 'unavailable' as const
    }
  };
}

function evidenceState(routes: readonly ProjectCliAccessRoute[]) {
  if (routes.some((route) => route.type !== 'connector' && route.state === 'ready')) {
    return 'available' as const;
  }
  if (routes.some((route) => route.type !== 'connector' && route.state === 'stale')) {
    return 'stale' as const;
  }
  if (routes.some((route) => route.type !== 'connector' && route.state === 'unverified')) {
    return 'unknown' as const;
  }
  if (routes.some((route) => route.type !== 'connector' &&
    (route.state === 'unavailable' || route.state === 'policy_blocked'))) {
    return 'unavailable' as const;
  }
  return 'unknown' as const;
}

function projectWorkspaceSummaries(
  environmentId: string,
  sessions: readonly WorkspaceRuntimeSessionSnapshot[],
  hostd: ProjectHostdSnapshot | undefined
) {
  return sessions
    .filter((session) => session.environmentId === environmentId)
    .sort((left, right) => left.workspaceId.localeCompare(right.workspaceId))
    .map((session, index) => ({
      id: safeWorkspaceId(environmentId, session.workspaceId),
      name: session.presentation?.task
        ? `Task #${session.presentation.task.number}`
        : session.presentation?.repository ?? `Workspace Runtime ${index + 1}`,
      ...(session.presentation ? { repository: session.presentation.repository } : {}),
      runtime: {
        codex: runtimeCapabilityState(session, session.capabilities.includes('runtime.codex.v1')),
        connection: session.connectionState,
        devServers: session.capabilities.includes('runtime.dev-servers')
          ? session.devServers.map(({ name, state }) => ({ name, state }))
          : [],
        evidence: hostd?.runtimes.some((runtime) =>
          runtime.workspaceId === session.workspaceId && runtime.generation === session.generation
        ) ? 'project-hostd' as const : 'workspace-runtime' as const,
        lifecycle: session.lifecycleState
      },
      state: session.lifecycleState === 'stopped' || session.lifecycleState === 'failed'
        ? 'inactive' as const
        : 'active' as const
    }));
}

function runtimeCapabilityState(
  session: WorkspaceRuntimeSessionSnapshot,
  declared: boolean
) {
  if (!declared) return 'unavailable' as const;
  if (session.connectionState === 'online' && session.lifecycleState === 'running') {
    return 'available' as const;
  }
  if (session.connectionState === 'stale' || session.connectionState === 'disconnected') {
    return 'stale' as const;
  }
  return 'unavailable' as const;
}

function safeWorkspaceId(environmentId: string, workspaceId: string) {
  return safeProjectionId('workspace', `${environmentId}\u0000${workspaceId}`);
}

function safeProjectionId(namespace: string, value: string) {
  return `${namespace}-${createHash('sha256')
    .update(value, 'utf8')
    .digest('hex').slice(0, 32)}`;
}

function capabilityState(routes: readonly ProjectCliAccessRoute[]) {
  const controlled = routes.filter((route) => route.type !== 'connector');
  if (controlled.some((route) => route.state === 'ready')) return 'available' as const;
  if (controlled.some((route) => route.state === 'unverified' || route.state === 'stale')) {
    return 'unknown' as const;
  }
  return controlled.length > 0 ? 'unavailable' as const : 'unknown' as const;
}
