import type {
  CodexSessionsConnectorOperation,
  CodexSessionsWireEvent,
  CodexSessionsWireRequest,
  CodexSessionsWireResult
} from '../codex-sessions-connector-contract';
import type {
  CodexSessionListResult,
  CodexSessionOperationResult,
  CodexSessionReadResult
} from '../../src/shared/codex-sessions-api';

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
  if (value.result.operation === 'read') {
    const result = value.result.result as CodexSessionReadResult;
    return result.session.machineId === expected.machineId && result.session.id === expected.threadId;
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
  if (result.operation === 'read') {
    return isReadResult(result.result);
  }
  return ['approval', 'continue', 'input', 'interrupt'].includes(result.operation) &&
    isOperationResult(result.result);
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
      'approval', 'continue', 'input', 'interrupt', 'list', 'read', 'stream'
    ].includes(value.operation);
}

function isListResult(value: Record<string, unknown>) {
  return typeof value.checkedAt === 'string' && smallRecord(value.machine) &&
    identifier(value.machine.id, 256) && typeof value.machine.name === 'string' &&
    typeof value.machine.online === 'boolean' && Array.isArray(value.sessions) &&
    value.sessions.length <= 10_000 && value.sessions.every((session) =>
      smallRecord(session) && identifier(session.id, 128) && identifier(session.machineId, 256));
}

function isReadResult(value: Record<string, unknown>) {
  return value.openedReadOnly === true && smallRecord(value.session) &&
    identifier(value.session.id, 128) && identifier(value.session.machineId, 256) &&
    Array.isArray(value.turns) && value.turns.length <= 10_000;
}

function isOperationResult(value: Record<string, unknown>) {
  return identifier(value.operationId, 128) && identifier(value.threadId, 128) &&
    typeof value.replayed === 'boolean' && typeof value.status === 'string' &&
    ['accepted', 'ambiguous', 'completed', 'rejected'].includes(value.status) &&
    (value.turnId === undefined || identifier(value.turnId, 128));
}

function smallRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}
