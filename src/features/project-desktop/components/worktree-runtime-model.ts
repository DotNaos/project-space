import type { ProjectWorktreeRecord } from '../../../shared/project-space-api';

export interface WorktreeRuntimeRow {
  label: string;
  worktree: ProjectWorktreeRecord;
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
