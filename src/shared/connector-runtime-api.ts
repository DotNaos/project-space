export type ConnectorRuntimePlatform = 'darwin' | 'linux' | 'windows';
export type ConnectorRuntimeArchitecture = 'arm64' | 'x64';
export type ConnectorRuntimeChannel = 'stable' | 'beta' | 'dev';
export type ConnectorRuntimeSource =
  | 'managed'
  | 'homebrew'
  | 'winget'
  | 'source'
  | 'legacy'
  | 'unknown';

export interface ConnectorRuntimeBundleVersions {
  connector: string;
  machineTools: string;
  projectCli: string;
}

export interface ConnectorRuntimeMaintenanceEvidence {
  operationId: string;
  state: 'pending-health-check' | 'rolled-back';
}

export interface ConnectorRuntimeRecord {
  architecture: ConnectorRuntimeArchitecture;
  buildId: string;
  bundleVersions: ConnectorRuntimeBundleVersions;
  channel: ConnectorRuntimeChannel;
  instanceId: string;
  lastCheckedAt: string;
  maintenance?: ConnectorRuntimeMaintenanceEvidence;
  platform: ConnectorRuntimePlatform;
  protocolVersion: string;
  releaseId: string;
  source: ConnectorRuntimeSource;
  version: string;
}

export type ConnectorRuntimeState =
  | 'checking'
  | 'up-to-date'
  | 'update-available'
  | 'update-required'
  | 'updating'
  | 'restart-required'
  | 'restarting'
  | 'failed'
  | 'rollback'
  | 'offline'
  | 'unknown'
  | 'unsupported';

export type ConnectorRuntimeOperationName = 'restart' | 'update';
export type ConnectorRuntimeOperationState =
  | 'queued'
  | 'validating'
  | 'staging'
  | 'verified'
  | 'switching'
  | 'restarting'
  | 'reconnecting'
  | 'health-checking'
  | 'rolling-back'
  | 'succeeded'
  | 'failed'
  | 'rolled-back'
  | 'recovery-required';

export interface ConnectorRuntimeFailure {
  at: string;
  code: string;
  message: string;
  rollbackAvailable: boolean;
}

export interface ConnectorRuntimeFingerprint {
  buildId: string;
  bundleVersions: ConnectorRuntimeBundleVersions;
  capabilities: string[];
  instanceId: string;
  protocolVersion: string;
  releaseId: string;
  version: string;
}

export interface ConnectorRuntimeOperationRecord {
  createdAt: string;
  deadlineAt?: string;
  expectedBuildId?: string;
  expectedFingerprint?: ConnectorRuntimeFingerprint;
  expectedReleaseId?: string;
  finishedAt?: string;
  id: string;
  lastFailure?: ConnectorRuntimeFailure;
  machineId: string;
  operation: ConnectorRuntimeOperationName;
  previousFingerprint?: ConnectorRuntimeFingerprint;
  previousInstanceId?: string;
  requestedByUserId: string;
  startedAt?: string;
  state: ConnectorRuntimeOperationState;
  updatedAt: string;
}

export interface ConnectorRuntimeUpdateRecord {
  availableReleaseId?: string;
  availableVersion?: string;
  lastCheckedAt?: string;
  lastFailure?: ConnectorRuntimeFailure;
  operation?: ConnectorRuntimeOperationRecord;
  state: ConnectorRuntimeState;
}

export interface MachineRuntimeStatusResult {
  capabilities: string[];
  machineId: string;
  online: boolean;
  runtime?: ConnectorRuntimeRecord;
  update: ConnectorRuntimeUpdateRecord;
}

export interface MachineRuntimeOperationRequest {
  operation: ConnectorRuntimeOperationName;
  releaseId?: string;
}

export interface MachineRuntimeOperationResult {
  operation: ConnectorRuntimeOperationRecord;
  status: MachineRuntimeStatusResult;
}

export interface MachineRuntimeStopResult {
  operationId: string;
  status: 'accepted';
}
