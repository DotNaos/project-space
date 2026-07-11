import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { projectSpaceClient } from '@/api/project-space-client';
import type {
  DevServerOverviewResult,
  ProjectRunSettingsRecord,
  WorktreeDevServerRecord
} from '@/shared/project-space-api';

const stablePollMs = 10_000;
const transitionPollMs = 2_000;

function withOptimisticState(
  overview: DevServerOverviewResult | undefined,
  worktreeId: string,
  state: WorktreeDevServerRecord['state']
) {
  if (!overview) {
    return overview;
  }

  return {
    ...overview,
    servers: overview.servers.map((server) =>
      server.worktreeId === worktreeId
        ? { ...server, checkedAt: new Date().toISOString(), lastError: undefined, state }
        : server
    )
  };
}

export function useWorktreeDevServers({
  machineId,
  projectId
}: {
  machineId?: string;
  projectId: string;
}) {
  const [overview, setOverview] = useState<DevServerOverviewResult>();
  const [error, setError] = useState('');
  const [isChecking, setIsChecking] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [pendingWorktreeId, setPendingWorktreeId] = useState('');
  const requestSequence = useRef(0);
  const targetKey = `${machineId ?? ''}\u0000${projectId}`;
  const targetKeyRef = useRef(targetKey);
  targetKeyRef.current = targetKey;

  const refresh = useCallback(async () => {
    if (!machineId || !projectId) {
      setOverview(undefined);
      return undefined;
    }

    const requestKey = targetKey;
    const sequence = ++requestSequence.current;
    setIsChecking(true);
    try {
      const result = await projectSpaceClient.inspectDevServers({ machineId, projectId });
      if (
        targetKeyRef.current !== requestKey ||
        result.machineId !== machineId ||
        result.projectId !== projectId
      ) {
        return undefined;
      }
      setOverview(result);
      setError('');
      return result;
    } catch (nextError) {
      if (targetKeyRef.current !== requestKey) {
        return undefined;
      }
      const message =
        nextError instanceof Error ? nextError.message : 'Could not inspect development servers.';
      setOverview(undefined);
      setError(message);
      return undefined;
    } finally {
      if (sequence === requestSequence.current && targetKeyRef.current === requestKey) {
        setIsChecking(false);
      }
    }
  }, [machineId, projectId, targetKey]);

  useEffect(() => {
    let canceled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    setOverview(undefined);
    setError('');
    setPendingWorktreeId('');

    async function poll() {
      const result = await refresh();
      if (canceled) {
        return;
      }

      const isTransitioning = result?.servers.some(
        (server) => server.state === 'starting' || server.state === 'stopping'
      );
      timer = setTimeout(poll, isTransitioning ? transitionPollMs : stablePollMs);
    }

    void poll();

    return () => {
      canceled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [refresh]);

  const serversByWorktreeId = useMemo(
    () => new Map(overview?.servers.map((server) => [server.worktreeId, server]) ?? []),
    [overview?.servers]
  );

  const start = useCallback(
    async (worktreeId: string) => {
      if (!machineId) {
        return;
      }

      const requestKey = targetKey;
      setPendingWorktreeId(worktreeId);
      setOverview((current) => withOptimisticState(current, worktreeId, 'starting'));
      try {
        const result = await projectSpaceClient.startDevServer({
          machineId,
          projectId,
          worktreeId
        });
        if (
          targetKeyRef.current === requestKey &&
          result.machineId === machineId &&
          result.projectId === projectId
        ) {
          setOverview(result);
          setError('');
        }
      } catch (nextError) {
        if (targetKeyRef.current === requestKey) {
          setError(
            nextError instanceof Error ? nextError.message : 'Could not start the development server.'
          );
          await refresh();
        }
      } finally {
        if (targetKeyRef.current === requestKey) {
          setPendingWorktreeId('');
        }
      }
    },
    [machineId, projectId, refresh, targetKey]
  );

  const stop = useCallback(
    async (worktreeId: string) => {
      if (!machineId) {
        return;
      }

      const requestKey = targetKey;
      setPendingWorktreeId(worktreeId);
      setOverview((current) => withOptimisticState(current, worktreeId, 'stopping'));
      try {
        const result = await projectSpaceClient.stopDevServer({
          machineId,
          projectId,
          worktreeId
        });
        if (
          targetKeyRef.current === requestKey &&
          result.machineId === machineId &&
          result.projectId === projectId
        ) {
          setOverview(result);
          setError('');
        }
      } catch (nextError) {
        if (targetKeyRef.current === requestKey) {
          setError(
            nextError instanceof Error ? nextError.message : 'Could not stop the development server.'
          );
          await refresh();
        }
      } finally {
        if (targetKeyRef.current === requestKey) {
          setPendingWorktreeId('');
        }
      }
    },
    [machineId, projectId, refresh, targetKey]
  );

  const updateSettings = useCallback(
    async ({ allowedHosts, runTarget }: Pick<ProjectRunSettingsRecord, 'allowedHosts' | 'runTarget'>) => {
      if (!machineId) {
        return;
      }

      const requestKey = targetKey;
      setIsSavingSettings(true);
      try {
        const settings = await projectSpaceClient.updateProjectRunSettings({
          allowedHosts,
          machineId,
          projectId,
          runTarget
        });
        if (targetKeyRef.current === requestKey) {
          setOverview((current) => current ? { ...current, settings } : current);
          setError('');
          await refresh();
        }
      } catch (nextError) {
        if (targetKeyRef.current === requestKey) {
          setError(
            nextError instanceof Error ? nextError.message : 'Could not save dev-server settings.'
          );
          throw nextError;
        }
      } finally {
        if (targetKeyRef.current === requestKey) {
          setIsSavingSettings(false);
        }
      }
    },
    [machineId, projectId, refresh, targetKey]
  );

  const hasActiveServers = Boolean(
    overview?.servers.some(
      (server) => server.state === 'starting' || server.state === 'running' || server.state === 'stopping'
    )
  );

  return {
    access: overview?.access,
    error: error || overview?.message || '',
    hasActiveServers,
    isChecking,
    isSavingSettings,
    pendingWorktreeId,
    refresh,
    serversByWorktreeId,
    settings: overview?.settings,
    start,
    stop,
    updateSettings
  };
}
