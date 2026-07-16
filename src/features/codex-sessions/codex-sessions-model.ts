import type {
  CodexMachine,
  CodexSession,
  CodexSessionStatus,
  CodexThreadOrigin
} from './codex-sessions-types';

export interface CodexSessionSection {
  id: 'loaded' | 'stored';
  label: string;
  sessions: CodexSession[];
}

export interface CodexMachineSessionGroup {
  machine: CodexMachine;
  sections: CodexSessionSection[];
}

function normalizedSearchText(session: CodexSession, machine?: CodexMachine) {
  return [
    session.title,
    session.projectName,
    session.cwd,
    session.model,
    session.threadId,
    machine?.name
  ].filter(Boolean).join(' ').toLocaleLowerCase();
}

export function effectiveCodexSessionStatus(
  session: CodexSession,
  machine?: CodexMachine
): CodexSessionStatus {
  if (machine?.status === 'offline') return 'offline';
  if (machine?.status === 'unavailable') return 'unavailable';
  return session.status;
}

export function sortCodexSessions(sessions: readonly CodexSession[]) {
  return [...sessions].sort((left, right) => {
    const recent = Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt);
    return recent || left.title.localeCompare(right.title);
  });
}

export function groupCodexSessions(
  machines: readonly CodexMachine[],
  sessions: readonly CodexSession[],
  query = ''
): CodexMachineSessionGroup[] {
  const machineById = new Map(machines.map((machine) => [machine.id, machine]));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = sessions.filter((session) => (
    !normalizedQuery || normalizedSearchText(session, machineById.get(session.machineId)).includes(normalizedQuery)
  ));

  return machines.map((machine) => {
    const machineSessions = sortCodexSessions(
      visible.filter((session) => session.machineId === machine.id)
    );
    const loaded = machineSessions.filter((session) => session.loadedByProjectSpace);
    const stored = machineSessions.filter((session) => !session.loadedByProjectSpace);
    const sections: CodexSessionSection[] = [];
    if (loaded.length > 0) {
      sections.push({ id: 'loaded', label: 'Loaded by Project Space', sessions: loaded });
    }
    if (stored.length > 0) {
      sections.push({ id: 'stored', label: 'Stored sessions', sessions: stored });
    }
    return { machine, sections };
  }).filter((group) => group.sections.length > 0 || normalizedQuery.length === 0);
}

export function codexThreadOrigin(session: CodexSession): CodexThreadOrigin {
  return { machineId: session.machineId, threadId: session.threadId };
}

export function codexContinueBlockReason(session: CodexSession, machine?: CodexMachine) {
  const status = effectiveCodexSessionStatus(session, machine);
  switch (status) {
    case 'idle': return undefined;
    case 'active': return 'This task is still working; a new turn can start when it becomes idle.';
    case 'archived': return 'Archived threads are read-only.';
    case 'missing': return 'This stored thread is no longer available on its machine.';
    case 'offline': return 'The owning machine is offline.';
    case 'unavailable': return 'Codex is unavailable on the owning machine.';
  }
}

export function formatCodexActivity(isoDate: string, now = new Date()) {
  const elapsedMs = Math.max(0, now.getTime() - Date.parse(isoDate));
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return 'Now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d ago` : new Intl.DateTimeFormat(undefined, {
    day: 'numeric', month: 'short'
  }).format(new Date(isoDate));
}
