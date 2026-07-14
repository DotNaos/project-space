import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { promisify } from 'node:util';

import type {
  CodexSessionInspectResult,
  CodexSessionRecord,
  CodexSessionWriteCapability
} from '../../src/shared/codex-sessions-api';

export interface CodexResolvedTaskLocation {
  canonicalCwd: string;
  worktreeRoot: string;
}

export type CodexTaskLocationResolver = (cwd: string) => Promise<CodexResolvedTaskLocation>;

const execFileAsync = promisify(execFile);
const clockSkewToleranceMs = 30_000;
const writeCapabilityTtlMs = 30_000;

export async function resolveCodexTaskLocation(cwd: string): Promise<CodexResolvedTaskLocation> {
  if (!validNativeAbsolutePath(cwd)) throw new Error('The Codex task location is unavailable.');
  const canonicalCwd = await realpath(cwd);
  const { stdout } = await execFileAsync(
    'git',
    ['-C', canonicalCwd, 'rev-parse', '--show-toplevel'],
    { encoding: 'utf8', maxBuffer: 64 * 1024, timeout: 5_000 }
  );
  const reportedRoot = String(stdout).trim();
  if (!validNativeAbsolutePath(reportedRoot)) throw new Error('The Codex task location is unavailable.');
  const worktreeRoot = await realpath(reportedRoot);
  if (!validNativeAbsolutePath(worktreeRoot) || !nativePathContains(worktreeRoot, canonicalCwd)) {
    throw new Error('The Codex task location is unavailable.');
  }
  return { canonicalCwd, worktreeRoot };
}

export function codexSessionRevision(input: {
  activeTurnId?: string;
  connectorGeneration: number;
  runtimeEpoch: number;
  session: CodexSessionRecord;
  taskLocation: CodexResolvedTaskLocation;
}) {
  return createHash('sha256').update(JSON.stringify([
    input.connectorGeneration,
    input.runtimeEpoch,
    input.session.machineId,
    input.session.id,
    input.session.lastActivityAt,
    input.session.status,
    input.session.archived,
    input.activeTurnId ?? null,
    input.taskLocation.canonicalCwd,
    input.taskLocation.worktreeRoot
  ])).digest('hex');
}

export function codexSessionInspectionMatchesScope(
  result: CodexSessionInspectResult,
  scope: { machineId: string; threadId: string }
) {
  const location = result.taskLocation;
  const session = result.session;
  return result.openedReadOnly === true
    && session.machineId === scope.machineId
    && session.id === scope.threadId
    && location.machineId === scope.machineId
    && location.threadId === scope.threadId
    && location.source === 'connector-realpath'
    && location.checkedAt === result.checkedAt
    && validTimestamp(result.checkedAt)
    && validTimestamp(session.lastActivityAt)
    && validRevision(result.sessionRevision)
    && location.sessionRevision === result.sessionRevision
    && validPortableAbsolutePath(location.canonicalCwd)
    && validPortableAbsolutePath(location.worktreeRoot)
    && portablePathContains(location.worktreeRoot, location.canonicalCwd)
    && (result.activeTurnId === undefined || validRuntimeId(result.activeTurnId))
    && (session.status === 'active' || result.activeTurnId === undefined);
}

export function withCodexSessionWriteCapability(
  result: CodexSessionInspectResult,
  checkedAt: Date
): CodexSessionInspectResult {
  const { writeCapability: _untrusted, ...untrustedInspection } = result;
  const checkedAtTime = checkedAt.getTime();
  const checkedAtIso = Number.isFinite(checkedAtTime) ? checkedAt.toISOString() : undefined;
  const sessionTime = Date.parse(result.session.lastActivityAt);
  const unavailable = (reason: string): CodexSessionWriteCapability => ({
    ...(checkedAtIso ? { checkedAt: checkedAtIso } : {}),
    reason,
    state: 'unavailable'
  });

  const inspection = checkedAtIso ? {
    ...untrustedInspection,
    checkedAt: checkedAtIso,
    taskLocation: { ...untrustedInspection.taskLocation, checkedAt: checkedAtIso }
  } : untrustedInspection;
  if (
    !checkedAtIso
    || !Number.isFinite(sessionTime)
    || sessionTime > checkedAtTime + clockSkewToleranceMs
    || !validRevision(result.sessionRevision)
  ) {
    return {
      ...inspection,
      writeCapability: unavailable('The Codex task timestamps could not be verified.')
    };
  }
  const session = result.session;
  if (session.archived || (session.status !== 'active' && session.status !== 'idle')) {
    return {
      ...inspection,
      writeCapability: unavailable('This Codex task is not currently writable.')
    };
  }
  if (session.status === 'active' && !validRuntimeId(result.activeTurnId)) {
    return {
      ...inspection,
      writeCapability: unavailable('The active Codex turn identity could not be verified.')
    };
  }
  return {
    ...inspection,
    writeCapability: {
      canContinue: session.status === 'idle',
      checkedAt: checkedAtIso,
      expiresAt: new Date(checkedAtTime + writeCapabilityTtlMs).toISOString(),
      ...(session.status === 'active' && result.activeTurnId
        ? { interruptTurnId: result.activeTurnId }
        : {}),
      machineId: session.machineId,
      sessionRevision: result.sessionRevision,
      sessionLastActivityAt: session.lastActivityAt,
      state: 'ready',
      threadId: session.id
    }
  };
}

function validNativeAbsolutePath(value: string | undefined): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 32_000
    && !/[\u0000-\u001f\u007f]/.test(value)
    && isAbsolute(value);
}

function validPortableAbsolutePath(value: string | undefined): value is string {
  return Boolean(portableComparablePath(value));
}

function validRevision(value: string | undefined): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function validRuntimeId(value: string | undefined): value is string {
  return typeof value === 'string'
    && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function validTimestamp(value: string | undefined) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function nativePathContains(root: string, candidate: string) {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function portablePathContains(root: string, candidate: string) {
  const comparableRoot = portableComparablePath(root);
  const comparableCandidate = portableComparablePath(candidate);
  return Boolean(
    comparableRoot
    && comparableCandidate
    && comparableRoot.length > 1
    && (comparableCandidate === comparableRoot || comparableCandidate.startsWith(`${comparableRoot}/`))
  );
}

function portableComparablePath(value: string | undefined) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 32_000
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value)
  ) return '';
  const windowsPath = /^[A-Za-z]:[\\/]/.test(value);
  if (!windowsPath && value.includes('\\')) return '';
  const normalized = (windowsPath ? value.replace(/\\/g, '/') : value)
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '');
  if (!normalized.startsWith('/') && !/^[A-Za-z]:\//.test(normalized)) return '';
  if (normalized.split('/').some((segment) => segment === '.' || segment === '..')) return '';
  return windowsPath ? normalized.toLowerCase() : normalized;
}
