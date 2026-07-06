import { useState } from 'react';
import {
  Bot,
  Check,
  Copy,
  ExternalLink,
  FileCheck2,
  GitBranchPlus,
  GitGraph,
  LayoutDashboard,
  ListChecks,
  Rocket,
  Server,
  SquareTerminal
} from 'lucide-react';
import {
  Button,
  Chip,
  ListBox,
  ListBoxItem,
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
  ProjectSpaceRecord,
  ProjectWorktreeRecord
} from '@/shared/project-space-api';
import type { ProjectDetailTab } from '../hooks/use-project-desktop';
import { FileExplorer } from './file-explorer';
import { GitWorkbenchPanel } from './git-workbench-panel';
import { ProjectCliCommandPanel } from './project-cli-command-panel';
import { ProjectTemplateAdherencePanel } from './project-template-adherence-panel';
import { ProjectIssueDetailPanel } from './project-issue-detail-panel';
import { ProjectMachinesPanel } from './project-machines-panel';
import { ProjectDeploymentsPanel } from './project-deployments-panel';
import { ProjectOverviewWorkbench } from './project-overview-workbench';
import { ProjectCodexPanel, ProjectWorkspaceTools } from './project-workspace-tools';
import { ProjectctlManifestPanel } from './projectctl-manifest-panel';
import { RepositoryActivityPanel } from './repository-activity-panel';
import { ScopeDevboxJobPanel } from './scope-devbox-job-panel';

const templateChipLabel: Record<FullstackTemplateCheck['status'], string> = {
  implemented: 'template ok',
  partial: 'template partial',
  'not-detected': 'no template',
  'template-source': 'template source'
};

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

function CopyPathButton({ path }: { path: string }) {
  const [hasCopied, setHasCopied] = useState(false);

  async function copy() {
    await navigator.clipboard?.writeText(path);
    setHasCopied(true);
    window.setTimeout(() => setHasCopied(false), 1_500);
  }

  return (
    <Button
      aria-label="Copy path"
      isIconOnly
      size="sm"
      variant="ghost"
      onPress={() => void copy()}
      className="h-7 w-7 min-w-0 rounded-lg px-0 text-neutral-500 hover:text-neutral-100"
    >
      {hasCopied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </Button>
  );
}

interface ProjectIdentityStripProps {
  onOpenTemplateTab(): void;
  project: ProjectSpaceRecord;
  selectedTargetName: string;
  selectedTargetPath: string;
  targetLabel: string;
}

function ProjectIdentityStrip({
  onOpenTemplateTab,
  project,
  selectedTargetName,
  selectedTargetPath,
  targetLabel
}: ProjectIdentityStripProps) {
  const templateStatus = project.fullstackTemplate?.status;

  return (
    <section className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-neutral-800/70 pb-4">
      <Text className="shrink-0 text-xs font-medium text-neutral-500">{targetLabel}</Text>
      <div className="flex min-w-0 items-center gap-1">
        <Text
          title={selectedTargetPath}
          className="block truncate font-mono text-sm text-neutral-200"
        >
          {selectedTargetPath || 'No local checkout'}
        </Text>
        {selectedTargetPath ? <CopyPathButton path={selectedTargetPath} /> : null}
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <Chip size="sm" variant="tertiary" className="text-neutral-400">
          {selectedTargetName}
        </Chip>
        <button
          type="button"
          onClick={onOpenTemplateTab}
          title="Open template status"
          className={cn(
            'rounded-full px-2.5 py-1 text-xs font-medium transition hover:brightness-125',
            templateChipClass(templateStatus)
          )}
        >
          {templateChipLabel[templateStatus ?? 'not-detected']}
        </button>
      </div>
    </section>
  );
}

function OverviewTab({
  connectorOverview,
  launcherError,
  onOpenIssue,
  project,
  selectedRepository,
  selectedTargetPath
}: {
  connectorOverview: ConnectorOverviewResult;
  launcherError: string;
  onOpenIssue(issueNumber: number): void;
  project: ProjectSpaceRecord;
  selectedRepository?: ProjectSpaceRecord['github'];
  selectedTargetPath: string;
}) {
  return (
    <ProjectOverviewWorkbench
      connectorOverview={connectorOverview}
      launcherError={launcherError}
      onOpenIssue={onOpenIssue}
      project={project}
      repository={selectedRepository}
      selectedTargetPath={selectedTargetPath}
    />
  );
}

function WorkspacesTab({
  onOpenNewWorktree,
  onSelectWorkspace,
  onSelectWorktree,
  project,
  selectedExplorerTarget,
  selectedTargetPath,
  worktrees
}: {
  onOpenNewWorktree(): void;
  onSelectWorkspace(): void;
  onSelectWorktree(worktreeId: string): void;
  project: ProjectSpaceRecord;
  selectedExplorerTarget: ExplorerTarget;
  selectedTargetPath: string;
  worktrees: ProjectWorktreeRecord[];
}) {
  const activeItemId =
    selectedExplorerTarget.kind === 'workspace'
      ? 'workspace'
      : `worktree:${selectedExplorerTarget.worktreeId}`;

  return (
    <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
      <Surface
        variant="tertiary"
        className="flex min-h-0 flex-col rounded-lg border border-neutral-800 bg-neutral-950/45 p-3"
      >
        <div className="mb-2 flex items-center justify-between gap-2 px-1">
          <Text className="text-sm font-semibold text-neutral-100">Working targets</Text>
          <Button size="sm" variant="ghost" onPress={onOpenNewWorktree}>
            <GitBranchPlus className="size-4" />
            New worktree
          </Button>
        </div>

        <ListBox
          aria-label={`${project.name} targets`}
          disallowEmptySelection
          selectedKeys={new Set([activeItemId])}
          selectionMode="single"
          onAction={(key) => {
            const value = String(key);

            if (value === 'workspace') {
              onSelectWorkspace();
              return;
            }

            if (value.startsWith('worktree:')) {
              onSelectWorktree(value.slice('worktree:'.length));
            }
          }}
          className="space-y-1"
        >
          <ListBoxItem
            id="workspace"
            textValue="Workspace"
            className={cn(
              'rounded-xl transition',
              selectedExplorerTarget.kind === 'workspace'
                ? 'bg-neutral-700/70 text-neutral-50'
                : 'text-neutral-400 hover:bg-neutral-800/70 hover:text-neutral-100'
            )}
          >
            <div className="flex w-full items-center gap-2 px-3 py-2 text-left">
              <span className="min-w-0 flex-1 truncate text-sm font-medium">Workspace</span>
              {project.kind === 'workspace' ? (
                <Chip size="sm" variant="soft" className="shrink-0 uppercase tracking-[0.16em]">
                  root
                </Chip>
              ) : null}
            </div>
          </ListBoxItem>
          {worktrees.map((worktree) => {
            const isSelected =
              selectedExplorerTarget.kind === 'worktree' &&
              selectedExplorerTarget.worktreeId === worktree.id;
            const tone =
              worktree.status === 'broken' ? 'broken' : worktree.isBase ? 'base' : 'default';

            return (
              <ListBoxItem
                key={worktree.id}
                id={`worktree:${worktree.id}`}
                textValue={worktree.name}
                className={cn(
                  'rounded-xl transition',
                  isSelected
                    ? 'bg-neutral-700/70 text-neutral-50'
                    : tone === 'base'
                      ? 'bg-emerald-500/6 text-emerald-100 hover:bg-emerald-500/10'
                      : tone === 'broken'
                        ? 'bg-amber-500/6 text-amber-100 hover:bg-amber-500/10'
                        : 'text-neutral-400 hover:bg-neutral-800/70 hover:text-neutral-100'
                )}
              >
                <div className="flex w-full items-center gap-2 px-3 py-2 text-left">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {worktree.name}
                  </span>
                  {tone !== 'default' ? (
                    <Chip
                      color={tone === 'base' ? 'success' : 'warning'}
                      size="sm"
                      variant="soft"
                      className="shrink-0 uppercase tracking-[0.16em]"
                    >
                      {tone === 'base' ? 'base' : 'broken'}
                    </Chip>
                  ) : null}
                </div>
              </ListBoxItem>
            );
          })}
        </ListBox>
      </Surface>

      <Surface
        variant="tertiary"
        className="flex min-h-[24rem] flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950/45"
      >
        <FileExplorer rootPath={selectedTargetPath || undefined} />
      </Surface>
    </div>
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

const projectTabItems: Array<{
  icon: typeof LayoutDashboard;
  id: ProjectDetailTab;
  label: string;
}> = [
  { icon: LayoutDashboard, id: 'overview', label: 'Overview' },
  { icon: ListChecks, id: 'issues', label: 'Issues' },
  { icon: Server, id: 'machines', label: 'Machines' },
  { icon: GitBranchPlus, id: 'workspaces', label: 'Workspaces' },
  { icon: GitGraph, id: 'history', label: 'History' },
  { icon: SquareTerminal, id: 'terminal', label: 'Terminal' },
  { icon: Bot, id: 'codex', label: 'Codex' },
  { icon: FileCheck2, id: 'template', label: 'Template' },
  { icon: Rocket, id: 'deployments', label: 'Deployments' },
  { icon: Bot, id: 'automation', label: 'Automation' }
];

export interface ProjectDetailProps {
  connectorOverview: ConnectorOverviewResult;
  launcherError: string;
  onOpenNewWorktree(): void;
  onOpenIssue(issueNumber: number): void;
  onSelectTab(tab: ProjectDetailTab): void;
  onSelectWorkspace(): void;
  onSelectWorktree(worktreeId: string): void;
  project: ProjectSpaceRecord;
  projects: ProjectSpaceRecord[];
  selectedExplorerTarget: ExplorerTarget;
  selectedIssueNumber?: number;
  selectedRepository?: ProjectSpaceRecord['github'];
  selectedTargetName: string;
  selectedTargetPath: string;
  tab: ProjectDetailTab;
  worktrees: ProjectWorktreeRecord[];
}

export function ProjectDetail({
  connectorOverview,
  launcherError,
  onOpenNewWorktree,
  onOpenIssue,
  onSelectTab,
  onSelectWorkspace,
  onSelectWorktree,
  project,
  projects,
  selectedExplorerTarget,
  selectedIssueNumber,
  selectedRepository,
  selectedTargetName,
  selectedTargetPath,
  tab,
  worktrees
}: ProjectDetailProps) {
  if (project.kind === 'github' && project.github) {
    return (
      <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col">
        <GitHubProjectOverview
          onOpenIssue={onOpenIssue}
          project={project as ProjectSpaceRecord & { github: NonNullable<ProjectSpaceRecord['github']> }}
          selectedRepository={selectedRepository}
        />
      </div>
    );
  }

  const targetLabel =
    selectedExplorerTarget.kind === 'worktree' ? 'Worktree path' : 'Workspace path';
  const containsOwnScroll = tab === 'history' || tab === 'issues';

  return (
    <div
      className={cn(
        'mx-auto flex w-full max-w-5xl flex-col gap-4',
        containsOwnScroll ? 'h-full min-h-0 overflow-hidden' : 'min-h-full'
      )}
    >
      <ProjectIdentityStrip
        onOpenTemplateTab={() => onSelectTab('template')}
        project={project}
        selectedTargetName={selectedTargetName}
        selectedTargetPath={selectedTargetPath}
        targetLabel={targetLabel}
      />

      <div className="-mx-1 shrink-0 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
      </div>

      <div className="min-h-0 flex-1">
        {tab === 'overview' ? (
          <OverviewTab
            connectorOverview={connectorOverview}
            launcherError={launcherError}
            onOpenIssue={onOpenIssue}
            project={project}
            selectedRepository={selectedRepository}
            selectedTargetPath={selectedTargetPath}
          />
        ) : null}

        {tab === 'machines' ? (
          <ProjectMachinesPanel
            connectorOverview={connectorOverview}
            project={project}
            projects={projects}
            repository={selectedRepository}
          />
        ) : null}

        {tab === 'workspaces' ? (
          <WorkspacesTab
            onOpenNewWorktree={onOpenNewWorktree}
            onSelectWorkspace={onSelectWorkspace}
            onSelectWorktree={onSelectWorktree}
            project={project}
            selectedExplorerTarget={selectedExplorerTarget}
            selectedTargetPath={selectedTargetPath}
            worktrees={worktrees}
          />
        ) : null}

        {tab === 'history' ? (
          <GitWorkbenchPanel
            repositoryFullName={selectedRepository?.fullName}
            targetPath={selectedTargetPath}
          />
        ) : null}

        {tab === 'issues' ? (
          <ProjectIssueDetailPanel
            connectorOverview={connectorOverview}
            issueNumber={selectedIssueNumber}
            onBack={() => onSelectTab('issues')}
            onOpenIssue={onOpenIssue}
            project={project}
            projects={projects}
            repository={selectedRepository}
            targetPath={selectedTargetPath}
          />
        ) : null}

        {tab === 'template' ? (
          <div className="flex flex-col gap-4">
            <ProjectTemplateAdherencePanel targetPath={selectedTargetPath} />
            <TemplateStatusCard check={project.fullstackTemplate} />
            <ProjectCliCommandPanel project={project} targetPath={selectedTargetPath} />
            <ProjectctlManifestPanel targetPath={selectedTargetPath} />
          </div>
        ) : null}

        {tab === 'deployments' ? (
          <ProjectDeploymentsPanel
            projectName={project.name}
            repository={selectedRepository ?? project.github}
            targetPath={selectedTargetPath}
          />
        ) : null}

        {tab === 'automation' ? (
          <ScopeDevboxJobPanel
            connector={connectorOverview}
            projectName={project.name}
            targetPath={selectedTargetPath}
          />
        ) : null}

        {tab === 'codex' ? <ProjectCodexPanel targetPath={selectedTargetPath} /> : null}

        {tab === 'terminal' ? <ProjectWorkspaceTools targetPath={selectedTargetPath} /> : null}
      </div>
    </div>
  );
}
