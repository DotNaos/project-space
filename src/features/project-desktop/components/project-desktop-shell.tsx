import { useEffect, useState } from 'react';
import { useAuth, useClerk, useUser } from '@clerk/react';
import { FolderKanban, House, LogIn, Server, Settings } from 'lucide-react';
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
import { AppRail, type AppSection, type RailAccount } from './app-rail';
import { ContextPanel } from './context-panel';
import { ProjectMainPanel } from './project-main-panel';

const RAIL_WIDTH = 56;
const PANEL_DEFAULT_WIDTH = 272;
const PANEL_MIN_WIDTH = 224;
const PANEL_MAX_WIDTH = 400;
const COMPACT_VIEWPORT_WIDTH = 760;

function isCompactViewport() {
  return typeof window !== 'undefined' && window.innerWidth < COMPACT_VIEWPORT_WIDTH;
}

function sectionForView(view: ProjectMainView): AppSection {
  if (view === 'projects' || view === 'project') {
    return 'projects';
  }

  if (view === 'machines' || view === 'machine') {
    return 'machines';
  }

  if (view === 'settings') {
    return 'settings';
  }

  return 'home';
}

interface MobileTabBarProps {
  activeSection: AppSection;
  onOpenMachines(): void;
  onOpenProjects(): void;
  onOpenRoot(): void;
  onOpenSettings(): void;
}

function MobileTabBar({
  activeSection,
  onOpenMachines,
  onOpenProjects,
  onOpenRoot,
  onOpenSettings
}: MobileTabBarProps) {
  const items = [
    {
      icon: House,
      isActive: activeSection === 'home',
      label: 'Home',
      onPress: onOpenRoot
    },
    {
      icon: FolderKanban,
      isActive: activeSection === 'projects',
      label: 'Projects',
      onPress: onOpenProjects
    },
    {
      icon: Server,
      isActive: activeSection === 'machines',
      label: 'Machines',
      onPress: onOpenMachines
    },
    {
      icon: Settings,
      isActive: activeSection === 'settings',
      label: 'Settings',
      onPress: onOpenSettings
    }
  ];

  return (
    <nav
      aria-label="Primary"
      className="app-no-drag pointer-events-auto absolute inset-x-0 bottom-0 z-50 border-t border-neutral-800/90 bg-app-panel/95 px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-16px_40px_rgba(0,0,0,0.35)] backdrop-blur"
    >
      <div className="grid grid-cols-4 gap-1">
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
    <div className="flex min-h-full items-center justify-center bg-app-canvas px-6 text-neutral-100">
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

function AuthenticatedProjectDesktopShell({ account }: { account?: RailAccount }) {
  const desktop = useProjectDesktop();
  const [isCompact, setIsCompact] = useState(isCompactViewport);
  const [isPanelOpen, setIsPanelOpen] = useState(() => !isCompactViewport());
  const { isResizingSidebar, sidebarWidth, startSidebarResize } = useResizableSidebar({
    initialWidth: PANEL_DEFAULT_WIDTH,
    maxWidth: PANEL_MAX_WIDTH,
    minWidth: PANEL_MIN_WIDTH,
    offsetLeft: RAIL_WIDTH
  });

  useEffect(() => {
    function updateViewportMode() {
      setIsCompact(isCompactViewport());
    }

    updateViewportMode();
    window.addEventListener('resize', updateViewportMode);

    return () => {
      window.removeEventListener('resize', updateViewportMode);
    };
  }, []);

  const activeSection = sectionForView(desktop.mainView);
  const hasContextPanel =
    !isCompact && (activeSection === 'projects' || activeSection === 'machines');
  const showContextPanel = hasContextPanel && isPanelOpen;

  const gridTemplateColumns = isCompact
    ? 'minmax(0,1fr)'
    : showContextPanel
      ? `${RAIL_WIDTH}px ${sidebarWidth}px minmax(0,1fr)`
      : `${RAIL_WIDTH}px minmax(0,1fr)`;

  return (
    <div className="relative h-full overflow-hidden bg-app-canvas text-neutral-100">
      <div
        className="grid h-full"
        style={{
          gridTemplateColumns,
          transition: isResizingSidebar ? 'none' : 'grid-template-columns 200ms ease-out'
        }}
      >
        {!isCompact ? (
          <AppRail
            account={account}
            activeSection={activeSection}
            hasContextPanel={hasContextPanel}
            isContextPanelOpen={isPanelOpen}
            onOpenHome={desktop.openRoot}
            onOpenMachines={desktop.openMachines}
            onOpenProjects={desktop.openProjects}
            onOpenSettings={desktop.openSettings}
            onToggleContextPanel={() => {
              setIsPanelOpen((current) => !current);
            }}
          />
        ) : null}

        {showContextPanel ? (
          <ContextPanel
            connectorOverview={desktop.connectorOverview}
            groups={desktop.groups}
            onCreateProject={desktop.createProject}
            onOpenNewWorktree={desktop.openNewWorktreeWorkspace}
            onResizeStart={(event) => {
              event.preventDefault();
              startSidebarResize();
            }}
            onSelectMachine={desktop.openMachine}
            onSelectProject={desktop.selectProject}
            onSelectWorkspace={desktop.selectWorkspace}
            onSelectWorktree={desktop.selectWorktree}
            onTogglePinnedProject={desktop.togglePinnedProject}
            pinnedProjectIds={desktop.pinnedProjectIds}
            projects={desktop.projects}
            section={activeSection === 'machines' ? 'machines' : 'projects'}
            selectedExplorerTarget={desktop.selectedExplorerTarget}
            selectedMachineId={desktop.selectedMachineId}
            selectedProjectId={desktop.selectedProjectId}
            worktrees={desktop.worktrees}
          />
        ) : null}

        <ProjectMainPanel
          account={account}
          connectorOverview={desktop.connectorOverview}
          githubCatalog={desktop.githubCatalog}
          hasBottomTabBar={isCompact}
          isConnectorRefreshing={desktop.isConnectorRefreshing}
          isGitHubRefreshing={desktop.isGitHubRefreshing}
          launcherApps={desktop.launcherApps}
          launcherError={desktop.launcherError}
          machineTab={desktop.machineTab}
          mainView={desktop.mainView}
          onCreateProject={desktop.createProject}
          onOpenMachine={desktop.openMachine}
          onOpenMachines={desktop.openMachines}
          onOpenNewWorktree={desktop.openNewWorktreeWorkspace}
          onOpenProjects={desktop.openProjects}
          onOpenRoot={desktop.openRoot}
          onOpenSelectedTarget={desktop.openSelectedTargetInApp}
          onRefreshProjectDiscovery={desktop.refreshProjectDiscovery}
          onRefreshConnectorOverview={desktop.refreshConnectorOverview}
          onRefreshGitHubCatalog={desktop.refreshGitHubCatalog}
          onSelectLauncherApp={desktop.selectLauncherApp}
          onSelectMachineTab={desktop.selectMachineTab}
          onSelectProject={desktop.selectProject}
          onSelectProjectTab={desktop.selectProjectTab}
          onSelectWorkspace={desktop.selectWorkspace}
          onSelectWorktree={desktop.selectWorktree}
          onOpenProjectIssue={desktop.openProjectIssue}
          project={desktop.project}
          projects={desktop.projects}
          projectTab={desktop.projectTab}
          recentProjectIds={desktop.recentProjectIds}
          selectedApp={desktop.selectedLauncherApp}
          selectedAppLabel={desktop.selectedLauncherAppLabel}
          selectedExplorerTarget={desktop.selectedExplorerTarget}
          selectedIssueNumber={desktop.selectedIssueNumber}
          selectedMachine={desktop.selectedMachine}
          selectedMachineId={desktop.selectedMachineId}
          selectedTargetName={desktop.selectedTargetName}
          selectedTargetPath={desktop.selectedTargetPath}
          structureViolations={desktop.structureViolations}
          worktrees={desktop.worktrees}
        />
      </div>

      {isCompact ? (
        <MobileTabBar
          activeSection={activeSection}
          onOpenMachines={desktop.openMachines}
          onOpenProjects={desktop.openProjects}
          onOpenRoot={desktop.openRoot}
          onOpenSettings={desktop.openSettings}
        />
      ) : null}
    </div>
  );
}

export function ProjectDesktopShell() {
  if (import.meta.env.VITE_PROJECT_SPACE_AUTH_DISABLED === '1') {
    return <AuthenticatedProjectDesktopShell />;
  }

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
  const { openSignIn, signOut } = useClerk();
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
    return <div className="min-h-full bg-app-canvas" />;
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

  const account: RailAccount = {
    email: user?.primaryEmailAddress?.emailAddress,
    imageUrl: user?.imageUrl,
    name: user?.fullName ?? undefined,
    onSignOut() {
      void signOut();
    }
  };

  return <AuthenticatedProjectDesktopShell account={account} />;
}
