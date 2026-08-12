import type {
  WorkspaceRuntimeCapability,
  WorkspaceRuntimeCredential,
  WorkspaceRuntimeDevServer,
  WorkspaceRuntimeEvent,
  WorkspaceRuntimeRegistration,
  WorkspaceRuntimeSessionSnapshot
} from '../../src/shared/workspace-runtime-session-api';

export type RuntimeSessionErrorCode =
  | 'authentication_failed'
  | 'credential_expired'
  | 'generation_replaced'
  | 'invalid_message'
  | 'replay_conflict'
  | 'sequence_conflict';

export class RuntimeSessionError extends Error {
  constructor(readonly code: RuntimeSessionErrorCode, message: string) {
    super(message);
  }
}

export interface RuntimeCredentialScope {
  branch: string;
  capabilities: WorkspaceRuntimeCapability[];
  commit: string;
  credentialId: string;
  environmentId: string;
  expiresAt: string;
  generation: string;
  manifestDigest: string;
  ownerUserId: string;
  runtimeVersion: string;
  workspaceId: string;
}

export interface IssueRuntimeCredentialInput {
  branch: string;
  capabilities: WorkspaceRuntimeCapability[];
  commit: string;
  environmentId: string;
  expiresInSeconds?: number;
  generation: string;
  manifestDigest: string;
  ownerUserId: string;
  runtimeVersion: string;
  workspaceId: string;
}

export interface RuntimeSessionEventRecord {
  event: WorkspaceRuntimeEvent;
  fingerprint: string;
}

export interface RuntimeSessionRecord {
  credentialId: string;
  events: Map<string, RuntimeSessionEventRecord>;
  snapshot: WorkspaceRuntimeSessionSnapshot;
}

export interface RuntimeSessionStore {
  append(scope: RuntimeCredentialScope, sessionId: string, receivedAt: string, event: WorkspaceRuntimeEvent): Promise<{
    replayed: boolean;
    snapshot: WorkspaceRuntimeSessionSnapshot;
  }>;
  authenticate(token: string): Promise<RuntimeCredentialScope | null>;
  disconnect(scope: RuntimeCredentialScope, sessionId: string, checkedAt: string): Promise<void>;
  issue(input: IssueRuntimeCredentialInput): Promise<{
    credential: WorkspaceRuntimeCredential;
    replacedCredentialId?: string;
  }>;
  list(ownerUserId: string): Promise<WorkspaceRuntimeSessionSnapshot[]>;
  markStale(staleBefore: string, checkedAt: string): Promise<WorkspaceRuntimeSessionSnapshot[]>;
  revoke(ownerUserId: string, workspaceId: string, credentialId: string): Promise<void>;
  register(scope: RuntimeCredentialScope, sessionId: string, receivedAt: string, registration: WorkspaceRuntimeRegistration): Promise<{
    replacedSessionId?: string;
    replacedCredentialId?: string;
    snapshot: WorkspaceRuntimeSessionSnapshot;
  }>;
}

export interface RuntimeSessionClock {
  now(): Date;
}

export interface RuntimeSessionConnection {
  close(code: number, reason: string): void;
  send(value: string): void;
}

export interface RegisteredRuntimeConnection {
  connection: RuntimeSessionConnection;
  credentialId: string;
  generation: string;
  workspaceId: string;
}

export interface RuntimeSessionRegistrationInput {
  branch: string;
  capabilities: WorkspaceRuntimeCapability[];
  commit: string;
  environmentId: string;
  expiresAt: string;
  generation: string;
  manifestDigest: string;
  runtimeVersion: string;
  workspaceId: string;
}

export interface RuntimeSessionSafeState {
  devServers: WorkspaceRuntimeDevServer[];
}
