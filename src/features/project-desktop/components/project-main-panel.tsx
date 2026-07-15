import type {
  AppMeta,
  ConnectorOverviewResult,
  ExplorerTarget,
  GitHubCatalogResult,
  LauncherAppRecord,
  MachineRecord,
  ProjectSpaceRecord,
  ProjectStructureViolationRecord,
  ProjectWorktreeDiscoveryState,
  ProjectWorktreeRecord
} from '@/shared/project-space-api';
import { useCallback, useEffect, useMemo } from 'react';
import { createProjectChatClient } from '@/api/project-chat-client';
import { refreshProjectSpaceAuthToken } from '@/api/project-space-client';
import { ProjectChatWorkspace } from '@/features/project-chat/project-chat-workspace';
import { CodexSessionsControllerPage } from '@/features/codex-sessions/codex-sessions-controller-page';
import type { CodexSessionsController } from '@/features/codex-sessions/codex-sessions-controller';
import type { CodexSessionTarget } from '@/features/codex-sessions/codex-session-route';
import { ProjectTopologyProductionRoute } from '@/features/project-topology/project-topology-production-route';
import { ProjectHomeCommandCenter } from '@/features/project-topology/project-home-command-center';
import { projectChatProjectId } from '@/shared/project-chat-project';
import type {
  MachineDetailTab,
  ProjectDetailTab,
  ProjectMainView
} from '../hooks/use-project-desktop';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { Button, Card, Surface, Text } from '@/app/dotnaos-ui';
import type { RailAccount } from './app-rail';
import { EntitySwitcher, type SwitcherEntry } from './entity-switcher';
import { MachineDetailView } from './machine-detail-view';
import { ProjectDetail } from './project-detail';
import { ProjectHomeOverview } from './project-home-overview';
import { ProjectRootSummary } from './project-root-summary';
import { SettingsView } from './settings-view';
import { resolveProjectRepository } from './project-main-model';
import { cn } from '@/lib/utils';

const projectChatClient = createProjectChatClient({
  getAuthToken: refreshProjectSpaceAuthToken
});

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

function normalizeBranchKey(value: string | undefined) {
  return value?.trim().replace(/^refs\/heads\//, '').toLowerCase() ?? '';
}

function normalizeComparablePath(value: string | undefined) {
  return value?.replace(/^~(?=\/)/, '').replace(/\/+$/, '').toLowerCase() ?? '';
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
  connectorOverview: ConnectorOverviewResult;
  codexController: CodexSessionsController;
  codexMachineIds: string[];
  githubCatalog: GitHubCatalogResult;
  hasBottomTabBar?: boolean;
  isConnectorRefreshing: boolean;
  isGitHubRefreshing: boolean;
  launcherApps: LauncherAppRecord[];
  launcherError: string;
  machineTab: MachineDetailTab;
  mainView: ProjectMainView;
  onCreateProject(): void;
  onOpenChat(): void;
  onOpenCodex(target?: CodexSessionTarget): void;
  onOpenMachine(machineId: string, tab?: MachineDetailTab): void;
  onOpenMachines(): void;
  onOpenProjects(): void;
  onOpenProjectChat(projectId: string): void;
  onOpenProjectIssue(issueNumber: number, projectIdOverride?: string): void;
  onOpenProjectWorkflowRun(runId: number): void;
  onCloseProjectWorkflowRun(): void;
  onOpenRoot(): void;
  onOpenSelectedTarget(): void;
  onRefreshProjectDiscovery(): Promise<unknown>;
  onRefreshConnectorOverview(): Promise<ConnectorOverviewResult>;
  onRefreshGitHubCatalog(forceRefresh?: boolean): Promise<GitHubCatalogResult>;
  onRefreshProjectWorktrees(): Promise<ProjectWorktreeRecord[]>;
  onSelectLauncherApp(appId: string): void;
  onSelectMachineContext(machineId: string): void;
  onSelectMachineTab(tab: MachineDetailTab): void;
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
  selectedMachine?: MachineRecord;
  selectedMachineId: string;
  selectedTargetPath: string;
  structureViolations: ProjectStructureViolationRecord[];
  worktreeDiscovery: ProjectWorktreeDiscoveryState;
  worktrees: ProjectWorktreeRecord[];
}

export function ProjectMainPanel({
  account,
  appMeta,
  connectorOverview,
  codexController,
  codexMachineIds,
  githubCatalog,
  hasBottomTabBar = false,
  isConnectorRefreshing,
  isGitHubRefreshing,
  launcherApps,
  launcherError,
  machineTab,
  mainView,
  onCreateProject,
  onOpenChat,
  onOpenCodex,
  onOpenMachine,
  onOpenMachines,
  onOpenProjects,
  onOpenProjectChat,
  onOpenProjectIssue,
  onOpenProjectWorkflowRun,
  onCloseProjectWorkflowRun,
  onOpenRoot,
  onOpenSelectedTarget,
  onRefreshProjectDiscovery,
  onRefreshConnectorOverview,
  onRefreshGitHubCatalog,
  onRefreshProjectWorktrees,
  onSelectLauncherApp,
  onSelectMachineContext,
  onSelectMachineTab,
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
  selectedMachine,
  selectedMachineId,
  selectedTargetPath,
  structureViolations,
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

  function openProjectWorktreeBranch(machineId: string, branchName: string, path?: string) {
    onSelectMachineContext(machineId);

    const branchKey = normalizeBranchKey(branchName);
    const pathKey = normalizeComparablePath(path);
    const projectBranchKey = normalizeBranchKey(project?.gitStatus?.branchName);
    const projectPathKey = normalizeComparablePath(project?.rootPath);
    const matchingWorktree = worktrees.find((worktree) => {
      if (pathKey && normalizeComparablePath(worktree.path) === pathKey) {
        return true;
      }

      return normalizeBranchKey(worktree.branchName || worktree.name) === branchKey;
    });

    if (
      matchingWorktree &&
      !matchingWorktree.isBase &&
      normalizeComparablePath(matchingWorktree.path) !== projectPathKey
    ) {
      onSelectWorktree(matchingWorktree.id);
    } else if (!branchKey || branchKey === 'main' || branchKey === projectBranchKey || pathKey === projectPathKey) {
      onSelectWorkspace();
    }

    onSelectProjectTab('workspaces');
  }

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

  const machineSwitcherEntries = useMemo<SwitcherEntry[]>(() => {
    return connectorOverview.machines.map((machine) => ({
      id: machine.id,
      label: machine.name,
      sublabel: machine.connector.status
    }));
  }, [connectorOverview.machines]);

  const topologyNavigation = useMemo(() => ({
    openCoordinator(target: { kind: 'lead' } | {
      chatProjectId: string;
      kind: 'project-lead';
      projectId: string;
    }) {
      if (target.kind === 'project-lead') {
        onOpenProjectChat(target.chatProjectId);
        return;
      }
      onOpenChat();
    },
    openIssue(projectId: string, issueNumber: number) {
      onOpenProjectIssue(issueNumber, projectId);
    },
    resetFocus() {}
  }), [onOpenChat, onOpenProjectChat, onOpenProjectIssue]);

  const handleBack = useCallback(() => {
    if (mainView === 'machine') {
      onOpenMachines();
      return;
    }

    if (mainView === 'project') {
      onOpenProjects();
      return;
    }

    onOpenRoot();
  }, [mainView, onOpenMachines, onOpenProjects, onOpenRoot]);

  const homeSegment: BreadcrumbSegment = { label: 'Home', onPress: onOpenRoot };

  let segments: BreadcrumbSegment[] = [{ label: 'Home' }];
  let switcher: React.ReactNode;
  let onBack: (() => void) | undefined;

  if (mainView === 'machines') {
    segments = [homeSegment, { label: 'Machines' }];
    onBack = handleBack;
  } else if (mainView === 'machine') {
    segments = [homeSegment, { label: 'Machines', onPress: onOpenMachines }];
    switcher = (
      <EntitySwitcher
        ariaLabel="Switch machine"
        currentLabel={selectedMachine?.name ?? (selectedMachineId || 'Machine')}
        entries={machineSwitcherEntries}
        selectedId={selectedMachineId}
        onSelect={onOpenMachine}
      />
    );
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
        <EntitySwitcher
          ariaLabel="Switch machine context"
          currentLabel={selectedMachine?.name ?? (selectedMachineId || 'Machine')}
          entries={machineSwitcherEntries}
          selectedId={selectedMachineId}
          onSelect={onSelectMachineContext}
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
    (projectTab === 'history' || projectTab === 'issues' || projectTab === 'chat');

  const rootSummary = (
    <ProjectRootSummary
      connector={
        isConnectorRefreshing
          ? { state: 'loading' }
          : connectorOverview.connectorOrigin ||
              connectorOverview.machinesRepo.path ||
              connectorOverview.machines.length > 0 ||
              connectorOverview.tailscale.installed
            ? {
                checkedAt: new Date().toISOString(),
                state: 'ready',
                value: connectorOverview
              }
            : {
                message: 'Machine information is not available yet.',
                state: 'blocked'
              }
      }
      onRetry={() => {
        void onRefreshConnectorOverview();
      }}
      projects={projects.filter(isVisibleProject)}
      recentProjectIds={recentProjectIds}
    />
  );

  if (mainView === 'chat') {
    return (
      <Surface
        variant="transparent"
        className={cn(
          'h-full min-h-0 overflow-hidden rounded-none bg-app-panel',
          hasBottomTabBar && 'pb-[calc(6.75rem+env(safe-area-inset-bottom))]'
        )}
      >
        <ProjectChatWorkspace
          client={projectChatClient}
          onOpenThread={onOpenCodex}
          recentProjectIds={recentProjectIds}
        />
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
        <CodexSessionsControllerPage
          controller={codexController}
          machineIds={codexMachineIds}
          onOpenThread={onOpenCodex}
          selectedOrigin={selectedCodexOrigin}
        />
      </Surface>
    );
  }

  if (mainView === 'root' || mainView === 'topology') {
    return (
      <ProjectHomeCommandCenter
        hasBottomTabBar={hasBottomTabBar}
        map={(
          <ProjectTopologyProductionRoute
            hasBottomTabBar={hasBottomTabBar}
            hasHomeViewSwitcher
            navigation={topologyNavigation}
          />
        )}
        summary={rootSummary}
      />
    );
  }

  return (
    <Surface variant="transparent" className="flex min-h-0 flex-col rounded-none bg-app-panel">
      <div className="relative flex h-14 shrink-0 items-center justify-between gap-3 pr-4 pl-4 sm:pr-6 sm:pl-6">
        <div className="app-drag absolute inset-0" />

        <HeaderBreadcrumbs onBack={onBack} segments={segments} switcher={switcher} />

        <div className="app-no-drag relative shrink-0" />
      </div>

      <div
        data-testid="project-main-content"
        className={cn(
          'min-h-0 flex-1 overflow-x-hidden px-4 pt-2 sm:px-8',
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
        {mainView === 'machines' || mainView === 'projects' ? (
          <ProjectHomeOverview
            connector={connectorOverview}
            githubCatalog={githubCatalog}
            isConnectorRefreshing={isConnectorRefreshing}
            isGitHubRefreshing={isGitHubRefreshing}
            mode={mainView}
            onRefreshConnector={onRefreshConnectorOverview}
            onRefreshGitHubCatalog={onRefreshGitHubCatalog}
            onSelectMachine={onOpenMachine}
            projects={projects}
            onSelectProject={onSelectProject}
            recentProjectIds={recentProjectIds}
          />
        ) : mainView === 'machine' ? (
          <MachineDetailView
            connector={connectorOverview}
            machine={selectedMachine}
            machineId={selectedMachineId}
            onOpenMachines={onOpenMachines}
            onSelectProject={onSelectProject}
            onSelectTab={onSelectMachineTab}
            onRefreshProjectDiscovery={onRefreshProjectDiscovery}
            projects={projects}
            structureViolations={structureViolations}
            tab={machineTab}
          />
        ) : mainView === 'settings' ? (
          <SettingsView
            account={account}
            appMeta={appMeta}
            connectorOverview={connectorOverview}
            githubCatalog={githubCatalog}
            isGitHubRefreshing={isGitHubRefreshing}
            onRefreshGitHubCatalog={onRefreshGitHubCatalog}
          />
        ) : project ? (
          <ProjectDetail
            chat={(
              <ProjectChatWorkspace
                client={projectChatClient}
                fixedProjectId={projectChatProjectId(project, selectedChatRepository)}
                onOpenThread={onOpenCodex}
                showChannelNavigation={false}
              />
            )}
            connectorOverview={connectorOverview}
            launcherError={launcherError}
            onOpenMachine={onOpenMachine}
            onOpenWorktreeBranch={openProjectWorktreeBranch}
            onOpenIssue={onOpenProjectIssue}
            onOpenWorkflowRun={onOpenProjectWorkflowRun}
            onCloseWorkflowRun={onCloseProjectWorkflowRun}
            onRefreshWorktrees={onRefreshProjectWorktrees}
            onSelectTab={onSelectProjectTab}
            onSelectWorkspace={onSelectWorkspace}
            onSelectWorktree={onSelectWorktree}
            project={project}
            projects={projects}
            selectedExplorerTarget={selectedExplorerTarget}
            selectedIssueNumber={selectedIssueNumber}
            selectedWorkflowRunId={selectedWorkflowRunId}
            selectedRepository={selectedRepository}
            selectedTargetPath={selectedTargetPath}
            selectedMachineId={selectedMachineId}
            tab={projectTab}
            worktreeDiscovery={worktreeDiscovery}
            worktrees={worktrees}
          />
        ) : (
          <EmptyProjectView onCreateProject={onCreateProject} />
        )}
      </div>
    </Surface>
  );
}
