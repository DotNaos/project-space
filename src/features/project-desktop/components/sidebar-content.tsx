import { memo } from 'react';
import type {
  ExplorerTarget,
  ProjectSpaceRecord,
  ProjectWorktreeRecord
} from '@/shared/electron-api';
import { FileExplorer } from './file-explorer';
import type { SidebarView } from './sidebar-view-tabs';
import { WorkflowExplorer } from './workflow-explorer';

interface SidebarContentProps {
  onSelectWorkspace(): void;
  onSelectWorktree(worktreeId: string): void;
  project?: ProjectSpaceRecord;
  selectedExplorerTarget: ExplorerTarget;
  sidebarView: SidebarView;
  worktrees: ProjectWorktreeRecord[];
}

export const SidebarContent = memo(function SidebarContent({
  onSelectWorkspace,
  onSelectWorktree,
  project,
  selectedExplorerTarget,
  sidebarView,
  worktrees
}: SidebarContentProps) {
  if (sidebarView === 'workspace') {
    return (
      <WorkflowExplorer
        onSelectWorkspace={onSelectWorkspace}
        project={project}
        selectedExplorerTarget={selectedExplorerTarget}
        worktrees={worktrees}
        onSelectWorktree={onSelectWorktree}
      />
    );
  }

  const rootPath =
    selectedExplorerTarget.kind === 'worktree'
      ? worktrees.find((entry) => entry.id === selectedExplorerTarget.worktreeId)?.path ??
        project?.rootPath
      : project?.rootPath;

  return <FileExplorer rootPath={rootPath} />;
});
