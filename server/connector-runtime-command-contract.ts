import {
  createHash,
  randomBytes,
  sign as signPayload,
  verify as verifyPayload,
  type KeyLike
} from 'node:crypto';

import { canonicalJson } from './codex-sessions/canonical-json';
import type { ConnectorRuntimeReleaseTarget } from './connector-runtime-maintenance-contract';
import {
  isConnectorRuntimeReleaseManifest,
  resolveConnectorRuntimeReleaseArtifact,
  verifyConnectorRuntimeReleaseManifest,
  type ConnectorRuntimeReleaseArtifact,
  type ConnectorRuntimeReleaseManifest,
  type SignedConnectorRuntimeReleaseManifest
} from './connector-runtime-release-manifest';

export const connectorRuntimeCommandSchema =
  'project-space.connector-runtime-command/v1' as const;

export type ConnectorRuntimeCommandOperation = 'restart' | 'update';

export interface ConnectorRuntimeCommandFingerprint {
  buildId: string;
  bundleVersions: {
    connector: string;
    machineTools: string;
    projectCli: string;
  };
  capabilities: string[];
  instanceId: string;
  protocolVersion: string;
  releaseId: string;
  version: string;
}

interface ConnectorRuntimeCommandPlanBase {
  machineId: string;
  operationId: string;
  previousRuntime: ConnectorRuntimeCommandFingerprint;
  schema: typeof connectorRuntimeCommandSchema;
  target: ConnectorRuntimeReleaseTarget;
}

export interface ConnectorRuntimeRestartPlan extends ConnectorRuntimeCommandPlanBase {
  operation: 'restart';
}

export interface ConnectorRuntimeUpdatePlan extends ConnectorRuntimeCommandPlanBase {
  operation: 'update';
  release: SignedConnectorRuntimeReleaseManifest;
  releaseId: string;
}

export type ConnectorRuntimeCommandPlan =
  | ConnectorRuntimeRestartPlan
  | ConnectorRuntimeUpdatePlan;

export interface ConnectorRuntimeCommandGrant {
  expiresAt: string;
  generation: number;
  issuedAt: string;
  machineId: string;
  nonce: string;
  operation: ConnectorRuntimeCommandOperation;
  operationId: string;
  planSha256: string;
  previousRuntimeSha256: string;
  signature: string;
  target: ConnectorRuntimeReleaseTarget;
  userId: string;
}

export interface ConnectorRuntimeCommandWireRequest {
  grant: ConnectorRuntimeCommandGrant;
  plan: ConnectorRuntimeCommandPlan;
}

export interface VerifiedConnectorRuntimeCommand {
  artifact?: ConnectorRuntimeReleaseArtifact;
  manifest?: ConnectorRuntimeReleaseManifest;
  plan: ConnectorRuntimeCommandPlan;
  userId: string;
}

export type ConnectorRuntimeCommandErrorCode =
  | 'binding-mismatch'
  | 'capacity'
  | 'expired'
  | 'future-issued'
  | 'invalid-release'
  | 'invalid-schema'
  | 'invalid-signature'
  | 'invalid-ttl'
  | 'replayed'
  | 'stale-generation';

export class ConnectorRuntimeCommandError extends Error {
  constructor(readonly code: ConnectorRuntimeCommandErrorCode) {
    super('The connector runtime command is invalid.');
    this.name = 'ConnectorRuntimeCommandError';
  }
}

const defaultTtlMs = 30_000;
const maximumTtlMs = 60_000;
const clockSkewMs = 5_000;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const machineIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const releaseIdPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const signaturePattern = /^[A-Za-z0-9_-]{86}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const targets = new Set<ConnectorRuntimeReleaseTarget>([
  'darwin-arm64',
  'linux-x64',
  'windows-x64'
]);

function isCanonicalSignature(value: string) {
  if (!signaturePattern.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.byteLength === 64 && decoded.toString('base64url') === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function bounded(value: unknown, maximum: number) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function isTarget(value: unknown): value is ConnectorRuntimeReleaseTarget {
  return typeof value === 'string' && targets.has(value as ConnectorRuntimeReleaseTarget);
}

function isFingerprint(value: unknown): value is ConnectorRuntimeCommandFingerprint {
  if (!isRecord(value) || !isRecord(value.bundleVersions)) return false;
  const capabilities = value.capabilities;
  return hasExactKeys(value, [
    'buildId', 'bundleVersions', 'capabilities', 'instanceId', 'protocolVersion',
    'releaseId', 'version'
  ]) &&
    hasExactKeys(value.bundleVersions, ['connector', 'machineTools', 'projectCli']) &&
    bounded(value.buildId, 128) && bounded(value.instanceId, 128) &&
    bounded(value.protocolVersion, 32) && bounded(value.releaseId, 128) &&
    bounded(value.version, 64) && bounded(value.bundleVersions.connector, 64) &&
    bounded(value.bundleVersions.machineTools, 64) &&
    bounded(value.bundleVersions.projectCli, 64) && Array.isArray(capabilities) &&
    capabilities.length <= 64 && capabilities.every((entry) =>
      typeof entry === 'string' && /^[a-z][a-z0-9.-]{0,127}$/.test(entry)
    ) && new Set(capabilities).size === capabilities.length &&
    capabilities.every((entry, index) => index === 0 || capabilities[index - 1]! < entry);
}

function isSignedRelease(value: unknown): value is SignedConnectorRuntimeReleaseManifest {
  return isRecord(value) && hasExactKeys(value, ['manifest', 'signature']) &&
    isConnectorRuntimeReleaseManifest(value.manifest) &&
    typeof value.signature === 'string' && isCanonicalSignature(value.signature);
}

export function isConnectorRuntimeCommandPlan(
  value: unknown
): value is ConnectorRuntimeCommandPlan {
  if (!isRecord(value)) return false;
  const common = value.schema === connectorRuntimeCommandSchema &&
    typeof value.machineId === 'string' && machineIdPattern.test(value.machineId) &&
    typeof value.operationId === 'string' && identifierPattern.test(value.operationId) &&
    isFingerprint(value.previousRuntime) && isTarget(value.target);
  if (!common) return false;
  if (value.operation === 'restart') {
    return hasExactKeys(value, [
      'machineId', 'operation', 'operationId', 'previousRuntime', 'schema', 'target'
    ]);
  }
  return value.operation === 'update' && hasExactKeys(value, [
    'machineId', 'operation', 'operationId', 'previousRuntime', 'release', 'releaseId',
    'schema', 'target'
  ]) && typeof value.releaseId === 'string' && releaseIdPattern.test(value.releaseId) &&
    value.releaseId.toLowerCase() !== 'latest' && isSignedRelease(value.release);
}

function isGrant(value: unknown): value is ConnectorRuntimeCommandGrant {
  if (!isRecord(value) || !hasExactKeys(value, [
    'expiresAt', 'generation', 'issuedAt', 'machineId', 'nonce', 'operation', 'operationId',
    'planSha256', 'previousRuntimeSha256', 'signature', 'target', 'userId'
  ])) return false;
  return typeof value.machineId === 'string' && machineIdPattern.test(value.machineId) &&
    typeof value.userId === 'string' && identifierPattern.test(value.userId) &&
    typeof value.operationId === 'string' && identifierPattern.test(value.operationId) &&
    typeof value.nonce === 'string' && identifierPattern.test(value.nonce) &&
    (value.operation === 'restart' || value.operation === 'update') && isTarget(value.target) &&
    typeof value.generation === 'number' && Number.isSafeInteger(value.generation) &&
    value.generation > 0 && typeof value.issuedAt === 'string' &&
    timestampPattern.test(value.issuedAt) && Number.isFinite(Date.parse(value.issuedAt)) &&
    typeof value.expiresAt === 'string' && timestampPattern.test(value.expiresAt) &&
    Number.isFinite(Date.parse(value.expiresAt)) && typeof value.planSha256 === 'string' &&
    digestPattern.test(value.planSha256) && typeof value.previousRuntimeSha256 === 'string' &&
    digestPattern.test(value.previousRuntimeSha256) && typeof value.signature === 'string' &&
    isCanonicalSignature(value.signature);
}

export function isConnectorRuntimeCommandWireRequest(
  value: unknown
): value is ConnectorRuntimeCommandWireRequest {
  return isRecord(value) && hasExactKeys(value, ['grant', 'plan']) &&
    isGrant(value.grant) && isConnectorRuntimeCommandPlan(value.plan);
}

function digest(value: unknown) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function canonicalGrant(grant: Omit<ConnectorRuntimeCommandGrant, 'signature'>) {
  return JSON.stringify([
    grant.userId, grant.machineId, grant.generation, grant.operation, grant.operationId,
    grant.target, grant.previousRuntimeSha256, grant.planSha256, grant.issuedAt,
    grant.expiresAt, grant.nonce
  ]);
}

export function createConnectorRuntimeCommandWireRequest(
  input: { generation: number; plan: ConnectorRuntimeCommandPlan; userId: string },
  signingKey: KeyLike,
  options: { nonce?: string; now?: number; ttlMs?: number } = {}
): ConnectorRuntimeCommandWireRequest {
  if (!isConnectorRuntimeCommandPlan(input.plan) || !identifierPattern.test(input.userId) ||
      !Number.isSafeInteger(input.generation) || input.generation <= 0) {
    throw new ConnectorRuntimeCommandError('invalid-schema');
  }
  const issuedAt = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? defaultTtlMs;
  if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > maximumTtlMs) {
    throw new ConnectorRuntimeCommandError('invalid-ttl');
  }
  const unsigned: Omit<ConnectorRuntimeCommandGrant, 'signature'> = {
    expiresAt: new Date(issuedAt + ttlMs).toISOString(),
    generation: input.generation,
    issuedAt: new Date(issuedAt).toISOString(),
    machineId: input.plan.machineId,
    nonce: options.nonce ?? `n${randomBytes(24).toString('base64url')}`,
    operation: input.plan.operation,
    operationId: input.plan.operationId,
    planSha256: digest(input.plan),
    previousRuntimeSha256: digest(input.plan.previousRuntime),
    target: input.plan.target,
    userId: input.userId
  };
  const request = {
    grant: {
      ...unsigned,
      signature: signPayload(null, Buffer.from(canonicalGrant(unsigned)), signingKey)
        .toString('base64url')
    },
    plan: structuredClone(input.plan)
  };
  if (!isConnectorRuntimeCommandWireRequest(request)) {
    throw new ConnectorRuntimeCommandError('invalid-schema');
  }
  return request;
}

export class ConnectorRuntimeCommandReplayProtection {
  private readonly used = new Map<string, number>();

  constructor(readonly maximumEntries = 1_024) {}

  accept(grant: ConnectorRuntimeCommandGrant, now = Date.now()) {
    for (const [key, expiry] of this.used) if (expiry < now) this.used.delete(key);
    const key = [grant.machineId, grant.generation, grant.operationId].join('\u0000');
    if (this.used.has(key)) throw new ConnectorRuntimeCommandError('replayed');
    if (this.used.size >= this.maximumEntries) throw new ConnectorRuntimeCommandError('capacity');
    this.used.set(key, Date.parse(grant.expiresAt) + clockSkewMs);
  }
}

export function verifyConnectorRuntimeCommandWireRequest(
  value: unknown,
  commandVerificationKey: KeyLike,
  options: {
    expectedGeneration: number;
    expectedMachineId: string;
    expectedTarget: ConnectorRuntimeReleaseTarget;
    now?: number;
    releaseVerificationKey?: Buffer | KeyLike | string;
    replayProtection?: ConnectorRuntimeCommandReplayProtection;
  }
): VerifiedConnectorRuntimeCommand {
  if (!isConnectorRuntimeCommandWireRequest(value)) {
    throw new ConnectorRuntimeCommandError('invalid-schema');
  }
  const { signature, ...unsigned } = value.grant;
  if (!verifyPayload(
    null,
    Buffer.from(canonicalGrant(unsigned)),
    commandVerificationKey,
    Buffer.from(signature, 'base64url')
  )) throw new ConnectorRuntimeCommandError('invalid-signature');

  const now = options.now ?? Date.now();
  const issuedAt = Date.parse(value.grant.issuedAt);
  const expiresAt = Date.parse(value.grant.expiresAt);
  if (issuedAt > now + clockSkewMs) throw new ConnectorRuntimeCommandError('future-issued');
  if (expiresAt < now - clockSkewMs) throw new ConnectorRuntimeCommandError('expired');
  if (expiresAt <= issuedAt || expiresAt - issuedAt > maximumTtlMs) {
    throw new ConnectorRuntimeCommandError('invalid-ttl');
  }
  if (value.grant.generation !== options.expectedGeneration) {
    throw new ConnectorRuntimeCommandError('stale-generation');
  }
  const plan = value.plan;
  if (value.grant.machineId !== options.expectedMachineId ||
      plan.machineId !== options.expectedMachineId ||
      value.grant.operation !== plan.operation || value.grant.operationId !== plan.operationId ||
      value.grant.target !== plan.target || plan.target !== options.expectedTarget ||
      value.grant.planSha256 !== digest(plan) ||
      value.grant.previousRuntimeSha256 !== digest(plan.previousRuntime)) {
    throw new ConnectorRuntimeCommandError('binding-mismatch');
  }

  let manifest: ConnectorRuntimeReleaseManifest | undefined;
  let artifact: ConnectorRuntimeReleaseArtifact | undefined;
  if (plan.operation === 'update') {
    if (!options.releaseVerificationKey) throw new ConnectorRuntimeCommandError('invalid-release');
    try {
      manifest = verifyConnectorRuntimeReleaseManifest(
        plan.release,
        options.releaseVerificationKey,
        { now }
      );
      artifact = resolveConnectorRuntimeReleaseArtifact(manifest, plan.target, plan.releaseId);
    } catch {
      throw new ConnectorRuntimeCommandError('invalid-release');
    }
  }
  options.replayProtection?.accept(value.grant, now);
  return { artifact, manifest, plan: structuredClone(plan), userId: value.grant.userId };
}
