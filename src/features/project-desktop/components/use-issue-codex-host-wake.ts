import { useEffect, useMemo, useState } from 'react';
import type { IssueCodexConnectorTarget } from './issue-codex-work-list-model';

export interface IssueCodexOfflineHostGroup {
  key: string;
  name: string;
  targets: IssueCodexConnectorTarget[];
}

export interface IssueCodexHostWakeState {
  message: string;
  phase: 'checking' | 'error' | 'online' | 'unavailable' | 'wakeable' | 'waking';
}

export const canonicalComputeWakeMessage =
  'An exact Environment Instance and Workspace Runtime must be selected in Compute before a project task can start.';

/**
 * Project issue tasks retain their read-only inventory and discussion paths, but
 * cannot wake or reinterpret a legacy machine target. Runtime actions belong to
 * the canonical Compute flow until exact Environment/Workspace Runtime identity
 * is available here.
 */
export function useIssueCodexHostWake({
  groups,
  isOpen
}: {
  groups: IssueCodexOfflineHostGroup[];
  isOpen: boolean;
}) {
  const [states, setStates] = useState<Record<string, IssueCodexHostWakeState>>({});
  const scope = useMemo(() => groups.map((group) => [
    group.key,
    group.name,
    group.targets.map((target) => target.connectorId)
  ]), [groups]);
  const scopeKey = JSON.stringify(scope);

  useEffect(() => {
    if (!isOpen || groups.length === 0) return;
    setStates(Object.fromEntries(groups.map((group) => [group.key, {
      message: canonicalComputeWakeMessage,
      phase: 'unavailable' as const
    }])));
  // The serialized scope deliberately avoids restarting state for equivalent render objects.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, scopeKey]);

  async function wake(group: IssueCodexOfflineHostGroup) {
    setStates((current) => ({
      ...current,
      [group.key]: { message: canonicalComputeWakeMessage, phase: 'error' }
    }));
    return undefined;
  }

  return { states, wake };
}
