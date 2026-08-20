import type {
  RunnerHostAdmissionPolicy,
  RunnerHostCapacityEvidence,
  RunnerSandboxAdmissionRequest,
  RunnerResourceVector
} from '../src/shared/runner-host-admission-api';

export const hostId = 'vps:project-space-01';
export const isolation = {
  crossSandboxWritableVolumes: 'denied' as const,
  deploymentCredentials: 'denied' as const,
  dockerSocket: 'denied' as const,
  egress: 'development' as const,
  hostNetwork: 'denied' as const,
  productionDatabase: 'denied' as const,
  productionFilesystem: 'denied' as const,
  sharedCaches: 'immutable-only' as const
};
export const policy: RunnerHostAdmissionPolicy = {
  aggregateMaximum: vector({ cpuMillis: 2_000, memoryBytes: 4_000, pids: 256 }),
  absenceProofClockSkewSeconds: 0,
  absenceProofMaxAgeSeconds: 30,
  evidenceMaxAgeSeconds: 30,
  isolation,
  leaseSeconds: 900,
  maxConcurrentSandboxes: 2,
  maximumRuntimeSeconds: 43_200,
  productionReservation: vector({ cpuMillis: 2_000, memoryBytes: 4_000, pids: 256 }),
  sandboxMaximum: vector({ cpuMillis: 1_000, memoryBytes: 2_000, pids: 128 })
};
export const evidence: RunnerHostCapacityEvidence = {
  apiVersion: 1,
  capacity: {
    maxConcurrentSandboxes: 2,
    productionUsage: vector(),
    sandboxCount: 0,
    sandboxUsage: vector(),
    total: vector({ cpuMillis: 4_000, memoryBytes: 8_000, pids: 512 })
  },
  cleanup: { checkedAt: '2026-08-20T10:00:00.000Z', state: 'proven' },
  expiresAt: '2026-08-20T10:00:30.000Z',
  generation: 'host-generation-1',
  hostId,
  observedAt: '2026-08-20T10:00:00.000Z',
  productionHealth: 'healthy'
};

export const request = (
  id = 'reservation-1',
  resources = vector({ cpuMillis: 1_000, memoryBytes: 2_000, pids: 128 })
): RunnerSandboxAdmissionRequest => ({
  idleTimeoutSeconds: 1_800,
  identity: {
    baseSha: 'a'.repeat(40), branch: 'issue-826', codexTaskId: 'codex-826',
    generation: 'host-generation-1', hostId, issueNumber: 826, operationId: `operation-${id}`,
    ownerUserId: 'project-manager', projectManagerTaskId: 'manager-826',
    repositoryId: 'DotNaos/project-space', reservationId: `${hostId}:${id}`, taskId: 'task-826',
    workspaceId: 'workspace-826'
  },
  isolation,
  maximumRuntimeSeconds: 43_200,
  resources
});

export function vector(overrides: Partial<RunnerResourceVector> = {}): RunnerResourceVector {
  return {
    cpuMillis: 0, cpuSchedulingWeight: 0, memoryBytes: 0, swapBytes: 0, pids: 0, openFiles: 0,
    diskBytes: 0, inodes: 0, ioBytesPerSecond: 0, ioWeight: 0, networkConnections: 0,
    exposedPorts: 0, logBytes: 0, modelConcurrency: 0, ...overrides
  };
}
