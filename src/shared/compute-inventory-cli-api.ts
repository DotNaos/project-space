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

export const projectCliInventorySchemaVersion = 1;

export interface ProjectCliInventoryResourceSummary {
  architecture: string;
  cpuCores: number;
  cpuLimit?: number;
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
  alias: string;
  capabilities: ProjectCliHostCapabilities;
  id: string;
  name: string;
  platformId: string;
  resources?: ProjectCliInventoryResourceSummary;
}

export interface ProjectCliAccessRoute {
  available: boolean;
  capabilities: string[];
  connectorStatus: 'local' | 'online' | 'offline' | 'not-installed';
  lastSeen?: string;
  type: 'connector';
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
    state: 'available' | 'unavailable' | 'unknown';
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

export interface ProjectCliComputeInventory {
  checkedAt: string;
  environmentCatalog: ProjectCliEnvironmentDefinition[];
  environmentInstances: ProjectCliEnvironmentInstance[];
  hosts: ProjectCliHost[];
  inventoryState: 'conflict' | 'ready';
  platforms: ProjectCliPlatform[];
  schemaVersion: typeof projectCliInventorySchemaVersion;
  violations: ProjectCliInventoryViolation[];
}
