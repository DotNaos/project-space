import { createHash } from 'node:crypto';

import { canonicalJson } from '../codex-sessions/canonical-json';
import type { TaskExecutionResult } from '../../src/shared/task-execution-mcp-api';

export function taskExecutionFingerprint(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function deterministicTaskExecutionId(namespace: string, ...parts: string[]) {
  const hex = createHash('sha256').update([namespace, ...parts].join('\0')).digest('hex');
  const bytes = Buffer.from(hex.slice(0, 32), 'hex');
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const value = bytes.toString('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function nestedOperationId(operationId: string, action: string) {
  const digest = createHash('sha256').update(`${action}\0${operationId}`).digest('hex').slice(0, 24);
  return `execution:${action}:${digest}`;
}

export function encodeTaskExecutionCursor(value: { createdAt: string; id: string }) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeTaskExecutionCursor(value: string | undefined) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const record = parsed as { createdAt?: unknown; id?: unknown };
    if (typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt)) ||
        typeof record.id !== 'string' || !uuidPattern.test(record.id)) return undefined;
    return { createdAt: record.createdAt, id: record.id };
  } catch {
    return undefined;
  }
}

export function compactOperationResult(input: {
  delivery?: 'queued' | 'sent' | 'steered';
  executionId: string;
  message: string;
  messageOutcome?: TaskExecutionResult['messageOutcome'];
  reconcileState?: string;
  state: string;
  version: number;
}) {
  return {
    ...(input.delivery ? { delivery: input.delivery } : {}),
    executionId: input.executionId,
    message: input.message.slice(0, 500),
    ...(input.messageOutcome ? { messageOutcome: input.messageOutcome } : {}),
    ...(input.reconcileState ? { reconcileState: input.reconcileState } : {}),
    state: input.state,
    version: input.version
  };
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
