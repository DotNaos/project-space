import {
  createHash,
  randomBytes,
  sign as signPayload,
  verify as verifyPayload,
  type KeyLike
} from 'node:crypto';

import type {
  CodexSessionApprovalRequest,
  CodexSessionBrowserRequest,
  CodexSessionBrowserResult,
  CodexSessionContinueRequest,
  CodexSessionInspectRequest,
  CodexSessionInspectResult,
  CodexSessionInterruptRequest,
  CodexSessionListRequest,
  CodexSessionListResult,
  CodexSessionOperationResult,
  CodexSessionReadRequest,
  CodexSessionReadResult,
  CodexSessionStreamEvent,
  CodexSessionUserInputResponse
} from '../src/shared/codex-sessions-api';
import { canonicalJson } from './codex-sessions/canonical-json';

export const CODEX_SESSIONS_CONNECTOR_CAPABILITY = 'codex.sessions.v1';
export const CODEX_SESSIONS_BROWSER_CONNECTOR_CAPABILITY = 'codex.sessions.browser.v1';
export const CODEX_SESSIONS_INSPECT_CONNECTOR_CAPABILITY = 'codex.sessions.inspect.v1';
export const CODEX_SESSIONS_MODEL_SELECTION_CONNECTOR_CAPABILITY = 'codex.sessions.model-selection.v1';

export type CodexSessionsConnectorOperation =
  | 'approval'
  | 'browser'
  | 'continue'
  | 'inspect'
  | 'input'
  | 'interrupt'
  | 'list'
  | 'read'
  | 'stream';

type CodexSessionsConnectorPayload =
  | CodexSessionApprovalRequest
  | CodexSessionBrowserRequest
  | CodexSessionContinueRequest
  | CodexSessionInspectRequest
  | CodexSessionInterruptRequest
  | CodexSessionListRequest
  | CodexSessionReadRequest
  | CodexSessionUserInputResponse;

export interface CodexSessionsCommandGrant {
  expiresAt: string;
  generation: number;
  issuedAt: string;
  machineId: string;
  nonce: string;
  operation: CodexSessionsConnectorOperation;
  operationId: string;
  payloadSha256: string;
  signature: string;
  threadId?: string;
  userId: string;
}

export interface CodexSessionsWireRequest {
  grant: CodexSessionsCommandGrant;
  payload: CodexSessionsConnectorPayload;
}

export type CodexSessionsWireResult =
  | { operation: 'browser'; result: CodexSessionBrowserResult }
  | { operation: 'list'; result: CodexSessionListResult }
  | { operation: 'read'; result: CodexSessionReadResult }
  | { operation: 'inspect'; result: CodexSessionInspectResult }
  | {
      operation: 'approval' | 'continue' | 'input' | 'interrupt';
      result: CodexSessionOperationResult;
    };

export interface CodexSessionsWireEvent {
  event: CodexSessionStreamEvent;
  operation: 'stream';
}

export class CodexSessionsGrantError extends Error {
  constructor(
    readonly code:
      | 'binding-mismatch'
      | 'expired'
      | 'future-issued'
      | 'invalid-signature'
      | 'invalid-ttl'
      | 'replayed'
      | 'stale-generation'
  ) {
    super('The Codex session operation grant is invalid.');
    this.name = 'CodexSessionsGrantError';
  }
}

interface CreateGrantInput {
  generation: number;
  operation: CodexSessionsConnectorOperation;
  operationId: string;
  payload: CodexSessionsConnectorPayload;
  userId: string;
}

const maximumTtlMs = 60_000;
const defaultTtlMs = 30_000;
const clockSkewMs = 5_000;

export function createCodexSessionsWireRequest(
  input: CreateGrantInput,
  signingKey: KeyLike,
  options: { nonce?: string; now?: number; ttlMs?: number } = {}
): CodexSessionsWireRequest {
  const machineId = input.payload.machineId;
  const threadId = 'threadId' in input.payload ? input.payload.threadId : undefined;
  const issuedAt = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? defaultTtlMs;
  if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > maximumTtlMs) {
    throw new Error(`Codex session grant TTL must be between 1 and ${maximumTtlMs}ms.`);
  }
  const unsigned: Omit<CodexSessionsCommandGrant, 'signature'> = {
    expiresAt: new Date(issuedAt + ttlMs).toISOString(),
    generation: input.generation,
    issuedAt: new Date(issuedAt).toISOString(),
    machineId,
    nonce: options.nonce ?? `n${randomBytes(24).toString('base64url')}`,
    operation: input.operation,
    operationId: input.operationId,
    payloadSha256: payloadFingerprint(input.payload),
    ...(threadId ? { threadId } : {}),
    userId: input.userId
  };
  return {
    grant: {
      ...unsigned,
      signature: signPayload(
        null,
        Buffer.from(canonicalGrant(unsigned)),
        signingKey
      ).toString('base64url')
    },
    payload: input.payload
  };
}

export function verifyCodexSessionsWireRequest(
  request: CodexSessionsWireRequest,
  operation: CodexSessionsConnectorOperation,
  verificationKey: KeyLike,
  options: {
    expectedGeneration: number;
    expectedMachineId: string;
    now?: number;
    replayProtection?: CodexSessionsGrantReplayProtection;
  }
) {
  const { signature, ...unsigned } = request.grant;
  if (!verifyPayload(
    null,
    Buffer.from(canonicalGrant(unsigned)),
    verificationKey,
    Buffer.from(signature, 'base64url')
  )) {
    throw new CodexSessionsGrantError('invalid-signature');
  }
  const now = options.now ?? Date.now();
  const issuedAt = Date.parse(request.grant.issuedAt);
  const expiresAt = Date.parse(request.grant.expiresAt);
  if (issuedAt > now + clockSkewMs) throw new CodexSessionsGrantError('future-issued');
  if (expiresAt < now - clockSkewMs) throw new CodexSessionsGrantError('expired');
  if (expiresAt <= issuedAt || expiresAt - issuedAt > maximumTtlMs) {
    throw new CodexSessionsGrantError('invalid-ttl');
  }
  if (request.grant.generation !== options.expectedGeneration) {
    throw new CodexSessionsGrantError('stale-generation');
  }
  const payloadThreadId = 'threadId' in request.payload ? request.payload.threadId : undefined;
  if (
    request.grant.operation !== operation ||
    request.grant.machineId !== options.expectedMachineId ||
    request.payload.machineId !== options.expectedMachineId ||
    request.grant.threadId !== payloadThreadId ||
    ('operationId' in request.payload && request.grant.operationId !== request.payload.operationId) ||
    request.grant.payloadSha256 !== payloadFingerprint(request.payload)
  ) {
    throw new CodexSessionsGrantError('binding-mismatch');
  }
  options.replayProtection?.accept(request.grant, now);
  return { userId: request.grant.userId };
}

export class CodexSessionsGrantReplayProtection {
  private readonly used = new Map<string, number>();

  accept(grant: CodexSessionsCommandGrant, now = Date.now()) {
    this.prune(now);
    const key = [
      grant.userId,
      grant.machineId,
      grant.threadId ?? '',
      grant.operation,
      grant.operationId,
      grant.nonce
    ].join('\u0000');
    if (this.used.has(key)) throw new CodexSessionsGrantError('replayed');
    this.used.set(key, Date.parse(grant.expiresAt) + clockSkewMs);
  }

  private prune(now: number) {
    for (const [key, expiresAt] of this.used) {
      if (expiresAt < now) this.used.delete(key);
    }
  }
}

export function isCodexSessionsWireRequest(value: unknown): value is CodexSessionsWireRequest {
  if (!isRecord(value) || !hasOnlyKeys(value, ['grant', 'payload'])) return false;
  if (!isRecord(value.grant) || !isRecord(value.payload)) return false;
  const grant = value.grant;
  return hasOnlyKeys(grant, [
    'expiresAt', 'generation', 'issuedAt', 'machineId', 'nonce', 'operation', 'operationId',
    'payloadSha256', 'signature', 'threadId', 'userId'
  ]) &&
    typeof grant.signature === 'string' && grant.signature.length <= 256 &&
    typeof grant.payloadSha256 === 'string' && /^[0-9a-f]{64}$/.test(grant.payloadSha256) &&
    typeof grant.generation === 'number' && Number.isSafeInteger(grant.generation) && grant.generation >= 0 &&
    typeof grant.operation === 'string' && [
      'approval', 'browser', 'continue', 'inspect', 'input', 'interrupt', 'list', 'read', 'stream'
    ].includes(grant.operation) &&
    boundedIdentifier(grant.machineId, 256) && boundedIdentifier(grant.userId, 256) &&
    boundedIdentifier(grant.nonce, 128) && boundedIdentifier(grant.operationId, 128) &&
    typeof grant.issuedAt === 'string' && typeof grant.expiresAt === 'string' &&
    (grant.threadId === undefined || boundedIdentifier(grant.threadId, 128)) &&
    boundedPayload(grant.operation as CodexSessionsConnectorOperation, value.payload);
}

function payloadFingerprint(payload: CodexSessionsConnectorPayload) {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

function canonicalGrant(grant: Omit<CodexSessionsCommandGrant, 'signature'>) {
  return JSON.stringify([
    grant.userId,
    grant.machineId,
    grant.threadId ?? null,
    grant.operation,
    grant.operationId,
    grant.payloadSha256,
    grant.issuedAt,
    grant.expiresAt,
    grant.nonce,
    grant.generation
  ]);
}

function boundedPayload(operation: CodexSessionsConnectorOperation, payload: Record<string, unknown>) {
  if (!boundedIdentifier(payload.machineId, 256)) return false;
  if ('threadId' in payload && !boundedIdentifier(payload.threadId, 128)) return false;
  if ('operationId' in payload && !boundedIdentifier(payload.operationId, 128)) return false;
  if ('message' in payload && (typeof payload.message !== 'string' || payload.message.length > 16_000)) {
    return false;
  }
  if (JSON.stringify(payload).length > 24_000) return false;
  switch (operation) {
    case 'list':
      return hasOnlyKeys(payload, ['includeArchived', 'machineId', 'search']) &&
        (payload.includeArchived === undefined || typeof payload.includeArchived === 'boolean') &&
        (payload.search === undefined || typeof payload.search === 'string' && payload.search.length <= 256);
    case 'inspect':
    case 'stream':
    case 'read':
      return hasOnlyKeys(payload, ['machineId', 'threadId']) &&
        boundedIdentifier(payload.threadId, 128);
    case 'browser':
      return hasOnlyKeys(payload, ['afterImageRevision', 'machineId', 'threadId']) &&
        boundedIdentifier(payload.threadId, 128) &&
        (payload.afterImageRevision === undefined || (
          typeof payload.afterImageRevision === 'string' && /^[a-f0-9]{64}$/.test(payload.afterImageRevision)
        ));
    case 'continue':
      return hasOnlyKeys(payload, ['machineId', 'message', 'model', 'operationId', 'threadId']) &&
        boundedIdentifier(payload.threadId, 128) && boundedIdentifier(payload.operationId, 128) &&
        (payload.model === undefined || boundedIdentifier(payload.model, 128)) &&
        typeof payload.message === 'string' && payload.message.length > 0 && payload.message.length <= 16_000;
    case 'interrupt':
      return hasOnlyKeys(payload, ['machineId', 'operationId', 'threadId', 'turnId']) &&
        boundedIdentifier(payload.threadId, 128) && boundedIdentifier(payload.turnId, 128) &&
        boundedIdentifier(payload.operationId, 128);
    case 'approval':
      return hasOnlyKeys(payload, [
        'approvalId', 'decision', 'itemId', 'machineId', 'operationId', 'requestId', 'threadId', 'turnId'
      ]) && boundedIdentifier(payload.threadId, 128) && boundedIdentifier(payload.turnId, 128) &&
        boundedIdentifier(payload.requestId, 256) && boundedIdentifier(payload.operationId, 128) &&
        (payload.decision === 'allow-once' || payload.decision === 'deny') &&
        (payload.approvalId === undefined || boundedIdentifier(payload.approvalId, 256)) &&
        (payload.itemId === undefined || boundedIdentifier(payload.itemId, 256));
    case 'input':
      return hasOnlyKeys(payload, [
        'answers', 'machineId', 'operationId', 'requestId', 'threadId', 'turnId'
      ]) && boundedIdentifier(payload.threadId, 128) && boundedIdentifier(payload.turnId, 128) &&
        boundedIdentifier(payload.requestId, 256) && boundedIdentifier(payload.operationId, 128) &&
        Array.isArray(payload.answers) && payload.answers.length > 0 && payload.answers.length <= 32 &&
        payload.answers.every((answer) => isRecord(answer) &&
          hasOnlyKeys(answer, ['questionId', 'value']) && boundedIdentifier(answer.questionId, 128) &&
          typeof answer.value === 'string' && answer.value.length > 0 && answer.value.length <= 4_000);
  }
}

function boundedIdentifier(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).every((key) => keys.includes(key));
}
