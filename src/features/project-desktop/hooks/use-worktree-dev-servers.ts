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
  serverId: string,
  state: WorktreeDevServerRecord['state']
) {
  if (!overview) {
    return overview;
  }

  return {
    ...overview,
    servers: overview.servers.map((server) =>
      server.worktreeId === worktreeId && server.serverId === serverId
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
  const [pendingServerKey, setPendingServerKey] = useState('');
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
    setPendingServerKey('');

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

  const serversForWorktree = useMemo(() => {
    const grouped = new Map<string, WorktreeDevServerRecord[]>();
    for (const server of overview?.servers ?? []) {
      const current = grouped.get(server.worktreeId) ?? [];
      current.push(server);
      grouped.set(server.worktreeId, current);
    }
    return grouped;
  }, [overview?.servers]);
  const serversByWorktreeId = useMemo(
    () => new Map(Array.from(serversForWorktree, ([worktreeId, servers]) => [worktreeId, servers[0]!])),
    [serversForWorktree]
  );

  const start = useCallback(
    async (worktreeId: string, requestedServerId?: string) => {
      if (!machineId) {
        return;
      }

      const serverId = requestedServerId ?? serversByWorktreeId.get(worktreeId)?.serverId;
      if (!serverId) {
        setError('No trusted development server is declared for this worktree.');
        return;
      }
      const requestKey = targetKey;
      setPendingServerKey(`${worktreeId}\u0000${serverId}`);
      setOverview((current) => withOptimisticState(current, worktreeId, serverId, 'starting'));
      try {
        const result = await projectSpaceClient.startDevServer({
          machineId,
          projectId,
          serverId,
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
          setPendingServerKey('');
        }
      }
    },
    [machineId, projectId, refresh, serversByWorktreeId, targetKey]
  );

  const stop = useCallback(
    async (worktreeId: string, requestedServerId?: string) => {
      if (!machineId) {
        return;
      }

      const serverId = requestedServerId ?? serversByWorktreeId.get(worktreeId)?.serverId;
      if (!serverId) {
        setError('No trusted development server is declared for this worktree.');
        return;
      }
      const requestKey = targetKey;
      setPendingServerKey(`${worktreeId}\u0000${serverId}`);
      setOverview((current) => withOptimisticState(current, worktreeId, serverId, 'stopping'));
      try {
        const result = await projectSpaceClient.stopDevServer({
          machineId,
          projectId,
          serverId,
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
          setPendingServerKey('');
        }
      }
    },
    [machineId, projectId, refresh, serversByWorktreeId, targetKey]
  );

  const updateSettings = useCallback(
    async ({ allowedHosts }: Pick<ProjectRunSettingsRecord, 'allowedHosts'>) => {
      if (!machineId) {
        return;
      }

      const requestKey = targetKey;
      setIsSavingSettings(true);
      try {
        const settings = await projectSpaceClient.updateProjectRunSettings({
          allowedHosts,
          machineId,
          projectId
        });
        if (targetKeyRef.current === requestKey) {
          setOverview((current) => current ? { ...current, settings } : current);
          setError('');
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
    [machineId, projectId, targetKey]
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
    pendingServerKey,
    pendingWorktreeId: pendingServerKey.split('\u0000')[0] ?? '',
    refresh,
    serversByWorktreeId,
    serversForWorktree,
    settings: overview?.settings,
    start,
    stop,
    updateSettings
  };
}
