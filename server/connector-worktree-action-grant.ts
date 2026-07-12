import { randomBytes, sign, verify, type KeyLike } from 'node:crypto';
import type {
  ConnectorWorktreeActionActor,
  ConnectorWorktreeActionGrant,
  ConnectorWorktreeActionOperation,
  ConnectorWorktreeActionTrustedRequest
} from './connector-worktree-action-contract';

const maxTtl = 60_000;
const skew = 5_000;

function canonical(grant: Omit<ConnectorWorktreeActionGrant, 'signature'>) {
  return JSON.stringify([
    grant.userId,
    grant.machineId,
    grant.projectId,
    grant.repositoryFullName,
    grant.operation,
    grant.branchName ?? null,
    grant.commitSha ?? null,
    grant.worktreeId ?? null,
    grant.expectedHeadSha ?? null,
    grant.setupStepId ?? null,
    grant.declarationDigest ?? null,
    grant.issuedAt,
    grant.expiresAt,
    grant.nonce,
    grant.generation
  ]);
}

function unsignedFor(
  operation: ConnectorWorktreeActionOperation,
  request: ConnectorWorktreeActionTrustedRequest,
  actor: ConnectorWorktreeActionActor,
  now: number,
  ttl: number,
  nonce: string
): Omit<ConnectorWorktreeActionGrant, 'signature'> {
  return {
    ...(request.operation === 'materialize'
      ? { branchName: request.branchName, commitSha: request.commitSha }
      : {
          expectedHeadSha: request.expectedHeadSha,
          worktreeId: request.worktreeId
        }),
    ...(request.operation === 'setup.run'
      ? {
          declarationDigest: request.declarationDigest,
          setupStepId: request.setupStepId
        }
      : {}),
    expiresAt: new Date(now + ttl).toISOString(),
    generation: actor.generation,
    issuedAt: new Date(now).toISOString(),
    machineId: request.machineId,
    nonce,
    operation,
    projectId: request.projectId,
    repositoryFullName: request.repositoryFullName,
    userId: actor.userId
  };
}

export function createConnectorWorktreeActionGrant(
  operation: ConnectorWorktreeActionOperation,
  request: ConnectorWorktreeActionTrustedRequest,
  actor: ConnectorWorktreeActionActor,
  key: KeyLike,
  options: { now?: number; ttlMs?: number; nonce?: string } = {}
): ConnectorWorktreeActionGrant {
  const now = options.now ?? Date.now();
  const ttl = options.ttlMs ?? 30_000;
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > maxTtl)
    throw new Error('Worktree action grant TTL is invalid.');
  const unsigned = unsignedFor(
    operation,
    request,
    actor,
    now,
    ttl,
    options.nonce ?? randomBytes(24).toString('base64url')
  );
  return {
    ...unsigned,
    signature: sign(null, Buffer.from(canonical(unsigned)), key).toString('base64url')
  };
}

export class WorktreeActionReplayProtection {
  private readonly nonces = new Map<string, number>();
  private readonly generations = new Map<string, { expiresAt: number; generation: number }>();
  readonly maximumEntries = 10_000;

  accept(grant: ConnectorWorktreeActionGrant, now = Date.now()) {
    for (const [key, expiresAt] of this.nonces) if (expiresAt < now) this.nonces.delete(key);
    for (const [key, value] of this.generations)
      if (value.expiresAt < now) this.generations.delete(key);
    const scope = [
      grant.userId,
      grant.machineId,
      grant.projectId,
      grant.operation,
      grant.worktreeId ?? grant.branchName
    ].join('\0');
    const current = this.generations.get(scope);
    if (current && grant.generation < current.generation)
      throw new Error('Worktree action grant generation is stale.');
    const key = `${scope}\0${grant.nonce}`;
    if (this.nonces.has(key)) throw new Error('Worktree action grant was replayed.');
    if (
      this.nonces.size >= this.maximumEntries ||
      (!current && this.generations.size >= this.maximumEntries)
    )
      throw new Error('Worktree action replay protection is at capacity.');
    const expiresAt = Date.parse(grant.expiresAt) + skew;
    this.generations.set(scope, {
      expiresAt,
      generation: Math.max(current?.generation ?? grant.generation, grant.generation)
    });
    this.nonces.set(key, expiresAt);
  }

  get trackedNonceCount() {
    return this.nonces.size;
  }
}

export function verifyConnectorWorktreeActionGrant(
  grant: ConnectorWorktreeActionGrant,
  operation: ConnectorWorktreeActionOperation,
  request: ConnectorWorktreeActionTrustedRequest,
  key: KeyLike,
  options: { now?: number; replay?: WorktreeActionReplayProtection } = {}
): ConnectorWorktreeActionActor {
  const { signature, ...unsigned } = grant;
  if (!verify(null, Buffer.from(canonical(unsigned)), key, Buffer.from(signature, 'base64url')))
    throw new Error('Worktree action signature is invalid.');
  const now = options.now ?? Date.now();
  const issued = Date.parse(grant.issuedAt);
  const expires = Date.parse(grant.expiresAt);
  if (
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    issued > now + skew ||
    expires < now - skew ||
    expires <= issued ||
    expires - issued > maxTtl
  )
    throw new Error('Worktree action grant lifetime is invalid.');
  const expected = unsignedFor(
    operation,
    request,
    { generation: grant.generation, userId: grant.userId },
    issued,
    expires - issued,
    grant.nonce
  );
  if (canonical(expected) !== canonical(unsigned))
    throw new Error('Worktree action grant binding does not match.');
  options.replay?.accept(grant, now);
  return { generation: grant.generation, userId: grant.userId };
}
