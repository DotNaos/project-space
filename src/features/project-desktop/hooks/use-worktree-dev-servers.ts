import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { projectSpaceClient } from '@/api/project-space-client';
import type {
  DevServerOverviewResult,
  ProjectRunSettingsRecord,
  WorktreeDevServerRecord
} from '@/shared/project-space-api';
import {
  startDevServerBatch,
  type DevServerBatchStartResult
} from '../components/worktree-runtime-model';

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
  branchName,
  machineId,
  preferBase,
  projectId,
  worktreeIds
}: {
  branchName?: string;
  machineId?: string;
  preferBase?: boolean;
  projectId: string;
  worktreeIds?: string[];
}) {
  const [overview, setOverview] = useState<DevServerOverviewResult>();
  const [error, setError] = useState('');
  const [isChecking, setIsChecking] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isStartingAll, setIsStartingAll] = useState(false);
  const [pendingServerKey, setPendingServerKey] = useState('');
  const [startAllResults, setStartAllResults] = useState<DevServerBatchStartResult[]>([]);
  const [stateTargetKey, setStateTargetKey] = useState('');
  const requestSequence = useRef(0);
  const startingAllKeyRef = useRef('');
  const worktreeKey = worktreeIds?.join('\u0001') ?? branchName ?? (preferBase ? 'base' : '*');
  const targetKey = `${machineId ?? ''}\u0000${projectId}\u0000${worktreeKey}`;
  const targetKeyRef = useRef(targetKey);
  targetKeyRef.current = targetKey;
  const scopedOverview = stateTargetKey === targetKey ? overview : undefined;

  const refresh = useCallback(async () => {
    if (!machineId || !projectId || worktreeIds?.length === 0) {
      setStateTargetKey(targetKey);
      setOverview(undefined);
      setIsChecking(false);
      return undefined;
    }

    const requestKey = targetKey;
    const sequence = ++requestSequence.current;
    setStateTargetKey(requestKey);
    setIsChecking(true);
    try {
      const result = await projectSpaceClient.inspectDevServers({
        ...(branchName ? { branchName } : {}),
        machineId,
        ...(preferBase ? { preferBase: true } : {}),
        projectId,
        ...(worktreeIds ? { worktreeIds } : {})
      });
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
      setError(message);
      return undefined;
    } finally {
      if (sequence === requestSequence.current && targetKeyRef.current === requestKey) {
        setIsChecking(false);
      }
    }
  }, [branchName, machineId, preferBase, projectId, targetKey, worktreeIds]);

  useEffect(() => {
    let canceled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    setOverview(undefined);
    setStateTargetKey(targetKey);
    setIsChecking(false);
    if (startingAllKeyRef.current !== targetKey) startingAllKeyRef.current = '';
    setError('');
    setPendingServerKey('');
    setIsStartingAll(false);
    setStartAllResults([]);

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
    for (const server of scopedOverview?.servers ?? []) {
      const current = grouped.get(server.worktreeId) ?? [];
      current.push(server);
      grouped.set(server.worktreeId, current);
    }
    return grouped;
  }, [scopedOverview?.servers]);
  const serversByWorktreeId = useMemo(
    () => new Map(Array.from(serversForWorktree, ([worktreeId, servers]) => [worktreeId, servers[0]!])),
    [serversForWorktree]
  );

  const startOne = useCallback(
    async (worktreeId: string, requestedServerId?: string) => {
      if (!machineId) {
        return { message: 'No connector machine is selected.', status: 'failed' as const };
      }

      const serverId = requestedServerId ?? serversByWorktreeId.get(worktreeId)?.serverId;
      if (!serverId) {
        setError('No trusted development server is declared for this worktree.');
        return {
          message: 'No trusted development server is declared for this worktree.',
          status: 'failed' as const
        };
      }
      const requestKey = targetKey;
      setPendingServerKey(`${worktreeId}\u0000${serverId}`);
      setOverview((current) => withOptimisticState(current, worktreeId, serverId, 'starting'));
      try {
        const result = await projectSpaceClient.startDevServer({
          ...(branchName ? { branchName } : {}),
          machineId,
          ...(preferBase ? { preferBase: true } : {}),
          projectId,
          serverId,
          worktreeId,
          ...(worktreeIds ? { worktreeIds } : {})
        });
        if (
          targetKeyRef.current === requestKey &&
          result.machineId === machineId &&
          result.projectId === projectId
        ) {
          setOverview(result);
          setError('');
          return { status: 'started' as const };
        }
        return { message: 'The selected machine changed before the server started.', status: 'failed' as const };
      } catch (nextError) {
        const message =
          nextError instanceof Error ? nextError.message : 'Could not start the development server.';
        if (targetKeyRef.current === requestKey) {
          await refresh();
          if (targetKeyRef.current === requestKey) setError(message);
        }
        return { message, status: 'failed' as const };
      } finally {
        if (targetKeyRef.current === requestKey) {
          setPendingServerKey('');
        }
      }
    },
    [branchName, machineId, preferBase, projectId, refresh, serversByWorktreeId, targetKey, worktreeIds]
  );

  const start = useCallback(
    async (worktreeId: string, requestedServerId?: string) => {
      if (startingAllKeyRef.current) {
        return { message: 'Wait for Start all to finish.', status: 'failed' as const };
      }
      setStartAllResults([]);
      await startOne(worktreeId, requestedServerId);
    },
    [startOne]
  );

  const startAll = useCallback(
    async (servers: WorktreeDevServerRecord[]) => {
      if (!machineId || startingAllKeyRef.current || servers.length === 0) {
        return [];
      }
      const requestKey = targetKey;
      startingAllKeyRef.current = requestKey;
      setIsStartingAll(true);
      setStartAllResults([]);
      setError('');
      try {
        const results = await startDevServerBatch(
          servers,
          async (server) => {
            if (targetKeyRef.current !== requestKey) {
              return { message: 'The selected machine changed.', status: 'failed' as const };
            }
            return startOne(server.worktreeId, server.serverId);
          },
          (progress) => {
            if (targetKeyRef.current === requestKey) setStartAllResults(progress);
          }
        );
        if (targetKeyRef.current === requestKey) {
          const failures = results.filter((result) => result.status === 'failed').length;
          setError(
            failures > 0
              ? `${results.length - failures} development server${results.length - failures === 1 ? '' : 's'} started; ${failures} failed.`
              : ''
          );
        }
        return results;
      } finally {
        if (startingAllKeyRef.current === requestKey) {
          startingAllKeyRef.current = '';
        }
        if (targetKeyRef.current === requestKey) {
          setIsStartingAll(false);
        }
      }
    },
    [machineId, startOne, targetKey]
  );

  const stop = useCallback(
    async (worktreeId: string, requestedServerId?: string) => {
      if (startingAllKeyRef.current) {
        return;
      }
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
          ...(branchName ? { branchName } : {}),
          machineId,
          ...(preferBase ? { preferBase: true } : {}),
          projectId,
          serverId,
          worktreeId,
          ...(worktreeIds ? { worktreeIds } : {})
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
          const message = nextError instanceof Error
            ? nextError.message
            : 'Could not stop the development server.';
          await refresh();
          if (targetKeyRef.current === requestKey) setError(message);
        }
      } finally {
        if (targetKeyRef.current === requestKey) {
          setPendingServerKey('');
        }
      }
    },
    [branchName, machineId, preferBase, projectId, refresh, serversByWorktreeId, targetKey, worktreeIds]
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
    scopedOverview?.servers.some(
      (server) => server.state === 'starting' || server.state === 'running' || server.state === 'stopping'
    )
  );

  return {
    access: scopedOverview?.access,
    error: stateTargetKey === targetKey ? error || scopedOverview?.message || '' : '',
    hasActiveServers,
    isChecking: stateTargetKey === targetKey ? isChecking : Boolean(machineId && projectId),
    isSavingSettings,
    isStartingAll,
    pendingServerKey,
    pendingWorktreeId: pendingServerKey.split('\u0000')[0] ?? '',
    refresh,
    serversByWorktreeId,
    serversForWorktree,
    settings: scopedOverview?.settings,
    start,
    startAll,
    startAllResults,
    stop,
    updateSettings
  };
}
