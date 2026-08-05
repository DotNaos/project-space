export type DevServerCapability = 'configured' | 'unavailable';
export type DevServerState = 'starting' | 'running' | 'stopping' | 'stopped' | 'error';
export type DevServerOperation = 'inspect' | 'list' | 'start' | 'stop';
export type MachineMembershipAccess =
  'owner' | 'member' | 'unclaimed' | 'denied' | 'database-required';

/** Browser-safe identity for a known project on a known connector machine. */
export interface DevServerInspectRequest {
  machineId: string;
  projectId: string;
  /** Optional exact branch selector for task-scoped server inspection. */
  branchName?: string;
  /** Select only the project's base worktree. */
  preferBase?: boolean;
  /** Optional trusted worktree identities used to keep focused views bounded. */
  worktreeIds?: string[];
}

/** Browser-safe identity for a known worktree. Paths are resolved by the server. */
export interface DevServerActionRequest extends DevServerInspectRequest {
  serverId: string;
  worktreeId: string;
}

export interface ConfiguredDevServerRecord {
  capability: DevServerCapability;
  label: string;
  serverId: string;
}

export interface ProjectRunSettingsRecord {
  allowedHosts: string[];
  machineId: string;
  preferredWorktreeId?: string;
  projectId: string;
  runTarget: string;
}

export interface ProjectRunSettingsUpdateRequest extends DevServerInspectRequest {
  allowedHosts: string[];
  preferredWorktreeId?: string;
  runTarget?: string;
}

/** A short-lived grant signed by the hub and checked by the connector. */
export interface DevServerCommandGrant {
  allowedHosts?: string[];
  expectedHeadSha: string;
  expiresAt: string;
  generation: number;
  issuedAt: string;
  machineId: string;
  nonce: string;
  operation: DevServerOperation;
  projectId: string;
  runTarget?: string;
  serverId?: string;
  signature: string;
  userId: string;
  worktreeId: string;
}

/** Trusted hub-to-connector request. Never construct this from browser input directly. */
export interface DevServerConnectorRequest extends DevServerActionRequest {
  allowedHosts: string[];
  expectedHeadSha: string;
  grant: DevServerCommandGrant;
  runTarget: string;
}

/** Trusted inventory request. The connector resolves declarations inside the selected worktree. */
export interface DevServerListConnectorRequest extends DevServerInspectRequest {
  expectedHeadSha: string;
  grant: DevServerCommandGrant;
  worktreeId: string;
}

export interface DevServerConnectorResult {
  capability: DevServerCapability;
  checkedAt: string;
  generation: number;
  lastError?: string;
  localPort?: number;
  localUrl?: string;
  machineId: string;
  projectId: string;
  publicPort?: number;
  runTarget: string;
  serverId: string;
  startedAt?: string;
  state: DevServerState;
  tailscaleIPv4?: string;
  tailscaleUrl?: string;
  worktreeId: string;
}

export interface DevServerListConnectorResult {
  capability: DevServerCapability;
  checkedAt: string;
  generation: number;
  lastError?: string;
  machineId: string;
  projectId: string;
  servers: ConfiguredDevServerRecord[];
  worktreeId: string;
}

/** Stable JSON contract returned directly by `project serve`. */
export interface DevServerRuntimeResult {
  allowedHosts: string[];
  capability: DevServerCapability;
  checkedAt: string;
  directory: string;
  lastError: string | null;
  localPort: number | null;
  localUrl: string | null;
  operation: 'start' | 'status' | 'stop';
  pid: number | null;
  publicPort: number | null;
  publicUrl: string | null;
  schemaVersion: 1;
  script: string;
  startedAt: string | null;
  state: DevServerState;
  tailscaleIPv4: string | null;
}

/** Stable JSON contract returned by `project serve list`. */
export interface DevServerRuntimeListResult {
  capability: DevServerCapability;
  checkedAt: string;
  directory: string;
  lastError: string | null;
  operation: 'list';
  schemaVersion: 1;
  servers: ConfiguredDevServerRecord[];
}

export interface WorktreeDevServerRecord {
  capability: DevServerCapability;
  checkedAt: string;
  lastError?: string;
  localPort?: number;
  localUrl?: string;
  machineId: string;
  projectId: string;
  publicPort?: number;
  runTarget: string;
  serverId: string;
  serverLabel: string;
  startedAt?: string;
  state: DevServerState;
  tailscaleIPv4?: string;
  tailscaleUrl?: string;
  verifiedAt?: string;
  worktreeId: string;
}

export interface DevServerOverviewResult {
  access: MachineMembershipAccess;
  machineId: string;
  message?: string;
  projectId: string;
  servers: WorktreeDevServerRecord[];
  settings?: ProjectRunSettingsRecord;
}

export interface ConnectorInstallerResult {
  command: string;
  scriptUrl: string;
}

export type ConnectorCredentialStatus = 'active' | 'expired' | 'pending' | 'revoked';

export interface ConnectorCredentialRecord {
  createdAt: string;
  expiresAt: string;
  id: string;
  lastSeenAt?: string;
  machineId?: string;
  revokedAt?: string;
  status: ConnectorCredentialStatus;
}
