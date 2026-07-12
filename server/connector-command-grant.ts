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
  type ConnectorDevServerAnyTrustedRequest,
  type ConnectorDevServerCommandGrant,
  type ConnectorDevServerOperation
} from './connector-dev-server-contract';

const defaultGrantTtlMs = 30_000;
const maximumGrantTtlMs = 60_000;
const clockSkewMs = 5_000;

export type ConnectorCommandGrantErrorCode =
  | 'binding-mismatch'
  | 'capacity'
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
  request: ConnectorDevServerAnyTrustedRequest;
}

function canonicalGrantPayload(grant: Omit<ConnectorDevServerCommandGrant, 'signature'>) {
  return JSON.stringify([
    grant.userId,
    grant.machineId,
    grant.projectId,
    grant.worktreeId,
    grant.expectedHeadSha,
    grant.operation,
    grant.serverId ?? null,
    grant.runTarget,
    grant.allowedHosts,
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
  return [
    grant.userId,
    grant.machineId,
    grant.projectId,
    grant.worktreeId,
    grant.operation === 'list' ? 'list' : grant.serverId
  ].join('\u0000');
}

export class ConnectorCommandReplayProtection {
  private readonly generations = new Map<string, { expiresAt: number; generation: number }>();
  private readonly usedNonces = new Map<string, number>();

  constructor(readonly maximumEntries = 10_000) {}

  accept(grant: ConnectorDevServerCommandGrant, now = Date.now()) {
    this.prune(now);
    const scope = replayScope(grant);
    const current = this.generations.get(scope);
    if (current !== undefined && grant.generation < current.generation) {
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

    if (
      this.usedNonces.size >= this.maximumEntries ||
      (current === undefined && this.generations.size >= this.maximumEntries)
    ) {
      throw new ConnectorCommandGrantError(
        'capacity',
        'Connector command replay protection is at capacity.'
      );
    }
    const expiresAt = Date.parse(grant.expiresAt) + clockSkewMs;
    this.generations.set(scope, {
      expiresAt: Math.max(current?.expiresAt ?? expiresAt, expiresAt),
      generation: Math.max(current?.generation ?? grant.generation, grant.generation)
    });
    this.usedNonces.set(nonceKey, expiresAt);
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
    for (const [key, value] of this.generations.entries()) {
      if (value.expiresAt < now) {
        this.generations.delete(key);
      }
    }
  }

  get trackedGenerationCount() {
    return this.generations.size;
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

  const common = {
    expiresAt: new Date(issuedAt + ttlMs).toISOString(),
    generation: actor.generation,
    issuedAt: new Date(issuedAt).toISOString(),
    machineId: request.machineId,
    nonce: options.nonce ?? randomBytes(24).toString('base64url'),
    operation,
    projectId: request.projectId,
    userId: actor.userId,
    worktreeId: request.worktreeId,
    expectedHeadSha: request.expectedHeadSha
  };
  const unsigned: Omit<ConnectorDevServerCommandGrant, 'signature'> =
    operation === 'list'
      ? common
      : {
          ...common,
          allowedHosts: normalizeAllowedHosts(
            'allowedHosts' in request ? request.allowedHosts : []
          ),
          runTarget: 'runTarget' in request ? request.runTarget : undefined,
          serverId: 'serverId' in request ? request.serverId : undefined
        };

  return {
    ...unsigned,
    signature: signatureForGrant(unsigned, signingKey)
  };
}

export function verifyConnectorCommandGrant(
  grant: ConnectorDevServerCommandGrant,
  request: ConnectorDevServerAnyTrustedRequest,
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
  if (expiresAt <= issuedAt || expiresAt - issuedAt > maximumGrantTtlMs) {
    throw new ConnectorCommandGrantError(
      'invalid-ttl',
      'The connector command grant lifetime is invalid.'
    );
  }

  const baseBindingMatches =
    grant.operation === operation &&
    grant.machineId === request.machineId &&
    grant.projectId === request.projectId &&
    grant.worktreeId === request.worktreeId &&
    grant.expectedHeadSha === request.expectedHeadSha &&
    (options.expectedUserId === undefined || grant.userId === options.expectedUserId);
  const bindingMatches =
    operation === 'list'
      ? baseBindingMatches && !('serverId' in request)
      : baseBindingMatches &&
        'serverId' in request &&
        grant.serverId === request.serverId &&
        grant.runTarget === request.runTarget &&
        arraysEqual(grant.allowedHosts ?? [], normalizeAllowedHosts(request.allowedHosts));
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
