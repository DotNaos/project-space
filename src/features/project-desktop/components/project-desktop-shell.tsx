import { useEffect, useRef, useState } from 'react';
import { useAuth, useClerk, useUser } from '@clerk/react';
import { useSignIn } from '@clerk/react/legacy';
import {
  FolderKanban,
  PanelLeft,
  PencilLine,
  TriangleAlert
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button, Surface, Text } from '@/app/dotnaos-ui';
import {
  projectSpaceClient,
  setProjectSpaceAuthTokenProvider
} from '@/api/project-space-client';
import { isClerkConfigured } from '@/auth/clerk-provider';
import { clerkOAuthRedirectUrls } from '@/auth/oauth-redirects';
import type { ProjectSpaceAuthSessionResult } from '@/shared/project-space-api';
import { PullRequestChangelogDialog } from '@/features/pr-preview-changelog/pull-request-changelog-dialog';
import { ReleaseChangelogDialog } from '@/features/release-changelog/release-changelog-dialog';
import { useReleaseChangelog } from '@/features/release-changelog/use-release-changelog';
import { useProjectDesktop } from '../hooks/use-project-desktop';
import { routeForView } from '../hooks/use-project-desktop';
import type { RailAccount } from './account-menu';
import { ProjectMainPanel } from './project-main-panel';
import { ProjectWorkspaceSidebar } from './project-workspace-sidebar';
import { LocalSimulationIndicator } from './local-simulation-indicator';
import { shouldShowProjectSpaceSessionGate } from './project-desktop-session-gate';
import { projectShellLayout } from './project-shell-layout';
import { RuntimeBindingProvider } from './runtime-binding-context';

const COMPACT_VIEWPORT_WIDTH = 760;

function isCompactViewport() {
  return typeof window !== 'undefined' && window.innerWidth < COMPACT_VIEWPORT_WIDTH;
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
  const releaseChangelog = useReleaseChangelog({
    currentVersion: desktop.appMeta.version,
    enabled: !desktop.appMeta.preview && desktop.appMeta.version !== 'unknown'
  });
  const [changelogOpenRequestId, setChangelogOpenRequestId] = useState(0);
  const [isCompact, setIsCompact] = useState(isCompactViewport);
  const [isProjectSidebarCollapsed, setIsProjectSidebarCollapsed] = useState(false);
  const [isProjectSidebarOpen, setIsProjectSidebarOpen] = useState(false);

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

  const layout = projectShellLayout(
    desktop.mainView,
    isCompact,
    isProjectSidebarCollapsed
  );
  const openPreviewChangelog = desktop.appMeta.preview
    ? () => {
        setChangelogOpenRequestId((current) => current + 1);
      }
    : undefined;
  const openDocumentation = () => {
    window.location.assign('/docs');
  };
  const compactTitle = desktop.project?.github?.name
    ?? desktop.project?.name
    ?? (desktop.mainView === 'chat'
      ? 'Chat'
      : desktop.mainView === 'codex'
        ? 'Codex'
        : desktop.mainView === 'settings'
          ? 'Settings'
          : 'Projects');

  const isResolvingProject =
    desktop.mainView === 'project' &&
    !desktop.project &&
    (!desktop.githubCatalog.checkedAt || desktop.isGitHubRefreshing);

  if (!desktop.hasLoaded) {
    return (
      <div className="flex h-full items-center justify-center bg-app-panel text-neutral-100">
        <div className="flex items-center gap-3 text-sm text-neutral-400">
          <span
            aria-hidden="true"
            className="size-4 animate-spin rounded-full border-2 border-neutral-700 border-t-neutral-200"
          />
          Opening Project Space…
        </div>
      </div>
    );
  }

  if (!desktop.appMeta.runtime) {
    return (
      <div className="flex h-full items-center justify-center bg-app-panel px-6 text-neutral-100">
        <div className="max-w-sm text-center">
          <TriangleAlert className="mx-auto size-5 text-amber-300" />
          <p className="mt-3 text-sm font-medium">Runtime evidence unavailable</p>
          <p className="mt-1 text-xs leading-5 text-neutral-500">
            Project Space stopped before choosing a backend so local and external data cannot mix.
          </p>
        </div>
      </div>
    );
  }

  if (isResolvingProject) {
    return (
      <div className="flex h-full items-center justify-center bg-app-panel text-neutral-100">
        <div className="flex items-center gap-3 text-sm text-neutral-400">
          <span aria-hidden="true" className="size-4 animate-spin rounded-full border-2 border-neutral-700 border-t-neutral-200" />
          Opening Project Space…
        </div>
      </div>
    );
  }

  return (
    <RuntimeBindingProvider runtime={desktop.appMeta.runtime}>
    <div className="relative h-full overflow-hidden bg-app-canvas text-neutral-100">
      <div
        className="grid h-full"
        style={{
          gridTemplateColumns: layout.gridTemplateColumns,
          transition: 'grid-template-columns 200ms ease-out'
        }}
      >
        <aside
          data-testid="canonical-project-sidebar"
          className={cn(
            'min-h-0 overflow-hidden bg-[#151515]',
            isCompact && 'absolute inset-y-0 left-0 z-0 w-[calc(100%-2rem)] max-w-[20rem]'
          )}
        >
          <ProjectWorkspaceSidebar
            account={account}
            collapsed={!isCompact && isProjectSidebarCollapsed}
            currentProject={desktop.project}
            mainView={desktop.mainView}
            onClose={() => setIsProjectSidebarOpen(false)}
            onCollapsedChange={setIsProjectSidebarCollapsed}
            onNewTask={() => {
              if (desktop.project) {
                window.location.assign(`${routeForView('project', desktop.project.id, 'issues')}/new`);
              }
            }}
            onDismissRelease={releaseChangelog.dismissCurrent}
            onOpenChat={desktop.openChat}
            onOpenDocumentation={openDocumentation}
            onOpenMachines={desktop.openMachines}
            onOpenPreviewChangelog={openPreviewChangelog}
            onOpenProjects={desktop.openProjects}
            onOpenReleaseChangelog={() => releaseChangelog.open()}
            onOpenSettings={desktop.openSettings}
            onSelectProject={desktop.selectProject}
            onSelectTab={(tab) => {
              if (!desktop.project) return;
              if (desktop.mainView === 'project') {
                desktop.selectProjectTab(tab);
                return;
              }
              window.location.assign(routeForView('project', desktop.project.id, tab));
            }}
            projectTab={desktop.projectTab}
            projects={desktop.projects}
            release={releaseChangelog.currentRelease}
            releaseCardVisible={releaseChangelog.isCardVisible}
            releaseVersion={releaseChangelog.currentVersion}
            runtime={!isCompact ? desktop.appMeta.runtime : undefined}
            settingsSection={desktop.settingsSection}
          />
        </aside>

        <div
          className={cn(
            'relative z-10 flex min-h-0 min-w-0 flex-col overflow-hidden bg-app-panel transition-[transform,border-radius] duration-300 ease-out',
            isCompact && 'border-l border-white/[.08]',
            isCompact && isProjectSidebarOpen && 'translate-x-[calc(100%-2rem)] rounded-l-[2rem]'
          )}
        >
        {layout.showCompactHeader ? (
          <div className="relative flex h-14 shrink-0 items-center justify-between px-4">
            <Button
              aria-label="Open sidebar"
              isIconOnly
              size="sm"
              variant="ghost"
              className="size-9 min-w-9 rounded-xl text-neutral-300"
              onPress={() => setIsProjectSidebarOpen(true)}
            >
              <PanelLeft className="size-4" />
            </Button>
            <div className="flex max-w-[60%] min-w-0 flex-col items-center gap-0.5">
              <button
                type="button"
                onClick={() => setIsProjectSidebarOpen(true)}
                className="max-w-full truncate text-sm font-medium text-neutral-200"
              >
                {compactTitle}
              </button>
              <LocalSimulationIndicator runtime={desktop.appMeta.runtime} />
            </div>
            {desktop.project ? (
              <Button
                aria-label="New task"
                isIconOnly
                size="sm"
                variant="ghost"
                className="size-9 min-w-9 rounded-xl text-neutral-300"
                onPress={() => {
                  window.location.assign(`${routeForView('project', desktop.project!.id, 'issues')}/new`);
                }}
              >
                <PencilLine className="size-4" />
              </Button>
            ) : <span className="size-9" />}
          </div>
        ) : null}
        <ProjectMainPanel
          account={account}
          appMeta={desktop.appMeta}
          computeInventory={desktop.computeInventory}
          computeInventoryError={desktop.computeInventoryError}
          computeInventoryStatus={desktop.computeInventoryStatus}
          codexController={desktop.codexController}
          codexMachineIds={desktop.codexMachineIds}
          githubCatalog={desktop.githubCatalog}
          hasBottomTabBar={false}
          isGitHubRefreshing={desktop.isGitHubRefreshing}
          launcherApps={desktop.launcherApps}
          launcherError={desktop.launcherError}
          mainView={desktop.mainView}
          onCreateProject={desktop.createProject}
          onOpenChat={desktop.openChat}
          onOpenCodex={desktop.openCodex}
          onOpenProjects={desktop.openProjects}
          onOpenProjectChat={desktop.openProjectChat}
          onOpenRoot={desktop.openRoot}
          onOpenSelectedTarget={desktop.openSelectedTargetInApp}
          onRefreshProjectDiscovery={desktop.refreshProjectDiscovery}
          onRefreshProjectWorktrees={desktop.refreshProjectWorktrees}
          onRefreshComputeInventory={desktop.refreshComputeInventory}
          onRefreshGitHubCatalog={desktop.refreshGitHubCatalog}
          onSelectLauncherApp={desktop.selectLauncherApp}
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
          selectedTargetPath={desktop.selectedTargetPath}
          settingsSection={desktop.settingsSection}
          structureViolations={desktop.structureViolations}
          useWorkspaceChrome
          worktreeDiscovery={desktop.worktreeDiscovery}
          worktrees={desktop.worktrees}
        />
        </div>
      </div>

      <PullRequestChangelogDialog
        openRequestId={changelogOpenRequestId}
        preview={desktop.appMeta.preview}
      />
      <ReleaseChangelogDialog
        currentVersion={releaseChangelog.currentVersion}
        error={releaseChangelog.error}
        isLoading={releaseChangelog.isLoading}
        isOpen={releaseChangelog.isDialogOpen}
        onClose={releaseChangelog.close}
        onDismissCurrent={releaseChangelog.dismissCurrent}
        onSelect={releaseChangelog.select}
        releases={releaseChangelog.releases}
        selectedRelease={releaseChangelog.selectedRelease}
        selectedVersion={releaseChangelog.selectedVersion}
      />
    </div>
    </RuntimeBindingProvider>
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

      const redirectUrls = clerkOAuthRedirectUrls(window.location);
      await signIn.authenticateWithRedirect({
        redirectUrl: redirectUrls.callbackUrl,
        redirectUrlComplete: redirectUrls.completeUrl,
        strategy: 'oauth_google'
      });
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
