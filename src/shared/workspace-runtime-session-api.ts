export const workspaceRuntimeSessionSchemaVersion = 1 as const;

export const workspaceRuntimeBaseCapabilities = [
  'runtime.lifecycle',
  'runtime.heartbeat',
  'runtime.dev-servers',
  'runtime.telemetry',
  'runtime.log-pointers'
] as const;

export const workspaceRuntimeReadyCapabilities = [
  'runtime.codex.v1'
] as const;

export type WorkspaceRuntimeBaseCapability = typeof workspaceRuntimeBaseCapabilities[number];
export type WorkspaceRuntimeReadyCapability = typeof workspaceRuntimeReadyCapabilities[number];
export type WorkspaceRuntimeCapability =
  | WorkspaceRuntimeBaseCapability
  | WorkspaceRuntimeReadyCapability;
export type WorkspaceRuntimeConnectionState =
  | 'connecting'
  | 'online'
  | 'disconnected'
  | 'stale'
  | 'stopped';
export type WorkspaceRuntimeLifecycleState =
  | 'starting'
  | 'running'
  | 'suspended'
  | 'stopping'
  | 'stopped'
  | 'failed';

export interface WorkspaceRuntimeCredentialRequest {
  capabilities: WorkspaceRuntimeBaseCapability[];
  environmentId: string;
  expiresInSeconds?: number;
  generation: string;
  workspaceId: string;
}

export interface WorkspaceRuntimeCredential {
  capabilities: WorkspaceRuntimeBaseCapability[];
  credentialId: string;
  environmentId: string;
  expiresAt: string;
  generation: string;
  schemaVersion: typeof workspaceRuntimeSessionSchemaVersion;
  token: string;
  workspaceId: string;
}

export interface WorkspaceRuntimeRegistration {
  branch: string;
  commit: string;
  environmentId: string;
  generation: string;
  manifestDigest: string;
  readyCapabilities?: WorkspaceRuntimeReadyCapability[];
  resumeAfterSequence: number;
  resumeAfterCodexCommandSequence?: number;
  resumeAfterCodexEventSequence?: number;
  runtimeVersion: string;
  schemaVersion: typeof workspaceRuntimeSessionSchemaVersion;
  type: 'runtime.register';
  workspaceId: string;
}

export interface WorkspaceRuntimeDevServer {
  name: string;
  port: number;
  state: 'starting' | 'ready' | 'stopped' | 'failed';
  url?: string;
}

export type WorkspaceRuntimeEvent =
  | {
      eventId: string;
      observedAt: string;
      schemaVersion: typeof workspaceRuntimeSessionSchemaVersion;
      sequence: number;
      state: WorkspaceRuntimeLifecycleState;
      type: 'runtime.lifecycle';
    }
  | {
      eventId: string;
      observedAt: string;
      schemaVersion: typeof workspaceRuntimeSessionSchemaVersion;
      sequence: number;
      type: 'runtime.heartbeat';
    }
  | {
      devServers: WorkspaceRuntimeDevServer[];
      eventId: string;
      observedAt: string;
      schemaVersion: typeof workspaceRuntimeSessionSchemaVersion;
      sequence: number;
      type: 'runtime.dev-servers';
    }
  | {
      cpuPercent: number;
      eventId: string;
      memoryBytes: number;
      observedAt: string;
      schemaVersion: typeof workspaceRuntimeSessionSchemaVersion;
      sequence: number;
      type: 'runtime.telemetry';
    }
  | {
      eventId: string;
      observedAt: string;
      pointer: string;
      schemaVersion: typeof workspaceRuntimeSessionSchemaVersion;
      sequence: number;
      type: 'runtime.log-pointer';
    };

export interface WorkspaceRuntimeSessionSnapshot {
  branch: string;
  capabilities: WorkspaceRuntimeCapability[];
  commit: string;
  connectionState: WorkspaceRuntimeConnectionState;
  devServers: WorkspaceRuntimeDevServer[];
  environmentId: string;
  expiresAt: string;
  generation: string;
  lastEventAt: string;
  lastHeartbeatAt: string;
  lastSequence: number;
  lifecycleState: WorkspaceRuntimeLifecycleState;
  logPointer?: string;
  manifestDigest: string;
  runtimeVersion: string;
  schemaVersion: typeof workspaceRuntimeSessionSchemaVersion;
  sessionId: string;
  telemetry?: { cpuPercent: number; memoryBytes: number };
  workspaceId: string;
}

export interface WorkspaceRuntimeServerMessage {
  acceptedSequence: number;
  heartbeatIntervalSeconds: number;
  sessionId: string;
  staleAfterSeconds: number;
  replayed: boolean;
  schemaVersion: typeof workspaceRuntimeSessionSchemaVersion;
  snapshot?: WorkspaceRuntimeSessionSnapshot;
  type: 'runtime.accepted' | 'runtime.registered';
}
