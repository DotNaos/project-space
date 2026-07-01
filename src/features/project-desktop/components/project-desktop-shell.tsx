import { useEffect, useState } from 'react';
import { useAuth, useClerk, useUser } from '@clerk/react';
import { FolderKanban, House, LogIn, Server } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button, Surface, Text } from '@/app/dotnaos-ui';
import {
  projectSpaceClient,
  setProjectSpaceAuthTokenProvider
} from '@/api/project-space-client';
import { isClerkConfigured } from '@/auth/clerk-provider';
import type { ProjectSpaceAuthSessionResult } from '@/shared/project-space-api';
import { useProjectDesktop } from '../hooks/use-project-desktop';
import type { ProjectMainView } from '../hooks/use-project-desktop';
import { useResizableSidebar } from '../hooks/use-resizable-sidebar';
import { useSidebarSwipeNavigation } from '../hooks/use-sidebar-swipe-navigation';
import { ProjectMainPanel } from './project-main-panel';
import { ProjectSidebarPane } from './project-sidebar-pane';
import { SidebarToggleButton } from './sidebar-toggle-button';

const SIDEBAR_DEFAULT_WIDTH = 294;
const SIDEBAR_COLLAPSED_WIDTH = 64;
const SIDEBAR_MIN_WIDTH = 248;
const SIDEBAR_MAX_WIDTH = 420;
const TITLEBAR_TOGGLE_LEFT = 12;
const TITLEBAR_TOGGLE_TOP = 12;
const TITLEBAR_TOGGLE_SIZE = 40;
const TITLEBAR_SAFE_INSET = TITLEBAR_TOGGLE_LEFT + TITLEBAR_TOGGLE_SIZE + 16;
const COMPACT_VIEWPORT_WIDTH = 760;
const COMPACT_TITLEBAR_TOGGLE_LEFT = 12;
const COMPACT_TITLEBAR_SAFE_INSET = COMPACT_TITLEBAR_TOGGLE_LEFT + TITLEBAR_TOGGLE_SIZE + 16;

function isCompactViewport() {
  return typeof window !== 'undefined' && window.innerWidth < COMPACT_VIEWPORT_WIDTH;
}

interface MobileTabBarProps {
  mainView: ProjectMainView;
  onOpenRoot(): void;
  onOpenMachines(): void;
  onOpenProjects(): void;
}

function MobileTabBar({
  mainView,
  onOpenRoot,
  onOpenMachines,
  onOpenProjects
}: MobileTabBarProps) {
  const items = [
    {
      icon: House,
      isActive: mainView === 'root',
      label: 'Home',
      onPress: onOpenRoot
    },
    {
      icon: Server,
      isActive: mainView === 'machines' || mainView === 'machine',
      label: 'Machines',
      onPress: onOpenMachines
    },
    {
      icon: FolderKanban,
      isActive: mainView === 'projects' || mainView === 'project',
      label: 'Projects',
      onPress: onOpenProjects
    }
  ];

  return (
    <nav
      aria-label="Primary"
      className="app-no-drag pointer-events-auto absolute inset-x-0 bottom-0 z-50 border-t border-neutral-800/90 bg-app-panel/95 px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-16px_40px_rgba(0,0,0,0.35)] backdrop-blur"
    >
      <div className="grid grid-cols-3 gap-1">
        {items.map((item) => {
          const Icon = item.icon;

          return (
            <button
              key={item.label}
              type="button"
              aria-current={item.isActive ? 'page' : undefined}
              onClick={item.onPress}
              className={cn(
                'flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl px-2 text-[11px] font-medium transition',
                item.isActive
                  ? 'bg-neutral-800 text-neutral-50'
                  : 'text-neutral-500 hover:bg-neutral-900/70 hover:text-neutral-200'
              )}
            >
              <Icon className="size-5" strokeWidth={1.9} />
              <span className="max-w-full truncate">{item.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function ProjectSpaceLoginScreen({
  isBusy = false,
  message,
  onSignIn
}: {
  isBusy?: boolean;
  message?: string;
  onSignIn(): void;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-app-canvas px-6 text-neutral-100">
      <Surface
        variant="secondary"
        className="flex w-full max-w-md flex-col gap-6 rounded-lg border-neutral-800 p-6"
      >
        <div className="flex items-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-lg bg-neutral-100 text-neutral-950">
            <LogIn className="size-5" strokeWidth={2} />
          </div>
          <div className="min-w-0">
            <Text as="h1" className="text-xl font-semibold text-neutral-50">
              Sign in to Project Space
            </Text>
            <Text as="p" className="mt-1 text-sm text-neutral-400">
              Sign in with Google through Clerk to open this workspace. Connect GitHub later for repositories.
            </Text>
          </div>
        </div>

        <Button onPress={onSignIn} isDisabled={isBusy}>
          <LogIn className="size-4" />
          Sign in with Google
        </Button>

        {message ? (
          <Text as="p" className="text-sm text-amber-300">
            {message}
          </Text>
        ) : null}
      </Surface>
    </div>
  );
}

function AuthenticatedProjectDesktopShell() {
  const desktop = useProjectDesktop();
  const [isCompact, setIsCompact] = useState(isCompactViewport);
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => !isCompactViewport());
  const [sidebarMode, setSidebarMode] = useState<ProjectMainView>('root');
  const useBottomTabBar = isCompact;
  const { isResizingSidebar, sidebarWidth, startSidebarResize } = useResizableSidebar({
    initialWidth: SIDEBAR_DEFAULT_WIDTH,
    maxWidth: SIDEBAR_MAX_WIDTH,
    minWidth: SIDEBAR_MIN_WIDTH
  });
  const titlebarToggleLeft = isCompact ? COMPACT_TITLEBAR_TOGGLE_LEFT : TITLEBAR_TOGGLE_LEFT;
  const titlebarSafeInset = !isSidebarOpen
    ? SIDEBAR_COLLAPSED_WIDTH
    : isCompact
      ? COMPACT_TITLEBAR_SAFE_INSET
      : TITLEBAR_SAFE_INSET;

  useEffect(() => {
    function updateViewportMode() {
      const nextIsCompact = isCompactViewport();
      setIsCompact(nextIsCompact);

      if (nextIsCompact) {
        setIsSidebarOpen(false);
      }
    }

    updateViewportMode();
    window.addEventListener('resize', updateViewportMode);

    return () => {
      window.removeEventListener('resize', updateViewportMode);
    };
  }, []);

  useEffect(() => {
    if (desktop.mainView === 'project' && desktop.selectedProjectId) {
      setSidebarMode('project');
    }

    if (desktop.mainView === 'machine' && desktop.selectedMachineId) {
      setSidebarMode('machine');
    }
  }, [desktop.mainView, desktop.selectedMachineId, desktop.selectedProjectId]);

  function openSidebarRoot() {
    setSidebarMode('root');
  }

  function openHomeFromSidebar() {
    setSidebarMode('root');
    desktop.openRoot();
  }

  function openSidebarMachines() {
    setSidebarMode('machines');
    setIsSidebarOpen(true);
  }

  function openSidebarProjects() {
    setSidebarMode('projects');
    setIsSidebarOpen(true);
  }

  function selectProjectFromSidebar(projectId: string, groupId?: string) {
    setSidebarMode('project');
    desktop.selectProject(projectId, groupId);
  }

  function selectNavigationItemFromSidebar(itemId: string) {
    setSidebarMode('project');
    desktop.selectNavigationItem(itemId);
  }

  function selectMachineFromSidebar(machineId: string) {
    setSidebarMode('machine');
    desktop.openMachine(machineId);
  }

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
    <div className="relative h-screen overflow-hidden bg-app-canvas text-neutral-100">
      {!useBottomTabBar ? (
        <div
          className="app-drag absolute top-0 left-0 z-50 flex h-14 items-center"
          style={{
            width: `${titlebarSafeInset}px`
          }}
        >
          <SidebarToggleButton
            isOpen={isSidebarOpen}
            left={titlebarToggleLeft}
            top={TITLEBAR_TOGGLE_TOP}
            onToggle={() => {
              setIsSidebarOpen((current) => !current);
            }}
          />
        </div>
      ) : null}

      <div
        className="grid h-full"
        style={{
          gridTemplateColumns: useBottomTabBar
            ? 'minmax(0,1fr)'
            : isSidebarOpen
              ? `${sidebarWidth}px minmax(0,1fr)`
              : `${SIDEBAR_COLLAPSED_WIDTH}px minmax(0,1fr)`,
          transition: isResizingSidebar ? 'none' : 'grid-template-columns 200ms ease-out'
        }}
      >
        {!useBottomTabBar ? (
          <ProjectSidebarPane
            activeNavigationItemId={desktop.activeNavigationItemId}
            connectorOverview={desktop.connectorOverview}
            currentPanelRef={currentPanelRef}
            groups={desktop.groups}
            groupedProjects={desktop.groupedProjects}
            groupedProjectsLabel={desktop.groupedProjectsLabel}
            isOpen={isSidebarOpen}
            navigationItems={desktop.navigationItems}
            onCreateProject={desktop.createProject}
            onOpenHome={openHomeFromSidebar}
            onOpenRoot={openSidebarRoot}
            onOpenMachines={openSidebarMachines}
            onOpenProjects={openSidebarProjects}
            onOpenNewWorktree={desktop.openNewWorktreeWorkspace}
            onResizeStart={(event) => {
              event.preventDefault();
              startSidebarResize();
            }}
            onSelectProject={selectProjectFromSidebar}
            onSelectMachine={selectMachineFromSidebar}
            onSelectNavigationItem={selectNavigationItemFromSidebar}
            onSelectWorkspace={desktop.selectWorkspace}
            onSelectWorktree={desktop.selectWorktree}
            onSidebarViewChange={desktop.setSidebarView}
            onSidebarWheel={handleSidebarWheel}
            previewPanelRef={previewPanelRef}
            previewProject={previewProject}
            previewWorktrees={previewWorktrees}
            isHomeSelected={desktop.mainView === 'root'}
            isMachinesSelected={sidebarMode === 'machines'}
            isProjectsSelected={sidebarMode === 'projects'}
            project={desktop.project}
            projects={desktop.projects}
            rootItems={desktop.rootItems}
            selectedExplorerTarget={desktop.selectedExplorerTarget}
            selectedMachine={desktop.selectedMachine}
            selectedMachineId={desktop.selectedMachineId}
            selectedProjectId={desktop.selectedProjectId}
            sidebarMode={sidebarMode}
            sidebarView={desktop.sidebarView}
            titlebarSafeInset={titlebarSafeInset}
            worktrees={desktop.worktrees}
          />
        ) : null}

        <ProjectMainPanel
          connectorOverview={desktop.connectorOverview}
          githubCatalog={desktop.githubCatalog}
          hasBottomTabBar={useBottomTabBar}
          isSidebarOpen={isSidebarOpen}
          isConnectorRefreshing={desktop.isConnectorRefreshing}
          isGitHubRefreshing={desktop.isGitHubRefreshing}
          launcherApps={desktop.launcherApps}
          launcherError={desktop.launcherError}
          mainView={desktop.mainView}
          onCreateProject={desktop.createProject}
          onOpenMachines={desktop.openMachines}
          onOpenMachine={desktop.openMachine}
          onOpenProjects={desktop.openProjects}
          onOpenRoot={desktop.openRoot}
          onOpenSelectedTarget={desktop.openSelectedTargetInApp}
          onRefreshConnectorOverview={desktop.refreshConnectorOverview}
          onRefreshGitHubCatalog={desktop.refreshGitHubCatalog}
          onSelectLauncherApp={desktop.selectLauncherApp}
          onSelectProject={desktop.selectProject}
          project={desktop.project}
          projects={desktop.projects}
          selectedApp={desktop.selectedLauncherApp}
          selectedAppLabel={desktop.selectedLauncherAppLabel}
          selectedExplorerTarget={desktop.selectedExplorerTarget}
          selectedMachine={desktop.selectedMachine}
          selectedMachineId={desktop.selectedMachineId}
          selectedTargetName={desktop.selectedTargetName}
          selectedTargetPath={desktop.selectedTargetPath}
          sidebarClosedPaddingLeft={useBottomTabBar ? 16 : titlebarSafeInset}
        />
      </div>

      {useBottomTabBar ? (
        <MobileTabBar
          mainView={desktop.mainView}
          onOpenRoot={desktop.openRoot}
          onOpenMachines={desktop.openMachines}
          onOpenProjects={desktop.openProjects}
        />
      ) : null}
    </div>
  );
}

export function ProjectDesktopShell() {
  if (!isClerkConfigured()) {
    return (
      <ProjectSpaceLoginScreen
        message="Set VITE_CLERK_PUBLISHABLE_KEY to enable Project Space login."
        onSignIn={() => undefined}
      />
    );
  }

  return <ClerkProjectDesktopShell />;
}

function ClerkProjectDesktopShell() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const { openSignIn } = useClerk();
  const { user } = useUser();
  const [session, setSession] = useState<ProjectSpaceAuthSessionResult | null>(null);
  const [isCheckingSession, setIsCheckingSession] = useState(true);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let canceled = false;

    if (!isLoaded) {
      return () => {
        canceled = true;
      };
    }

    if (!isSignedIn) {
      setProjectSpaceAuthTokenProvider(null);
      setSession({
        authenticated: false,
        authRequired: true
      });
      setMessage('');
      setIsCheckingSession(false);
      return () => {
        canceled = true;
      };
    }

    setProjectSpaceAuthTokenProvider(() => getToken());
    setIsCheckingSession(true);
    setMessage('');

    projectSpaceClient
      .getAuthSession()
      .then((nextSession) => {
        if (canceled) {
          return;
        }

        setSession(nextSession);
        setMessage(
          nextSession.authenticated
            ? ''
            : nextSession.message ??
                `This Clerk session was not accepted${user?.primaryEmailAddress?.emailAddress ? ` for ${user.primaryEmailAddress.emailAddress}` : ''}.`
        );
      })
      .catch((error) => {
        if (canceled) {
          return;
        }
        setSession({
          authenticated: false,
          authRequired: true
        });
        setMessage(error instanceof Error ? error.message : 'Could not verify Clerk session.');
      })
      .finally(() => {
        if (!canceled) {
          setIsCheckingSession(false);
        }
      });

    return () => {
      canceled = true;
    };
  }, [getToken, isLoaded, isSignedIn, user?.primaryEmailAddress?.emailAddress]);

  if (!isLoaded || isCheckingSession) {
    return <div className="min-h-screen bg-app-canvas" />;
  }

  if (!isSignedIn || (session?.authRequired && !session.authenticated)) {
    return (
      <ProjectSpaceLoginScreen
        isBusy={!isLoaded}
        message={message}
        onSignIn={() => {
          void openSignIn();
        }}
      />
    );
  }

  return <AuthenticatedProjectDesktopShell />;
}
