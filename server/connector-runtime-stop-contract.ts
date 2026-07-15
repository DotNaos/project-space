import {
  createHash,
  randomBytes,
  sign as signPayload,
  verify as verifyPayload,
  type KeyLike
} from 'node:crypto';

import { canonicalJson } from './codex-sessions/canonical-json';
import type { ConnectorRuntimeReleaseTarget } from './connector-runtime-maintenance-contract';

export const connectorRuntimeStopSchema =
  'project-space.connector-runtime-stop/v1' as const;

export interface ConnectorRuntimeStopIdentity {
  buildId: string;
  channel: 'dev';
  instanceId: string;
  protocolVersion: string;
  releaseId: string;
  source: 'source';
}

export interface ConnectorRuntimeStopPlan {
  expectedRuntime: ConnectorRuntimeStopIdentity;
  machineId: string;
  operation: 'stop';
  operationId: string;
  schema: typeof connectorRuntimeStopSchema;
  target: ConnectorRuntimeReleaseTarget;
}

export interface ConnectorRuntimeStopGrant {
  expiresAt: string;
  generation: number;
  issuedAt: string;
  machineId: string;
  nonce: string;
  operation: 'stop';
  operationId: string;
  planSha256: string;
  runtimeSha256: string;
  signature: string;
  userId: string;
}

export interface ConnectorRuntimeStopWireRequest {
  grant: ConnectorRuntimeStopGrant;
  plan: ConnectorRuntimeStopPlan;
}

export interface ConnectorRuntimeStopBinding {
  generation: number;
  instanceId: string;
  machineId: string;
  operationId: string;
  planSha256: string;
}

export interface ConnectorRuntimeStopAcceptedResult {
  binding: ConnectorRuntimeStopBinding;
  status: 'accepted';
}

export interface VerifiedConnectorRuntimeStop {
  plan: ConnectorRuntimeStopPlan;
  userId: string;
}

export type ConnectorRuntimeStopContractErrorCode =
  | 'binding-mismatch'
  | 'capacity'
  | 'expired'
  | 'future-issued'
  | 'invalid-schema'
  | 'invalid-signature'
  | 'invalid-ttl'
  | 'replayed'
  | 'stale-generation';

export class ConnectorRuntimeStopContractError extends Error {
  constructor(readonly code: ConnectorRuntimeStopContractErrorCode) {
    super('The connector runtime stop command is invalid.');
    this.name = 'ConnectorRuntimeStopContractError';
  }
}

const defaultTtlMs = 30_000;
const maximumTtlMs = 60_000;
const clockSkewMs = 5_000;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const machineIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const signaturePattern = /^[A-Za-z0-9_-]{86}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const targets = new Set<ConnectorRuntimeReleaseTarget>([
  'darwin-arm64',
  'linux-x64',
  'windows-x64'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function bounded(value: unknown, maximum: number) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function isTarget(value: unknown): value is ConnectorRuntimeReleaseTarget {
  return typeof value === 'string' && targets.has(value as ConnectorRuntimeReleaseTarget);
}

function isCanonicalSignature(value: string) {
  if (!signaturePattern.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.byteLength === 64 && decoded.toString('base64url') === value;
}

export function isConnectorRuntimeStopIdentity(
  value: unknown
): value is ConnectorRuntimeStopIdentity {
  return isRecord(value) && hasExactKeys(value, [
    'buildId', 'channel', 'instanceId', 'protocolVersion', 'releaseId', 'source'
  ]) && bounded(value.buildId, 128) && value.channel === 'dev' &&
    bounded(value.instanceId, 128) && bounded(value.protocolVersion, 32) &&
    bounded(value.releaseId, 128) && value.source === 'source';
}

export function isConnectorRuntimeStopPlan(value: unknown): value is ConnectorRuntimeStopPlan {
  return isRecord(value) && hasExactKeys(value, [
    'expectedRuntime', 'machineId', 'operation', 'operationId', 'schema', 'target'
  ]) && value.schema === connectorRuntimeStopSchema && value.operation === 'stop' &&
    typeof value.machineId === 'string' && machineIdPattern.test(value.machineId) &&
    typeof value.operationId === 'string' && identifierPattern.test(value.operationId) &&
    isTarget(value.target) && isConnectorRuntimeStopIdentity(value.expectedRuntime);
}

function isGrant(value: unknown): value is ConnectorRuntimeStopGrant {
  if (!isRecord(value) || !hasExactKeys(value, [
    'expiresAt', 'generation', 'issuedAt', 'machineId', 'nonce', 'operation', 'operationId',
    'planSha256', 'runtimeSha256', 'signature', 'userId'
  ])) return false;
  return typeof value.machineId === 'string' && machineIdPattern.test(value.machineId) &&
    typeof value.userId === 'string' && identifierPattern.test(value.userId) &&
    typeof value.operationId === 'string' && identifierPattern.test(value.operationId) &&
    typeof value.nonce === 'string' && identifierPattern.test(value.nonce) &&
    value.operation === 'stop' && typeof value.generation === 'number' &&
    Number.isSafeInteger(value.generation) && value.generation > 0 &&
    typeof value.issuedAt === 'string' && timestampPattern.test(value.issuedAt) &&
    Number.isFinite(Date.parse(value.issuedAt)) && typeof value.expiresAt === 'string' &&
    timestampPattern.test(value.expiresAt) && Number.isFinite(Date.parse(value.expiresAt)) &&
    typeof value.planSha256 === 'string' && digestPattern.test(value.planSha256) &&
    typeof value.runtimeSha256 === 'string' && digestPattern.test(value.runtimeSha256) &&
    typeof value.signature === 'string' && isCanonicalSignature(value.signature);
}

export function isConnectorRuntimeStopWireRequest(
  value: unknown
): value is ConnectorRuntimeStopWireRequest {
  return isRecord(value) && hasExactKeys(value, ['grant', 'plan']) &&
    isGrant(value.grant) && isConnectorRuntimeStopPlan(value.plan);
}

export function isConnectorRuntimeStopBinding(
  value: unknown
): value is ConnectorRuntimeStopBinding {
  return isRecord(value) && hasExactKeys(value, [
    'generation', 'instanceId', 'machineId', 'operationId', 'planSha256'
  ]) && typeof value.generation === 'number' && Number.isSafeInteger(value.generation) &&
    value.generation > 0 && typeof value.machineId === 'string' &&
    machineIdPattern.test(value.machineId) && bounded(value.instanceId, 128) &&
    typeof value.operationId === 'string' && identifierPattern.test(value.operationId) &&
    typeof value.planSha256 === 'string' && digestPattern.test(value.planSha256);
}

export function isConnectorRuntimeStopAcceptedResult(
  value: unknown
): value is ConnectorRuntimeStopAcceptedResult {
  return isRecord(value) && hasExactKeys(value, ['binding', 'status']) &&
    value.status === 'accepted' && isConnectorRuntimeStopBinding(value.binding);
}

function digest(value: unknown) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function canonicalGrant(grant: Omit<ConnectorRuntimeStopGrant, 'signature'>) {
  return JSON.stringify([
    grant.userId,
    grant.machineId,
    grant.generation,
    grant.operation,
    grant.operationId,
    grant.runtimeSha256,
    grant.planSha256,
    grant.issuedAt,
    grant.expiresAt,
    grant.nonce
  ]);
}

export function connectorRuntimeStopBinding(
  request: ConnectorRuntimeStopWireRequest
): ConnectorRuntimeStopBinding {
  return {
    generation: request.grant.generation,
    instanceId: request.plan.expectedRuntime.instanceId,
    machineId: request.grant.machineId,
    operationId: request.grant.operationId,
    planSha256: request.grant.planSha256
  };
}

export function createConnectorRuntimeStopWireRequest(
  input: { generation: number; plan: ConnectorRuntimeStopPlan; userId: string },
  signingKey: KeyLike,
  options: { nonce?: string; now?: number; ttlMs?: number } = {}
): ConnectorRuntimeStopWireRequest {
  if (!isConnectorRuntimeStopPlan(input.plan) || !identifierPattern.test(input.userId) ||
      !Number.isSafeInteger(input.generation) || input.generation <= 0) {
    throw new ConnectorRuntimeStopContractError('invalid-schema');
  }
  const issuedAt = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? defaultTtlMs;
  if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > maximumTtlMs) {
    throw new ConnectorRuntimeStopContractError('invalid-ttl');
  }
  const unsigned: Omit<ConnectorRuntimeStopGrant, 'signature'> = {
    expiresAt: new Date(issuedAt + ttlMs).toISOString(),
    generation: input.generation,
    issuedAt: new Date(issuedAt).toISOString(),
    machineId: input.plan.machineId,
    nonce: options.nonce ?? `n${randomBytes(24).toString('base64url')}`,
    operation: 'stop',
    operationId: input.plan.operationId,
    planSha256: digest(input.plan),
    runtimeSha256: digest(input.plan.expectedRuntime),
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
  if (!isConnectorRuntimeStopWireRequest(request)) {
    throw new ConnectorRuntimeStopContractError('invalid-schema');
  }
  return request;
}

export class ConnectorRuntimeStopReplayProtection {
  private readonly used = new Map<string, number>();

  constructor(readonly maximumEntries = 1_024) {}

  accept(grant: ConnectorRuntimeStopGrant, now = Date.now()) {
    for (const [key, expiry] of this.used) if (expiry < now) this.used.delete(key);
    const key = [grant.machineId, grant.generation, grant.operationId].join('\u0000');
    if (this.used.has(key)) throw new ConnectorRuntimeStopContractError('replayed');
    if (this.used.size >= this.maximumEntries) {
      throw new ConnectorRuntimeStopContractError('capacity');
    }
    this.used.set(key, Date.parse(grant.expiresAt) + clockSkewMs);
  }
}

function identitiesEqual(left: ConnectorRuntimeStopIdentity, right: ConnectorRuntimeStopIdentity) {
  return left.buildId === right.buildId && left.channel === right.channel &&
    left.instanceId === right.instanceId && left.protocolVersion === right.protocolVersion &&
    left.releaseId === right.releaseId && left.source === right.source;
}

export function verifyConnectorRuntimeStopWireRequest(
  value: unknown,
  verificationKey: KeyLike,
  options: {
    expectedGeneration: number;
    expectedMachineId: string;
    expectedRuntime: ConnectorRuntimeStopIdentity;
    expectedTarget: ConnectorRuntimeReleaseTarget;
    now?: number;
    replayProtection?: ConnectorRuntimeStopReplayProtection;
  }
): VerifiedConnectorRuntimeStop {
  if (!isConnectorRuntimeStopWireRequest(value) ||
      !isConnectorRuntimeStopIdentity(options.expectedRuntime)) {
    throw new ConnectorRuntimeStopContractError('invalid-schema');
  }
  const { signature, ...unsigned } = value.grant;
  if (!verifyPayload(
    null,
    Buffer.from(canonicalGrant(unsigned)),
    verificationKey,
    Buffer.from(signature, 'base64url')
  )) throw new ConnectorRuntimeStopContractError('invalid-signature');

  const now = options.now ?? Date.now();
  const issuedAt = Date.parse(value.grant.issuedAt);
  const expiresAt = Date.parse(value.grant.expiresAt);
  if (issuedAt > now + clockSkewMs) {
    throw new ConnectorRuntimeStopContractError('future-issued');
  }
  if (expiresAt < now - clockSkewMs) throw new ConnectorRuntimeStopContractError('expired');
  if (expiresAt <= issuedAt || expiresAt - issuedAt > maximumTtlMs) {
    throw new ConnectorRuntimeStopContractError('invalid-ttl');
  }
  if (value.grant.generation !== options.expectedGeneration) {
    throw new ConnectorRuntimeStopContractError('stale-generation');
  }
  const plan = value.plan;
  if (value.grant.machineId !== options.expectedMachineId ||
      plan.machineId !== options.expectedMachineId ||
      value.grant.operationId !== plan.operationId ||
      plan.target !== options.expectedTarget ||
      value.grant.planSha256 !== digest(plan) ||
      value.grant.runtimeSha256 !== digest(plan.expectedRuntime) ||
      !identitiesEqual(plan.expectedRuntime, options.expectedRuntime)) {
    throw new ConnectorRuntimeStopContractError('binding-mismatch');
  }
  options.replayProtection?.accept(value.grant, now);
  return { plan: structuredClone(plan), userId: value.grant.userId };
}
