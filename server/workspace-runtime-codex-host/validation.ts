import { CODEX_OPERATION_ID_PATTERN } from '../../src/shared/codex-sessions-api';
import type { WorkspaceRuntimeCodexCommand } from '../../src/shared/workspace-runtime-codex-api';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const workspace = /^ws_[a-f0-9]{24}$/;
const identifier = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const maximumMessageBytes = 64 * 1024;

export interface CodexHostScope {
  actorOwnerUserId: string;
  environmentId: string;
  generation: string;
  machineId: string;
  sessionId: string;
  workspaceId: string;
}

export class CodexHostCommandError extends Error {
  constructor(readonly code: 'invalid_command' | 'stale_generation') {
    super('The Workspace Runtime Codex command was rejected.');
  }
}

export function parseCodexHostCommand(
  value: unknown,
  scope: CodexHostScope
): WorkspaceRuntimeCodexCommand {
  if (Buffer.byteLength(JSON.stringify(value)) > maximumMessageBytes) invalid();
  const input = object(value);
  if (input.type !== 'runtime.codex.command' || input.schemaVersion !== 1 ||
      !identifier.test(text(input.actorId)) ||
      !['agent', 'human', 'orchestrator', 'system'].includes(text(input.actorKind)) ||
      text(input.actorUserId) !== scope.actorOwnerUserId ||
      !identifier.test(text(input.commandId)) ||
      !Number.isSafeInteger(input.commandSequence) || Number(input.commandSequence) < 1 ||
      !uuid.test(text(input.environmentId)) || !uuid.test(text(input.generation)) ||
      !CODEX_OPERATION_ID_PATTERN.test(text(input.operationId)) ||
      !identifier.test(text(input.sessionId)) || !workspace.test(text(input.workspaceId))) invalid();
  if (input.workspaceId !== scope.workspaceId || input.environmentId !== scope.environmentId ||
      input.generation !== scope.generation) {
    throw new CodexHostCommandError('stale_generation');
  }
  if (input.sessionId !== scope.sessionId) invalid();
  const request = object(input.request);
  const kind = text(input.kind);
  const machineKinds = new Set([
    'approval', 'continue', 'input', 'inspect', 'interrupt', 'list', 'read',
    'settings', 'start', 'stream-start', 'stream-stop'
  ]);
  if (machineKinds.has(kind) && request.machineId !== scope.machineId) invalid();
  if (!machineKinds.has(kind) && !['runtime-start', 'runtime-stop'].includes(kind)) invalid();
  if (['approval', 'continue', 'input', 'interrupt', 'settings', 'start'].includes(kind) &&
      request.operationId !== input.operationId) invalid();
  if (kind === 'runtime-start' || kind === 'runtime-stop') {
    if (request.operationId !== input.operationId) invalid();
    if (kind === 'runtime-stop' && request.reason !== undefined) safeText(request.reason, 256);
  }
  if (kind === 'stream-start' && request.afterSequence !== undefined &&
      (!Number.isSafeInteger(request.afterSequence) || Number(request.afterSequence) < 0)) invalid();
  const threadKinds = new Set([
    'approval', 'continue', 'input', 'inspect', 'interrupt', 'read', 'settings',
    'stream-start', 'stream-stop'
  ]);
  if (threadKinds.has(kind)) {
    if (!identifier.test(text(input.targetThreadId)) || input.targetThreadId !== request.threadId) invalid();
  } else if (input.targetThreadId !== undefined) {
    invalid();
  }
  return input as unknown as WorkspaceRuntimeCodexCommand;
}

export function generationNumber(generation: string) {
  const normalized = generation.replaceAll('-', '').slice(0, 8);
  return Number.parseInt(normalized, 16) & 0x7fff_ffff;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function text(value: unknown) {
  if (typeof value !== 'string') invalid();
  return value;
}

function safeText(value: unknown, maximum: number) {
  const result = text(value);
  if (!result || result.length > maximum || /[\u0000-\u001f\u007f]/.test(result)) invalid();
  return result;
}

function invalid(): never {
  throw new CodexHostCommandError('invalid_command');
}
