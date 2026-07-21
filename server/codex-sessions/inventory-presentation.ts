import type {
  CodexSessionListRequest,
  CodexSessionListResult,
  CodexSessionMachineRecord,
  CodexSessionRecord
} from '../../src/shared/codex-sessions-api';

export function filterCodexSessionInventory(
  inventory: CodexSessionListResult,
  request: CodexSessionListRequest
) {
  const search = request.search?.trim().toLocaleLowerCase();
  return {
    ...inventory,
    sessions: inventory.sessions
      .filter((session) => request.includeArchived || !session.archived)
      .filter((session) => !search || [session.title, session.cwd, session.project, session.model]
        .some((value) => value?.toLocaleLowerCase().includes(search)))
      .sort((left, right) => Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt))
  };
}

export function asLiveCodexSessionInventory(
  inventory: CodexSessionListResult
): CodexSessionListResult {
  return {
    ...inventory,
    inventoryState: 'live'
  };
}

export function asOfflineCodexSessionInventory(
  machine: CodexSessionMachineRecord,
  sessions: CodexSessionRecord[],
  now: () => Date
): CodexSessionListResult {
  const checkedAt = now().toISOString();
  return {
    checkedAt,
    inventoryState: 'stale',
    machine: {
      ...machine,
      online: false,
      statusMessage: 'The connector is offline. Showing the last saved session inventory.'
    },
    publishedAt: checkedAt,
    sessions: sessions.map((session) => ({
      ...session,
      loadedByProjectSpace: false,
      status: 'offline'
    }))
  };
}
