import { useCallback, useEffect, useRef, useState } from 'react';
import { projectSpaceClient } from '@/api/project-space-client';
import type { PullRequestPreviewInventoryState } from '../components/pull-request-preview-model';

const refreshIntervalMs = 30_000;

export function usePullRequestPreviewStatus({
  enabled = true,
  pullRequestNumber,
  repositoryFullName
}: {
  enabled?: boolean;
  pullRequestNumber?: number;
  repositoryFullName?: string;
}) {
  const identity = repositoryFullName
    ? `${repositoryFullName.toLowerCase()}:${pullRequestNumber ?? 'all'}`
    : '';
  const [inventory, setInventory] = useState<PullRequestPreviewInventoryState>({ state: 'idle' });
  const [isRefreshing, setIsRefreshing] = useState(false);
  const generation = useRef(0);
  const refreshing = useRef(false);
  const lastSafe = useRef<{
    identity: string;
    result: Extract<PullRequestPreviewInventoryState, { state: 'ready' }>['result'];
  } | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (!enabled || !repositoryFullName || !identity || refreshing.current) return;
    const requestGeneration = ++generation.current;
    refreshing.current = true;
    setIsRefreshing(true);
    setInventory((current) => current.state === 'idle' ? { state: 'checking' } : current);
    try {
      const result = await projectSpaceClient.getPullRequestPreviewStatus(
        repositoryFullName,
        pullRequestNumber
      );
      if (generation.current !== requestGeneration) return;
      if (result.status === 'available') {
        lastSafe.current = { identity, result };
        setInventory({ result, state: 'ready' });
      } else if (lastSafe.current?.identity === identity) {
        setInventory({
          lastSafeAt: lastSafe.current.result.checkedAt,
          reason: result.status === 'unauthorized'
            ? 'Preview status is no longer authorized.'
            : 'Preview status could not be refreshed.',
          result: lastSafe.current.result,
          state: 'stale'
        });
      } else {
        setInventory({
          reason: result.status === 'unauthorized'
            ? 'This repository is not authorized to read Preview status.'
            : 'Preview status is temporarily unavailable.',
          status: result.status,
          state: 'blocked'
        });
      }
    } catch {
      if (generation.current !== requestGeneration) return;
      if (lastSafe.current?.identity === identity) {
        setInventory({
          lastSafeAt: lastSafe.current.result.checkedAt,
          reason: 'Preview status could not be refreshed.',
          result: lastSafe.current.result,
          state: 'stale'
        });
      } else {
        setInventory({
          reason: 'Preview status is temporarily unavailable.',
          status: 'unavailable',
          state: 'blocked'
        });
      }
    } finally {
      if (generation.current === requestGeneration) {
        refreshing.current = false;
        setIsRefreshing(false);
      }
    }
  }, [enabled, identity, pullRequestNumber, repositoryFullName]);

  useEffect(() => {
    generation.current += 1;
    refreshing.current = false;
    if (!enabled || !identity) {
      setInventory({ state: 'idle' });
      setIsRefreshing(false);
      return;
    }
    if (lastSafe.current?.identity !== identity) lastSafe.current = undefined;
    setInventory({ state: 'checking' });
    void refresh();
    const interval = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, refreshIntervalMs);
    return () => {
      window.clearInterval(interval);
      generation.current += 1;
      refreshing.current = false;
    };
  }, [enabled, identity, refresh]);

  return { inventory, isRefreshing, refresh };
}
