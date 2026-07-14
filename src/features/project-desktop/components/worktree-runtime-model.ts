import type {
  ProjectWorktreeRecord,
  WorktreeDevServerRecord
} from '../../../shared/project-space-api';
import type { WorktreeSetupResult } from '../../../shared/worktree-action-api';

export interface WorktreeRuntimeRow {
  label: string;
  worktree: ProjectWorktreeRecord;
}

export interface DevServerBatchStartResult {
  key: string;
  message?: string;
  serverLabel: string;
  status: 'started' | 'failed';
}

export function runtimeRowsForWorktrees(worktrees: ProjectWorktreeRecord[]): WorktreeRuntimeRow[] {
  return worktrees.map((worktree) => ({
    label: worktree.branchName ?? worktree.name,
    worktree
  }));
}

export function unmaterializedBranchesFor(
  branchNames: string[],
  worktrees: ProjectWorktreeRecord[]
) {
  const localBranches = new Set(
    worktrees.flatMap((worktree) => (worktree.branchName ? [worktree.branchName] : []))
  );
  return branchNames.filter((branchName) => !localBranches.has(branchName));
}

export function devServerKey(server: Pick<WorktreeDevServerRecord, 'serverId' | 'worktreeId'>) {
  return `${server.worktreeId}\u0000${server.serverId}`;
}

export function startableDevServers(
  servers: WorktreeDevServerRecord[],
  worktrees: ProjectWorktreeRecord[],
  setupResults: Map<string, WorktreeSetupResult>
) {
  const readyWorktrees = new Set(
    worktrees.filter((worktree) => worktree.status === 'ready').map((worktree) => worktree.id)
  );
  const seen = new Set<string>();
  return servers.filter((server) => {
    const key = devServerKey(server);
    const setup = setupResults.get(server.worktreeId);
    const setupReady =
      setup?.capability === 'unavailable' ||
      Boolean(setup && setup.steps.every((step) => step.state === 'ready'));
    const startable =
      readyWorktrees.has(server.worktreeId) &&
      setupReady &&
      server.capability === 'configured' &&
      (server.state === 'stopped' || server.state === 'error') &&
      !seen.has(key);
    if (startable) seen.add(key);
    return startable;
  });
}

export async function startDevServerBatch(
  servers: WorktreeDevServerRecord[],
  start: (
    server: WorktreeDevServerRecord
  ) => Promise<Pick<DevServerBatchStartResult, 'message' | 'status'>>,
  onProgress?: (results: DevServerBatchStartResult[]) => void
) {
  const results: DevServerBatchStartResult[] = [];
  for (const server of servers) {
    let outcome: Pick<DevServerBatchStartResult, 'message' | 'status'>;
    try {
      outcome = await start(server);
    } catch (error) {
      outcome = {
        message: error instanceof Error ? error.message : 'Could not start the development server.',
        status: 'failed'
      };
    }
    results.push({
      key: devServerKey(server),
      message: outcome.message,
      serverLabel: server.serverLabel,
      status: outcome.status
    });
    onProgress?.([...results]);
  }
  return results;
}
