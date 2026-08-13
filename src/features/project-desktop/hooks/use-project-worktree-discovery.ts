import { useCallback, useEffect, useState } from 'react';
import type {
  ExplorerTarget,
  ProjectSpaceRecord,
  ProjectWorktreeDiscoveryState
} from '@/shared/project-space-api';

export function useProjectWorktreeDiscovery({
  project,
  selectedTarget,
  setSelectedTarget
}: {
  project?: ProjectSpaceRecord;
  selectedTarget: ExplorerTarget;
  setSelectedTarget(target: ExplorerTarget): void;
}) {
  const scope = project?.id ?? '';
  const [discoveries, setDiscoveries] = useState<
    Record<string, ProjectWorktreeDiscoveryState>
  >({});
  const discovery: ProjectWorktreeDiscoveryState = discoveries[scope] ?? { state: 'checking' };

  const load = useCallback(async () => {
    if (!project) return undefined;
    const requestScope = project.id;
    const blocked: ProjectWorktreeDiscoveryState = {
      checkedAt: new Date().toISOString(),
      message: 'Workspace Runtime is unavailable. Open Compute to connect a canonical runtime.',
      reason: 'canonical-runtime-required',
      state: 'blocked'
    };
    setDiscoveries((current) => ({ ...current, [requestScope]: blocked }));
    return blocked;
  }, [project]);

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
