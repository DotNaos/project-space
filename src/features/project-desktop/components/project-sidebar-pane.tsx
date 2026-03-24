import type { WheelEvent } from 'react';
import { Button, Surface } from '@heroui/react';
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

interface ProjectSidebarPaneProps {
  activeNavigationItemId: string;
  currentPanelRef: React.RefObject<HTMLDivElement | null>;
  groups: ProjectGroupRecord[];
  isOpen: boolean;
  navigationItems: ProjectNavigationItem[];
  onCreateIdea(): void;
  onCreateProject(): void;
  onOpenCodexSkills(): void;
  onOpenAppSettings(): void;
  onOpenProjectSettings(): void;
  onOpenNewWorktree(): void;
  onResizeStart(event: React.MouseEvent<HTMLButtonElement>): void;
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
  selectedProjectId: string;
  titlebarSafeInset: number;
  worktrees: ProjectWorktreeRecord[];
}

export function ProjectSidebarPane({
  activeNavigationItemId,
  currentPanelRef,
  groups,
  isOpen,
  navigationItems,
  onCreateIdea,
  onCreateProject,
  onOpenCodexSkills,
  onOpenAppSettings,
  onOpenProjectSettings,
  onOpenNewWorktree,
  onResizeStart,
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
  selectedProjectId,
  titlebarSafeInset,
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
          />
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div ref={currentPanelRef} className="absolute inset-y-0 left-0 w-full">
          <SidebarContent
            onOpenNewWorktree={onOpenNewWorktree}
            onSelectWorkspace={onSelectWorkspace}
            onSelectWorktree={onSelectWorktree}
            project={project}
            selectedExplorerTarget={selectedExplorerTarget}
            worktrees={worktrees}
          />
        </div>

        {previewProject ? (
          <div ref={previewPanelRef} className="absolute inset-y-0 w-full">
            <SidebarContent
              onOpenNewWorktree={() => undefined}
              onSelectWorkspace={() => undefined}
              onSelectWorktree={() => undefined}
              project={previewProject}
              selectedExplorerTarget={{ kind: 'workspace' }}
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
