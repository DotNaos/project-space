import { memo } from 'react';
import type {
  ExplorerTarget,
  ProjectSpaceRecord,
  ProjectWorktreeRecord
} from '@/shared/electron-api';
import { WorkflowExplorer } from './workflow-explorer';

interface SidebarContentProps {
  onOpenNewWorktree(): void;
  onSelectWorkspace(): void;
  onSelectWorktree(worktreeId: string): void;
  project?: ProjectSpaceRecord;
  selectedExplorerTarget: ExplorerTarget;
  worktrees: ProjectWorktreeRecord[];
}

export const SidebarContent = memo(function SidebarContent({
  onOpenNewWorktree,
  onSelectWorkspace,
  onSelectWorktree,
  project,
  selectedExplorerTarget,
  worktrees
}: SidebarContentProps) {
  return (
    <WorkflowExplorer
      onOpenNewWorktree={onOpenNewWorktree}
      onSelectWorkspace={onSelectWorkspace}
      project={project}
      selectedExplorerTarget={selectedExplorerTarget}
      worktrees={worktrees}
      onSelectWorktree={onSelectWorktree}
    />
  );
});
