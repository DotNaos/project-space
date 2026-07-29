import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

import {
  CODEX_PERMISSION_PROFILE_ID_PATTERN,
  CODEX_THREAD_ID_PATTERN
} from '../../src/shared/codex-sessions-api';
import type {
  CodexLoadedThreadListResult,
  CodexThreadResult,
  CodexThreadSummary,
  CodexThreadTokenUsageSnapshot,
  CodexTurnResult
} from './contracts';
import { CodexOperationUncertainError } from './operation-ledger';
import { CodexAppServerProtocolError } from './stdio-transport';
import {
  CodexSessionValidationError,
  sanitizeProtocolValue,
  validateIdentifier
} from './validation';

export function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw protocolError();
  return value as Record<string, unknown>;
}

export function readThread(value: unknown): CodexThreadSummary {
  const thread = sanitizeProtocolValue(requireRecord(value)) as CodexThreadSummary;
  thread.id = validateIdentifier(thread.id, 'threadId');
  return thread;
}

export function readThreadResult(value: unknown): CodexThreadResult {
  return { thread: readThread(requireRecord(value).thread) };
}

export function readStartedThreadResult(value: unknown): CodexThreadResult {
  try {
    const result = readThreadResult(value);
    if (!CODEX_THREAD_ID_PATTERN.test(result.thread.id) || result.thread.ephemeral !== false) {
      throw protocolError();
    }
    return result;
  } catch {
    throw new CodexOperationUncertainError(
      'Codex app-server did not confirm a persistent thread id.'
    );
  }
}

export function readResumedThreadResult(
  value: unknown,
  expectedThreadId: string
): CodexThreadResult {
  try {
    const result = readThreadResult(value);
    if (result.thread.id !== expectedThreadId) throw protocolError();
    return result;
  } catch {
    throw new CodexOperationUncertainError(
      'Codex app-server did not confirm the resumed thread id.'
    );
  }
}

export function readLoadedThreads(value: unknown): CodexLoadedThreadListResult {
  const result = requireRecord(value);
  if (!Array.isArray(result.data) || result.data.length > 10_000) throw protocolError();
  return { data: result.data.map((id) => validateIdentifier(id, 'threadId')) };
}

export function readPermissionProfile(value: unknown) {
  const profile = requireRecord(value);
  const id = validatePermissionProfileId(profile.id);
  if (typeof profile.allowed !== 'boolean') throw protocolError();
  const description = typeof profile.description === 'string'
    ? profile.description.trim()
    : undefined;
  return {
    allowed: profile.allowed,
    ...(description ? { description } : {}),
    id
  };
}

export function validatePermissionProfileId(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length > 128 ||
    !CODEX_PERMISSION_PROFILE_ID_PATTERN.test(value)
  ) {
    throw protocolError();
  }
  return value;
}

export function readThreadTokenUsage(value: unknown): CodexThreadTokenUsageSnapshot {
  const usage = requireRecord(value);
  const modelContextWindow = usage.modelContextWindow === null
    || usage.modelContextWindow === undefined
    ? undefined
    : nonNegativeSafeInteger(usage.modelContextWindow);
  return {
    last: readTokenUsageBreakdown(usage.last),
    ...(modelContextWindow && modelContextWindow > 0 ? { modelContextWindow } : {}),
    total: readTokenUsageBreakdown(usage.total)
  };
}

function readTokenUsageBreakdown(value: unknown) {
  const usage = requireRecord(value);
  return {
    cachedInputTokens: nonNegativeSafeInteger(usage.cachedInputTokens),
    inputTokens: nonNegativeSafeInteger(usage.inputTokens),
    outputTokens: nonNegativeSafeInteger(usage.outputTokens),
    reasoningOutputTokens: nonNegativeSafeInteger(usage.reasoningOutputTokens),
    totalTokens: nonNegativeSafeInteger(usage.totalTokens)
  };
}

function nonNegativeSafeInteger(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw protocolError();
  }
  return value;
}

function readTurnResult(value: unknown): CodexTurnResult {
  const turn = sanitizeProtocolValue(
    requireRecord(requireRecord(value).turn)
  ) as CodexTurnResult['turn'];
  turn.id = validateIdentifier(turn.id, 'turnId');
  return { turn };
}

export function readStartedTurnResult(value: unknown): CodexTurnResult {
  try {
    return readTurnResult(value);
  } catch {
    throw new CodexOperationUncertainError('Codex app-server did not confirm a turn id.');
  }
}

export function protocolError() {
  return new CodexAppServerProtocolError('Codex app-server returned invalid data.');
}

export function fingerprint(method: string, params: unknown) {
  return createHash('sha256')
    .update(`${method}:${JSON.stringify(params)}`, 'utf8')
    .digest('hex');
}

export function validateCwd(value: unknown) {
  if (
    typeof value !== 'string'
    || !isAbsolute(value)
    || value.length > 4_096
    || /[\u0000\r\n]/.test(value)
  ) {
    throw new CodexSessionValidationError('Codex working directory is invalid.');
  }
  return value;
}

export function validateLocalImagePaths(value: unknown) {
  if (value === undefined) return [] as string[];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 3 ||
    new Set(value).size !== value.length ||
    value.some(
      (path) =>
        typeof path !== 'string' ||
        path.length > 4_096 ||
        !isAbsolute(path) ||
        /[\u0000-\u001f\u007f]/.test(path)
    )
  ) {
    throw new CodexSessionValidationError('Invalid local image paths.');
  }
  return value as string[];
}

export function sanitizeErrorNotification(value: unknown) {
  const params = requireRecord(value);
  const result: Record<string, unknown> = {
    error: { message: 'Codex turn failed.' }
  };
  if (typeof params.threadId === 'string') {
    result.threadId = validateIdentifier(params.threadId, 'threadId');
  }
  if (typeof params.turnId === 'string') {
    result.turnId = validateIdentifier(params.turnId, 'turnId');
  }
  return result;
}
