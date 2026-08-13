import { createHash } from 'node:crypto';

import type {
  CodexSessionOperationResult
} from '../../src/shared/codex-sessions-api';

export function derivedOperationId(operationId: string, step: string) {
  const digest = createHash('sha256')
    .update(`${step}\u0000${operationId}`)
    .digest('hex')
    .slice(0, 32);
  return `codex:${step}:${digest}`;
}

export function operationResult(
  request: { operationId: string; threadId: string },
  status: CodexSessionOperationResult['status'],
  turnId?: string,
  reason?: CodexSessionOperationResult['reason']
): CodexSessionOperationResult {
  return {
    operationId: request.operationId,
    replayed: false,
    status,
    threadId: request.threadId,
    ...(reason ? { reason } : {}),
    ...(turnId ? { turnId } : {})
  };
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function stringValue(value: unknown) {
  return typeof value === 'string' && value ? value : undefined;
}
