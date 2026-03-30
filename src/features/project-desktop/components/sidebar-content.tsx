import { memo } from 'react';
import type {
  ExplorerTarget,
  ProjectSpaceRecord,
  ProjectWorktreeRecord
} from '@/shared/electron-api';
import { WorkflowExplorer } from './workflow-explorer';
import type { ProjectMainView } from './project-main-panel';
import type { IdeaPresentationRecord } from '../lib/idea-utils';

interface SidebarContentProps {
  isInteractive?: boolean;
  isAppLoading?: boolean;
  isWorktreesLoading?: boolean;
  mainView: ProjectMainView;
  onCreateIdea(): void;
  onDeleteIdea(ideaId: string): void;
  onMoveIdeaToWorktree(ideaId: string, targetWorktreeId?: string): void;
  onOpenIdeasView(): void;
  onOpenNewWorktree(): void;
  onOpenWorktreeInApp(worktreeId: string): void;
  onOpenWorktreesView(): void;
  onSelectIdea(ideaId: string): void;
  onSelectWorkspace(): void;
  onSelectWorktree(worktreeId: string): void;
  project?: ProjectSpaceRecord;
  selectedExplorerTarget: ExplorerTarget;
  selectedIdeaId: string;
  unassignedIdeas: IdeaPresentationRecord[];
  worktreeIdeasById: Record<string, IdeaPresentationRecord[]>;
  worktrees: ProjectWorktreeRecord[];
}

export const SidebarContent = memo(function SidebarContent({
  isInteractive = true,
  isAppLoading = false,
  isWorktreesLoading = false,
  mainView,
  onCreateIdea,
  onDeleteIdea,
  onMoveIdeaToWorktree,
  onOpenIdeasView,
  onOpenNewWorktree,
  onOpenWorktreeInApp,
  onOpenWorktreesView,
  onSelectIdea,
  onSelectWorkspace,
  onSelectWorktree,
  project,
  selectedExplorerTarget,
  selectedIdeaId,
  unassignedIdeas,
  worktreeIdeasById,
  worktrees
}: SidebarContentProps) {
  return (
    <WorkflowExplorer
      isInteractive={isInteractive}
      isAppLoading={isAppLoading}
      isWorktreesLoading={isWorktreesLoading}
      mainView={mainView}
      onCreateIdea={onCreateIdea}
      onDeleteIdea={onDeleteIdea}
      onMoveIdeaToWorktree={onMoveIdeaToWorktree}
      onOpenIdeasView={onOpenIdeasView}
      onOpenNewWorktree={onOpenNewWorktree}
      onOpenWorktreeInApp={onOpenWorktreeInApp}
      onOpenWorktreesView={onOpenWorktreesView}
      onSelectIdea={onSelectIdea}
      onSelectWorkspace={onSelectWorkspace}
      project={project}
      selectedExplorerTarget={selectedExplorerTarget}
      selectedIdeaId={selectedIdeaId}
      unassignedIdeas={unassignedIdeas}
      worktreeIdeasById={worktreeIdeasById}
      worktrees={worktrees}
      onSelectWorktree={onSelectWorktree}
    />
  );
});
