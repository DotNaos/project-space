import type { WheelEvent } from 'react';
import { Button, Surface, Text } from '@heroui/react';
import type {
  ExplorerTarget,
  ProjectNavigationItem,
  ProjectSpaceRecord,
  ProjectWorktreeRecord
} from '@/shared/electron-api';
import type { SidebarView } from './sidebar-view-tabs';
import { SidebarContent } from './sidebar-content';
import { SidebarViewTabs } from './sidebar-view-tabs';
import { SpacesDock } from './spaces-dock';

interface ProjectSidebarPaneProps {
  activeGroupName?: string;
  activeNavigationItemId: string;
  canNavigateUp: boolean;
  currentPanelRef: React.RefObject<HTMLDivElement | null>;
  discoveryRoot: string;
  isOpen: boolean;
  navigationItems: ProjectNavigationItem[];
  onCreateProject(): void;
  onNavigateToRoot(): void;
  onResizeStart(event: React.MouseEvent<HTMLButtonElement>): void;
  onSelectNavigationItem(itemId: string): void;
  onSelectWorkspace(): void;
  onSelectWorktree(worktreeId: string): void;
  onSidebarWheel(event: WheelEvent<HTMLElement>): void;
  onSidebarViewChange(nextView: SidebarView): void;
  previewPanelRef: React.RefObject<HTMLDivElement | null>;
  previewProject?: ProjectSpaceRecord;
  previewWorktrees: ProjectWorktreeRecord[];
  project?: ProjectSpaceRecord;
  selectedExplorerTarget: ExplorerTarget;
  sidebarView: SidebarView;
  titlebarSafeInset: number;
  worktrees: ProjectWorktreeRecord[];
}

export function ProjectSidebarPane({
  activeGroupName,
  activeNavigationItemId,
  canNavigateUp,
  currentPanelRef,
  discoveryRoot,
  isOpen,
  navigationItems,
  onCreateProject,
  onNavigateToRoot,
  onResizeStart,
  onSelectNavigationItem,
  onSelectWorkspace,
  onSelectWorktree,
  onSidebarWheel,
  onSidebarViewChange,
  previewPanelRef,
  previewProject,
  previewWorktrees,
  project,
  selectedExplorerTarget,
  sidebarView,
  titlebarSafeInset,
  worktrees
}: ProjectSidebarPaneProps) {
  return (
    <Surface
      onWheel={onSidebarWheel}
      variant="secondary"
      className="relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-none border-r border-slate-800 bg-app-sidebar transition-[border-color,opacity] duration-200"
      style={{
        borderRightColor: isOpen ? undefined : 'transparent',
        opacity: isOpen ? 1 : 0,
        pointerEvents: isOpen ? 'auto' : 'none'
      }}
    >
      <div className="relative border-b border-slate-800 px-5 pt-14 pb-4">
        <div
          className="app-drag absolute inset-y-0 right-0"
          style={{
            left: `${titlebarSafeInset}px`
          }}
        />

        <div className="app-no-drag relative">
          {activeGroupName ? (
            <Button
              size="sm"
              variant="ghost"
              onPress={onNavigateToRoot}
              className="h-auto min-h-0 rounded-xl px-2 py-1 text-sm text-slate-400 transition hover:text-slate-100"
            >
              ← {activeGroupName}
            </Button>
          ) : discoveryRoot ? (
            <Text className="text-xs text-slate-500">{discoveryRoot}</Text>
          ) : null}
        </div>
      </div>

      <div className="app-no-drag">
        <SidebarViewTabs value={sidebarView} onChange={onSidebarViewChange} />
      </div>

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div ref={currentPanelRef} className="absolute inset-y-0 left-0 w-full">
          <SidebarContent
            onSelectWorkspace={onSelectWorkspace}
            onSelectWorktree={onSelectWorktree}
            project={project}
            selectedExplorerTarget={selectedExplorerTarget}
            sidebarView={sidebarView}
            worktrees={worktrees}
          />
        </div>

        {previewProject ? (
          <div ref={previewPanelRef} className="absolute inset-y-0 w-full">
            <SidebarContent
              onSelectWorkspace={() => undefined}
              onSelectWorktree={() => undefined}
              project={previewProject}
              selectedExplorerTarget={{ kind: 'workspace' }}
              sidebarView={sidebarView}
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
          canNavigateUp={canNavigateUp}
          onNavigateUp={onNavigateToRoot}
          onSelect={onSelectNavigationItem}
          onCreate={onCreateProject}
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
          <span className="absolute top-0 right-0 h-full w-px bg-slate-600/70" />
        </Button>
      ) : null}
    </Surface>
  );
}
