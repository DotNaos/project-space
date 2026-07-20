import { useCallback, useEffect, useState } from 'react';

const selectionParameter = 'roadmapIssue';
const selectionStateKey = 'projectSpaceRoadmapSelection';

export function roadmapSelectedIssueId(search: string) {
  const raw = new URLSearchParams(search).get(selectionParameter);
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function roadmapSelectionUrl(
  location: Pick<Location, 'hash' | 'pathname' | 'search'>,
  issueId?: number
) {
  const search = new URLSearchParams(location.search);
  if (issueId) search.set(selectionParameter, String(issueId));
  else search.delete(selectionParameter);
  const query = search.toString();
  return `${location.pathname}${query ? `?${query}` : ''}${location.hash}`;
}

export function useRoadmapSelection(repositoryId?: number) {
  const [selectedIssueId, setSelectedIssueId] = useState<number | undefined>(() => (
    typeof window === 'undefined' ? undefined : roadmapSelectedIssueId(window.location.search)
  ));

  useEffect(() => {
    const update = () => setSelectedIssueId(roadmapSelectedIssueId(window.location.search));
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);

  useEffect(() => {
    setSelectedIssueId(roadmapSelectedIssueId(window.location.search));
  }, [repositoryId]);

  const select = useCallback((issueId: number) => {
    if (issueId === selectedIssueId) return;
    window.history.pushState({
      ...(historyRecord(window.history.state) ?? {}),
      [selectionStateKey]: { issueId, repositoryId, version: 1 }
    }, '', roadmapSelectionUrl(window.location, issueId));
    setSelectedIssueId(issueId);
  }, [repositoryId, selectedIssueId]);

  const clear = useCallback(() => {
    const state = historyRecord(window.history.state);
    const nextState = { ...(state ?? {}) };
    delete nextState[selectionStateKey];
    window.history.replaceState(nextState, '', roadmapSelectionUrl(window.location));
    setSelectedIssueId(undefined);
  }, []);

  return { clear, select, selectedIssueId };
}

function historyRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
