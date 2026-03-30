import type { WheelEvent } from 'react';
import { Button, Surface } from '@heroui/react';
import type { ProjectMainView } from './project-main-panel';
import type {
  ExplorerTarget,
  ProjectGroupRecord,
  ProjectNavigationItem,
  ProjectSpaceRecord,
  ProjectWorktreeRecord
} from '@/shared/electron-api';
import { SidebarContent } from './sidebar-content';
import { SidebarQuickActions } from './sidebar-quick-actions';
import { SpacesDock } from './spaces-dock';
import type { IdeaPresentationRecord } from '../lib/idea-utils';

interface ProjectSidebarPaneProps {
  activeNavigationItemId: string;
  currentPanelRef: React.RefObject<HTMLDivElement | null>;
  groups: ProjectGroupRecord[];
  isAppLoading: boolean;
  isOpen: boolean;
  isPreviewWorktreesLoading: boolean;
  isWorktreesLoading: boolean;
  mainView: ProjectMainView;
  navigationItems: ProjectNavigationItem[];
  onCreateIdea(): void;
  onCreateProject(): void;
  onDeleteIdea(ideaId: string): void;
  onOpenCodexSkills(): void;
  onOpenAppSettings(): void;
  onOpenProjectSettings(): void;
  onOpenWorktreesView(): void;
  onOpenNewWorktree(): void;
  onOpenWorktreeInApp(worktreeId: string): void;
  onMoveIdeaToWorktree(ideaId: string, targetWorktreeId?: string): void;
  onOpenIdeasView(): void;
  onResizeStart(event: React.MouseEvent<HTMLButtonElement>): void;
  onSelectIdea(ideaId: string): void;
  onSelectProject(projectId: string, groupId?: string): void;
  onSelectNavigationItem(itemId: string): void;
  onSelectWorkspace(): void;
  onSelectWorktree(worktreeId: string): void;
  onSidebarWheel(event: WheelEvent<HTMLElement>): void;
  previewPanelRef: React.RefObject<HTMLDivElement | null>;
  previewProject?: ProjectSpaceRecord;
  previewWorktrees: ProjectWorktreeRecord[];
  project?: ProjectSpaceRecord;
  projects: ProjectSpaceRecord[];
  rootItems: ProjectNavigationItem[];
  selectedExplorerTarget: ExplorerTarget;
  selectedIdeaId: string;
  unassignedIdeas: IdeaPresentationRecord[];
  selectedProjectId: string;
  titlebarSafeInset: number;
  worktreeIdeasById: Record<string, IdeaPresentationRecord[]>;
  worktrees: ProjectWorktreeRecord[];
}

export function ProjectSidebarPane({
  activeNavigationItemId,
  currentPanelRef,
  groups,
  isAppLoading,
  isOpen,
  isPreviewWorktreesLoading,
  isWorktreesLoading,
  mainView,
  navigationItems,
  onCreateIdea,
  onCreateProject,
  onDeleteIdea,
  onOpenCodexSkills,
  onOpenAppSettings,
  onOpenIdeasView,
  onOpenProjectSettings,
  onOpenWorktreesView,
  onOpenNewWorktree,
  onOpenWorktreeInApp,
  onMoveIdeaToWorktree,
  onResizeStart,
  onSelectIdea,
  onSelectProject,
  onSelectNavigationItem,
  onSelectWorkspace,
  onSelectWorktree,
  onSidebarWheel,
  previewPanelRef,
  previewProject,
  previewWorktrees,
  project,
  projects,
  rootItems,
  selectedExplorerTarget,
  selectedIdeaId,
  unassignedIdeas,
  selectedProjectId,
  titlebarSafeInset,
  worktreeIdeasById,
  worktrees
}: ProjectSidebarPaneProps) {
  return (
    <Surface
      onWheel={onSidebarWheel}
      variant="secondary"
      className="relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-none border-r border-zinc-800 bg-app-sidebar transition-[border-color,opacity] duration-200"
      style={{
        borderRightColor: isOpen ? undefined : 'transparent',
        opacity: isOpen ? 1 : 0,
        pointerEvents: isOpen ? 'auto' : 'none'
      }}
    >
      <div className="relative border-b border-zinc-800 px-5 pt-14 pb-4">
        <div
          className="app-drag absolute inset-y-0 right-0"
          style={{
            left: `${titlebarSafeInset}px`
          }}
        />

        <div className="app-no-drag relative">
          <SidebarQuickActions
            canCreateIdea={Boolean(project)}
            canOpenSettings={Boolean(project)}
            onCreateIdea={onCreateIdea}
            onOpenProjectSettings={onOpenProjectSettings}
            onOpenSkills={onOpenCodexSkills}
            projectName={project?.name}
          />
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div ref={currentPanelRef} className="absolute inset-y-0 left-0 w-full">
          <SidebarContent
            isInteractive
            isAppLoading={isAppLoading}
            mainView={mainView}
            isWorktreesLoading={isWorktreesLoading}
            onCreateIdea={onCreateIdea}
            onDeleteIdea={onDeleteIdea}
            onMoveIdeaToWorktree={onMoveIdeaToWorktree}
            onOpenIdeasView={onOpenIdeasView}
            onOpenNewWorktree={onOpenNewWorktree}
            onOpenWorktreeInApp={onOpenWorktreeInApp}
            onOpenWorktreesView={onOpenWorktreesView}
            onSelectIdea={onSelectIdea}
            onSelectWorkspace={onSelectWorkspace}
            onSelectWorktree={onSelectWorktree}
            project={project}
            selectedExplorerTarget={selectedExplorerTarget}
            selectedIdeaId={selectedIdeaId}
            unassignedIdeas={unassignedIdeas}
            worktreeIdeasById={worktreeIdeasById}
            worktrees={worktrees}
          />
        </div>

        {previewProject ? (
          <div ref={previewPanelRef} className="absolute inset-y-0 w-full">
            <SidebarContent
              isInteractive={false}
              isAppLoading={isAppLoading}
              mainView={mainView}
              isWorktreesLoading={isPreviewWorktreesLoading}
              onCreateIdea={() => undefined}
              onDeleteIdea={() => undefined}
              onMoveIdeaToWorktree={() => undefined}
              onOpenIdeasView={() => undefined}
              onOpenNewWorktree={() => undefined}
              onOpenWorktreeInApp={() => undefined}
              onOpenWorktreesView={() => undefined}
              onSelectIdea={() => undefined}
              onSelectWorkspace={() => undefined}
              onSelectWorktree={() => undefined}
              project={previewProject}
              selectedExplorerTarget={{ kind: 'workspace' }}
              selectedIdeaId=""
              unassignedIdeas={[]}
              worktreeIdeasById={{}}
              worktrees={previewWorktrees}
            />
          </div>
        ) : null}
      </div>

      {navigationItems.length > 0 ? (
        <SpacesDock
          items={navigationItems.map((item) => ({
            id: item.id,
            kind: item.kind,
            label: item.label
          }))}
          activeItemId={activeNavigationItemId}
          canNavigateUp={false}
          groups={groups}
          onNavigateUp={undefined}
          onSelectProject={onSelectProject}
          onSelect={onSelectNavigationItem}
          onCreate={onCreateProject}
          onOpenAppSettings={onOpenAppSettings}
          projects={projects}
          rootItems={rootItems}
          selectedProjectId={selectedProjectId}
        />
      ) : null}

      {isOpen ? (
        <Button
          aria-label="Resize sidebar"
          isIconOnly
          variant="ghost"
          onMouseDown={onResizeStart}
          className="app-no-drag absolute top-0 right-0 h-full w-2 min-w-0 cursor-col-resize rounded-none px-0 opacity-0 transition hover:opacity-100"
        >
          <span className="absolute top-0 right-0 h-full w-px bg-zinc-600/70" />
        </Button>
      ) : null}
    </Surface>
  );
}
