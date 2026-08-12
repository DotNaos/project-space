import type {
  ProjectHostdCredential,
  ProjectHostdCredentialRequest,
  ProjectHostdObservation,
  ProjectHostdSnapshot
} from '../../src/shared/project-hostd-api';

export type ProjectHostdErrorCode =
  | 'authentication_failed'
  | 'credential_expired'
  | 'invalid_message'
  | 'operation_in_progress'
  | 'replay_conflict'
  | 'sequence_conflict'
  | 'stale_observation'
  | 'target_conflict'
  | 'unregistered_runtime';

export class ProjectHostdError extends Error {
  constructor(
    readonly code: ProjectHostdErrorCode,
    message: string,
    readonly expectedNextSequence?: number
  ) {
    super(message);
  }
}

export interface ProjectHostdCredentialScope {
  credentialId: string;
  deviceId: string;
  environmentId: string;
  expiresAt: string;
  hostId?: string;
  ownerUserId: string;
}

export interface IssueProjectHostdCredentialInput extends ProjectHostdCredentialRequest {
  ownerUserId: string;
}

export interface ProjectHostdStore {
  append(
    scope: ProjectHostdCredentialScope,
    observation: ProjectHostdObservation,
    receivedAt: string
  ): Promise<{ replayed: boolean; snapshot: ProjectHostdSnapshot }>;
  authenticate(token: string): Promise<ProjectHostdCredentialScope | null>;
  issue(input: IssueProjectHostdCredentialInput): Promise<ProjectHostdCredential>;
  list(ownerUserId: string): Promise<ProjectHostdSnapshot[]>;
  markStale(staleBefore: string, checkedAt: string): Promise<ProjectHostdSnapshot[]>;
  pruneExpired(retainAfter: string): Promise<number>;
  replay(
    scope: ProjectHostdCredentialScope,
    observation: ProjectHostdObservation
  ): Promise<ProjectHostdSnapshot | null>;
  revoke(ownerUserId: string, deviceId: string, credentialId: string): Promise<void>;
}

export interface ProjectHostdTargetResolver {
  resolve(input: {
    environmentId: string;
    hostId?: string;
    ownerUserId: string;
  }): Promise<'matched' | 'missing' | 'conflict'>;
}

export interface RegisteredRuntimeResolver {
  registered(input: {
    environmentId: string;
    ownerUserId: string;
    runtimes: Array<{
      generation: string;
      workspaceId: string;
    }>;
  }): Promise<boolean>;
}
