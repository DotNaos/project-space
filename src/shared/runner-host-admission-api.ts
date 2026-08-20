export const RUNNER_HOST_ADMISSION_API_VERSION = 1 as const;

export const runnerResourceDimensions = [
  'cpuMillis',
  'cpuSchedulingWeight',
  'memoryBytes',
  'swapBytes',
  'pids',
  'openFiles',
  'diskBytes',
  'inodes',
  'ioBytesPerSecond',
  'ioWeight',
  'networkConnections',
  'exposedPorts',
  'logBytes',
  'modelConcurrency'
] as const;

export type RunnerResourceDimension = typeof runnerResourceDimensions[number];

export type RunnerResourceVector = Record<RunnerResourceDimension, number>;

export interface RunnerSandboxIsolationProfile {
  crossSandboxWritableVolumes: 'denied';
  deploymentCredentials: 'denied';
  dockerSocket: 'denied';
  egress: 'development';
  hostNetwork: 'denied';
  productionDatabase: 'denied';
  productionFilesystem: 'denied';
  sharedCaches: 'immutable-only';
}

export interface RunnerSandboxIdentity {
  baseSha: string;
  branch: string;
  codexTaskId: string;
  generation: string;
  hostId: string;
  issueNumber: number;
  operationId: string;
  ownerUserId: string;
  projectManagerTaskId: string;
  repositoryId: string;
  reservationId: string;
  taskId: string;
  workspaceId: string;
}

export interface RunnerHostCapacityEvidence {
  apiVersion: typeof RUNNER_HOST_ADMISSION_API_VERSION;
  capacity: {
    maxConcurrentSandboxes: number;
    productionUsage: RunnerResourceVector;
    sandboxCount: number;
    sandboxUsage: RunnerResourceVector;
    total: RunnerResourceVector;
  };
  cleanup: {
    checkedAt: string;
    state: 'proven' | 'uncertain';
  };
  expiresAt: string;
  generation: string;
  hostId: string;
  observedAt: string;
  productionHealth: 'healthy' | 'unknown';
}

export interface RunnerHostAdmissionPolicy {
  aggregateMaximum: RunnerResourceVector;
  absenceProofClockSkewSeconds: number;
  absenceProofMaxAgeSeconds: number;
  evidenceMaxAgeSeconds: number;
  isolation: RunnerSandboxIsolationProfile;
  leaseSeconds: number;
  maxConcurrentSandboxes: number;
  maximumRuntimeSeconds: number;
  productionReservation: RunnerResourceVector;
  sandboxMaximum: RunnerResourceVector;
}

export interface RunnerSandboxAdmissionRequest {
  idleTimeoutSeconds: number;
  identity: RunnerSandboxIdentity;
  isolation: RunnerSandboxIsolationProfile;
  maximumRuntimeSeconds: number;
  resources: RunnerResourceVector;
}

export interface RunnerSandboxReservation extends RunnerSandboxAdmissionRequest {
  createdAt: string;
  hostGeneration: string;
  idleExpiresAt: string;
  leaseExpiresAt: string;
  runtimeExpiresAt: string;
  state: 'active' | 'released' | 'uncertain';
  fingerprint: string;
  absenceProof?: RunnerSandboxAbsenceProof;
}

export type RunnerHostAdmissionBlockedReason =
  | 'capacity_evidence_missing'
  | 'capacity_evidence_invalid'
  | 'capacity_evidence_stale'
  | 'cleanup_uncertain'
  | 'concurrency_limit'
  | 'identity_conflict'
  | 'host_identity_mismatch'
  | 'identity_invalid'
  | 'invalid_lease'
  | 'production_reservation_not_proven'
  | 'resource_limit';

export type RunnerHostAdmissionResult =
  | { kind: 'blocked'; reason: RunnerHostAdmissionBlockedReason; message: string }
  | { kind: 'conflict'; reason: 'identity_conflict'; message: string }
  | { kind: 'replayed'; reservation: RunnerSandboxReservation }
  | { kind: 'reserved'; reservation: RunnerSandboxReservation };

export interface RunnerSandboxAbsenceProof {
  checkedAt: string;
  identity: RunnerSandboxIdentity;
  resourcesAbsent: true;
}
