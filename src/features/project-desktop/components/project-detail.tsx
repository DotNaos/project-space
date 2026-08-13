import { useMemo, useState } from 'react';
import {
  ExternalLink,
  FileCheck2,
} from 'lucide-react';
import {
  Button,
  Chip,
  Surface,
  Tab,
  TabList,
  Tabs,
  Text
} from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type {
  ConnectorOverviewResult,
  ExplorerTarget,
  FullstackTemplateCheck,
  GitHubCatalogRepository,
  ProjectSpaceRecord,
  ProjectWorktreeDiscoveryState,
  ProjectWorktreeRecord
} from '@/shared/project-space-api';
import type { MachineDetailTab, ProjectDetailTab } from '../hooks/use-project-desktop';
import { GitWorkbenchPanel } from './git-workbench-panel';
import { ProjectTasksExperience } from '@/features/project-tasks/project-tasks-experience';
import { ProjectMachinesPanel } from './project-machines-panel';
import { ProjectDeploymentsPanel } from './project-deployments-panel';
import { ProjectOverviewWorkbench } from './project-overview-workbench';
import { ProjectRepositoryPanel } from './project-repository-panel';
import { ProjectTemplateAdherencePanel } from './project-template-adherence-panel';
import { ProjectTemplateSetupPanel } from './project-template-setup-panel';
import { ProjectTemplatePage } from '@/features/project-template/project-template-page';
import { ProjectctlManifestPanel } from './projectctl-manifest-panel';
import { RepositoryActivityPanel } from './repository-activity-panel';
import { projectTabItems } from './project-detail-tabs';
import type { GitHistoryFocus } from './git-focused-history';

const templateStatusTitle: Record<FullstackTemplateCheck['status'], string> = {
  implemented: 'Implemented',
  partial: 'Partial',
  'not-detected': 'Not detected',
  'template-source': 'Template source'
};

function templateChipClass(status: FullstackTemplateCheck['status'] | undefined) {
  if (status === 'implemented' || status === 'template-source') {
    return 'bg-emerald-500/10 text-emerald-300';
  }

  if (status === 'partial') {
    return 'bg-amber-500/10 text-amber-300';
  }

  return 'bg-neutral-800/80 text-neutral-400';
}

function normalizeTemplateRelativePath(value: string) {
  return value
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/');
}

function joinTargetPath(rootPath: string, relativePath: string) {
  const normalizedRelativePath = normalizeTemplateRelativePath(relativePath);

  if (!rootPath || !normalizedRelativePath) {
    return rootPath;
  }

  return `${rootPath.replace(/\/+$/, '')}/${normalizedRelativePath}`;
}

function TemplateStatusCard({ check }: { check?: FullstackTemplateCheck }) {
  const status = check?.status ?? 'not-detected';
  const matched = check?.matched ?? [];
  const missing = check?.missing ?? [];
  const missingPreview = missing.slice(0, 12);
  const remainingMissing = Math.max(0, missing.length - missingPreview.length);

  return (
    <Surface
      variant="tertiary"
      className="min-w-0 rounded-lg border border-neutral-800 bg-neutral-950/45 p-4"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <FileCheck2 className="size-4 shrink-0 text-neutral-400" />
        <Text className="text-sm font-semibold text-neutral-100">Fullstack template</Text>
        <span
          className={cn(
            'rounded-full px-2.5 py-1 text-xs font-medium',
            templateChipClass(status)
          )}
        >
          {templateStatusTitle[status]}
        </span>
        {check ? (
          <Text className="text-xs text-neutral-500">
            {check.score}% · {missing.length} gaps
          </Text>
        ) : null}
      </div>

      <div className="mt-3">
        {check ? (
          missing.length > 0 ? (
            <div className="flex min-w-0 flex-wrap gap-1.5">
              {missingPreview.map((item) => (
                <Chip key={item} size="sm" variant="secondary" className="max-w-full">
                  <span className="truncate">{item}</span>
                </Chip>
              ))}
              {remainingMissing > 0 ? (
                <Chip size="sm" variant="tertiary">
                  +{remainingMissing}
                </Chip>
              ) : null}
            </div>
          ) : (
            <Text className="text-sm text-neutral-500">
              {matched.length} template checks matched.
            </Text>
          )
        ) : (
          <Text className="text-sm text-neutral-500">
            No template markers were detected in this workspace. Initialize it from the fullstack
            template to start tracking status here.
          </Text>
        )}
      </div>
    </Surface>
  );
}

function OverviewTab({
  connectorOverview,
  launcherError,
  onOpenIssue,
  onOpenDeployments,
  project,
  selectedRepository,
  selectedTargetPath
}: {
  connectorOverview: ConnectorOverviewResult;
  launcherError: string;
  onOpenIssue(issueNumber: number): void;
  onOpenDeployments(): void;
  project: ProjectSpaceRecord;
  selectedRepository?: ProjectSpaceRecord['github'];
  selectedTargetPath: string;
}) {
  return (
    <ProjectOverviewWorkbench
      connectorOverview={connectorOverview}
      launcherError={launcherError}
      onOpenIssue={onOpenIssue}
      onOpenDeployments={onOpenDeployments}
      project={project}
      repository={selectedRepository}
      selectedTargetPath={selectedTargetPath}
    />
  );
}

function GitHubProjectOverview({
  onOpenIssue,
  project,
  selectedRepository
}: {
  onOpenIssue(issueNumber: number): void;
  project: ProjectSpaceRecord & { github: NonNullable<ProjectSpaceRecord['github']> };
  selectedRepository?: ProjectSpaceRecord['github'];
}) {
  return (
    <div className="flex min-h-full w-full flex-col gap-4">
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
          className="min-w-0 rounded-lg border border-neutral-800 bg-neutral-950/45 p-4"
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
          className="min-w-0 rounded-lg border border-neutral-800 bg-neutral-950/45 p-4"
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

      <RepositoryActivityPanel repository={selectedRepository} onOpenIssue={onOpenIssue} />
    </div>
  );
}

export interface ProjectDetailProps {
  chat: React.ReactNode;
  codex: React.ReactNode;
  connectorOverview: ConnectorOverviewResult;
  historyFocus?: GitHistoryFocus;
  launcherError: string;
  onOpenMachine(machineId: string, tab?: MachineDetailTab): void;
  onOpenWorktreeBranch(machineId: string, branchName: string, path?: string): void;
  onOpenIssue(issueNumber: number, projectIdOverride?: string): void;
  onOpenHistory(focus: Omit<GitHistoryFocus, 'requestId'>): void;
  onOpenWorkflowRun(runId: number): void;
  onCloseWorkflowRun(): void;
  onRefreshWorktrees(): Promise<ProjectWorktreeRecord[]>;
  onSelectMachine(machineId: string): void;
  onSelectTab(tab: ProjectDetailTab): void;
  onSelectWorkspace(): void;
  onSelectWorktree(worktreeId: string): void;
  project: ProjectSpaceRecord;
  projects: ProjectSpaceRecord[];
  repositories: GitHubCatalogRepository[];
  selectedExplorerTarget: ExplorerTarget;
  selectedIssueNumber?: number;
  selectedWorkflowRunId?: number;
  selectedRepository?: ProjectSpaceRecord['github'];
  selectedTargetPath: string;
  selectedMachineId: string;
  showNavigationTabs?: boolean;
  tab: ProjectDetailTab;
  worktreeDiscovery: ProjectWorktreeDiscoveryState;
  worktrees: ProjectWorktreeRecord[];
}

export function ProjectDetail({
  chat,
  codex,
  connectorOverview,
  historyFocus,
  launcherError,
  onOpenMachine,
  onOpenWorktreeBranch,
  onOpenIssue,
  onOpenHistory,
  onOpenWorkflowRun,
  onCloseWorkflowRun,
  onRefreshWorktrees,
  onSelectMachine,
  onSelectTab,
  onSelectWorkspace,
  onSelectWorktree,
  project,
  projects,
  repositories,
  selectedExplorerTarget,
  selectedIssueNumber,
  selectedWorkflowRunId,
  selectedRepository,
  selectedTargetPath,
  selectedMachineId,
  showNavigationTabs = true,
  tab,
  worktreeDiscovery,
  worktrees
}: ProjectDetailProps) {
  const [templateRefreshKey, setTemplateRefreshKey] = useState(0);
  const [templateRelativePath, setTemplateRelativePath] = useState('');
  const containsOwnScroll =
    tab === 'history' ||
    tab === 'issues' ||
    tab === 'chat' ||
    tab === 'codex' ||
    tab === 'template' ||
    tab === 'workspaces';
  const templateTargetPath = joinTargetPath(selectedTargetPath, templateRelativePath);

  return (
    <div
      className={cn(
        'mx-auto flex w-full flex-col gap-4',
        tab === 'issues' || tab === 'roadmap' ? 'max-w-[90rem]' : 'max-w-5xl',
        containsOwnScroll || tab === 'roadmap' ? 'h-full min-h-0 overflow-hidden' : 'min-h-full'
      )}
    >
      {showNavigationTabs ? <div className="-mx-1 shrink-0 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <Tabs
          selectedKey={projectTabItems.some((item) => item.id === tab) ? tab : 'overview'}
          onSelectionChange={(key) => {
            const nextTab = projectTabItems.find((item) => item.id === key);

            if (nextTab) {
              onSelectTab(nextTab.id);
            }
          }}
        >
          <TabList className="inline-flex min-w-max gap-1 rounded-xl bg-neutral-900/60 p-1">
            {projectTabItems.map((item) => {
              const Icon = item.icon;

              return (
                <Tab key={item.id} id={item.id} className="min-h-8 gap-1.5 px-3 text-xs">
                  <Icon className="size-3.5" />
                  {item.label}
                </Tab>
              );
            })}
          </TabList>
        </Tabs>
      </div> : null}

      <div className="min-h-0 flex-1">
        {tab === 'overview' ? (
          project.kind === 'github' && project.github ? (
            <GitHubProjectOverview
              onOpenIssue={onOpenIssue}
              project={
                project as ProjectSpaceRecord & {
                  github: NonNullable<ProjectSpaceRecord['github']>;
                }
              }
              selectedRepository={selectedRepository}
            />
          ) : (
            <OverviewTab
              connectorOverview={connectorOverview}
              launcherError={launcherError}
              onOpenIssue={onOpenIssue}
              onOpenDeployments={() => onSelectTab('deployments')}
              project={project}
              selectedRepository={selectedRepository}
              selectedTargetPath={selectedTargetPath}
            />
          )
        ) : null}

        {tab === 'machines' ? (
          <ProjectMachinesPanel
            connectorOverview={connectorOverview}
            onOpenMachine={onOpenMachine}
            onOpenWorktreeBranch={onOpenWorktreeBranch}
            project={project}
            projects={projects}
            repository={selectedRepository}
          />
        ) : null}

        {tab === 'workspaces' ? (
          <ProjectRepositoryPanel
            connectorOverview={connectorOverview}
            onOpenHistory={onOpenHistory}
            onRefreshWorktrees={onRefreshWorktrees}
            onSelectMachine={onSelectMachine}
            onSelectWorkspace={onSelectWorkspace}
            onSelectWorktree={onSelectWorktree}
            project={project}
            repository={selectedRepository}
            selectedExplorerTarget={selectedExplorerTarget}
            selectedMachineId={selectedMachineId}
            worktreeDiscovery={worktreeDiscovery}
            worktrees={worktrees}
          />
        ) : null}

        {tab === 'chat' ? (
          <div className="h-full min-h-0 overflow-hidden">{chat}</div>
        ) : null}

        {tab === 'history' ? (
          <GitWorkbenchPanel
            connectorOverview={connectorOverview}
            onOpenMachine={onOpenMachine}
            project={project}
            projects={projects}
            repository={selectedRepository}
            repositoryFullName={selectedRepository?.fullName}
            targetPath={selectedTargetPath}
            focus={historyFocus}
          />
        ) : null}

        {tab === 'issues' || tab === 'roadmap' ? (
          <ProjectTasksExperience
            connectorOverview={connectorOverview}
            onOpenHistory={onOpenHistory}
            onOpenTask={onOpenIssue}
            onShowTasks={() => onSelectTab('issues')}
            project={project}
            projects={projects}
            repositories={repositories}
            repository={selectedRepository}
            selectedIssueNumber={selectedIssueNumber}
            targetPath={selectedTargetPath}
          />
        ) : null}

        {tab === 'template' ? (
          <ProjectTemplatePage
            projectCheck={(
              <div className="flex flex-col gap-4">
                <ProjectTemplateSetupPanel
                  connectorOverview={connectorOverview}
                  onSelectWorkspace={onSelectWorkspace}
                  onSelectWorktree={onSelectWorktree}
                  onTemplateRelativePathChange={setTemplateRelativePath}
                  onTemplateChanged={() => setTemplateRefreshKey((current) => current + 1)}
                  preferredMachineId={selectedMachineId}
                  project={project}
                  relativePath={templateRelativePath}
                  resolvedTargetPath={templateTargetPath}
                  selectedExplorerTarget={selectedExplorerTarget}
                  showMachineSelector={false}
                  targetRootPath={selectedTargetPath}
                  worktrees={worktrees}
                />
                <ProjectTemplateAdherencePanel
                  refreshKey={templateRefreshKey}
                  targetPath={templateTargetPath}
                />
                <TemplateStatusCard check={project.fullstackTemplate} />
                <ProjectctlManifestPanel targetPath={templateTargetPath} />
              </div>
            )}
          />
        ) : null}

        {tab === 'deployments' ? (
          <ProjectDeploymentsPanel
            onCloseWorkflowRun={onCloseWorkflowRun}
            onOpenWorkflowRun={onOpenWorkflowRun}
            projectId={project.id}
            projectName={project.name}
            repository={selectedRepository ?? project.github}
            selectedWorkflowRunId={selectedWorkflowRunId}
            targetPath={selectedTargetPath}
          />
        ) : null}

        {tab === 'codex' ? codex : null}
      </div>
    </div>
  );
}
