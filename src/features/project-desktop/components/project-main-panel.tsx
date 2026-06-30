import type {
  ExplorerTarget,
  LauncherAppRecord,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import type { ProjectMainView } from '../hooks/use-project-desktop';
import { ChevronDown, FolderKanban, GitBranch, ListChecks, Play, Server } from 'lucide-react';
import { Button, Card, Chip, Surface, Text } from '@/app/dotnaos-ui';
import { OpenTargetDropdown } from './open-target-dropdown';
import { ProjectCliCommandPanel } from './project-cli-command-panel';
import { ProjectHomeOverview } from './project-home-overview';
import { ProjectOperationsPanel } from './project-operations-panel';
import { ProjectTemplateCheckPanel } from './project-template-check';
import { ProjectWorkspaceTools } from './project-workspace-tools';
import { ProjectctlManifestPanel } from './projectctl-manifest-panel';

interface ProjectMainPanelProps {
  discoveryRoot: string;
  isSidebarOpen: boolean;
  launcherApps: LauncherAppRecord[];
  launcherError: string;
  mainView: ProjectMainView;
  selectedApp?: LauncherAppRecord;
  selectedAppLabel?: string;
  selectedExplorerTarget: ExplorerTarget;
  selectedTargetName: string;
  selectedTargetPath: string;
  sidebarClosedPaddingLeft: number;
  project?: ProjectSpaceRecord;
  projects: ProjectSpaceRecord[];
  onCreateProject(): void;
  onOpenMachines(): void;
  onOpenProjects(): void;
  onOpenSelectedTarget(): void;
  onSelectLauncherApp(appId: string): void;
  onSelectProject(projectId: string): void;
}

export function ProjectMainPanel({
  discoveryRoot,
  isSidebarOpen,
  launcherApps,
  launcherError,
  mainView,
  selectedApp,
  selectedAppLabel,
  selectedExplorerTarget,
  selectedTargetName,
  selectedTargetPath,
  sidebarClosedPaddingLeft,
  project,
  projects,
  onCreateProject,
  onOpenMachines,
  onOpenProjects,
  onOpenSelectedTarget,
  onSelectLauncherApp,
  onSelectProject
}: ProjectMainPanelProps) {
  const headerSafeInset = isSidebarOpen ? 0 : sidebarClosedPaddingLeft;
  const targetLabel =
    selectedExplorerTarget.kind === 'worktree' ? 'Worktree Path' : 'Workspace Path';

  return (
    <Surface
      variant="transparent"
      className="flex min-h-0 flex-col rounded-none bg-app-panel"
    >
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

        <div className="relative flex min-w-0 items-center gap-3 leading-none">
          <Text className="truncate text-[15px] font-semibold text-slate-100">
            {mainView === 'machines'
              ? 'Machines'
              : mainView === 'projects'
                ? 'Projects'
                : project?.name ?? 'No project selected'}
          </Text>
          {mainView === 'project' && project ? (
            <div className="hidden sm:block">
              <Chip
                color="default"
                size="sm"
                variant="tertiary"
                className="shrink-0 uppercase tracking-[0.18em] text-slate-400"
              >
                {selectedTargetName}
              </Chip>
            </div>
          ) : null}
        </div>

        {mainView === 'project' ? (
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

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 pb-8 pt-4 sm:px-8">
        <div className="mb-4 grid grid-cols-2 gap-2 sm:hidden">
          <Button
            data-testid="mobile-nav-machines"
            variant={mainView === 'machines' ? 'secondary' : 'ghost'}
            onPress={onOpenMachines}
          >
            <Server className="size-4" />
            Machines
          </Button>
          <Button
            data-testid="mobile-nav-projects"
            variant={mainView === 'projects' ? 'secondary' : 'ghost'}
            onPress={onOpenProjects}
          >
            <FolderKanban className="size-4" />
            Projects
          </Button>
        </div>

        {mainView === 'machines' || mainView === 'projects' ? (
          <ProjectHomeOverview
            mode={mainView}
            projects={projects}
            onSelectProject={onSelectProject}
          />
        ) : project ? (
          <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-4">
            <section className="shrink-0 border-b border-slate-800/70 pb-4">
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <Text className="block text-[11px] uppercase tracking-[0.18em] text-slate-500">
                    {targetLabel}
                  </Text>
                  <Text
                    title={selectedTargetPath}
                    className="mt-2 block truncate font-mono text-base font-medium text-slate-50"
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

            <section className="grid gap-3 lg:grid-cols-2">
              <Surface
                variant="tertiary"
                className="rounded-lg border border-slate-800 bg-slate-950/45 p-4"
              >
                <div className="mb-3 flex items-center gap-2">
                  <Play className="size-4 text-slate-400" />
                  <Text className="text-sm font-semibold text-slate-100">Actions</Text>
                </div>
                <Button variant="secondary" isDisabled={!project}>
                  Start developing a new feature
                </Button>
              </Surface>

              <Surface
                variant="tertiary"
                className="rounded-lg border border-slate-800 bg-slate-950/45 p-4"
              >
                <div className="mb-3 flex items-center gap-2">
                  <ListChecks className="size-4 text-slate-400" />
                  <Text className="text-sm font-semibold text-slate-100">
                    Board / Issues / Features
                  </Text>
                </div>
                <Text className="text-sm text-slate-500">
                  GitHub issues and feature planning will live here for this project.
                </Text>
              </Surface>

              <Surface
                variant="tertiary"
                className="rounded-lg border border-slate-800 bg-slate-950/45 p-4"
              >
                <div className="mb-3 flex items-center gap-2">
                  <GitBranch className="size-4 text-slate-400" />
                  <Text className="text-sm font-semibold text-slate-100">Branches</Text>
                </div>
                <div className="grid gap-2">
                  <div className="flex items-center justify-between gap-3 rounded-md border border-slate-800 bg-slate-950/50 px-3 py-2">
                    <Text className="text-sm text-slate-300">Workspace</Text>
                    <Chip size="sm" variant="tertiary">
                      current
                    </Chip>
                  </div>
                </div>
              </Surface>

              <Surface
                variant="tertiary"
                className="rounded-lg border border-slate-800 bg-slate-950/45 p-4"
              >
                <div className="mb-3 flex items-center gap-2">
                  <Server className="size-4 text-slate-400" />
                  <Text className="text-sm font-semibold text-slate-100">
                    Machines developing this project
                  </Text>
                </div>
                <div className="rounded-md border border-slate-800 bg-slate-950/50 px-3 py-2">
                  <Text className="block text-sm text-slate-300">Local connector</Text>
                  <Text className="block truncate font-mono text-xs text-slate-500">
                    {selectedTargetPath}
                  </Text>
                </div>
              </Surface>
            </section>

            <ProjectWorkspaceTools targetPath={selectedTargetPath} />
            <ProjectCliCommandPanel project={project} targetPath={selectedTargetPath} />

            <details className="group shrink-0 border-t border-slate-800/70 pt-3">
              <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg py-2 text-sm font-medium text-slate-300 hover:text-slate-100">
                <ChevronDown
                  className="size-4 text-slate-500 transition group-open:rotate-180"
                  strokeWidth={1.8}
                />
                Infrastructure and automation
                <Text className="text-xs font-normal text-slate-500">
                  connector, deploy, backup, scoped jobs
                </Text>
              </summary>
              <div className="grid gap-3 pt-2">
                <ProjectctlManifestPanel targetPath={selectedTargetPath} />
                <ProjectOperationsPanel projectName={project.name} targetPath={selectedTargetPath} />
              </div>
            </details>
          </div>
        ) : (
          <div className="mx-auto flex h-full w-full max-w-6xl flex-col justify-center gap-4">
            <Card
              variant="secondary"
              className="w-full border border-slate-800/80 bg-slate-950/70"
            >
              <Card.Header className="gap-3">
                <Text className="text-[11px] uppercase tracking-[0.18em] text-slate-500">
                  No Projects
                </Text>
                <Card.Title className="text-2xl font-semibold tracking-tight text-slate-50">
                  Nothing selected yet
                </Card.Title>
                <Card.Description className="text-base text-slate-400">
                  Add projects under {discoveryRoot || '~/projects'} to discover them.
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
        )}
      </div>
    </Surface>
  );
}
