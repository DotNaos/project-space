import type {
  ExplorerTarget,
  ProjectWorktreeRecord
} from '@/shared/project-space-api';

export function selectedProjectWorktree(
  worktrees: ProjectWorktreeRecord[],
  target: ExplorerTarget
) {
  return target.kind === 'worktree'
    ? worktrees.find((worktree) => worktree.id === target.worktreeId)
    : (worktrees.find((worktree) => worktree.isBase) ?? worktrees[0]);
}

export function selectedWorktreeExplorerPath(worktree: ProjectWorktreeRecord | undefined) {
  return worktree?.status === 'ready' ? worktree.path : '';
}
