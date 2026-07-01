import type {
  ConnectorOverviewResult,
  ExplorerTarget,
  GitHubCatalogResult,
  LauncherAppRecord,
  MachineRecord,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import { useCallback, useMemo } from 'react';
import type { ProjectMainView } from '../hooks/use-project-desktop';
import { ChevronDown, ExternalLink, Play, Server } from 'lucide-react';
import { Button, Card, Chip, Surface, Text } from '@/app/dotnaos-ui';
import { OpenTargetDropdown } from './open-target-dropdown';
import { MachineDetailView } from './machine-detail-view';
import { MainBreadcrumbs, type MainBreadcrumbItem } from './project-main-breadcrumbs';
import { ProjectCliCommandPanel } from './project-cli-command-panel';
import { ProjectHomeOverview } from './project-home-overview';
import { ProjectOperationsPanel } from './project-operations-panel';
import { ProjectRootOverview } from './project-root-overview';
import { ProjectTemplateCheckPanel } from './project-template-check';
import { ProjectWorkspaceTools } from './project-workspace-tools';
import { ProjectctlManifestPanel } from './projectctl-manifest-panel';
import { RepositoryActivityPanel } from './repository-activity-panel';
import { resolveProjectRepository } from './project-main-model';

interface ProjectMainPanelProps {
  connectorOverview: ConnectorOverviewResult;
  githubCatalog: GitHubCatalogResult;
  hasBottomTabBar?: boolean;
  isConnectorRefreshing: boolean;
  isGitHubRefreshing: boolean;
  isSidebarOpen: boolean;
  launcherApps: LauncherAppRecord[];
  launcherError: string;
  mainView: ProjectMainView;
  selectedApp?: LauncherAppRecord;
  selectedAppLabel?: string;
  selectedExplorerTarget: ExplorerTarget;
  selectedMachine?: MachineRecord;
  selectedMachineId: string;
  selectedTargetName: string;
  selectedTargetPath: string;
  sidebarClosedPaddingLeft: number;
  project?: ProjectSpaceRecord;
  projects: ProjectSpaceRecord[];
  onCreateProject(): void;
  onOpenMachines(): void;
  onOpenMachine(machineId: string): void;
  onOpenProjects(): void;
  onOpenRoot(): void;
  onOpenSelectedTarget(): void;
  onRefreshConnectorOverview(): Promise<ConnectorOverviewResult>;
  onRefreshGitHubCatalog(): Promise<GitHubCatalogResult>;
  onSelectLauncherApp(appId: string): void;
  onSelectProject(projectId: string): void;
}

function ProjectHeaderTitle({
  mainView,
  project,
  selectedMachine,
  selectedTargetName
}: {
  mainView: ProjectMainView;
  project?: ProjectSpaceRecord;
  selectedMachine?: MachineRecord;
  selectedTargetName: string;
}) {
  return (
    <div className="relative flex min-w-0 items-center gap-3 leading-none">
      <Text className="truncate text-[15px] font-semibold text-neutral-100">
        {mainView === 'root'
          ? 'Project Space'
          : mainView === 'machines'
            ? 'Machines'
            : mainView === 'machine'
              ? selectedMachine?.name ?? 'Machine'
              : mainView === 'projects'
                ? 'Projects'
                : project?.name ?? 'No project selected'}
      </Text>
      {mainView === 'project' && project && project.kind !== 'github' ? (
        <div className="hidden sm:block">
          <Chip color="default" size="sm" variant="tertiary" className="shrink-0 text-neutral-400">
            {selectedTargetName}
          </Chip>
        </div>
      ) : null}
    </div>
  );
}

function GitHubProjectView({
  project,
  selectedRepository
}: {
  project: ProjectSpaceRecord & { github: NonNullable<ProjectSpaceRecord['github']> };
  selectedRepository?: ProjectSpaceRecord['github'];
}) {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-4">
      <section className="shrink-0 border-b border-neutral-800/70 pb-4">
        <Text className="block text-[11px] font-medium text-neutral-500">GitHub repository</Text>
        <Text className="mt-2 block truncate text-xl font-semibold text-neutral-50">
          {project.github.fullName}
        </Text>
        {project.github.description ? (
          <Text className="mt-2 block text-sm text-neutral-500">
            {project.github.description}
          </Text>
        ) : null}
      </section>

      <section className="grid gap-3 sm:grid-cols-2">
        <Surface
          variant="tertiary"
          className="rounded-lg border border-neutral-800 bg-neutral-950/45 p-4"
        >
          <Text className="block text-sm font-semibold text-neutral-100">Repository</Text>
          <div className="mt-3 grid gap-2 text-sm">
            <div className="flex justify-between gap-3">
              <Text className="text-neutral-500">Owner</Text>
              <Text className="truncate text-neutral-200">{project.github.owner}</Text>
            </div>
            <div className="flex justify-between gap-3">
              <Text className="text-neutral-500">Default branch</Text>
              <Text className="truncate text-neutral-200">
                {project.github.defaultBranch ?? 'unknown'}
              </Text>
            </div>
            <div className="flex justify-between gap-3">
              <Text className="text-neutral-500">Visibility</Text>
              <Text className="truncate text-neutral-200">
                {project.github.isPrivate ? 'Private' : 'Public'}
              </Text>
            </div>
          </div>
        </Surface>

        <Surface
          variant="tertiary"
          className="rounded-lg border border-neutral-800 bg-neutral-950/45 p-4"
        >
          <Text className="block text-sm font-semibold text-neutral-100">Project config</Text>
          <div className="mt-3 grid gap-2 text-sm">
            <div className="flex justify-between gap-3">
              <Text className="text-neutral-500">Status</Text>
              <Text className="truncate text-neutral-200">
                {project.github.projectConfig.status}
              </Text>
            </div>
            <div className="flex justify-between gap-3">
              <Text className="text-neutral-500">project.yaml</Text>
              <Text className="truncate text-neutral-200">
                {project.github.projectConfig.projectYaml ? 'Present' : 'Missing'}
              </Text>
            </div>
            <div className="flex justify-between gap-3">
              <Text className="text-neutral-500">template lock</Text>
              <Text className="truncate text-neutral-200">
                {project.github.projectConfig.templateLock ? 'Present' : 'Missing'}
              </Text>
            </div>
          </div>
        </Surface>
      </section>

      <a
        href={project.github.url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex w-fit items-center gap-2 rounded-lg bg-neutral-900 px-3 py-2 text-sm font-medium text-neutral-100 transition hover:bg-neutral-800"
      >
        Open on GitHub
        <ExternalLink className="size-4" />
      </a>

      <RepositoryActivityPanel repository={selectedRepository} />
    </div>
  );
}

function LocalProjectView({
  launcherError,
  project,
  selectedRepository,
  selectedTargetPath,
  targetLabel
}: {
  launcherError: string;
  project: ProjectSpaceRecord;
  selectedRepository?: ProjectSpaceRecord['github'];
  selectedTargetPath: string;
  targetLabel: string;
}) {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-4">
      <section className="shrink-0 border-b border-neutral-800/70 pb-4">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <Text className="block text-[11px] font-medium text-neutral-500">{targetLabel}</Text>
            <Text
              title={selectedTargetPath}
              className="mt-2 block truncate font-mono text-base font-medium text-neutral-50"
            >
              {selectedTargetPath}
            </Text>
          </div>
          <div className="min-w-[18rem] max-w-full">
            <ProjectTemplateCheckPanel check={project.fullstackTemplate} />
          </div>
        </div>

        {launcherError ? (
          <Surface
            variant="tertiary"
            className="mt-3 rounded-lg border border-amber-400/20 bg-amber-500/8 px-4 py-3 text-sm text-amber-300"
          >
            {launcherError}
          </Surface>
        ) : null}
      </section>

      <RepositoryActivityPanel repository={selectedRepository} />

      <section className="grid gap-3 lg:grid-cols-2">
        <Surface
          variant="tertiary"
          className="rounded-lg border border-neutral-800 bg-neutral-950/45 p-4"
        >
          <div className="mb-3 flex items-center gap-2">
            <Play className="size-4 text-neutral-400" />
            <Text className="text-sm font-semibold text-neutral-100">Actions</Text>
          </div>
          <Button variant="secondary" isDisabled={!project}>
            Start developing a new feature
          </Button>
        </Surface>

        <Surface
          variant="tertiary"
          className="rounded-lg border border-neutral-800 bg-neutral-950/45 p-4"
        >
          <div className="mb-3 flex items-center gap-2">
            <Server className="size-4 text-neutral-400" />
            <Text className="text-sm font-semibold text-neutral-100">
              Machines developing this project
            </Text>
          </div>
          <div className="rounded-md border border-neutral-800 bg-neutral-950/50 px-3 py-2">
            <Text className="block text-sm text-neutral-300">Local connector</Text>
            <Text className="block truncate font-mono text-xs text-neutral-500">
              {selectedTargetPath}
            </Text>
          </div>
        </Surface>
      </section>

      <ProjectWorkspaceTools targetPath={selectedTargetPath} />
      <ProjectCliCommandPanel project={project} targetPath={selectedTargetPath} />

      <details className="group shrink-0 border-t border-neutral-800/70 pt-3">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg py-2 text-sm font-medium text-neutral-300 hover:text-neutral-100">
          <ChevronDown
            className="size-4 text-neutral-500 transition group-open:rotate-180"
            strokeWidth={1.8}
          />
          Infrastructure and automation
          <Text className="text-xs font-normal text-neutral-500">
            connector, deploy, backup, scoped jobs
          </Text>
        </summary>
        <div className="grid gap-3 pt-2">
          <ProjectctlManifestPanel targetPath={selectedTargetPath} />
          <ProjectOperationsPanel projectName={project.name} targetPath={selectedTargetPath} />
        </div>
      </details>
    </div>
  );
}

function EmptyProjectView({
  onCreateProject
}: {
  onCreateProject(): void;
}) {
  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col justify-center gap-4">
      <Card variant="secondary" className="w-full border border-neutral-800/80 bg-neutral-950/70">
        <Card.Header className="gap-3">
          <Text className="text-[11px] uppercase tracking-[0.18em] text-neutral-500">
            No Projects
          </Text>
          <Card.Title className="text-2xl font-semibold tracking-tight text-neutral-50">
            Nothing selected yet
          </Card.Title>
          <Card.Description className="text-base text-neutral-400">
            Add projects to discover them.
          </Card.Description>
        </Card.Header>
        <Card.Footer>
          <Button variant="outline" onPress={onCreateProject}>
            Select project
          </Button>
        </Card.Footer>
      </Card>
      <ProjectOperationsPanel projectName="project-space" targetPath="" />
    </div>
  );
}

export function ProjectMainPanel({
  connectorOverview,
  githubCatalog,
  hasBottomTabBar = false,
  isConnectorRefreshing,
  isGitHubRefreshing,
  isSidebarOpen,
  launcherApps,
  launcherError,
  mainView,
  selectedApp,
  selectedAppLabel,
  selectedExplorerTarget,
  selectedMachine,
  selectedMachineId,
  selectedTargetName,
  selectedTargetPath,
  sidebarClosedPaddingLeft,
  project,
  projects,
  onCreateProject,
  onOpenMachines,
  onOpenMachine,
  onOpenProjects,
  onOpenRoot,
  onOpenSelectedTarget,
  onRefreshConnectorOverview,
  onRefreshGitHubCatalog,
  onSelectLauncherApp,
  onSelectProject
}: ProjectMainPanelProps) {
  const headerSafeInset = isSidebarOpen ? 0 : sidebarClosedPaddingLeft;
  const targetLabel =
    selectedExplorerTarget.kind === 'worktree' ? 'Worktree path' : 'Workspace path';
  const selectedRepository = useMemo(
    () => resolveProjectRepository(project, githubCatalog),
    [githubCatalog, project]
  );
  const mainBreadcrumbItems = useMemo<MainBreadcrumbItem[]>(() => {
    if (mainView === 'root') {
      return [];
    }

    const homeItem: MainBreadcrumbItem = {
      label: 'Home',
      onPress: onOpenRoot
    };

    if (mainView === 'machines') {
      return [homeItem, { label: 'Machines' }];
    }

    if (mainView === 'machine') {
      return [
        homeItem,
        { label: 'Machines', onPress: onOpenMachines },
        { label: selectedMachine?.name ?? (selectedMachineId || 'Machine') }
      ];
    }

    if (mainView === 'projects') {
      return [homeItem, { label: 'Projects' }];
    }

    return [
      homeItem,
      { label: 'Projects', onPress: onOpenProjects },
      { label: project?.name ?? 'Project' }
    ];
  }, [
    mainView,
    onOpenMachines,
    onOpenProjects,
    onOpenRoot,
    project?.name,
    selectedMachine?.name,
    selectedMachineId
  ]);
  const handleMainBack = useCallback(() => {
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

  return (
    <Surface variant="transparent" className="flex min-h-0 flex-col rounded-none bg-app-panel">
      <div
        className="relative flex h-14 items-center justify-between pr-4 sm:pr-6"
        style={{
          paddingLeft: isSidebarOpen ? '2rem' : `${sidebarClosedPaddingLeft}px`
        }}
      >
        <div
          className="app-drag absolute inset-y-0 right-0"
          style={{
            left: `${headerSafeInset}px`
          }}
        />

        <ProjectHeaderTitle
          mainView={mainView}
          project={project}
          selectedMachine={selectedMachine}
          selectedTargetName={selectedTargetName}
        />

        {mainView === 'project' && project?.kind !== 'github' ? (
          <div className="app-no-drag relative">
            <OpenTargetDropdown
              apps={launcherApps}
              disabled={!project || !selectedTargetPath}
              onOpen={onOpenSelectedTarget}
              onSelectApp={onSelectLauncherApp}
              selectedApp={selectedApp}
              selectedAppLabel={selectedAppLabel}
            />
          </div>
        ) : null}
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 pt-4 sm:px-8"
        style={{
          paddingBottom: hasBottomTabBar ? 'calc(6.75rem + env(safe-area-inset-bottom))' : '2rem'
        }}
      >
        <MainBreadcrumbs
          items={mainBreadcrumbItems}
          onBack={mainView === 'root' ? undefined : handleMainBack}
        />

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
          />
        ) : mainView === 'machine' ? (
          <MachineDetailView
            connector={connectorOverview}
            machine={selectedMachine}
            machineId={selectedMachineId}
            onOpenMachines={onOpenMachines}
            onSelectProject={onSelectProject}
            projects={projects}
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
        ) : project?.kind === 'github' && project.github ? (
          <GitHubProjectView project={project as ProjectSpaceRecord & { github: NonNullable<ProjectSpaceRecord['github']> }} selectedRepository={selectedRepository} />
        ) : project ? (
          <LocalProjectView
            launcherError={launcherError}
            project={project}
            selectedRepository={selectedRepository}
            selectedTargetPath={selectedTargetPath}
            targetLabel={targetLabel}
          />
        ) : (
          <EmptyProjectView onCreateProject={onCreateProject} />
        )}
      </div>
    </Surface>
  );
}
