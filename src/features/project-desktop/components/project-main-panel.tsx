import type {
  ConnectorOverviewResult,
  ExplorerTarget,
  GitHubCatalogResult,
  LauncherAppRecord,
  MachineRecord,
  ProjectSpaceRecord,
  ProjectStructureViolationRecord,
  ProjectWorktreeRecord
} from '@/shared/project-space-api';
import { useCallback, useMemo } from 'react';
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
import { ProjectRootOverview } from './project-root-overview';
import { SettingsView } from './settings-view';
import { resolveProjectRepository } from './project-main-model';
import { cn } from '@/lib/utils';

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

export interface ProjectMainPanelProps {
  account?: RailAccount;
  connectorOverview: ConnectorOverviewResult;
  githubCatalog: GitHubCatalogResult;
  hasBottomTabBar?: boolean;
  isConnectorRefreshing: boolean;
  isGitHubRefreshing: boolean;
  launcherApps: LauncherAppRecord[];
  launcherError: string;
  machineTab: MachineDetailTab;
  mainView: ProjectMainView;
  onCreateProject(): void;
  onOpenMachine(machineId: string): void;
  onOpenMachines(): void;
  onOpenNewWorktree(): void;
  onOpenProjects(): void;
  onOpenProjectIssue(issueNumber: number): void;
  onOpenRoot(): void;
  onOpenSelectedTarget(): void;
  onRefreshProjectDiscovery(): Promise<unknown>;
  onRefreshConnectorOverview(): Promise<ConnectorOverviewResult>;
  onRefreshGitHubCatalog(): Promise<GitHubCatalogResult>;
  onSelectLauncherApp(appId: string): void;
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
  selectedAppLabel?: string;
  selectedExplorerTarget: ExplorerTarget;
  selectedIssueNumber?: number;
  selectedMachine?: MachineRecord;
  selectedMachineId: string;
  selectedTargetName: string;
  selectedTargetPath: string;
  structureViolations: ProjectStructureViolationRecord[];
  worktrees: ProjectWorktreeRecord[];
}

export function ProjectMainPanel({
  account,
  connectorOverview,
  githubCatalog,
  hasBottomTabBar = false,
  isConnectorRefreshing,
  isGitHubRefreshing,
  launcherApps,
  launcherError,
  machineTab,
  mainView,
  onCreateProject,
  onOpenMachine,
  onOpenMachines,
  onOpenNewWorktree,
  onOpenProjects,
  onOpenProjectIssue,
  onOpenRoot,
  onOpenSelectedTarget,
  onRefreshProjectDiscovery,
  onRefreshConnectorOverview,
  onRefreshGitHubCatalog,
  onSelectLauncherApp,
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
  selectedAppLabel,
  selectedExplorerTarget,
  selectedIssueNumber,
  selectedMachine,
  selectedMachineId,
  selectedTargetName,
  selectedTargetPath,
  structureViolations,
  worktrees
}: ProjectMainPanelProps) {
  const selectedRepository = useMemo(
    () => resolveProjectRepository(project, githubCatalog),
    [githubCatalog, project]
  );

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
      <EntitySwitcher
        ariaLabel="Switch project"
        currentLabel={project?.github?.name ?? project?.name ?? 'No project selected'}
        entries={projectSwitcherEntries}
        selectedId={project?.id ?? ''}
        onSelect={onSelectProject}
      />
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
    (projectTab === 'history' || projectTab === 'issues');

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
            ? '0.5rem'
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
        ) : mainView === 'root' ? (
          <ProjectRootOverview
            connector={connectorOverview}
            onOpenMachine={onOpenMachine}
            onOpenMachines={onOpenMachines}
            onOpenProjects={onOpenProjects}
            onSelectProject={onSelectProject}
            projects={projects}
          />
        ) : mainView === 'settings' ? (
          <SettingsView
            account={account}
            connectorOverview={connectorOverview}
            githubCatalog={githubCatalog}
            isGitHubRefreshing={isGitHubRefreshing}
            onRefreshGitHubCatalog={onRefreshGitHubCatalog}
          />
        ) : project ? (
          <ProjectDetail
            connectorOverview={connectorOverview}
            launcherError={launcherError}
            onOpenNewWorktree={onOpenNewWorktree}
            onOpenIssue={onOpenProjectIssue}
            onSelectTab={onSelectProjectTab}
            onSelectWorkspace={onSelectWorkspace}
            onSelectWorktree={onSelectWorktree}
            project={project}
            projects={projects}
            selectedExplorerTarget={selectedExplorerTarget}
            selectedIssueNumber={selectedIssueNumber}
            selectedRepository={selectedRepository}
            selectedTargetName={selectedTargetName}
            selectedTargetPath={selectedTargetPath}
            tab={projectTab}
            worktrees={worktrees}
          />
        ) : (
          <EmptyProjectView onCreateProject={onCreateProject} />
        )}
      </div>
    </Surface>
  );
}
