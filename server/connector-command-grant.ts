import {
  randomBytes,
  sign as signPayload,
  verify as verifyPayload,
  type KeyLike
} from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  normalizeAllowedHosts,
  type ConnectorDevServerActor,
  type ConnectorDevServerCommandGrant,
  type ConnectorDevServerOperation,
  type ConnectorDevServerTrustedRequest
} from './connector-dev-server-contract';

const defaultGrantTtlMs = 30_000;
const maximumGrantTtlMs = 60_000;
const clockSkewMs = 5_000;

export type ConnectorCommandGrantErrorCode =
  | 'binding-mismatch'
  | 'expired'
  | 'future-issued'
  | 'invalid-signature'
  | 'invalid-ttl'
  | 'replayed'
  | 'stale-generation';

export class ConnectorCommandGrantError extends Error {
  readonly code: ConnectorCommandGrantErrorCode;

  constructor(code: ConnectorCommandGrantErrorCode, message: string) {
    super(message);
    this.name = 'ConnectorCommandGrantError';
    this.code = code;
  }
}

interface CreateConnectorCommandGrantOptions {
  nonce?: string;
  now?: number;
  ttlMs?: number;
}

interface VerifyConnectorCommandGrantOptions {
  expectedUserId?: string;
  now?: number;
  replayProtection?: ConnectorCommandReplayProtection;
}

interface GrantInput {
  actor: ConnectorDevServerActor;
  operation: ConnectorDevServerOperation;
  request: ConnectorDevServerTrustedRequest;
}

function canonicalGrantPayload(grant: Omit<ConnectorDevServerCommandGrant, 'signature'>) {
  return JSON.stringify([
    grant.userId,
    grant.machineId,
    grant.projectId,
    grant.worktreeId,
    grant.worktreePath,
    grant.runTarget,
    grant.allowedHosts,
    grant.operation,
    grant.issuedAt,
    grant.expiresAt,
    grant.nonce,
    grant.generation
  ]);
}

function signatureForGrant(
  grant: Omit<ConnectorDevServerCommandGrant, 'signature'>,
  signingKey: KeyLike
) {
  return signPayload(null, Buffer.from(canonicalGrantPayload(grant)), signingKey).toString(
    'base64url'
  );
}

function arraysEqual(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function replayScope(grant: ConnectorDevServerCommandGrant) {
  return [grant.userId, grant.machineId, grant.projectId, grant.worktreeId].join('\u0000');
}

export class ConnectorCommandReplayProtection {
  private readonly generations = new Map<string, number>();
  private readonly usedNonces = new Map<string, number>();

  accept(grant: ConnectorDevServerCommandGrant, now = Date.now()) {
    this.prune(now);
    const scope = replayScope(grant);
    const currentGeneration = this.generations.get(scope);
    if (currentGeneration !== undefined && grant.generation < currentGeneration) {
      throw new ConnectorCommandGrantError(
        'stale-generation',
        'The connector command belongs to an older runtime generation.'
      );
    }

    const nonceKey = `${scope}\u0000${grant.nonce}`;
    if (this.usedNonces.has(nonceKey)) {
      throw new ConnectorCommandGrantError(
        'replayed',
        'The connector command grant has already been used.'
      );
    }

    if (currentGeneration === undefined || grant.generation > currentGeneration) {
      this.generations.set(scope, grant.generation);
    }
    this.usedNonces.set(nonceKey, Date.parse(grant.expiresAt) + clockSkewMs);
  }

  clear() {
    this.generations.clear();
    this.usedNonces.clear();
  }

  private prune(now: number) {
    for (const [key, expiresAt] of this.usedNonces.entries()) {
      if (expiresAt < now) {
        this.usedNonces.delete(key);
      }
    }
  }
}

export function createConnectorCommandGrant(
  { actor, operation, request }: GrantInput,
  signingKey: KeyLike,
  options: CreateConnectorCommandGrantOptions = {}
): ConnectorDevServerCommandGrant {
  const issuedAt = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? defaultGrantTtlMs;
  if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > maximumGrantTtlMs) {
    throw new Error(`Connector command grant TTL must be between 1 and ${maximumGrantTtlMs}ms.`);
  }

  const unsigned: Omit<ConnectorDevServerCommandGrant, 'signature'> = {
    allowedHosts: normalizeAllowedHosts(request.allowedHosts),
    expiresAt: new Date(issuedAt + ttlMs).toISOString(),
    generation: actor.generation,
    issuedAt: new Date(issuedAt).toISOString(),
    machineId: request.machineId,
    nonce: options.nonce ?? randomBytes(24).toString('base64url'),
    operation,
    projectId: request.projectId,
    runTarget: request.runTarget,
    userId: actor.userId,
    worktreeId: request.worktreeId,
    worktreePath: request.worktreePath
  };

  return {
    ...unsigned,
    signature: signatureForGrant(unsigned, signingKey)
  };
}

export function verifyConnectorCommandGrant(
  grant: ConnectorDevServerCommandGrant,
  request: ConnectorDevServerTrustedRequest,
  operation: ConnectorDevServerOperation,
  verificationKey: KeyLike,
  options: VerifyConnectorCommandGrantOptions = {}
) {
  const { signature, ...unsigned } = grant;
  const signatureIsValid = verifyPayload(
    null,
    Buffer.from(canonicalGrantPayload(unsigned)),
    verificationKey,
    Buffer.from(signature, 'base64url')
  );
  if (!signatureIsValid) {
    throw new ConnectorCommandGrantError(
      'invalid-signature',
      'The connector command signature is invalid.'
    );
  }

  const now = options.now ?? Date.now();
  const issuedAt = Date.parse(grant.issuedAt);
  const expiresAt = Date.parse(grant.expiresAt);
  if (issuedAt > now + clockSkewMs) {
    throw new ConnectorCommandGrantError(
      'future-issued',
      'The connector command was issued too far in the future.'
    );
  }
  if (expiresAt < now - clockSkewMs) {
    throw new ConnectorCommandGrantError('expired', 'The connector command grant has expired.');
  }
  if (
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > maximumGrantTtlMs
  ) {
    throw new ConnectorCommandGrantError(
      'invalid-ttl',
      'The connector command grant lifetime is invalid.'
    );
  }

  const expectedAllowedHosts = normalizeAllowedHosts(request.allowedHosts);
  const bindingMatches =
    grant.operation === operation &&
    grant.machineId === request.machineId &&
    grant.projectId === request.projectId &&
    grant.worktreeId === request.worktreeId &&
    grant.worktreePath === request.worktreePath &&
    grant.runTarget === request.runTarget &&
    arraysEqual(grant.allowedHosts, expectedAllowedHosts) &&
    (options.expectedUserId === undefined || grant.userId === options.expectedUserId);
  if (!bindingMatches) {
    throw new ConnectorCommandGrantError(
      'binding-mismatch',
      'The connector command does not match its signed target.'
    );
  }

  options.replayProtection?.accept(grant, now);
  return {
    generation: grant.generation,
    userId: grant.userId
  } satisfies ConnectorDevServerActor;
}

export function connectorCommandGrantSigningKey() {
  const encodedKey = process.env.PROJECT_CONNECTOR_COMMAND_SIGNING_PRIVATE_KEY_B64?.trim();
  if (encodedKey) {
    try {
      const decoded = Buffer.from(encodedKey, 'base64').toString('utf8').trim();
      return decoded.includes('BEGIN PRIVATE KEY') ? decoded : undefined;
    } catch {
      return undefined;
    }
  }
  const inlineKey = process.env.PROJECT_CONNECTOR_COMMAND_SIGNING_PRIVATE_KEY;
  if (inlineKey) {
    return inlineKey;
  }
  const keyFile = process.env.PROJECT_CONNECTOR_COMMAND_SIGNING_PRIVATE_KEY_FILE?.trim();
  if (keyFile) {
    try {
      return readFileSync(keyFile);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
