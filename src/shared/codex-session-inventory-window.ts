import type { CodexSessionListResult } from './codex-sessions-api';

export const CODEX_SESSION_LIST_DEADLINE_MS = 28_000;
export const CODEX_SESSION_INVENTORY_EVIDENCE_MAX_AGE_MS = 15_000;
export const CODEX_SESSION_INVENTORY_CLOCK_SKEW_MS = 5_000;

export interface CodexSessionInventoryWindow {
  ageMs: number;
  inventory: CodexSessionListResult;
}

export function localizeCodexSessionInventoryWindow(
  inventory: CodexSessionListResult,
  options: {
    elapsedMs: number;
    machineId: string;
    publishedAt: string;
  }
): CodexSessionInventoryWindow | undefined {
  if (
    inventory.machine.id !== options.machineId
    || inventory.sessions.some((session) => session.machineId !== options.machineId)
  ) return undefined;

  const sourceCheckedAt = Date.parse(inventory.checkedAt);
  const sourcePublishedAt = Date.parse(inventory.publishedAt ?? inventory.checkedAt);
  const localizedPublishedAt = Date.parse(options.publishedAt);
  const elapsedMs = Math.ceil(options.elapsedMs);
  if (
    ![sourceCheckedAt, sourcePublishedAt, localizedPublishedAt, elapsedMs].every(Number.isFinite)
    || sourcePublishedAt < sourceCheckedAt
    || elapsedMs < 0
  ) return undefined;

  const ageMs = Math.max(elapsedMs, sourcePublishedAt - sourceCheckedAt);
  const localizedCheckedAt = localizedPublishedAt - ageMs;
  const localizedDate = new Date(localizedCheckedAt);
  if (!Number.isFinite(localizedDate.getTime())) return undefined;

  return {
    ageMs,
    inventory: {
      ...inventory,
      checkedAt: localizedDate.toISOString(),
      publishedAt: options.publishedAt
    }
  };
}
