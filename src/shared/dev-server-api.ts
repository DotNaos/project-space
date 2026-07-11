export type DevServerCapability = 'configured' | 'unavailable';
export type DevServerState = 'starting' | 'running' | 'stopping' | 'stopped' | 'error';
export type DevServerOperation = 'inspect' | 'start' | 'stop';
export type MachineMembershipAccess =
  | 'owner'
  | 'member'
  | 'unclaimed'
  | 'denied'
  | 'database-required';

/** Browser-safe identity for a known project on a known connector machine. */
export interface DevServerInspectRequest {
  machineId: string;
  projectId: string;
}

/** Browser-safe identity for a known worktree. Paths are resolved by the server. */
export interface DevServerActionRequest extends DevServerInspectRequest {
  worktreeId: string;
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
  runTarget: string;
}

/** A short-lived grant signed by the hub and checked by the connector. */
export interface DevServerCommandGrant {
  allowedHosts: string[];
  expiresAt: string;
  generation: number;
  issuedAt: string;
  machineId: string;
  nonce: string;
  operation: DevServerOperation;
  projectId: string;
  runTarget: string;
  signature: string;
  userId: string;
  worktreeId: string;
  worktreePath: string;
}

/** Trusted hub-to-connector request. Never construct this from browser input directly. */
export interface DevServerConnectorRequest extends DevServerActionRequest {
  allowedHosts: string[];
  grant: DevServerCommandGrant;
  runTarget: string;
  worktreePath: string;
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
  startedAt?: string;
  state: DevServerState;
  tailscaleIPv4?: string;
  tailscaleUrl?: string;
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
  credentialId: string;
  expiresAt: string;
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
