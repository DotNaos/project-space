import { useState } from 'react';
import { useProjectDesktop } from '../hooks/use-project-desktop';
import { useResizableSidebar } from '../hooks/use-resizable-sidebar';
import { useSidebarSwipeNavigation } from '../hooks/use-sidebar-swipe-navigation';
import { ProjectMainPanel } from './project-main-panel';
import { ProjectSidebarPane } from './project-sidebar-pane';
import { SidebarToggleButton } from './sidebar-toggle-button';

const SIDEBAR_DEFAULT_WIDTH = 294;
const SIDEBAR_MIN_WIDTH = 248;
const SIDEBAR_MAX_WIDTH = 420;
const TITLEBAR_TOGGLE_LEFT = 90;
const TITLEBAR_TOGGLE_TOP = 12;
const TITLEBAR_TOGGLE_SIZE = 32;
const TITLEBAR_SAFE_INSET = TITLEBAR_TOGGLE_LEFT + TITLEBAR_TOGGLE_SIZE + 24;

export function ProjectDesktopShell() {
  const desktop = useProjectDesktop();
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const { isResizingSidebar, sidebarWidth, startSidebarResize } = useResizableSidebar({
    initialWidth: SIDEBAR_DEFAULT_WIDTH,
    maxWidth: SIDEBAR_MAX_WIDTH,
    minWidth: SIDEBAR_MIN_WIDTH
  });
  const {
    currentPanelRef,
    handleSidebarWheel,
    previewPanelRef,
    previewProject,
    previewWorktrees
  } = useSidebarSwipeNavigation({
    activeNavigationItemId: desktop.activeNavigationItemId,
    isSidebarOpen,
    navigationItems: desktop.navigationItems,
    projects: desktop.projects,
    resolveNavigationSelection: desktop.resolveNavigationSelection,
    selectNavigationItem: desktop.selectNavigationItem,
    sidebarWidth
  });

  return (
    <div className="relative h-screen overflow-hidden bg-app-canvas text-slate-100">
      <div
        className="app-drag absolute top-0 left-0 z-30 h-14"
        style={{
          width: `${TITLEBAR_SAFE_INSET}px`
        }}
      >
        <SidebarToggleButton
          isOpen={isSidebarOpen}
          left={TITLEBAR_TOGGLE_LEFT}
          top={TITLEBAR_TOGGLE_TOP}
          onToggle={() => {
            setIsSidebarOpen((current) => !current);
          }}
        />
      </div>

      <div
        className="grid h-full"
        style={{
          gridTemplateColumns: isSidebarOpen
            ? `${sidebarWidth}px minmax(0,1fr)`
            : '0px minmax(0,1fr)',
          transition: isResizingSidebar ? 'none' : 'grid-template-columns 200ms ease-out'
        }}
      >
        <ProjectSidebarPane
          activeNavigationItemId={desktop.activeNavigationItemId}
          currentPanelRef={currentPanelRef}
          discoveryRoot={desktop.discoveryRoot}
          groups={desktop.groups}
          groupedProjects={desktop.groupedProjects}
          groupedProjectsLabel={desktop.groupedProjectsLabel}
          isOpen={isSidebarOpen}
          navigationItems={desktop.navigationItems}
          onCreateProject={desktop.createProject}
          onResizeStart={(event) => {
            event.preventDefault();
            startSidebarResize();
          }}
          onSelectProject={desktop.selectProject}
          onSelectNavigationItem={desktop.selectNavigationItem}
          onSelectWorkspace={desktop.selectWorkspace}
          onSelectWorktree={desktop.selectWorktree}
          onSidebarViewChange={desktop.setSidebarView}
          onSidebarWheel={handleSidebarWheel}
          previewPanelRef={previewPanelRef}
          previewProject={previewProject}
          previewWorktrees={previewWorktrees}
          project={desktop.project}
          projects={desktop.projects}
          rootItems={desktop.rootItems}
          selectedExplorerTarget={desktop.selectedExplorerTarget}
          selectedProjectId={desktop.selectedProjectId}
          sidebarView={desktop.sidebarView}
          titlebarSafeInset={TITLEBAR_SAFE_INSET}
          worktrees={desktop.worktrees}
        />

        <ProjectMainPanel
          discoveryRoot={desktop.discoveryRoot}
          isSidebarOpen={isSidebarOpen}
          launcherApps={desktop.launcherApps}
          launcherError={desktop.launcherError}
          onCreateProject={desktop.createProject}
          onOpenSelectedTarget={desktop.openSelectedTargetInApp}
          onSelectLauncherApp={desktop.selectLauncherApp}
          project={desktop.project}
          selectedApp={desktop.selectedLauncherApp}
          selectedAppLabel={desktop.selectedLauncherAppLabel}
          selectedExplorerTarget={desktop.selectedExplorerTarget}
          selectedTargetName={desktop.selectedTargetName}
          selectedTargetPath={desktop.selectedTargetPath}
          sidebarClosedPaddingLeft={TITLEBAR_SAFE_INSET}
        />
      </div>
    </div>
  );
}
