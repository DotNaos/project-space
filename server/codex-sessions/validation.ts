import {
  codexNotificationMethods,
  codexServerRequestMethods,
  type CodexNotificationMethod,
  type CodexRpcId,
  type CodexServerRequestMethod,
  type CodexThreadListInput
} from './contracts';

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const sensitiveKeyPattern =
  /^(?:authorization|cookie|credential|env|environment|headers|output|outputDelta|secret|stderr|stdout|token)$/i;

export class CodexSessionValidationError extends Error {
  readonly code = 'invalid_codex_session_input';
}

function validationError(message: string): never {
  throw new CodexSessionValidationError(message);
}

export function validateIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !identifierPattern.test(value)) {
    validationError(`${label} is invalid.`);
  }
  return value;
}

export function validateRpcId(value: unknown): CodexRpcId {
  if (
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === 'string' && identifierPattern.test(value))
  ) {
    return value;
  }
  return validationError('requestId is invalid.');
}

export function validatePrompt(value: unknown): string {
  if (typeof value !== 'string') {
    validationError('prompt is invalid.');
  }
  const prompt = value.trim();
  if (!prompt || prompt.length > 100_000 || /[\u0000\u0008\u000B\u000C]/.test(prompt)) {
    validationError('prompt is invalid.');
  }
  return prompt;
}

export function validateThreadListInput(input: CodexThreadListInput): CodexThreadListInput {
  const result: CodexThreadListInput = {};
  if (input.archived !== undefined) result.archived = input.archived === true;
  if (input.cursor !== undefined) result.cursor = validateOpaque(input.cursor, 'cursor', 4_096);
  if (input.limit !== undefined) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      validationError('limit must be between 1 and 100.');
    }
    result.limit = input.limit;
  }
  if (input.searchTerm !== undefined) {
    result.searchTerm = validateOpaque(input.searchTerm, 'searchTerm', 500);
  }
  if (input.sortDirection !== undefined) {
    if (input.sortDirection !== 'asc' && input.sortDirection !== 'desc') {
      validationError('sortDirection is invalid.');
    }
    result.sortDirection = input.sortDirection;
  }
  if (input.sortKey !== undefined) {
    if (!['created_at', 'recency_at', 'updated_at'].includes(input.sortKey)) {
      validationError('sortKey is invalid.');
    }
    result.sortKey = input.sortKey;
  }
  return result;
}

export function validateAnswers(value: Record<string, string[]>) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    validationError('answers are invalid.');
  }
  const entries = Object.entries(value);
  if (entries.length > 50) validationError('answers are invalid.');
  return Object.fromEntries(
    entries.map(([questionId, answers]) => {
      validateIdentifier(questionId, 'questionId');
      if (!Array.isArray(answers) || answers.length > 3) validationError('answers are invalid.');
      return [questionId, answers.map((answer) => validateOpaque(answer, 'answer', 20_000))];
    })
  );
}

export function isNotificationMethod(value: string): value is CodexNotificationMethod {
  return (codexNotificationMethods as readonly string[]).includes(value);
}

export function isServerRequestMethod(value: string): value is CodexServerRequestMethod {
  return (codexServerRequestMethods as readonly string[]).includes(value);
}

export function rpcIdKey(id: CodexRpcId) {
  return `${typeof id}:${id}`;
}

export function sanitizeProtocolValue(
  value: unknown,
  options: { commandOutput?: boolean } = {},
  depth = 0
): unknown {
  if (depth > 8) return '[truncated]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    const clean = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    return clean.length > 32_000 ? `${clean.slice(0, 32_000)}…` : clean;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 500).map((entry) => sanitizeProtocolValue(entry, options, depth + 1));
  }
  if (typeof value !== 'object') return null;

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 250)) {
    if (
      sensitiveKeyPattern.test(key) ||
      (options.commandOutput && (key === 'delta' || /(?:output|stderr|stdout)/i.test(key)))
    ) {
      result[key] = '[redacted]';
    } else {
      result[key] = sanitizeProtocolValue(entry, options, depth + 1);
    }
  }
  return result;
}

function validateOpaque(value: unknown, label: string, maxLength: number) {
  if (typeof value !== 'string' || !value || value.length > maxLength || /[\u0000\r\n]/.test(value)) {
    validationError(`${label} is invalid.`);
  }
  return value;
}
