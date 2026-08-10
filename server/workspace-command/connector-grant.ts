import { randomBytes, sign, verify, type KeyLike } from 'node:crypto';
import type {
  WorkspaceCommandConnectorActor,
  WorkspaceCommandConnectorGrant,
  WorkspaceCommandConnectorOperation,
  WorkspaceCommandConnectorRequest
} from './connector-contract';

const maximumTtlMs = 60_000;
const clockSkewMs = 5_000;

function canonical(grant: Omit<WorkspaceCommandConnectorGrant, 'signature'>) {
  return JSON.stringify([
    grant.userId, grant.machineId, grant.generation, grant.operation, grant.commandId,
    grant.environmentId, grant.executionId, grant.workspaceId, grant.projectId,
    grant.worktreeId, grant.expectedHeadSha ?? null, grant.commandSha256,
    grant.workspaceWritable, grant.repositoryWritable, grant.allowNetwork,
    grant.timeoutSeconds, grant.maxOutputBytes,
    grant.issuedAt, grant.expiresAt, grant.nonce
  ]);
}

function unsigned(
  operation: WorkspaceCommandConnectorOperation,
  request: WorkspaceCommandConnectorRequest,
  actor: WorkspaceCommandConnectorActor,
  issuedAt: number,
  ttlMs: number,
  nonce: string
): Omit<WorkspaceCommandConnectorGrant, 'signature'> {
  return {
    allowNetwork: request.allowNetwork,
    commandId: request.commandId,
    commandSha256: request.commandSha256,
    environmentId: request.environmentId,
    executionId: request.executionId,
    ...(request.expectedHeadSha ? { expectedHeadSha: request.expectedHeadSha } : {}),
    expiresAt: new Date(issuedAt + ttlMs).toISOString(),
    generation: actor.generation,
    issuedAt: new Date(issuedAt).toISOString(),
    machineId: request.machineId,
    maxOutputBytes: request.maxOutputBytes,
    nonce,
    operation,
    projectId: request.projectId,
    repositoryWritable: request.repositoryWritable,
    timeoutSeconds: request.timeoutSeconds,
    userId: actor.userId,
    workspaceId: request.workspaceId,
    workspaceWritable: request.workspaceWritable,
    worktreeId: request.worktreeId
  };
}

export function createWorkspaceCommandGrant(
  operation: WorkspaceCommandConnectorOperation,
  request: WorkspaceCommandConnectorRequest,
  actor: WorkspaceCommandConnectorActor,
  key: KeyLike,
  options: { nonce?: string; now?: number; ttlMs?: number } = {}
): WorkspaceCommandConnectorGrant {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? 30_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > maximumTtlMs)
    throw new Error('Workspace command grant TTL is invalid.');
  const value = unsigned(
    operation, request, actor, now, ttlMs,
    options.nonce ?? randomBytes(24).toString('base64url')
  );
  return {
    ...value,
    signature: sign(null, Buffer.from(canonical(value)), key).toString('base64url')
  };
}

export class WorkspaceCommandReplayProtection {
  private readonly seen = new Map<string, number>();
  accept(grant: WorkspaceCommandConnectorGrant, now: number) {
    for (const [key, expiry] of this.seen) if (expiry < now) this.seen.delete(key);
    const key = `${grant.userId}\0${grant.machineId}\0${grant.generation}\0${grant.nonce}`;
    if (this.seen.has(key)) throw new Error('Workspace command grant was replayed.');
    if (this.seen.size >= 10_000) throw new Error('Workspace command replay protection is full.');
    this.seen.set(key, Date.parse(grant.expiresAt) + clockSkewMs);
  }
}

export function verifyWorkspaceCommandGrant(
  grant: WorkspaceCommandConnectorGrant,
  operation: WorkspaceCommandConnectorOperation,
  request: WorkspaceCommandConnectorRequest,
  key: KeyLike,
  options: { now?: number; replay?: WorkspaceCommandReplayProtection } = {}
): WorkspaceCommandConnectorActor {
  const { signature, ...value } = grant;
  if (!verify(null, Buffer.from(canonical(value)), key, Buffer.from(signature, 'base64url')))
    throw new Error('Workspace command grant signature is invalid.');
  const now = options.now ?? Date.now();
  const issued = Date.parse(grant.issuedAt);
  const expires = Date.parse(grant.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > now + clockSkewMs ||
      expires < now - clockSkewMs || expires <= issued || expires - issued > maximumTtlMs)
    throw new Error('Workspace command grant lifetime is invalid.');
  const expected = unsigned(
    operation, request, { generation: grant.generation, userId: grant.userId },
    issued, expires - issued, grant.nonce
  );
  if (canonical(expected) !== canonical(value))
    throw new Error('Workspace command grant binding does not match.');
  options.replay?.accept(grant, now);
  return { generation: grant.generation, userId: grant.userId };
}
