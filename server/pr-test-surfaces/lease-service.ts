import { randomUUID } from 'node:crypto';

import type { PullRequestPrototypeSurfaceKind } from '../../src/shared/pr-preview-test-surfaces-api';
import {
  canonicalTailscaleUrl,
  optionalThreadId,
  requireBranchName,
  requireCommitSha,
  requireIdentifier,
  requirePrototypeSurface,
  requirePullRequestNumber,
  requireRepositoryFullName,
  requireTimestamp
} from './validation';

export const prDevServerHeartbeatIntervalMs = 15_000;
export const prDevServerLeaseDurationMs = 45_000;
const maximumFutureEvidenceMs = 5_000;

export interface PullRequestDevServerLease {
  branchName: string;
  codexThreadId?: string;
  commitSha: string;
  connectorId: string;
  createdAt: string;
  expiresAt: string;
  generation: number;
  heartbeatAt: string;
  id: string;
  machineId: string;
  ownerUserId: string;
  projectId: string;
  pullRequestNumber: number;
  repositoryFullName: string;
  revokedAt?: string;
  servedSurface: PullRequestPrototypeSurfaceKind;
  serverId: string;
  tailscaleIpv4: string;
  tailscalePort: number;
  tailscaleUrl: string;
  updatedAt: string;
  worktreeId: string;
}

export interface PullRequestDevServerActor {
  connectorId: string;
  machineId: string;
  userId: string;
}

export interface PullRequestDevServerRuntimeEvidence {
  checkedAt: string;
  state: 'running' | 'stopped';
  tailscaleIpv4?: string;
  tailscalePort?: number;
}

export interface PullRequestDevServerRegistration {
  branchName: string;
  codexThreadId?: string;
  commitSha: string;
  projectId: string;
  pullRequestNumber: number;
  repositoryFullName: string;
  runtime: PullRequestDevServerRuntimeEvidence;
  servedSurface: PullRequestPrototypeSurfaceKind;
  serverId: string;
  worktreeId: string;
}

export interface PullRequestDevServerScopeEvidence {
  branchName: string;
  checkedAt: string;
  commitSha: string;
  connectorId: string;
  machineId: string;
  projectId: string;
  pullRequestNumber: number;
  repositoryFullName: string;
  servedSurface: PullRequestPrototypeSurfaceKind;
  serverId: string;
  state: 'verified';
  worktreeId: string;
}

interface PullRequestDevServerLeaseScope {
  ownerUserId: string;
  pullRequestNumber: number;
  repositoryFullName: string;
}

interface PullRequestDevServerHeartbeatMutation {
  actor: PullRequestDevServerActor;
  expiresAt: string;
  generation: number;
  heartbeatAt: string;
  leaseId: string;
  tailscaleIpv4: string;
  tailscalePort: number;
  tailscaleUrl: string;
}

export type PullRequestDevServerLeaseMutationResult =
  | { lease: PullRequestDevServerLease; state: 'updated' }
  | { state: 'expired' | 'forbidden' | 'missing' | 'revoked' | 'superseded' };

export interface PullRequestDevServerLeaseStore {
  heartbeat(
    mutation: PullRequestDevServerHeartbeatMutation
  ): Promise<PullRequestDevServerLeaseMutationResult>;
  readCurrent(
    scope: PullRequestDevServerLeaseScope
  ): Promise<PullRequestDevServerLease | null>;
  release(input: {
    actor: PullRequestDevServerActor;
    generation: number;
    leaseId: string;
    revokedAt: string;
  }): Promise<PullRequestDevServerLeaseMutationResult>;
  supersede(input: {
    actor: PullRequestDevServerActor;
    at: string;
    createId(): string;
    registration: Omit<
      PullRequestDevServerLease,
      'createdAt' | 'generation' | 'heartbeatAt' | 'id' | 'ownerUserId' | 'updatedAt'
    >;
  }): Promise<PullRequestDevServerLease>;
}

export type PullRequestDevServerLeaseErrorCode =
  | 'forbidden'
  | 'heartbeat-expired'
  | 'invalid-evidence'
  | 'lease-missing'
  | 'lease-revoked'
  | 'lease-superseded'
  | 'registration-mismatch'
  | 'server-stopped';

export class PullRequestDevServerLeaseError extends Error {
  constructor(readonly code: PullRequestDevServerLeaseErrorCode) {
    super(code.replaceAll('-', ' '));
    this.name = 'PullRequestDevServerLeaseError';
  }
}

export interface PullRequestDevServerLeaseServiceOptions {
  createId?: () => string;
  now?: () => Date;
  store: PullRequestDevServerLeaseStore;
  verifyScope(
    actor: PullRequestDevServerActor,
    registration: Omit<PullRequestDevServerRegistration, 'runtime'>
  ): Promise<PullRequestDevServerScopeEvidence | null>;
}

export function createPullRequestDevServerLeaseService(
  options: PullRequestDevServerLeaseServiceOptions
) {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;

  async function register(
    actorInput: PullRequestDevServerActor,
    registrationInput: PullRequestDevServerRegistration
  ) {
    const actor = normalizedActor(actorInput);
    const registration = normalizedRegistration(registrationInput);
    const acceptedAt = now();
    currentEvidenceTime(registration.runtime, acceptedAt);
    const scopeEvidence = await options.verifyScope(actor, {
      branchName: registration.branchName,
      codexThreadId: registration.codexThreadId,
      commitSha: registration.commitSha,
      projectId: registration.projectId,
      pullRequestNumber: registration.pullRequestNumber,
      repositoryFullName: registration.repositoryFullName,
      servedSurface: registration.servedSurface,
      serverId: registration.serverId,
      worktreeId: registration.worktreeId
    });
    if (!scopeEvidence || !scopeMatches(actor, registration, scopeEvidence)) {
      throw new PullRequestDevServerLeaseError('registration-mismatch');
    }
    requireFreshTimestamp(scopeEvidence.checkedAt, acceptedAt, 'scope evidence');
    const exposure = healthyExposure(
      registration.runtime,
      registration.servedSurface
    );
    const heartbeatAt = acceptedAt.toISOString();
    const expiresAt = new Date(acceptedAt.getTime() + prDevServerLeaseDurationMs).toISOString();
    const lease = await options.store.supersede({
      actor,
      at: heartbeatAt,
      createId,
      registration: {
        branchName: registration.branchName,
        codexThreadId: registration.codexThreadId,
        commitSha: registration.commitSha,
        connectorId: actor.connectorId,
        expiresAt,
        machineId: actor.machineId,
        projectId: registration.projectId,
        pullRequestNumber: registration.pullRequestNumber,
        repositoryFullName: registration.repositoryFullName,
        servedSurface: registration.servedSurface,
        serverId: registration.serverId,
        ...exposure,
        worktreeId: registration.worktreeId
      }
    });
    return leaseResponse(lease);
  }

  async function heartbeat(input: {
    actor: PullRequestDevServerActor;
    generation: number;
    leaseId: string;
    runtime: PullRequestDevServerRuntimeEvidence;
    servedSurface: PullRequestPrototypeSurfaceKind;
  }) {
    const actor = normalizedActor(input.actor);
    const leaseId = requireIdentifier(input.leaseId, 'leaseId');
    const generation = requireGeneration(input.generation);
    const acceptedAt = now();
    currentEvidenceTime(input.runtime, acceptedAt);
    const exposure = healthyExposure(
      input.runtime,
      requirePrototypeSurface(input.servedSurface)
    );
    const heartbeatAt = acceptedAt.toISOString();
    const result = await options.store.heartbeat({
      actor,
      expiresAt: new Date(acceptedAt.getTime() + prDevServerLeaseDurationMs).toISOString(),
      generation,
      heartbeatAt,
      leaseId,
      ...exposure
    });
    return mutationResponse(result);
  }

  async function release(input: {
    actor: PullRequestDevServerActor;
    generation: number;
    leaseId: string;
  }) {
    const result = await options.store.release({
      actor: normalizedActor(input.actor),
      generation: requireGeneration(input.generation),
      leaseId: requireIdentifier(input.leaseId, 'leaseId'),
      revokedAt: now().toISOString()
    });
    return mutationResponse(result);
  }

  return { heartbeat, register, release };
}

function normalizedActor(actor: PullRequestDevServerActor): PullRequestDevServerActor {
  return {
    connectorId: requireIdentifier(actor.connectorId, 'connectorId'),
    machineId: requireIdentifier(actor.machineId, 'machineId'),
    userId: requireIdentifier(actor.userId, 'userId')
  };
}

function normalizedRegistration(
  registration: PullRequestDevServerRegistration
): PullRequestDevServerRegistration {
  return {
    branchName: requireBranchName(registration.branchName),
    codexThreadId: optionalThreadId(registration.codexThreadId),
    commitSha: requireCommitSha(registration.commitSha),
    projectId: requireIdentifier(registration.projectId, 'projectId'),
    pullRequestNumber: requirePullRequestNumber(registration.pullRequestNumber),
    repositoryFullName: requireRepositoryFullName(registration.repositoryFullName),
    runtime: registration.runtime,
    servedSurface: requirePrototypeSurface(registration.servedSurface),
    serverId: requireIdentifier(registration.serverId, 'serverId'),
    worktreeId: requireIdentifier(registration.worktreeId, 'worktreeId')
  };
}

function currentEvidenceTime(
  runtime: PullRequestDevServerRuntimeEvidence,
  current: Date
) {
  const checkedAt = requireTimestamp(runtime.checkedAt, 'runtime.checkedAt');
  const observedAt = new Date(checkedAt);
  const age = current.getTime() - observedAt.getTime();
  if (age > prDevServerHeartbeatIntervalMs || age < -maximumFutureEvidenceMs) {
    throw new PullRequestDevServerLeaseError('invalid-evidence');
  }
  return observedAt;
}

function requireFreshTimestamp(value: string, current: Date, name: string) {
  const checkedAt = new Date(requireTimestamp(value, name));
  const age = current.getTime() - checkedAt.getTime();
  if (age > prDevServerHeartbeatIntervalMs || age < -maximumFutureEvidenceMs) {
    throw new PullRequestDevServerLeaseError('invalid-evidence');
  }
}

function healthyExposure(
  runtime: PullRequestDevServerRuntimeEvidence,
  servedSurface: PullRequestPrototypeSurfaceKind
) {
  if (runtime.state !== 'running') {
    throw new PullRequestDevServerLeaseError('server-stopped');
  }
  if (!runtime.tailscaleIpv4 || runtime.tailscalePort === undefined) {
    throw new PullRequestDevServerLeaseError('invalid-evidence');
  }
  return {
    tailscaleIpv4: runtime.tailscaleIpv4,
    tailscalePort: runtime.tailscalePort,
    tailscaleUrl: canonicalTailscaleUrl(
      runtime.tailscaleIpv4,
      runtime.tailscalePort,
      servedSurface
    )
  };
}

function scopeMatches(
  actor: PullRequestDevServerActor,
  registration: PullRequestDevServerRegistration,
  evidence: PullRequestDevServerScopeEvidence
) {
  return evidence.state === 'verified' &&
    evidence.connectorId === actor.connectorId &&
    evidence.machineId === actor.machineId &&
    evidence.repositoryFullName.toLowerCase() === registration.repositoryFullName.toLowerCase() &&
    evidence.pullRequestNumber === registration.pullRequestNumber &&
    evidence.projectId === registration.projectId &&
    evidence.worktreeId === registration.worktreeId &&
    evidence.branchName === registration.branchName &&
    evidence.commitSha.toLowerCase() === registration.commitSha &&
    evidence.servedSurface === registration.servedSurface &&
    evidence.serverId === registration.serverId;
}

function requireGeneration(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('generation must be a positive integer.');
  }
  return value;
}

function mutationResponse(result: PullRequestDevServerLeaseMutationResult) {
  if (result.state === 'updated') return leaseResponse(result.lease);
  const codes = {
    expired: 'heartbeat-expired',
    forbidden: 'forbidden',
    missing: 'lease-missing',
    revoked: 'lease-revoked',
    superseded: 'lease-superseded'
  } as const;
  throw new PullRequestDevServerLeaseError(codes[result.state]);
}

function leaseResponse(lease: PullRequestDevServerLease) {
  return {
    heartbeatIntervalSeconds: prDevServerHeartbeatIntervalMs / 1_000,
    lease,
    leaseDurationSeconds: prDevServerLeaseDurationMs / 1_000
  };
}

function scopeKey(scope: PullRequestDevServerLeaseScope) {
  return [
    scope.ownerUserId,
    scope.repositoryFullName.toLowerCase(),
    scope.pullRequestNumber
  ].join('\u0000');
}

export class InMemoryPullRequestDevServerLeaseStore
  implements PullRequestDevServerLeaseStore {
  private readonly leases = new Map<string, PullRequestDevServerLease>();
  private readonly currentByScope = new Map<string, string>();

  async supersede(
    input: Parameters<PullRequestDevServerLeaseStore['supersede']>[0]
  ) {
    const key = scopeKey({
      ownerUserId: input.actor.userId,
      pullRequestNumber: input.registration.pullRequestNumber,
      repositoryFullName: input.registration.repositoryFullName
    });
    const currentId = this.currentByScope.get(key);
    const current = currentId ? this.leases.get(currentId) : undefined;
    if (current && !current.revokedAt) {
      this.leases.set(current.id, {
        ...current,
        expiresAt: input.at,
        revokedAt: input.at,
        updatedAt: input.at
      });
    }
    const lease: PullRequestDevServerLease = {
      ...input.registration,
      createdAt: input.at,
      generation: (current?.generation ?? 0) + 1,
      heartbeatAt: input.at,
      id: input.createId(),
      ownerUserId: input.actor.userId,
      updatedAt: input.at
    };
    this.leases.set(lease.id, lease);
    this.currentByScope.set(key, lease.id);
    return structuredClone(lease);
  }

  async heartbeat(mutation: PullRequestDevServerHeartbeatMutation) {
    const checked = this.mutableCurrent(
      mutation.actor,
      mutation.leaseId,
      mutation.generation
    );
    if (checked.state !== 'updated') return checked;
    if (Date.parse(checked.lease.expiresAt) <= Date.parse(mutation.heartbeatAt)) {
      return { state: 'expired' as const };
    }
    const lease = {
      ...checked.lease,
      expiresAt: mutation.expiresAt,
      heartbeatAt: mutation.heartbeatAt,
      tailscaleIpv4: mutation.tailscaleIpv4,
      tailscalePort: mutation.tailscalePort,
      tailscaleUrl: mutation.tailscaleUrl,
      updatedAt: mutation.heartbeatAt
    };
    this.leases.set(lease.id, lease);
    return { lease: structuredClone(lease), state: 'updated' as const };
  }

  async release(
    input: Parameters<PullRequestDevServerLeaseStore['release']>[0]
  ) {
    const checked = this.mutableCurrent(input.actor, input.leaseId, input.generation);
    if (checked.state !== 'updated') return checked;
    const lease = {
      ...checked.lease,
      expiresAt: input.revokedAt,
      revokedAt: input.revokedAt,
      updatedAt: input.revokedAt
    };
    this.leases.set(lease.id, lease);
    return { lease: structuredClone(lease), state: 'updated' as const };
  }

  async readCurrent(scope: PullRequestDevServerLeaseScope) {
    const id = this.currentByScope.get(scopeKey(scope));
    const lease = id ? this.leases.get(id) : undefined;
    return lease && !lease.revokedAt ? structuredClone(lease) : null;
  }

  readForTest(leaseId: string) {
    const lease = this.leases.get(leaseId);
    return lease ? structuredClone(lease) : undefined;
  }

  private mutableCurrent(
    actor: PullRequestDevServerActor,
    leaseId: string,
    generation: number
  ): PullRequestDevServerLeaseMutationResult {
    const lease = this.leases.get(leaseId);
    if (!lease) return { state: 'missing' };
    if (lease.ownerUserId !== actor.userId || lease.connectorId !== actor.connectorId) {
      return { state: 'forbidden' };
    }
    if (lease.revokedAt) {
      const currentId = this.currentByScope.get(scopeKey(lease));
      return { state: currentId && currentId !== lease.id ? 'superseded' : 'revoked' };
    }
    if (lease.machineId !== actor.machineId || lease.generation !== generation) {
      return { state: 'superseded' };
    }
    const currentId = this.currentByScope.get(scopeKey(lease));
    return currentId === lease.id
      ? { lease: structuredClone(lease), state: 'updated' }
      : { state: 'superseded' };
  }
}
