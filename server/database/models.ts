import type { ProjectsState } from '../../src/shared/project-space-api';

export type MachineMembershipRole = 'member' | 'owner';

export interface MachineMembership {
  createdAt: string;
  id: string;
  machineId: string;
  role: MachineMembershipRole;
  updatedAt: string;
  userId: string;
}

export interface MachineMembershipKey {
  machineId: string;
  userId: string;
}

export interface ProjectRunSettings {
  allowedHosts: string[];
  createdAt: string;
  id: string;
  machineId: string;
  preferredWorktreeId?: string;
  projectId: string;
  runTarget: string;
  updatedAt: string;
  userId: string;
}

export interface ProjectRunSettingsKey extends MachineMembershipKey {
  projectId: string;
}

export interface UpsertProjectRunSettingsInput extends ProjectRunSettingsKey {
  allowedHosts?: readonly string[];
  preferredWorktreeId?: string | null;
  runTarget?: string;
}

export type DevServerSessionState =
  | 'error'
  | 'running'
  | 'starting'
  | 'stopped'
  | 'stopping';

export interface DevServerSession {
  createdAt: string;
  generation: number;
  id: string;
  lastError?: string;
  lastSeenAt?: string;
  localPort?: number;
  machineId: string;
  ownerUserId: string;
  projectId: string;
  runTarget: string;
  serverId: string;
  startedAt?: string;
  state: DevServerSessionState;
  stoppedAt?: string;
  tailscalePort?: number;
  tailscaleUrl?: string;
  updatedAt: string;
  worktreeId: string;
}

export interface CreateDevServerSessionInput {
  localPort?: number;
  machineId: string;
  ownerUserId: string;
  projectId: string;
  runTarget?: string;
  serverId: string;
  state?: DevServerSessionState;
  tailscalePort?: number;
  tailscaleUrl?: string;
  worktreeId: string;
}

export interface DevServerSessionKey {
  sessionId: string;
  userId: string;
}

export interface DevServerSessionListFilter {
  activeOnly?: boolean;
  machineId?: string;
  projectId?: string;
  serverId?: string;
  worktreeId?: string;
}

export interface TransitionDevServerSessionInput extends DevServerSessionKey {
  expectedGeneration: number;
  lastError?: string | null;
  lastSeenAt?: string | null;
  localPort?: number | null;
  startedAt?: string | null;
  state: DevServerSessionState;
  stoppedAt?: string | null;
  tailscalePort?: number | null;
  tailscaleUrl?: string | null;
}

export interface CreateConnectorCredentialInput {
  machineId: string;
  ttlSeconds?: number;
  userId: string;
}

export interface CreatedConnectorCredential {
  expiresAt: string;
  id: string;
  token: string;
  userId: string;
}

export type ConnectorCredentialStatus = 'active' | 'expired' | 'pending' | 'revoked';

export interface StoredConnectorCredential {
  createdAt: string;
  expiresAt: string;
  id: string;
  lastSeenAt?: string;
  machineId?: string;
  revokedAt?: string;
  status: ConnectorCredentialStatus;
}

export interface AuthenticateConnectorCredentialInput {
  machineId: string;
  token: string;
}

export interface AuthenticatedConnectorCredential {
  credentialId: string;
  machineId: string;
  userId: string;
}

export interface RevokeConnectorCredentialInput {
  credentialId: string;
  userId: string;
}

export interface MachineExecutionScopeKey {
  scopeId: string;
  userId: string;
}

export interface SaveMachineExecutionScopeInput {
  machineIds: string[];
  name: string;
  scopeId?: string;
  userId: string;
}

export interface UserProjectsStateKey {
  userId: string;
}

export interface UpsertUserProjectsStateInput extends UserProjectsStateKey {
  state: ProjectsState;
}
