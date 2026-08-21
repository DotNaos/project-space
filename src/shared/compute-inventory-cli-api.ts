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
import type {
  WorkspaceRuntimeConnectionState,
  WorkspaceRuntimeDevServer,
  WorkspaceRuntimeLifecycleState
} from './workspace-runtime-session-api';

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
  summary?: ProjectCliHostCapabilitySummary;
}

export type ProjectCliEvidenceState = 'available' | 'stale' | 'unavailable' | 'unknown';

export interface ProjectCliHostCapabilitySummary {
  console: ProjectCliEvidenceState;
  power: ProjectCliEvidenceState;
  provider: 'jetkvm' | 'none' | 'unknown';
  reset: ProjectCliEvidenceState;
  wakeOnLan: ProjectCliEvidenceState;
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
  clientAccess?: ProjectCliClientAccess;
  id: string;
  lastVerifiedAt?: string;
  priority: number;
  providerKind?: 'tailscale' | 'wireguard' | 'other';
  state: 'ready' | 'unavailable' | 'unverified' | 'stale' | 'policy_blocked';
  type: 'ssh_private_network' | 'provider_native' | 'host_console' | 'hostd';
}

/**
 * Non-secret launch metadata for the client-owned access bridge.
 * Credentials, sockets, terminal data, and remote command text never belong here.
 */
export interface ProjectCliClientAccess {
  address: string;
  hostKeySha256: string;
  port: number;
  targetIdentityRevision: string;
  user: string;
}

export type ProjectCliAccessRoute =
  | ProjectCliConnectorAccessRoute
  | ProjectCliControlledAccessRoute;

export interface ProjectCliEnvironmentAccessSummary {
  providerKind: 'none' | 'other' | 'provider_native' | 'tailscale' | 'wireguard';
  route: ProjectCliEvidenceState;
  ssh: {
    hostKey: 'unknown' | 'unverified' | 'verified';
    projectCli: ProjectCliEvidenceState;
    readiness: ProjectCliEvidenceState;
  };
}

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
  runtime?: ProjectCliWorkspaceRuntimeSummary;
  state: 'active' | 'inactive';
}

export interface ProjectCliWorkspaceRuntimeSummary {
  codex: ProjectCliEvidenceState;
  connection: WorkspaceRuntimeConnectionState;
  devServers: Array<Pick<WorkspaceRuntimeDevServer, 'name' | 'state'>>;
  evidence: 'project-hostd' | 'unavailable' | 'workspace-runtime';
  lifecycle: WorkspaceRuntimeLifecycleState;
}

export interface ProjectCliEnvironmentInstance {
  accessSummary?: ProjectCliEnvironmentAccessSummary;
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
