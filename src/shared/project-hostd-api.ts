export const projectHostdSchemaVersion = 1 as const;
export const projectHostdProtocolVersion = 1 as const;

export const projectHostdPartialMetrics = [
  'cpu',
  'memory',
  'storage',
  'gpu',
  'runtime'
] as const;

export type ProjectHostdPartialMetric = typeof projectHostdPartialMetrics[number];

export interface ProjectHostdCredentialRequest {
  deviceId: string;
  environmentId: string;
  expiresInSeconds?: number;
  hostId?: string;
  operationId: string;
}

export interface ProjectHostdCredential {
  credentialId: string;
  deviceId: string;
  environmentId: string;
  expiresAt: string;
  hostId?: string;
  schemaVersion: typeof projectHostdSchemaVersion;
  token: string;
}

export interface ProjectHostdResources {
  architecture: string;
  cpu: {
    cores: number;
    usedPercent: number;
  };
  gpu?: Array<{
    memoryBytes?: number;
    model: string;
    usedPercent?: number;
  }>;
  memory: {
    availableBytes: number;
    totalBytes: number;
  };
  operatingSystem: string;
  storage: {
    availableBytes: number;
    totalBytes: number;
  };
}

export interface ProjectHostdRuntimeTelemetry {
  boundaryKind: 'process_group';
  cpuPercent: number;
  generation: string;
  memoryBytes: number;
  workspaceId: string;
}

export interface ProjectHostdObservation {
  deviceId: string;
  environmentId: string;
  health: 'healthy' | 'degraded';
  hostId?: string;
  hostdVersion: string;
  observationId: string;
  observedAt: string;
  partialMetrics: ProjectHostdPartialMetric[];
  protocolVersion: typeof projectHostdProtocolVersion;
  resources: ProjectHostdResources;
  runtimes: ProjectHostdRuntimeTelemetry[];
  schemaVersion: typeof projectHostdSchemaVersion;
  sequence: number;
  type: 'hostd.telemetry';
  uptimeSeconds: number;
}

export interface ProjectHostdObservationResponse {
  acceptedSequence: number;
  replayed: boolean;
  schemaVersion: typeof projectHostdSchemaVersion;
  staleAfterSeconds: number;
  type: 'hostd.accepted';
}

export interface ProjectHostdSnapshot {
  connectionState: 'online' | 'stale';
  credentialId: string;
  deviceId: string;
  environmentId: string;
  health: 'healthy' | 'degraded';
  hostId?: string;
  hostdVersion: string;
  lastSeenAt: string;
  observedAt: string;
  partialMetrics: ProjectHostdPartialMetric[];
  protocolVersion: typeof projectHostdProtocolVersion;
  resources: ProjectHostdResources;
  runtimes: ProjectHostdRuntimeTelemetry[];
  schemaVersion: typeof projectHostdSchemaVersion;
  sequence: number;
  uptimeSeconds: number;
}
