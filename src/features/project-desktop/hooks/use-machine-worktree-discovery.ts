import { useEffect, useState } from 'react';
import { projectSpaceClient } from '@/api/project-space-client';
import type { ProjectWorktreeRecord } from '@/shared/project-space-api';

export type MachineWorktreeInfo = ProjectWorktreeRecord;

export interface MachineWorktreeState {
  error?: string;
  scope: string;
  state: 'blocked' | 'proven-empty' | 'ready';
  worktrees: MachineWorktreeInfo[];
}

export interface MachineWorktreeDiscoveryTarget {
  blockedMessage?: string;
  machineId: string;
  projectId?: string;
}

export function useMachineWorktreeDiscovery(targets: MachineWorktreeDiscoveryTarget[]) {
  const [states, setStates] = useState<Record<string, MachineWorktreeState>>({});
  const scopes = Object.fromEntries(
    targets.map((target) => [target.machineId, `${target.projectId ?? ''}:${target.machineId}`])
  );

  useEffect(() => {
    let canceled = false;
    void Promise.all(
      targets
        .filter((target) => target.projectId)
        .map(async (target) => {
          if (target.blockedMessage) {
            return {
              key: target.machineId,
              state: {
                error: target.blockedMessage,
                scope: `${target.projectId ?? ''}:${target.machineId}`,
                state: 'blocked' as const,
                worktrees: []
              }
            };
          }

          const discovery = await projectSpaceClient
            .discoverProjectWorktrees(target.projectId!, target.machineId)
            .catch((error) => ({
              checkedAt: new Date().toISOString(),
              message:
                error instanceof Error ? error.message : 'Worktree discovery request failed.',
              reason: 'request-failed' as const,
              state: 'blocked' as const
            }));

          return {
            key: target.machineId,
            state:
              discovery.state === 'ready'
                ? {
                    scope: `${target.projectId}:${target.machineId}`,
                    state: 'ready' as const,
                    worktrees: discovery.worktrees
                  }
                : discovery.state === 'proven-empty'
                  ? {
                      scope: `${target.projectId}:${target.machineId}`,
                      state: 'proven-empty' as const,
                      worktrees: []
                    }
                  : {
                      error: discovery.message,
                      scope: `${target.projectId}:${target.machineId}`,
                      state: 'blocked' as const,
                      worktrees: []
                    }
          };
        })
    ).then((results) => {
      if (!canceled) setStates(Object.fromEntries(results.map((result) => [result.key, result.state])));
    });

    return () => {
      canceled = true;
    };
  }, [targets]);

  return Object.fromEntries(
    targets.flatMap((target) => {
      const state = states[target.machineId];
      return state?.scope === scopes[target.machineId] ? [[target.machineId, state]] : [];
    })
  );
}
