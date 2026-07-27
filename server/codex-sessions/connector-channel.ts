import type {
  CodexSessionsConnectorOperation,
  CodexSessionsWireEvent,
  CodexSessionsWireRequest,
  CodexSessionsWireResult
} from '../codex-sessions-connector-contract';
import type {
  CodexSessionBrowserResult,
  CodexSessionListResult,
  CodexSessionInspectResult,
  CodexSessionOperationResult,
  CodexSessionReadResult
} from '../../src/shared/codex-sessions-api';
import {
  CODEX_BROWSER_MAXIMUM_IMAGE_BYTES,
  CODEX_THREAD_ID_PATTERN
} from '../../src/shared/codex-sessions-api';
import type { CodexMachineTaskConnectorStartResult } from '../../src/shared/codex-machine-tasks-api';
import type { CodexAuthorizationConnectorResult } from '../../src/shared/codex-authorization-api';
import {
  codexDaemonEvidenceIsConsistent,
  codexDaemonResultStateForEvidence,
  type CodexDaemonConnectorResult
} from '../../src/shared/codex-daemon-api';

export interface CodexSessionsCommandBinding {
  generation: number;
  machineId: string;
  operation: CodexSessionsConnectorOperation;
  operationId: string;
  threadId?: string;
  userId: string;
}

export interface BoundCodexSessionsResult {
  binding: CodexSessionsCommandBinding;
  result: CodexSessionsWireResult;
}

export interface BoundCodexSessionsEvent {
  binding: CodexSessionsCommandBinding;
  event: CodexSessionsWireEvent;
}

export interface BoundCodexSessionsCompletion {
  binding: CodexSessionsCommandBinding;
}

export interface BoundCodexSessionsError {
  binding: CodexSessionsCommandBinding;
  error: { code: 'rejected' | 'unavailable' };
}

export const CODEX_ATTACH_MAXIMUM_MESSAGE_BYTES = 16 * 1024 * 1024;
export const CODEX_ATTACH_CHUNK_BYTES = 192 * 1024;

export interface CodexAttachChunk {
  chunkIndex: number;
  data: string;
  final: boolean;
  messageId: number;
}

export interface BoundCodexAttachChunk {
  binding: CodexSessionsCommandBinding;
  chunk: CodexAttachChunk;
}

export interface BoundCodexAttachReady {
  binding: CodexSessionsCommandBinding;
}

export interface BoundCodexAttachClosed {
  binding: CodexSessionsCommandBinding;
  code: 'cancelled' | 'process_exited' | 'protocol_error' | 'unavailable';
}

export class CodexAttachChunkError extends Error {
  constructor() {
    super('The Codex attach tunnel frame is invalid.');
    this.name = 'CodexAttachChunkError';
  }
}

export class CodexAttachChunkAssembler {
  private chunks: Buffer[] = [];
  private expectedChunkIndex = 0;
  private expectedMessageId = 1;
  private totalBytes = 0;

  push(chunk: CodexAttachChunk) {
    if (!isCodexAttachChunk(chunk) || chunk.messageId !== this.expectedMessageId ||
      chunk.chunkIndex !== this.expectedChunkIndex) throw new CodexAttachChunkError();
    const decoded = decodeChunk(chunk.data);
    if (!decoded || this.totalBytes + decoded.byteLength > CODEX_ATTACH_MAXIMUM_MESSAGE_BYTES) {
      throw new CodexAttachChunkError();
    }
    this.chunks.push(decoded);
    this.totalBytes += decoded.byteLength;
    this.expectedChunkIndex += 1;
    if (!chunk.final) return undefined;
    const message = decodeAttachMessage(Buffer.concat(this.chunks, this.totalBytes));
    this.chunks = [];
    this.totalBytes = 0;
    this.expectedChunkIndex = 0;
    this.expectedMessageId += 1;
    return message;
  }
}

export function codexAttachMessageChunks(message: string, messageId: number): CodexAttachChunk[] {
  const bytes = Buffer.from(validateAttachMessage(message), 'utf8');
  if (!Number.isSafeInteger(messageId) || messageId < 1 ||
    bytes.byteLength > CODEX_ATTACH_MAXIMUM_MESSAGE_BYTES) throw new CodexAttachChunkError();
  const chunks: CodexAttachChunk[] = [];
  for (let offset = 0, chunkIndex = 0; offset < bytes.byteLength; chunkIndex += 1) {
    const next = bytes.subarray(offset, offset + CODEX_ATTACH_CHUNK_BYTES);
    offset += next.byteLength;
    chunks.push({
      chunkIndex,
      data: next.toString('base64'),
      final: offset === bytes.byteLength,
      messageId
    });
  }
  return chunks;
}

export function isBoundCodexAttachChunk(value: unknown): value is BoundCodexAttachChunk {
  return smallRecord(value) && hasOnlyKeys(value, ['binding', 'chunk']) &&
    isBinding(value.binding) && value.binding.operation === 'attach' &&
    isCodexAttachChunk(value.chunk);
}

export function isBoundCodexAttachReady(value: unknown): value is BoundCodexAttachReady {
  return smallRecord(value) && hasOnlyKeys(value, ['binding']) &&
    isBinding(value.binding) && value.binding.operation === 'attach';
}

export function isBoundCodexAttachClosed(value: unknown): value is BoundCodexAttachClosed {
  return smallRecord(value) && hasOnlyKeys(value, ['binding', 'code']) &&
    isBinding(value.binding) && value.binding.operation === 'attach' &&
    typeof value.code === 'string' &&
    ['cancelled', 'process_exited', 'protocol_error', 'unavailable'].includes(value.code);
}

export function isCodexAttachChunk(value: unknown): value is CodexAttachChunk {
  if (!smallRecord(value) || !hasOnlyKeys(value, [
    'chunkIndex', 'data', 'final', 'messageId'
  ]) || !Number.isSafeInteger(value.messageId) || Number(value.messageId) < 1 ||
    !Number.isSafeInteger(value.chunkIndex) || Number(value.chunkIndex) < 0 ||
    Number(value.chunkIndex) > Math.ceil(CODEX_ATTACH_MAXIMUM_MESSAGE_BYTES / CODEX_ATTACH_CHUNK_BYTES) ||
    typeof value.final !== 'boolean' || typeof value.data !== 'string') return false;
  return decodeChunk(value.data) !== undefined;
}

export function bindingForCodexSessionsRequest(
  request: CodexSessionsWireRequest
): CodexSessionsCommandBinding {
  return {
    generation: request.grant.generation,
    machineId: request.grant.machineId,
    operation: request.grant.operation,
    operationId: request.grant.operationId,
    ...(request.grant.threadId ? { threadId: request.grant.threadId } : {}),
    userId: request.grant.userId
  };
}

export function codexSessionsBindingsEqual(
  left: CodexSessionsCommandBinding,
  right: CodexSessionsCommandBinding
) {
  return left.generation === right.generation &&
    left.machineId === right.machineId &&
    left.operation === right.operation &&
    left.operationId === right.operationId &&
    left.threadId === right.threadId &&
    left.userId === right.userId;
}

export function boundCodexSessionsResultMatchesRequest(
  value: BoundCodexSessionsResult,
  request: CodexSessionsWireRequest
) {
  const expected = bindingForCodexSessionsRequest(request);
  if (!codexSessionsBindingsEqual(value.binding, expected) ||
    value.result.operation !== expected.operation) return false;
  if (value.result.operation === 'list') {
    const result = value.result.result as CodexSessionListResult;
    return result.machine.id === expected.machineId &&
      result.sessions.every((session) => session.machineId === expected.machineId);
  }
  if (value.result.operation === 'browser') {
    const result = value.result.result as CodexSessionBrowserResult;
    const payload = request.payload as { afterImageRevision?: string };
    return result.machineId === expected.machineId && result.threadId === expected.threadId &&
      (result.imageUnchanged !== true || result.imageRevision === payload.afterImageRevision);
  }
  if (value.result.operation === 'read') {
    const result = value.result.result as CodexSessionReadResult;
    return result.session.machineId === expected.machineId && result.session.id === expected.threadId;
  }
  if (value.result.operation === 'inspect') {
    const result = value.result.result as CodexSessionInspectResult;
    return result.session.machineId === expected.machineId
      && result.session.id === expected.threadId
      && result.taskLocation.machineId === expected.machineId
      && result.taskLocation.threadId === expected.threadId
      && result.sessionRevision === result.taskLocation.sessionRevision;
  }
  if (value.result.operation === 'start') {
    const result = value.result.result as CodexMachineTaskConnectorStartResult;
    return result.state !== 'confirmed' || (
      CODEX_THREAD_ID_PATTERN.test(result.threadId) && identifier(result.worktreeId, 128)
    );
  }
  if (value.result.operation === 'authorization') {
    return isAuthorizationResult(value.result.result as CodexAuthorizationConnectorResult);
  }
  if (value.result.operation === 'daemon') {
    const result = value.result.result as CodexDaemonConnectorResult;
    const payload = request.payload as { operation: string };
    return result.operationId === expected.operationId &&
      result.operation === payload.operation;
  }
  const result = value.result.result as CodexSessionOperationResult;
  return result.operationId === expected.operationId && result.threadId === expected.threadId;
}

export function isBoundCodexSessionsResult(value: unknown): value is BoundCodexSessionsResult {
  if (!smallRecord(value) || !hasOnlyKeys(value, ['binding', 'result']) ||
    !isBinding(value.binding) || !smallRecord(value.result)) return false;
  const result = value.result;
  if (!hasOnlyKeys(result, ['operation', 'result']) || typeof result.operation !== 'string' ||
    !smallRecord(result.result)) return false;
  if (result.operation === 'list') {
    return isListResult(result.result);
  }
  if (result.operation === 'browser') {
    return isBrowserResult(result.result);
  }
  if (result.operation === 'read') {
    return isReadResult(result.result);
  }
  if (result.operation === 'inspect') {
    return isInspectResult(result.result);
  }
  if (result.operation === 'authorization') return isAuthorizationResult(result.result);
  if (result.operation === 'daemon') return isDaemonResult(result.result);
  if (result.operation === 'start') return isStartResult(result.result);
  return ['approval', 'continue', 'input', 'interrupt'].includes(result.operation) &&
    isOperationResult(result.result);
}

function isDaemonResult(value: unknown): value is CodexDaemonConnectorResult {
  if (!smallRecord(value) || !hasOnlyKeys(value, [
    'evidence', 'operation', 'operationId', 'state'
  ]) || !smallRecord(value.evidence)) return false;
  const evidence = value.evidence;
  return identifier(value.operationId, 128) &&
    ['ensure', 'restart', 'status'].includes(String(value.operation)) &&
    ['completed', 'blocked', 'uncertain'].includes(String(value.state)) &&
    hasOnlyKeys(evidence, [
      'appServerVersion', 'authenticated', 'checkedAt', 'cliVersion', 'compatible',
      'environmentId', 'installed', 'paired', 'reachable', 'remoteControlEnabled',
      'remoteControlState', 'running', 'state'
    ]) &&
    typeof evidence.checkedAt === 'string' &&
    Number.isFinite(Date.parse(evidence.checkedAt)) &&
    [
      evidence.authenticated, evidence.compatible, evidence.installed, evidence.paired,
      evidence.reachable, evidence.remoteControlEnabled, evidence.running
    ].every((entry) => typeof entry === 'boolean') &&
    ['disabled', 'connecting', 'connected', 'errored', 'unknown']
      .includes(String(evidence.remoteControlState)) &&
    [
      'ready', 'missing', 'stopped', 'incompatible', 'authorization-required',
      'remote-control-disabled', 'pairing-required', 'connecting', 'unsupported', 'uncertain'
    ].includes(String(evidence.state)) &&
    [evidence.appServerVersion, evidence.cliVersion, evidence.environmentId]
      .every((entry) => entry === undefined || identifier(entry, 256)) &&
    codexDaemonEvidenceIsConsistent(
      evidence as unknown as CodexDaemonConnectorResult['evidence']
    ) &&
    value.state === codexDaemonResultStateForEvidence(
      evidence as unknown as CodexDaemonConnectorResult['evidence']
    );
}

function isAuthorizationResult(value: unknown): value is CodexAuthorizationConnectorResult {
  if (!smallRecord(value) || typeof value.state !== 'string') return false;
  if (value.state === 'pending') {
    return hasOnlyKeys(value, [
      'deadlineAt', 'state', 'userCode', 'verificationUrl'
    ]) &&
      typeof value.deadlineAt === 'string' &&
      Number.isFinite(Date.parse(value.deadlineAt)) &&
      typeof value.userCode === 'string' &&
      /^[A-Z0-9][A-Z0-9-]{3,31}$/.test(value.userCode) &&
      value.verificationUrl === 'https://auth.openai.com/codex/device';
  }
  return hasOnlyKeys(value, ['state']) && [
    'ambiguous', 'authorization-required', 'cancelled', 'expired', 'failed', 'ready'
  ].includes(value.state);
}

export function isBoundCodexSessionsEvent(value: unknown): value is BoundCodexSessionsEvent {
  if (!smallRecord(value) || !hasOnlyKeys(value, ['binding', 'event']) ||
    !isBinding(value.binding) || value.binding.operation !== 'stream' ||
    !smallRecord(value.event) || JSON.stringify(value.event).length > 128_000) return false;
  const event = value.event;
  return event.operation === 'stream' && smallRecord(event.event) &&
    typeof event.event.eventId === 'string' && event.event.eventId.length <= 128 &&
    typeof event.event.type === 'string' && [
      'agent-message-delta', 'approval-requested', 'item', 'session-status',
      'turn-completed', 'user-input-requested'
    ].includes(event.event.type);
}

export function isBoundCodexSessionsCompletion(
  value: unknown
): value is BoundCodexSessionsCompletion {
  return smallRecord(value) && hasOnlyKeys(value, ['binding']) &&
    isBinding(value.binding) && value.binding.operation === 'stream';
}

export function isBoundCodexSessionsError(value: unknown): value is BoundCodexSessionsError {
  return smallRecord(value) && hasOnlyKeys(value, ['binding', 'error']) &&
    isBinding(value.binding) && smallRecord(value.error) &&
    hasOnlyKeys(value.error, ['code']) &&
    (value.error.code === 'rejected' || value.error.code === 'unavailable');
}

function isBinding(value: unknown): value is CodexSessionsCommandBinding {
  return smallRecord(value) && hasOnlyKeys(value, [
    'generation', 'machineId', 'operation', 'operationId', 'threadId', 'userId'
  ]) && Number.isSafeInteger(value.generation) && Number(value.generation) >= 0 &&
    identifier(value.machineId, 256) && identifier(value.userId, 256) &&
    identifier(value.operationId, 128) &&
    (value.threadId === undefined || identifier(value.threadId, 128)) &&
    typeof value.operation === 'string' && [
      'approval', 'attach', 'authorization', 'browser', 'continue', 'daemon', 'inspect', 'input',
      'interrupt', 'list', 'read', 'start', 'stream'
    ].includes(value.operation);
}

function isListResult(value: Record<string, unknown>) {
  const checkedAt = Date.parse(String(value.checkedAt));
  const publishedAt = Date.parse(String(value.publishedAt ?? value.checkedAt));
  return Number.isFinite(checkedAt) && Number.isFinite(publishedAt) &&
    checkedAt <= publishedAt && smallRecord(value.machine) &&
    identifier(value.machine.id, 256) && typeof value.machine.name === 'string' &&
    typeof value.machine.online === 'boolean' && Array.isArray(value.sessions) &&
    value.sessions.length <= 10_000 && value.sessions.every((session) =>
      smallRecord(session) && identifier(session.id, 128) && identifier(session.machineId, 256));
}

function isStartResult(value: Record<string, unknown>) {
  if (value.state === 'uncertain') return hasOnlyKeys(value, ['state']);
  if (value.state === 'worktree_failure') {
    return hasOnlyKeys(value, ['message', 'state']) &&
      typeof value.message === 'string' && value.message.length <= 512;
  }
  return value.state === 'confirmed' &&
    hasOnlyKeys(value, ['state', 'threadId', 'worktreeId']) &&
    typeof value.threadId === 'string' && CODEX_THREAD_ID_PATTERN.test(value.threadId) &&
    identifier(value.worktreeId, 128);
}

function isReadResult(value: Record<string, unknown>) {
  return hasOnlyKeys(value, ['openedReadOnly', 'session', 'streamCursor', 'turns']) &&
    value.openedReadOnly === true && smallRecord(value.session) &&
    identifier(value.session.id, 128) && identifier(value.session.machineId, 256) &&
    Array.isArray(value.turns) && value.turns.length <= 10_000;
}

function isBrowserResult(value: Record<string, unknown>) {
  if (!hasOnlyKeys(value, [
    'checkedAt', 'imageDataUrl', 'imageRevision', 'imageUnchanged', 'machineId', 'observedAt',
    'pageUrl', 'reason', 'state', 'threadId', 'turnId'
  ]) || !identifier(value.machineId, 256) || !identifier(value.threadId, 128) ||
    !timestamp(value.checkedAt) || (value.observedAt !== undefined && !timestamp(value.observedAt)) ||
    (value.turnId !== undefined && !identifier(value.turnId, 128)) ||
    (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length > 512)) ||
    typeof value.state !== 'string' ||
    !['never-used', 'loading', 'live', 'ended', 'unavailable'].includes(value.state)) return false;
  if (value.pageUrl !== undefined && !pageOrigin(value.pageUrl)) return false;
  const unchanged = value.imageUnchanged === true && sha256(value.imageRevision)
    && value.imageDataUrl === undefined;
  const completeFrame = imageDataUrl(value.imageDataUrl) && sha256(value.imageRevision)
    && value.imageUnchanged === undefined;
  if (value.state === 'live') return unchanged || completeFrame;
  if (value.state === 'ended') {
    if (unchanged || completeFrame) return true;
    return value.imageDataUrl === undefined && value.imageRevision === undefined
      && value.imageUnchanged === undefined && value.pageUrl === undefined;
  }
  return value.imageDataUrl === undefined && value.imageRevision === undefined
    && value.imageUnchanged === undefined && value.pageUrl === undefined;
}

function isInspectResult(value: Record<string, unknown>) {
  if (!hasOnlyKeys(value, [
    'activeTurnId', 'checkedAt', 'openedReadOnly', 'session', 'sessionRevision', 'taskLocation'
  ]) || value.openedReadOnly !== true || typeof value.checkedAt !== 'string' ||
    !smallRecord(value.session) || !smallRecord(value.taskLocation) ||
    !sha256(value.sessionRevision)) return false;
  const session = value.session;
  const location = value.taskLocation;
  return identifier(session.id, 128) && identifier(session.machineId, 256) &&
    (value.activeTurnId === undefined || identifier(value.activeTurnId, 128)) &&
    hasOnlyKeys(location, [
      'canonicalCwd', 'checkedAt', 'machineId', 'sessionRevision', 'source', 'threadId',
      'worktreeRoot'
    ]) && typeof location.canonicalCwd === 'string' && location.canonicalCwd.length <= 32_000 &&
    typeof location.worktreeRoot === 'string' && location.worktreeRoot.length <= 32_000 &&
    location.checkedAt === value.checkedAt && location.machineId === session.machineId &&
    location.threadId === session.id && location.source === 'connector-realpath' &&
    location.sessionRevision === value.sessionRevision;
}

function isOperationResult(value: Record<string, unknown>) {
  return hasOnlyKeys(value, [
    'operationId', 'reason', 'replayed', 'status', 'threadId', 'turnId'
  ]) && identifier(value.operationId, 128) && identifier(value.threadId, 128) &&
    typeof value.replayed === 'boolean' && typeof value.status === 'string' &&
    ['accepted', 'ambiguous', 'completed', 'rejected'].includes(value.status) &&
    (value.reason === undefined || (
      value.status === 'rejected' &&
      (value.reason === 'thread_active' || value.reason === 'unavailable')
    )) &&
    (value.turnId === undefined || identifier(value.turnId, 128));
}

function decodeChunk(value: string) {
  if (value.length === 0 || value.length > Math.ceil(CODEX_ATTACH_CHUNK_BYTES / 3) * 4 ||
    value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return undefined;
  }
  const decoded = Buffer.from(value, 'base64');
  return decoded.byteLength > 0 && decoded.byteLength <= CODEX_ATTACH_CHUNK_BYTES &&
    decoded.toString('base64') === value ? decoded : undefined;
}

function decodeAttachMessage(bytes: Buffer) {
  let message: string;
  try {
    message = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CodexAttachChunkError();
  }
  return validateAttachMessage(message);
}

function validateAttachMessage(message: string) {
  if (!message || Buffer.byteLength(message, 'utf8') > CODEX_ATTACH_MAXIMUM_MESSAGE_BYTES) {
    throw new CodexAttachChunkError();
  }
  try {
    const parsed = JSON.parse(message);
    if (!smallRecord(parsed)) throw new Error();
  } catch {
    throw new CodexAttachChunkError();
  }
  return message;
}

function smallRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function sha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function imageDataUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2_100_000) return false;
  const match = value.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[2]!.length % 4 !== 0) return false;
  const padding = match[2]!.endsWith('==') ? 2 : match[2]!.endsWith('=') ? 1 : 0;
  const bytes = match[2]!.length * 3 / 4 - padding;
  return Number.isSafeInteger(bytes) && bytes > 0 &&
    bytes <= CODEX_BROWSER_MAXIMUM_IMAGE_BYTES;
}

function pageOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4_096) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
      url.origin === value;
  } catch {
    return false;
  }
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}
