import { useCallback, useEffect, useRef, useState } from 'react';
import { projectSpaceClient } from '@/api/project-space-client';
import type {
  ExplorerTarget,
  ProjectSpaceRecord,
  ProjectWorktreeDiscoveryState
} from '@/shared/project-space-api';

function blockedRequest(error: unknown): ProjectWorktreeDiscoveryState {
  return {
    checkedAt: new Date().toISOString(),
    message: error instanceof Error ? error.message : 'Worktree discovery request failed.',
    reason: 'request-failed',
    state: 'blocked'
  };
}

export function useProjectWorktreeDiscovery({
  machineId,
  project,
  selectedTarget,
  setSelectedTarget
}: {
  machineId: string;
  project?: ProjectSpaceRecord;
  selectedTarget: ExplorerTarget;
  setSelectedTarget(target: ExplorerTarget): void;
}) {
  const scope = project
    ? `${project.id}:${project.machineId ?? machineId}`
    : '';
  const [discoveries, setDiscoveries] = useState<
    Record<string, ProjectWorktreeDiscoveryState>
  >({});
  const requestGenerations = useRef<Record<string, number>>({});
  const discovery: ProjectWorktreeDiscoveryState = discoveries[scope] ?? { state: 'checking' };

  const load = useCallback(async () => {
    if (!project) return undefined;
    const requestScope = `${project.id}:${project.machineId ?? machineId}`;
    const generation = (requestGenerations.current[requestScope] ?? 0) + 1;
    requestGenerations.current[requestScope] = generation;

    try {
      const next = await projectSpaceClient.discoverProjectWorktrees(
        project.id,
        project.machineId ?? (machineId || undefined)
      );
      if (requestGenerations.current[requestScope] === generation) {
        setDiscoveries((current) => ({ ...current, [requestScope]: next }));
      }
      return next;
    } catch (error) {
      const blocked = blockedRequest(error);
      if (requestGenerations.current[requestScope] === generation) {
        setDiscoveries((current) => ({ ...current, [requestScope]: blocked }));
      }
      return blocked;
    }
  }, [machineId, project]);

  useEffect(() => {
    if (project) void load();
  }, [load, project]);

  useEffect(() => {
    if (!project && selectedTarget.kind !== 'workspace') {
      setSelectedTarget({ kind: 'workspace' });
    }
  }, [project, selectedTarget.kind, setSelectedTarget]);

  useEffect(() => {
    if (selectedTarget.kind !== 'worktree') return;
    if (
      discovery.state === 'proven-empty' ||
      (discovery.state === 'ready' &&
        !discovery.worktrees.some((entry) => entry.id === selectedTarget.worktreeId))
    ) {
      setSelectedTarget({ kind: 'workspace' });
    }
  }, [discovery, selectedTarget, setSelectedTarget]);

  return {
    discovery,
    refresh: load,
    worktrees: discovery.state === 'ready' ? discovery.worktrees : []
  };
}
