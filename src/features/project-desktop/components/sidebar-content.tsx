import { memo } from 'react';
import type {
  ExplorerTarget,
  ProjectSpaceRecord,
  ProjectWorktreeRecord
} from '@/shared/electron-api';
import { WorkflowExplorer } from './workflow-explorer';

interface SidebarContentProps {
  onSelectWorkspace(): void;
  onSelectWorktree(worktreeId: string): void;
  project?: ProjectSpaceRecord;
  selectedExplorerTarget: ExplorerTarget;
  worktrees: ProjectWorktreeRecord[];
}

export const SidebarContent = memo(function SidebarContent({
  onSelectWorkspace,
  onSelectWorktree,
  project,
  selectedExplorerTarget,
  worktrees
}: SidebarContentProps) {
  return (
    <WorkflowExplorer
      onSelectWorkspace={onSelectWorkspace}
      project={project}
      selectedExplorerTarget={selectedExplorerTarget}
      worktrees={worktrees}
      onSelectWorktree={onSelectWorktree}
    />
  );
});
