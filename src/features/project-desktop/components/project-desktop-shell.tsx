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
    isPreviewWorktreesLoading,
    previewPanelRef,
    previewProject,
    previewWorktrees
  } = useSidebarSwipeNavigation({
    activeNavigationItemId: desktop.activeNavigationItemId,
    isSidebarOpen,
    navigationItems: desktop.navigationItems,
    preloadProjectWorktrees: desktop.loadWorktreesForProject,
    projectWorktreesById: desktop.projectWorktrees,
    projects: desktop.projects,
    resolveNavigationSelection: desktop.resolveNavigationSelection,
    selectNavigationItem: desktop.selectNavigationItem,
    sidebarWidth
  });

  return (
    <div className="relative h-screen overflow-hidden bg-app-sidebar text-zinc-100">
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
          groups={desktop.groups}
          isAppLoading={!desktop.hasLoaded}
          isOpen={isSidebarOpen}
          isPreviewWorktreesLoading={isPreviewWorktreesLoading}
          isWorktreesLoading={desktop.isWorktreesLoading}
          navigationItems={desktop.navigationItems}
          onCreateIdea={desktop.createIdea}
          onCreateProject={desktop.createProject}
          onOpenCodexSkills={desktop.openCodexSkills}
          onOpenAppSettings={desktop.openAppSettings}
          onOpenIdeasView={desktop.openIdeasView}
          onOpenWorktreesView={desktop.openWorktreesView}
          onOpenProjectSettings={desktop.openProjectSettings}
          onOpenNewWorktree={desktop.openNewWorktreeWorkspace}
          onResizeStart={(event) => {
            event.preventDefault();
            startSidebarResize();
          }}
          onMoveIdeaToWorktree={desktop.moveIdeaToWorktree}
          onSelectIdea={desktop.selectIdea}
          onSelectProject={desktop.selectProject}
          onSelectNavigationItem={desktop.selectNavigationItem}
          onSelectWorkspace={desktop.selectWorkspace}
          onSelectWorktree={desktop.selectWorktree}
          onSidebarWheel={handleSidebarWheel}
          previewPanelRef={previewPanelRef}
          previewProject={previewProject}
          previewWorktrees={previewWorktrees}
          project={desktop.project}
          mainView={desktop.mainView}
          projects={desktop.projects}
          rootItems={desktop.rootItems}
          selectedExplorerTarget={desktop.selectedExplorerTarget}
          selectedIdeaId={desktop.selectedIdeaId}
          unassignedIdeas={desktop.unassignedIdeas}
          selectedProjectId={desktop.selectedProjectId}
          titlebarSafeInset={TITLEBAR_SAFE_INSET}
          worktreeIdeasById={desktop.worktreeIdeasById}
          worktrees={desktop.worktrees}
        />

        <ProjectMainPanel
          activeSettingsTab={desktop.settingsTab}
          discoveryRoot={desktop.discoveryRoot}
          draftValues={desktop.ideaDraftValues}
          assignedIdeaIds={desktop.assignedIdeaIds}
          groupedProjects={desktop.groupedProjects}
          groupedProjectsLabel={desktop.groupedProjectsLabel}
          ideas={desktop.ideas}
          isDirty={desktop.isIdeasDirty}
          isIdeasLoading={desktop.isIdeasLoading}
          isIssueSourceLoading={desktop.isIssueSourceLoading}
          isIssueSourceSaving={desktop.isIssueSourceSaving}
          isSavingIdea={desktop.isIdeaSaving}
          isSidebarOpen={isSidebarOpen}
          issueSourceConfig={desktop.issueSourceConfig}
          issueSourceDraftKind={desktop.issueSourceDraftKind}
          issueSourceDraftUrl={desktop.issueSourceDraftUrl}
          issueSourceError={desktop.issueSourceError}
          launcherApps={desktop.launcherApps}
          launcherError={desktop.launcherError}
          loadIdeasError={desktop.ideasLoadError}
          mainView={desktop.mainView}
          onCreateIdea={desktop.createIdea}
          onCreateProject={desktop.createProject}
          onMoveIdeaToWorktree={desktop.moveIdeaToWorktree}
          onOpenIssueSource={desktop.openIssueSource}
          onOpenSelectedTarget={desktop.openSelectedTargetInApp}
          onSaveIdea={desktop.saveIdea}
          onSaveIssueSourceConfig={desktop.saveIssueSourceConfig}
          onSelectProject={desktop.selectProject}
          onSelectSettingsTab={desktop.setSettingsTab}
          onSelectIdea={desktop.selectIdea}
          onSelectLauncherApp={desktop.selectLauncherApp}
          onUpdateIdeaValue={desktop.setIdeaDraftValue}
          onUpdateIssueSourceKind={desktop.setIssueSourceDraftKind}
          onUpdateIssueSourceUrl={desktop.setIssueSourceDraftUrl}
          onToggleShowClosedIdeas={desktop.setShowClosedIdeas}
          project={desktop.project}
          selectedApp={desktop.selectedLauncherApp}
          selectedAppLabel={desktop.selectedLauncherAppLabel}
          selectedExplorerTarget={desktop.selectedExplorerTarget}
          selectedIdea={desktop.selectedIdea}
          selectedTargetPath={desktop.selectedTargetPath}
          selectedTargetIdeas={desktop.selectedTargetIdeas}
          showClosedIdeas={desktop.showClosedIdeas}
          sidebarClosedPaddingLeft={TITLEBAR_SAFE_INSET}
          syncErrors={desktop.syncErrors}
          selectedWorktree={desktop.selectedWorktree}
          worktrees={desktop.worktrees}
        />
      </div>
    </div>
  );
}
