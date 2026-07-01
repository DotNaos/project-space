import { memo } from 'react';
import type {
  ExplorerTarget,
  ProjectSpaceRecord,
  ProjectWorktreeRecord
} from '@/shared/project-space-api';
import { FileExplorer } from './file-explorer';
import { WorkflowExplorer } from './workflow-explorer';

export type SidebarView = 'workspace' | 'files';

interface SidebarContentProps {
  onOpenNewWorktree(): void;
  onSelectWorkspace(): void;
  onSelectWorktree(worktreeId: string): void;
  onSidebarViewChange(nextView: SidebarView): void;
  project?: ProjectSpaceRecord;
  selectedExplorerTarget: ExplorerTarget;
  sidebarView: SidebarView;
  worktrees: ProjectWorktreeRecord[];
}

export const SidebarContent = memo(function SidebarContent({
  onOpenNewWorktree,
  onSelectWorkspace,
  onSelectWorktree,
  onSidebarViewChange,
  project,
  selectedExplorerTarget,
  sidebarView,
  worktrees
}: SidebarContentProps) {
  if (sidebarView === 'workspace') {
    return (
      <WorkflowExplorer
        onOpenFiles={() => onSidebarViewChange('files')}
        onOpenNewWorktree={onOpenNewWorktree}
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

  return <FileExplorer rootPath={rootPath} onBack={() => onSidebarViewChange('workspace')} />;
});
