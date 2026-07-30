import { useEffect, useRef, useState } from 'react';
import { useAuth, useClerk, useSignIn, useUser } from '@clerk/react';
import {
  FolderKanban,
  House,
  MessageSquare,
  TriangleAlert
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button, Surface, Text } from '@/app/dotnaos-ui';
import {
  projectSpaceClient,
  setProjectSpaceAuthTokenProvider
} from '@/api/project-space-client';
import { isClerkConfigured } from '@/auth/clerk-provider';
import type { ProjectSpaceAuthSessionResult } from '@/shared/project-space-api';
import {
  projectSpacePrimaryNavigation,
  projectSpaceViewPlacement
} from '@/features/project-topology/project-space-information-architecture';
import { PullRequestChangelogDialog } from '@/features/pr-preview-changelog/pull-request-changelog-dialog';
import { useProjectDesktop } from '../hooks/use-project-desktop';
import type { ProjectMainView } from '../hooks/use-project-desktop';
import { useResizableSidebar } from '../hooks/use-resizable-sidebar';
import {
  AppRail,
  CompactUtilityBar,
  type AppSection,
  type RailAccount
} from './app-rail';
import { ContextPanel } from './context-panel';
import { ProjectMainPanel } from './project-main-panel';
import { shouldShowProjectSpaceSessionGate } from './project-desktop-session-gate';
import { shouldDefaultContextPanelOpen } from './project-desktop-viewport';

const RAIL_WIDTH = 56;
const PANEL_DEFAULT_WIDTH = 272;
const PANEL_MIN_WIDTH = 224;
const PANEL_MAX_WIDTH = 400;
const COMPACT_VIEWPORT_WIDTH = 760;

function isCompactViewport() {
  return typeof window !== 'undefined' && window.innerWidth < COMPACT_VIEWPORT_WIDTH;
}

function defaultContextPanelOpen() {
  return typeof window !== 'undefined'
    && shouldDefaultContextPanelOpen(window.innerWidth);
}

export function sectionForView(view: ProjectMainView): AppSection {
  return projectSpaceViewPlacement(view).destination;
}

interface MobileTabBarProps {
  activeSection: AppSection;
  onOpenChat(): void;
  onOpenProjects(): void;
  onOpenRoot(): void;
}

export function MobileTabBar({
  activeSection,
  onOpenChat,
  onOpenProjects,
  onOpenRoot
}: MobileTabBarProps) {
  const actions = {
    chat: onOpenChat,
    home: onOpenRoot,
    projects: onOpenProjects
  };
  const icons = {
    chat: MessageSquare,
    home: House,
    projects: FolderKanban
  };
  const items = projectSpacePrimaryNavigation.map((item) => ({
    ...item,
    icon: icons[item.destination],
    isActive: activeSection === item.destination,
    onPress: actions[item.destination]
  }));

  return (
    <nav
      aria-label="Primary"
      className="app-no-drag pointer-events-auto absolute inset-x-0 bottom-0 z-50 border-t border-neutral-800/90 bg-app-panel/95 px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-16px_40px_rgba(0,0,0,0.35)] backdrop-blur"
    >
      <div className="grid grid-cols-3 gap-2">
        {items.map((item) => {
          const Icon = item.icon;

          return (
            <button
              key={item.label}
              type="button"
              aria-current={item.isActive ? 'page' : undefined}
              onClick={item.onPress}
              className={cn(
                'flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl px-0.5 text-[10px] font-medium transition',
                item.isActive
                  ? 'bg-neutral-800 text-neutral-50'
                  : 'text-neutral-500 hover:bg-neutral-900/70 hover:text-neutral-200'
              )}
            >
              <Icon className="size-5" strokeWidth={1.9} />
              <span className="max-w-full truncate text-[10px] leading-4">{item.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function GoogleLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
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
    <div className="relative flex min-h-full items-center justify-center overflow-hidden bg-app-canvas px-6 text-neutral-100">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-[-30%] h-[26rem] w-[42rem] -translate-x-1/2 rounded-full bg-neutral-50/[0.05] blur-[120px]" />
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-neutral-700/70 to-transparent" />
      </div>

      <div className="relative flex w-full max-w-sm flex-col items-center text-center">
        <div className="flex size-14 items-center justify-center rounded-2xl border border-neutral-800 bg-app-panel shadow-[0_16px_40px_rgba(0,0,0,0.5)]">
          <FolderKanban className="size-6 text-neutral-100" strokeWidth={1.8} />
        </div>

        <Text as="h1" className="mt-6 text-2xl font-semibold tracking-tight text-neutral-50">
          Welcome to Project Space
        </Text>
        <Text as="p" className="mt-2 max-w-xs text-sm leading-relaxed text-neutral-400">
          Sign in to open your workspace. Connect GitHub later for repositories.
        </Text>

        <Button
          fullWidth
          size="lg"
          variant="primary"
          isDisabled={isBusy}
          onPress={onSignIn}
          className="mt-8 gap-3 rounded-xl bg-white text-[15px] hover:bg-neutral-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-300"
        >
          {isBusy ? (
            <span
              aria-hidden="true"
              className="size-4 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-800"
            />
          ) : (
            <GoogleLogo className="size-4.5" />
          )}
          {isBusy ? 'Redirecting to Google…' : 'Continue with Google'}
        </Button>

        {message ? (
          <div className="mt-5 flex max-w-xs items-start gap-2 text-left">
            <TriangleAlert
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0 text-amber-300/90"
              strokeWidth={1.8}
            />
            <Text as="p" className="text-xs leading-relaxed text-neutral-400">
              {message}
            </Text>
          </div>
        ) : null}

        <Text as="p" className="mt-10 text-xs text-neutral-600">
          You&apos;ll be taken straight to Google to sign in securely.
        </Text>
      </div>
    </div>
  );
}

function AuthenticatedProjectDesktopShell({ account }: { account?: RailAccount }) {
  const desktop = useProjectDesktop();
  const [changelogOpenRequestId, setChangelogOpenRequestId] = useState(0);
  const [isCompact, setIsCompact] = useState(isCompactViewport);
  const [isPanelOpen, setIsPanelOpen] = useState(defaultContextPanelOpen);
  const defaultPanelModeRef = useRef(defaultContextPanelOpen());
  const { isResizingSidebar, sidebarWidth, startSidebarResize } = useResizableSidebar({
    initialWidth: PANEL_DEFAULT_WIDTH,
    maxWidth: PANEL_MAX_WIDTH,
    minWidth: PANEL_MIN_WIDTH,
    offsetLeft: RAIL_WIDTH
  });

  useEffect(() => {
    function updateViewportMode() {
      setIsCompact(isCompactViewport());
      const nextDefaultPanelMode = defaultContextPanelOpen();
      if (nextDefaultPanelMode !== defaultPanelModeRef.current) {
        defaultPanelModeRef.current = nextDefaultPanelMode;
        setIsPanelOpen(nextDefaultPanelMode);
      }
    }

    updateViewportMode();
    window.addEventListener('resize', updateViewportMode);

    return () => {
      window.removeEventListener('resize', updateViewportMode);
    };
  }, []);

  const activeSection = sectionForView(desktop.mainView);
  const hasContextPanel = !isCompact && activeSection === 'projects';
  const showContextPanel = hasContextPanel && isPanelOpen;

  const gridTemplateColumns = isCompact
    ? 'minmax(0,1fr)'
    : showContextPanel
      ? `${RAIL_WIDTH}px ${sidebarWidth}px minmax(0,1fr)`
      : `${RAIL_WIDTH}px minmax(0,1fr)`;
  const openChangelog = desktop.appMeta.preview
    ? () => {
        setChangelogOpenRequestId((current) => current + 1);
      }
    : undefined;
  const openDocumentation = () => {
    window.location.assign('/docs');
  };

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
            onOpenChat={desktop.openChat}
            onOpenChangelog={openChangelog}
            onOpenDocumentation={openDocumentation}
            onOpenHome={desktop.openRoot}
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
            onResizeStart={(event) => {
              event.preventDefault();
              startSidebarResize();
            }}
            onSelectMachine={desktop.openMachine}
            onSelectProject={desktop.selectProject}
            onTogglePinnedProject={desktop.togglePinnedProject}
            pinnedProjectIds={desktop.pinnedProjectIds}
            projects={desktop.projects}
            recentProjectIds={desktop.recentProjectIds}
            section="projects"
            selectedMachineId={desktop.selectedMachineId}
            selectedProjectId={desktop.selectedProjectId}
          />
        ) : null}

        <ProjectMainPanel
          account={account}
          appMeta={desktop.appMeta}
          connectorOverview={desktop.connectorOverview}
          codexController={desktop.codexController}
          codexMachineIds={desktop.codexMachineIds}
          githubCatalog={desktop.githubCatalog}
          hasBottomTabBar={isCompact}
          isConnectorRefreshing={desktop.isConnectorRefreshing}
          isGitHubRefreshing={desktop.isGitHubRefreshing}
          launcherApps={desktop.launcherApps}
          launcherError={desktop.launcherError}
          machineTab={desktop.machineTab}
          mainView={desktop.mainView}
          onCreateProject={desktop.createProject}
          onOpenChat={desktop.openChat}
          onOpenCodex={desktop.openCodex}
          onOpenMachine={desktop.openMachine}
          onOpenMachines={desktop.openMachines}
          onOpenProjects={desktop.openProjects}
          onOpenProjectChat={desktop.openProjectChat}
          onOpenRoot={desktop.openRoot}
          onOpenSelectedTarget={desktop.openSelectedTargetInApp}
          onRefreshProjectDiscovery={desktop.refreshProjectDiscovery}
          onRefreshProjectWorktrees={desktop.refreshProjectWorktrees}
          onRefreshConnectorOverview={desktop.refreshConnectorOverview}
          onRefreshGitHubCatalog={desktop.refreshGitHubCatalog}
          onSelectLauncherApp={desktop.selectLauncherApp}
          onSelectMachineContext={desktop.selectMachineContext}
          onSelectMachineTab={desktop.selectMachineTab}
          onSelectProject={desktop.selectProject}
          onSelectProjectTab={desktop.selectProjectTab}
          onSelectWorkspace={desktop.selectWorkspace}
          onSelectWorktree={desktop.selectWorktree}
          onOpenProjectIssue={desktop.openProjectIssue}
          onOpenProjectHistory={desktop.openProjectHistory}
          onOpenProjectWorkflowRun={desktop.openProjectWorkflowRun}
          onCloseProjectWorkflowRun={desktop.closeProjectWorkflowRun}
          project={desktop.project}
          projects={desktop.projects}
          projectTab={desktop.projectTab}
          historyFocus={desktop.historyFocus}
          recentProjectIds={desktop.recentProjectIds}
          selectedApp={desktop.selectedLauncherApp}
          selectedCodexOrigin={desktop.selectedCodexOrigin}
          selectedAppLabel={desktop.selectedLauncherAppLabel}
          selectedExplorerTarget={desktop.selectedExplorerTarget}
          selectedIssueNumber={desktop.selectedIssueNumber}
          selectedWorkflowRunId={desktop.selectedWorkflowRunId}
          selectedMachine={desktop.selectedMachine}
          selectedMachineId={desktop.selectedMachineId}
          selectedTargetPath={desktop.selectedTargetPath}
          structureViolations={desktop.structureViolations}
          worktreeDiscovery={desktop.worktreeDiscovery}
          worktrees={desktop.worktrees}
        />
      </div>

      {isCompact ? (
        <CompactUtilityBar
          isSettingsActive={activeSection === 'settings'}
          onOpenChangelog={openChangelog}
          onOpenDocumentation={openDocumentation}
          onOpenSettings={desktop.openSettings}
        />
      ) : null}

      {isCompact ? (
        <MobileTabBar
          activeSection={activeSection}
          onOpenChat={desktop.openChat}
          onOpenProjects={desktop.openProjects}
          onOpenRoot={desktop.openRoot}
        />
      ) : null}

      <PullRequestChangelogDialog
        openRequestId={changelogOpenRequestId}
        preview={desktop.appMeta.preview}
      />
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
  const { signOut } = useClerk();
  const { signIn } = useSignIn();
  const { user } = useUser();
  const [session, setSession] = useState<ProjectSpaceAuthSessionResult | null>(null);
  const [isCheckingSession, setIsCheckingSession] = useState(true);
  const [verifiedUserId, setVerifiedUserId] = useState<string>();
  const [isRedirectingToGoogle, setIsRedirectingToGoogle] = useState(false);
  const [message, setMessage] = useState('');
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const currentUserId = user?.id;
  const currentUserEmail = user?.primaryEmailAddress?.emailAddress;

  async function signInWithGoogle() {
    if (!signIn) {
      return;
    }

    setIsRedirectingToGoogle(true);
    setMessage('');

    try {
      // A rejected Clerk session must be cleared before a new OAuth attempt.
      if (isSignedIn) {
        await signOut();
      }

      const { error } = await signIn.sso({
        redirectCallbackUrl: '/sso-callback',
        redirectUrl: '/',
        strategy: 'oauth_google'
      });

      if (error) {
        setIsRedirectingToGoogle(false);
        setMessage(error.message || 'Could not start Google sign-in.');
      }
    } catch (error) {
      setIsRedirectingToGoogle(false);
      setMessage(error instanceof Error ? error.message : 'Could not start Google sign-in.');
    }
  }

  useEffect(() => {
    let canceled = false;

    if (!isLoaded) {
      return () => {
        canceled = true;
      };
    }

    if (!isSignedIn) {
      setProjectSpaceAuthTokenProvider(null);
      setVerifiedUserId(undefined);
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

    setProjectSpaceAuthTokenProvider(() => getTokenRef.current());
    setIsCheckingSession(true);
    setMessage('');

    projectSpaceClient
      .getAuthSession()
      .then((nextSession) => {
        if (canceled) {
          return;
        }

        setVerifiedUserId(currentUserId);
        setSession(nextSession);
        setMessage(
          nextSession.authenticated
            ? ''
            : nextSession.message ??
                `This Clerk session was not accepted${currentUserEmail ? ` for ${currentUserEmail}` : ''}.`
        );
      })
      .catch((error) => {
        if (canceled) {
          return;
        }
        setVerifiedUserId(currentUserId);
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
  }, [currentUserEmail, currentUserId, isLoaded, isSignedIn]);

  if (shouldShowProjectSpaceSessionGate({
    currentUserId,
    isCheckingSession,
    isLoaded,
    verifiedUserId
  })) {
    return <div className="min-h-full bg-app-canvas" />;
  }

  if (!isSignedIn || (session?.authRequired && !session.authenticated)) {
    return (
      <ProjectSpaceLoginScreen
        isBusy={!isLoaded || isRedirectingToGoogle}
        message={message}
        onSignIn={() => {
          void signInWithGoogle();
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
