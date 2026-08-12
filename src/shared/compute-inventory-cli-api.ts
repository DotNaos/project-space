import type {
  ComputeEnvironmentKind,
  ComputePlatformKind,
  EnvironmentBootstrapStrategy,
  EnvironmentDefinitionOwnership,
  EnvironmentOperatingSystemFamily,
  EnvironmentResourceMode,
  HostResolution,
  ResourceSource
} from './compute-environment-api';

export const projectCliInventoryLegacySchemaVersion = 1;
export const projectCliInventorySchemaVersion = 2;
export const projectCliInventoryHostdSchemaVersion = 3;
export type ProjectCliInventorySchemaVersion =
  | typeof projectCliInventoryLegacySchemaVersion
  | typeof projectCliInventorySchemaVersion
  | typeof projectCliInventoryHostdSchemaVersion;

export interface ProjectCliInventoryResourceSummary {
  architecture: string;
  cpuCores: number;
  cpuLimit?: number;
  cpuUsedPercent?: number;
  gpu?: Array<{
    memoryBytes?: number;
    model: string;
    usedPercent?: number;
  }>;
  memoryAvailableBytes?: number;
  memoryLimitBytes?: number;
  memoryTotalBytes: number;
  operatingSystem: string;
  reportedAt: string;
  source: ResourceSource;
  storageAvailableBytes?: number;
  storageTotalBytes: number;
}

export interface ProjectCliEnvironmentDefinition {
  bootstrapStrategy: EnvironmentBootstrapStrategy;
  id: string;
  kind: ComputeEnvironmentKind;
  name: string;
  operatingSystemFamily: EnvironmentOperatingSystemFamily;
  ownership: EnvironmentDefinitionOwnership;
  slug: string;
  supportedArchitectures: string[];
}

export interface ProjectCliPlatform {
  alias: string;
  id: string;
  kind: ComputePlatformKind;
  name: string;
}

export interface ProjectCliHostCapabilities {
  console: string[];
  power: string[];
  state: 'available' | 'unavailable' | 'unknown';
}

export interface ProjectCliHost {
  accessRoutes?: ProjectCliAccessRoute[];
  alias: string;
  capabilities: ProjectCliHostCapabilities;
  id: string;
  name: string;
  platformId: string;
  resources?: ProjectCliInventoryResourceSummary;
}

export interface ProjectCliConnectorAccessRoute {
  available: boolean;
  capabilities: string[];
  connectorStatus: 'local' | 'online' | 'offline' | 'not-installed';
  lastSeen?: string;
  type: 'connector';
}

export interface ProjectCliControlledAccessRoute {
  capabilities: string[];
  id: string;
  lastVerifiedAt?: string;
  priority: number;
  providerKind?: 'tailscale' | 'wireguard' | 'other';
  state: 'ready' | 'unavailable' | 'unverified' | 'stale' | 'policy_blocked';
  type: 'ssh_private_network' | 'provider_native' | 'host_console' | 'hostd';
}

export type ProjectCliAccessRoute =
  | ProjectCliConnectorAccessRoute
  | ProjectCliControlledAccessRoute;

export interface ProjectCliPrivateNetwork {
  approvalState: 'approved' | 'pending' | 'revoked';
  id: string;
  lastVerifiedAt?: string;
  name: string;
  providerKind: 'tailscale' | 'wireguard' | 'other';
  state: 'available' | 'unavailable' | 'unknown';
}

export interface ProjectCliWorkspaceSummary {
  id: string;
  name: string;
  repository?: string;
  state: 'active';
}

export interface ProjectCliEnvironmentInstance {
  accessRoutes: ProjectCliAccessRoute[];
  alias: string;
  environmentDefinitionId: string;
  hostId?: string;
  hostResolution: HostResolution;
  hostd: {
    health?: 'healthy' | 'degraded';
    hostdVersion?: string;
    lastSeenAt?: string;
    observedAt?: string;
    partialMetrics?: Array<'cpu' | 'memory' | 'storage' | 'gpu' | 'runtime'>;
    protocolVersion?: number;
    state: 'available' | 'stale' | 'unavailable' | 'unknown';
  };
  id: string;
  kind: ComputeEnvironmentKind;
  name: string;
  parentEnvironmentInstanceId?: string;
  platformId: string;
  providerLifecycleState: 'unknown';
  reference: string;
  resourceMode: EnvironmentResourceMode;
  resources?: ProjectCliInventoryResourceSummary;
  workspaceInventory: {
    state: 'available' | 'unavailable';
  };
  workspaces: ProjectCliWorkspaceSummary[];
}

export interface ProjectCliInventoryViolation {
  code: string;
  message: string;
}

interface ProjectCliComputeInventoryBase {
  checkedAt: string;
  environmentCatalog: ProjectCliEnvironmentDefinition[];
  environmentInstances: ProjectCliEnvironmentInstance[];
  hosts: ProjectCliHost[];
  inventoryState: 'conflict' | 'ready';
  platforms: ProjectCliPlatform[];
  violations: ProjectCliInventoryViolation[];
}

export interface ProjectCliComputeInventoryV1 extends ProjectCliComputeInventoryBase {
  schemaVersion: typeof projectCliInventoryLegacySchemaVersion;
}

export interface ProjectCliComputeInventoryV2 extends ProjectCliComputeInventoryBase {
  privateNetworks: ProjectCliPrivateNetwork[];
  schemaVersion: typeof projectCliInventorySchemaVersion;
}

export interface ProjectCliComputeInventoryV3 extends ProjectCliComputeInventoryBase {
  privateNetworks: ProjectCliPrivateNetwork[];
  schemaVersion: typeof projectCliInventoryHostdSchemaVersion;
}

export type ProjectCliComputeInventory =
  | ProjectCliComputeInventoryV1
  | ProjectCliComputeInventoryV2
  | ProjectCliComputeInventoryV3;
