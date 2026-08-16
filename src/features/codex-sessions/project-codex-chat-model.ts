import type { ChatThreadSection } from '@dotnaos/ui/chat';
import type { CodexHostInventoryItem } from '@/shared/codex-host-inventory-api';
import type { CodexSession, CodexThreadOrigin } from './codex-sessions-types';

export function codexChatThreadId(origin: CodexThreadOrigin) {
  return JSON.stringify([origin.machineId, origin.threadId]);
}

export function parseCodexChatThreadId(value: string): CodexThreadOrigin | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      && parsed.length === 2
      && parsed.every((entry) => typeof entry === 'string' && entry.length > 0)
      ? { machineId: parsed[0], threadId: parsed[1] }
      : undefined;
  } catch {
    return undefined;
  }
}

export function buildCodexChatThreadSections(
  hosts: readonly CodexHostInventoryItem[],
  sessions: readonly CodexSession[],
  selectedOrigin?: CodexThreadOrigin
): ChatThreadSection[] {
  const onlineHostIds = new Set(hosts.map((host) => host.machineId));
  const sessionsByHost = new Map<string, CodexSession[]>();
  for (const session of sessions) {
    if (!onlineHostIds.has(session.machineId)) continue;
    const entries = sessionsByHost.get(session.machineId) ?? [];
    entries.push(session);
    sessionsByHost.set(session.machineId, entries);
  }

  return hosts.map((host) => {
    const hostSessions = [...(sessionsByHost.get(host.machineId) ?? [])]
      .sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt));
    return {
      collapsedCount: 4,
      heading: host.name,
      id: host.machineId,
      meta: `${hostSessions.length} ${hostSessions.length === 1 ? 'task' : 'tasks'}`,
      threads: hostSessions.map((session) => ({
        active: session.machineId === selectedOrigin?.machineId
          && session.threadId === selectedOrigin.threadId,
        id: codexChatThreadId(session),
        label: session.title,
        meta: threadMeta(session),
        tone: session.attention ? 'warning' : session.status === 'active' ? 'success' : 'muted'
      }))
    };
  });
}

export function newestSessionForWorktree(
  sessions: readonly CodexSession[],
  machineId: string,
  worktreePath: string
) {
  return sessions
    .filter((session) => session.machineId === machineId && session.cwd === worktreePath)
    .sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt))[0];
}

function threadMeta(session: CodexSession) {
  if (session.attention === 'approval') return 'Approval needed';
  if (session.attention === 'input') return 'Input needed';
  if (session.status === 'active') return 'Running';
  const observedAt = Date.parse(session.lastActivityAt);
  if (!Number.isFinite(observedAt)) return session.status;
  const minutes = Math.max(0, Math.floor((Date.now() - observedAt) / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
