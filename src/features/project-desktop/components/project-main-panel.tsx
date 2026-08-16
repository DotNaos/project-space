import type {
  AppMeta,
  ExplorerTarget,
  GitHubCatalogResult,
  LauncherAppRecord,
  ProjectSpaceRecord,
  ProjectStructureViolationRecord,
  ProjectWorktreeDiscoveryState,
  ProjectWorktreeRecord
} from '@/shared/project-space-api';
import type { ProjectCliComputeInventory } from '@/shared/compute-inventory-cli-api';
import { useCallback, useEffect, useMemo } from 'react';
import { ProjectCodexChatPage } from '@/features/codex-sessions/project-codex-chat-page';
import type { CodexSessionsController } from '@/features/codex-sessions/codex-sessions-controller';
import { CodexSessionsInventoryProvider } from '@/features/codex-sessions/codex-sessions-inventory-context';
import type { CodexSessionTarget } from '@/features/codex-sessions/codex-session-route';
import { ProjectCodexTasks } from '@/features/codex-sessions/project-codex-tasks';
import type { ProjectDetailTab, ProjectMainView, SettingsSection } from '../hooks/project-desktop-routing';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { Button, Card, Surface, Text } from '@/app/dotnaos-ui';
import type { RailAccount } from './account-menu';
import { EntitySwitcher, type SwitcherEntry } from './entity-switcher';
import { ProjectDetail } from './project-detail';
import { ProjectHomeOverview } from './project-home-overview';
import { SettingsView } from './settings-view';
import { projectRecordsForCodex, resolveProjectRepository } from './project-main-model';
import { cn } from '@/lib/utils';
import type { GitHistoryFocus } from './git-focused-history';

function isVisibleProject(project: ProjectSpaceRecord) {
  const folder = project.rootPath.split('/').filter(Boolean).pop() ?? '';

  return !folder.startsWith('.') && !folder.endsWith('.worktrees');
}

interface BreadcrumbSegment {
  label: string;
  onPress?(): void;
}

function HeaderBreadcrumbs({
  onBack,
  segments,
  switcher
}: {
  onBack?(): void;
  segments: BreadcrumbSegment[];
  switcher?: React.ReactNode;
}) {
  return (
    <div className="app-no-drag relative flex min-w-0 items-center gap-1">
      {onBack ? (
        <Button
          aria-label="Back"
          isIconOnly
          size="sm"
          variant="ghost"
          onPress={onBack}
          className="mr-1 h-8 w-8 min-w-0 rounded-lg px-0 text-neutral-500 hover:text-neutral-100"
        >
          <ArrowLeft className="size-4" />
        </Button>
      ) : null}

      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1">
        {segments.map((segment, index) => {
          const isLast = index === segments.length - 1 && !switcher;

          return (
            <span key={`${segment.label}-${index}`} className="flex min-w-0 items-center gap-1">
              {index > 0 ? (
                <ChevronRight className="size-3 shrink-0 text-neutral-700" strokeWidth={1.8} />
              ) : null}
              {segment.onPress && !isLast ? (
                <button
                  type="button"
                  onClick={segment.onPress}
                  className="hidden min-w-0 rounded-md px-1.5 py-1 text-left text-xs text-neutral-500 transition hover:bg-neutral-900 hover:text-neutral-200 sm:block"
                >
                  <span className="block max-w-[10rem] truncate">{segment.label}</span>
                </button>
              ) : (
                <Text
                  className={
                    isLast
                      ? 'min-w-0 truncate px-1 text-[15px] font-semibold text-neutral-100'
                      : 'hidden min-w-0 truncate px-1.5 py-1 text-xs text-neutral-500 sm:block'
                  }
                >
                  {segment.label}
                </Text>
              )}
            </span>
          );
        })}
        {switcher ? (
          <>
            {segments.length > 0 ? (
              <ChevronRight
                className="hidden size-3 shrink-0 text-neutral-700 sm:block"
                strokeWidth={1.8}
              />
            ) : null}
            {switcher}
          </>
        ) : null}
      </nav>
    </div>
  );
}

function EmptyProjectView({ onCreateProject }: { onCreateProject(): void }) {
  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col justify-center gap-4">
      <Card variant="secondary" className="w-full border border-neutral-800/80 bg-neutral-950/70">
        <Card.Header className="gap-3">
          <Text className="text-[11px] uppercase tracking-[0.18em] text-neutral-500">
            No project selected
          </Text>
          <Card.Title className="text-2xl font-semibold tracking-tight text-neutral-50">
            Pick a project from the sidebar
          </Card.Title>
          <Card.Description className="text-base text-neutral-400">
            Or add a project directory to discover it.
          </Card.Description>
        </Card.Header>
        <Card.Footer>
          <Button variant="outline" onPress={onCreateProject}>
            Add project directory
          </Button>
        </Card.Footer>
      </Card>
    </div>
  );
}

function tabNeedsRepository(tab: ProjectDetailTab) {
  return (
    tab === 'issues' ||
    tab === 'machines' ||
    tab === 'workspaces' ||
    tab === 'chat' ||
    tab === 'history' ||
    tab === 'deployments'
  );
}

export interface ProjectMainPanelProps {
  account?: RailAccount;
  appMeta: AppMeta;
  computeInventory?: ProjectCliComputeInventory;
  computeInventoryError: string;
  computeInventoryStatus: 'error' | 'loading' | 'ready' | 'refreshing';
  codexController: CodexSessionsController;
  codexMachineIds: string[];
  githubCatalog: GitHubCatalogResult;
  hasBottomTabBar?: boolean;
  historyFocus?: GitHistoryFocus;
  isGitHubRefreshing: boolean;
  launcherApps: LauncherAppRecord[];
  launcherError: string;
  mainView: ProjectMainView;
  onCreateProject(): void;
  onOpenChat(): void;
  onOpenCodex(target?: CodexSessionTarget): void;
  onOpenProjects(): void;
  onOpenProjectChat(projectId: string): void;
  onOpenProjectIssue(issueNumber: number, projectIdOverride?: string): void;
  onOpenProjectHistory(focus: Omit<GitHistoryFocus, 'requestId'>): void;
  onOpenProjectWorkflowRun(runId: number): void;
  onCloseProjectWorkflowRun(): void;
  onOpenRoot(): void;
  onOpenSelectedTarget(): void;
  onRefreshProjectDiscovery(): Promise<unknown>;
  onRefreshComputeInventory(): Promise<unknown>;
  onRefreshGitHubCatalog(forceRefresh?: boolean): Promise<GitHubCatalogResult>;
  onRefreshProjectWorktrees(): Promise<ProjectWorktreeRecord[]>;
  onSelectLauncherApp(appId: string): void;
  onSelectProject(projectId: string): void;
  onSelectProjectTab(tab: ProjectDetailTab): void;
  onSelectWorkspace(): void;
  onSelectWorktree(worktreeId: string): void;
  project?: ProjectSpaceRecord;
  projects: ProjectSpaceRecord[];
  projectTab: ProjectDetailTab;
  recentProjectIds: string[];
  selectedApp?: LauncherAppRecord;
  selectedCodexOrigin?: CodexSessionTarget;
  selectedAppLabel?: string;
  selectedExplorerTarget: ExplorerTarget;
  selectedIssueNumber?: number;
  selectedWorkflowRunId?: number;
  selectedTargetPath: string;
  settingsSection: SettingsSection;
  structureViolations: ProjectStructureViolationRecord[];
  useWorkspaceChrome?: boolean;
  worktreeDiscovery: ProjectWorktreeDiscoveryState;
  worktrees: ProjectWorktreeRecord[];
}

export function ProjectMainPanel({
  account,
  appMeta,
  computeInventory,
  computeInventoryError,
  computeInventoryStatus,
  codexController,
  codexMachineIds,
  githubCatalog,
  hasBottomTabBar = false,
  historyFocus,
  isGitHubRefreshing,
  launcherApps,
  launcherError,
  mainView,
  onCreateProject,
  onOpenChat,
  onOpenCodex,
  onOpenProjects,
  onOpenProjectChat,
  onOpenProjectHistory,
  onOpenProjectIssue,
  onOpenProjectWorkflowRun,
  onCloseProjectWorkflowRun,
  onOpenRoot,
  onOpenSelectedTarget,
  onRefreshProjectDiscovery,
  onRefreshComputeInventory,
  onRefreshGitHubCatalog,
  onRefreshProjectWorktrees,
  onSelectLauncherApp,
  onSelectProject,
  onSelectProjectTab,
  onSelectWorkspace,
  onSelectWorktree,
  project,
  projects,
  projectTab,
  recentProjectIds,
  selectedApp,
  selectedCodexOrigin,
  selectedAppLabel,
  selectedExplorerTarget,
  selectedIssueNumber,
  selectedWorkflowRunId,
  selectedTargetPath,
  settingsSection,
  structureViolations,
  useWorkspaceChrome = false,
  worktreeDiscovery,
  worktrees
}: ProjectMainPanelProps) {
  const selectedRepository = useMemo(
    () => resolveProjectRepository(project, githubCatalog),
    [githubCatalog, project]
  );
  const selectedChatRepository = useMemo(() => (
    project?.github
      ? githubCatalog.repositories.find(
          (repository) => repository.fullName.toLowerCase() === project.github!.fullName.toLowerCase()
        ) ?? selectedRepository
      : selectedRepository
  ), [githubCatalog.repositories, project, selectedRepository]);
  const projectCodexRecords = useMemo(() => {
    return projectRecordsForCodex(
      project,
      projects,
      selectedChatRepository?.fullName ?? project?.github?.fullName
    );
  }, [project, projects, selectedChatRepository?.fullName]);
  useEffect(() => {
    if (
      mainView !== 'project' ||
      !project ||
      (project.github && projectTab !== 'chat') ||
      (selectedRepository && projectTab !== 'chat') ||
      !tabNeedsRepository(projectTab) ||
      isGitHubRefreshing ||
      githubCatalog.checkedAt ||
      githubCatalog.status === 'connected'
    ) {
      return;
    }

    void onRefreshGitHubCatalog();
  }, [
    githubCatalog.checkedAt,
    githubCatalog.status,
    isGitHubRefreshing,
    mainView,
    onRefreshGitHubCatalog,
    project,
    projectTab,
    selectedRepository
  ]);

  const projectSwitcherEntries = useMemo<SwitcherEntry[]>(() => {
    return projects
      .filter(isVisibleProject)
      .map((entry) => ({
        id: entry.id,
        label: entry.github?.name ?? entry.name,
        sublabel: entry.github?.owner ?? (entry.kind === 'github' ? 'GitHub' : 'Local')
      }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [projects]);

  const handleBack = useCallback(() => {
    if (mainView === 'project') {
      onOpenProjects();
      return;
    }

    onOpenRoot();
  }, [mainView, onOpenProjects, onOpenRoot]);

  const homeSegment: BreadcrumbSegment = { label: 'Home', onPress: onOpenRoot };

  let segments: BreadcrumbSegment[] = [{ label: 'Home' }];
  let switcher: React.ReactNode;
  let onBack: (() => void) | undefined;

  if (mainView === 'machines' || mainView === 'machine') {
    segments = [homeSegment, { label: 'Settings' }];
    onBack = handleBack;
  } else if (mainView === 'projects') {
    segments = [homeSegment, { label: 'Projects' }];
    onBack = handleBack;
  } else if (mainView === 'project') {
    segments = [homeSegment, { label: 'Projects', onPress: onOpenProjects }];
    switcher = (
      <div className="flex min-w-0 items-center gap-1.5">
        <EntitySwitcher
          ariaLabel="Switch project"
          currentLabel={project?.github?.name ?? project?.name ?? 'No project selected'}
          entries={projectSwitcherEntries}
          selectedId={project?.id ?? ''}
          onSelect={onSelectProject}
        />
      </div>
    );
    onBack = handleBack;
  } else if (mainView === 'settings') {
    segments = [homeSegment, { label: 'Settings' }];
    onBack = handleBack;
  }

  const containsOwnScroll =
    mainView === 'project' &&
    project &&
    project.kind !== 'github' &&
    (projectTab === 'history' ||
      projectTab === 'issues' ||
      projectTab === 'chat' ||
      projectTab === 'template');

  if (mainView === 'chat') {
    return (
      <Surface
        variant="transparent"
        className={cn(
          'h-full min-h-0 overflow-hidden rounded-none bg-app-panel',
          hasBottomTabBar && 'pb-[calc(6.75rem+env(safe-area-inset-bottom))]'
        )}
      >
        <ProjectCodexChatPage controller={codexController} onOpenThread={onOpenCodex} />
      </Surface>
    );
  }

  if (mainView === 'codex') {
    return (
      <Surface
        variant="transparent"
        className={cn(
          'h-full min-h-0 overflow-hidden rounded-none bg-app-panel',
          hasBottomTabBar && 'pb-[calc(6.75rem+env(safe-area-inset-bottom))]'
        )}
      >
        <ProjectCodexChatPage
          controller={codexController}
          initialOrigin={selectedCodexOrigin}
          onOpenThread={onOpenCodex}
        />
      </Surface>
    );
  }

  return (
    <Surface variant="transparent" className="flex h-full min-h-0 flex-col rounded-none bg-app-panel">
      {useWorkspaceChrome ? null : <div className="relative flex h-14 shrink-0 items-center justify-between gap-3 pr-4 pl-4 sm:pr-6 sm:pl-6">
        <div className="app-drag absolute inset-0" />

        <HeaderBreadcrumbs onBack={onBack} segments={segments} switcher={switcher} />

        <div className="app-no-drag relative shrink-0" />
      </div>}

      <div
        data-testid="project-main-content"
        className={cn(
          'min-h-0 flex-1 overflow-x-hidden px-4 sm:px-8',
          useWorkspaceChrome ? 'pt-4 sm:pt-6' : 'pt-2',
          containsOwnScroll ? 'overflow-hidden' : 'overflow-y-auto'
        )}
        style={{
          paddingBottom: containsOwnScroll
            ? hasBottomTabBar
              ? 'calc(6.75rem + env(safe-area-inset-bottom))'
              : '0.5rem'
            : hasBottomTabBar
              ? 'calc(6.75rem + env(safe-area-inset-bottom))'
              : '2rem'
        }}
      >
        {mainView === 'projects' ? (
          <ProjectHomeOverview
            githubCatalog={githubCatalog}
            isGitHubRefreshing={isGitHubRefreshing}
            onRefreshGitHubCatalog={onRefreshGitHubCatalog}
            projects={projects}
            onSelectProject={onSelectProject}
            recentProjectIds={recentProjectIds}
          />
        ) : mainView === 'settings' || mainView === 'machines' || mainView === 'machine' ? (
          <SettingsView
            account={account}
            appMeta={appMeta}
            computeInventory={computeInventory}
            computeInventoryError={computeInventoryError}
            computeInventoryStatus={computeInventoryStatus}
            githubCatalog={githubCatalog}
            isGitHubRefreshing={isGitHubRefreshing}
            onRefreshComputeInventory={onRefreshComputeInventory}
            onRefreshGitHubCatalog={onRefreshGitHubCatalog}
            section={settingsSection}
          />
        ) : project ? (
          <CodexSessionsInventoryProvider
            controller={codexController}
            machineIds={codexMachineIds}
          >
          <ProjectDetail
            chat={(
              <ProjectCodexChatPage controller={codexController} />
            )}
            codex={(
              <ProjectCodexTasks
                controller={codexController}
                machineIds={codexMachineIds}
                mode="panel"
                onOpenTask={onOpenCodex}
                projectRecords={projectCodexRecords}
              />
            )}
            historyFocus={historyFocus}
            launcherError={launcherError}
            onOpenIssue={onOpenProjectIssue}
            onOpenHistory={onOpenProjectHistory}
            onOpenWorkflowRun={onOpenProjectWorkflowRun}
            onCloseWorkflowRun={onCloseProjectWorkflowRun}
            onRefreshWorktrees={onRefreshProjectWorktrees}
            onSelectTab={onSelectProjectTab}
            onSelectWorkspace={onSelectWorkspace}
            onSelectWorktree={onSelectWorktree}
            project={project}
            projects={projects}
            repositories={githubCatalog.repositories}
            selectedExplorerTarget={selectedExplorerTarget}
            selectedIssueNumber={selectedIssueNumber}
            selectedWorkflowRunId={selectedWorkflowRunId}
            selectedRepository={selectedRepository}
            selectedTargetPath={selectedTargetPath}
            showNavigationTabs={!useWorkspaceChrome}
            tab={projectTab}
            worktreeDiscovery={worktreeDiscovery}
            worktrees={worktrees}
          />
          </CodexSessionsInventoryProvider>
        ) : (
          <EmptyProjectView onCreateProject={onCreateProject} />
        )}
      </div>
    </Surface>
  );
}
