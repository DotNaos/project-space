import { useEffect, useMemo, useState } from 'react';
import {
  ExternalLink,
  Grid2X2,
  Info,
  List,
  RefreshCw,
} from 'lucide-react';
import { Button, Chip, Tab, TabIndicator, TabList, Tabs, Text, Tooltip } from '@/app/dotnaos-ui';
import { projectSpaceClient } from '@/api/project-space-client';
import type {
  ConnectorOverviewResult,
  FullstackTemplateStatus,
  GitHubCatalogRepository,
  GitHubCatalogResult,
  GitHubProjectConfigStatus,
  MachineRecord,
  ProjectWorktreeRecord,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import {
  isMachineConnected,
  MachineBatteryMeter,
  MachineConnectionIcon,
  MachineDeviceIcon,
  MachineOsMark
} from './machine-visuals';

interface ProjectHomeOverviewProps {
  connector: ConnectorOverviewResult;
  githubCatalog: GitHubCatalogResult;
  isConnectorRefreshing: boolean;
  isGitHubRefreshing: boolean;
  mode: 'machines' | 'projects';
  onRefreshConnector(): Promise<ConnectorOverviewResult>;
  onRefreshGitHubCatalog(): Promise<GitHubCatalogResult>;
  onSelectMachine(machineId: string): void;
  projects: ProjectSpaceRecord[];
  onSelectProject(projectId: string): void;
}

interface LocalMatch {
  machineId: string;
  project: ProjectSpaceRecord;
}

interface MatrixRow {
  id: string;
  isLocalOnly: boolean;
  localMatches: LocalMatch[];
  repo?: GitHubCatalogRepository;
  title: string;
}

interface BranchChipRecord {
  isBase: boolean;
  name: string;
}

const templateStatusLabels: Record<FullstackTemplateStatus, string> = {
  implemented: 'ok',
  partial: 'partial',
  'not-detected': 'missing',
  'template-source': 'template'
};

function getMachineId(project: ProjectSpaceRecord) {
  return project.id.includes(':') ? project.id.slice(0, project.id.indexOf(':')) : 'local';
}

function getProjectMachineId(project: ProjectSpaceRecord, localMachineId: string) {
  const machineId = getMachineId(project);
  return machineId === 'local' ? localMachineId : machineId;
}

function getTemplateStatus(project: ProjectSpaceRecord): FullstackTemplateStatus {
  return project.fullstackTemplate?.status ?? 'not-detected';
}

function basename(path: string) {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}

function isVisibleLocalProject(project: ProjectSpaceRecord) {
  if (project.kind === 'github') {
    return false;
  }

  const projectFolder = basename(project.rootPath);

  return !projectFolder.startsWith('.') && !projectFolder.endsWith('.worktrees');
}

function normalizeKey(value: string) {
  return value.trim().replace(/^@/, '').toLowerCase();
}

function projectKeys(project: ProjectSpaceRecord) {
  const name = normalizeKey(project.name);
  const rootName = normalizeKey(basename(project.rootPath));
  const keys = new Set([name, rootName]);

  if (name.includes('/')) {
    keys.add(name.split('/').at(-1) ?? name);
  }

  return keys;
}

function projectMatchesRepo(project: ProjectSpaceRecord, repo: GitHubCatalogRepository) {
  const keys = projectKeys(project);
  const fullName = normalizeKey(repo.fullName);
  const name = normalizeKey(repo.name);

  return keys.has(fullName) || keys.has(name);
}

function isBaseBranchName(branchName: string, defaultBranch?: string) {
  const normalizedBranch = normalizeKey(branchName);
  const normalizedDefault = defaultBranch ? normalizeKey(defaultBranch) : '';

  return (
    (normalizedDefault && normalizedBranch === normalizedDefault) ||
    normalizedBranch === 'main' ||
    normalizedBranch === 'master'
  );
}

function branchesFromWorktrees(
  worktrees: ProjectWorktreeRecord[],
  defaultBranch?: string
): BranchChipRecord[] {
  const branches = new Map<string, BranchChipRecord>();

  for (const worktree of worktrees) {
    const branchName = worktree.branchName?.trim();

    if (!branchName) {
      continue;
    }

    branches.set(branchName, {
      isBase: isBaseBranchName(branchName, defaultBranch),
      name: branchName
    });
  }

  return Array.from(branches.values()).sort((left, right) => {
    if (left.isBase !== right.isBase) {
      return left.isBase ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });
}

function mergeBranchChips(
  defaultBranch: string | undefined,
  branchGroups: BranchChipRecord[][]
) {
  const branches = new Map<string, BranchChipRecord>();

  if (defaultBranch) {
    branches.set(defaultBranch, {
      isBase: true,
      name: defaultBranch
    });
  }

  for (const group of branchGroups) {
    for (const branch of group) {
      const existing = branches.get(branch.name);

      branches.set(branch.name, {
        isBase: existing?.isBase || branch.isBase || isBaseBranchName(branch.name, defaultBranch),
        name: branch.name
      });
    }
  }

  return Array.from(branches.values()).sort((left, right) => {
    if (left.isBase !== right.isBase) {
      return left.isBase ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });
}

function configChipClass(status: GitHubProjectConfigStatus | FullstackTemplateStatus) {
  if (status === 'complete' || status === 'implemented' || status === 'template-source') {
    return 'text-emerald-300';
  }

  if (status === 'partial') {
    return 'text-amber-300';
  }

  return 'text-neutral-500';
}

function formatLastSeen(value?: string) {
  if (!value) {
    return 'not seen';
  }

  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    return value;
  }

  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));

  if (minutes < 1) {
    return 'now';
  }

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

function DetailRow({ label, mono, value }: { label: string; mono?: boolean; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-[10px] font-medium text-neutral-500">{label}</span>
      <span
        className={[
          'min-w-0 truncate text-right text-neutral-200',
          mono ? 'font-mono text-[11px]' : 'text-xs'
        ].join(' ')}
      >
        {value}
      </span>
    </div>
  );
}

function MachineDetailsTooltip({
  machine,
  projectCount
}: {
  machine: MachineRecord;
  projectCount: number;
}) {
  const origin =
    machine.connector.origin ?? machine.network.tailscaleIp ?? machine.connector.installCommand;

  return (
    <Tooltip delay={150}>
      <Tooltip.Trigger className="inline-flex">
        <span
          aria-label={`${machine.name} details`}
          className="inline-flex size-5 items-center justify-center rounded-full text-neutral-600 transition hover:text-neutral-300"
        >
          <Info className="size-3.5" strokeWidth={1.8} />
        </span>
      </Tooltip.Trigger>
      <Tooltip.Content className="w-56 space-y-1.5">
        {machine.connector.serviceName ? (
          <DetailRow label="Service" value={machine.connector.serviceName} />
        ) : null}
        <DetailRow label="Status" value={machine.connector.status} />
        <DetailRow label="Projects" value={String(projectCount)} />
        <DetailRow label="Last seen" value={formatLastSeen(machine.connector.lastSeen)} />
        {origin ? <DetailRow label="Origin" mono value={origin} /> : null}
      </Tooltip.Content>
    </Tooltip>
  );
}

function BranchChips({ branches }: { branches: BranchChipRecord[] }) {
  if (branches.length === 0) {
    return null;
  }

  const visibleBranches = branches.slice(0, 3);
  const hiddenCount = branches.length - visibleBranches.length;

  return (
    <div
      aria-label="Branches"
      className="flex max-w-[17rem] shrink-0 items-center gap-1 overflow-x-auto"
    >
      {visibleBranches.map((branch) => (
        <span
          key={branch.name}
          title={branch.name}
          className={[
            'inline-flex max-w-28 shrink-0 items-center truncate rounded-full px-2 py-0.5 text-[11px] font-medium',
            branch.isBase
              ? 'bg-neutral-100 text-neutral-950'
              : 'bg-neutral-800/80 text-neutral-300'
          ].join(' ')}
        >
          {branch.name}
        </span>
      ))}
      {hiddenCount > 0 ? (
        <span
          title={branches.slice(3).map((branch) => branch.name).join(', ')}
          className="inline-flex shrink-0 rounded-full bg-neutral-900 px-2 py-0.5 text-[11px] font-medium text-neutral-500"
        >
          +{hiddenCount}
        </span>
      ) : null}
    </div>
  );
}

export function ProjectHomeOverview({
  connector,
  githubCatalog,
  isConnectorRefreshing,
  isGitHubRefreshing,
  mode,
  onRefreshConnector,
  onRefreshGitHubCatalog,
  onSelectMachine,
  projects,
  onSelectProject
}: ProjectHomeOverviewProps) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [branchRecordsByProjectId, setBranchRecordsByProjectId] = useState<
    Record<string, BranchChipRecord[]>
  >({});
  const [layout, setLayout] = useState<'grid' | 'list'>('list');
  const [selectedMachineId, setSelectedMachineId] = useState('');

  async function refresh(includeConnector: boolean) {
    setIsRefreshing(true);
    try {
      const refreshTasks: Promise<unknown>[] = [
        onRefreshGitHubCatalog()
      ];

      if (includeConnector) {
        refreshTasks.push(onRefreshConnector());
      }

      await Promise.all(refreshTasks);
    } finally {
      setIsRefreshing(false);
    }
  }

  const machines = useMemo(() => {
    if (connector.machines.length > 0) {
      return connector.machines;
    }

    return [
      {
        connector: {
          installCommand: 'project-space connector install',
          lastSeen: new Date().toISOString(),
          status: 'local' as const
        },
        id: projects[0] ? getMachineId(projects[0]) : 'local',
        kind: 'local',
        name: projects[0] ? getMachineId(projects[0]) : 'local machine',
        network: {},
        roles: ['connector'],
        sourcePath: ''
      }
    ];
  }, [connector.machines, projects]);

  const machinesById = useMemo(
    () => new Map(machines.map((machine) => [machine.id, machine])),
    [machines]
  );
  const localMachineId =
    machines.find((machine) => machine.connector.status === 'local')?.id ??
    machines[0]?.id ??
    'local';
  const connectedMachines = machines.filter(isMachineConnected);
  const disconnectedMachines = machines.filter((machine) => !isMachineConnected(machine));
  const activeMachineId = selectedMachineId || localMachineId || machines[0]?.id || '';
  const activeMachine = machinesById.get(activeMachineId);

  const rows = useMemo<MatrixRow[]>(() => {
    const repositories =
      githubCatalog.status === 'connected'
        ? [...githubCatalog.repositories].sort((left, right) =>
            left.fullName.localeCompare(right.fullName)
          )
        : [];
    const matchedProjectIds = new Set<string>();
    const repoRows = repositories.map((repo) => {
      const localMatches = projects
        .filter((project) => projectMatchesRepo(project, repo))
        .map((project) => {
          matchedProjectIds.add(project.id);
          return {
            machineId: getProjectMachineId(project, localMachineId),
            project
          };
        });

      return {
        id: `github:${repo.id}`,
        isLocalOnly: false,
        localMatches,
        repo,
        title: repo.fullName
      };
    });

    const localOnlyRows = projects
      .filter((project) => project.kind !== 'github' && !matchedProjectIds.has(project.id))
      .map((project) => ({
        id: `local:${project.id}`,
        isLocalOnly: true,
        localMatches: [
          {
            machineId: getProjectMachineId(project, localMachineId),
            project
          }
        ],
        title: project.name
      }));

    return [...repoRows, ...localOnlyRows].sort((left, right) =>
      left.title.localeCompare(right.title)
    );
  }, [githubCatalog, localMachineId, projects]);

  const projectsByMachine = useMemo(() => {
    return projects.filter(isVisibleLocalProject).reduce<Record<string, ProjectSpaceRecord[]>>((groups, project) => {
      const machineId = getProjectMachineId(project, localMachineId);
      groups[machineId] = [...(groups[machineId] ?? []), project];
      return groups;
    }, {});
  }, [localMachineId, projects]);
  const activeMachineProjects = activeMachineId ? projectsByMachine[activeMachineId] ?? [] : [];
  const githubRows = rows.filter((row) => !row.isLocalOnly);
  const branchSourceProjects = useMemo(() => {
    if (mode !== 'projects') {
      return [];
    }

    const sourceProjects = new Map<string, ProjectSpaceRecord>();

    for (const row of rows) {
      for (const match of row.localMatches) {
        if (match.project.rootPath && isVisibleLocalProject(match.project)) {
          sourceProjects.set(match.project.id, match.project);
        }
      }
    }

    return Array.from(sourceProjects.values()).slice(0, 80);
  }, [mode, rows]);
  const githubRowGroups = useMemo(() => {
    const groups = new Map<string, MatrixRow[]>();

    for (const row of githubRows) {
      const owner = row.repo?.owner ?? 'Other';
      const items = groups.get(owner) ?? [];
      items.push(row);
      groups.set(owner, items);
    }

    return Array.from(groups.entries())
      .map(([owner, items]) => ({
        items: [...items].sort((left, right) => left.title.localeCompare(right.title)),
        owner
      }))
      .sort((left, right) => left.owner.localeCompare(right.owner));
  }, [githubRows]);

  useEffect(() => {
    const missingProjects = branchSourceProjects.filter(
      (project) => branchRecordsByProjectId[project.id] === undefined
    );

    if (missingProjects.length === 0) {
      return;
    }

    let canceled = false;

    void Promise.all(
      missingProjects.map(async (project) => {
        const worktrees = await projectSpaceClient
          .loadProjectWorktrees(project.rootPath)
          .catch(() => []);

        return {
          branches: branchesFromWorktrees(worktrees),
          projectId: project.id
        };
      })
    ).then((results) => {
      if (canceled) {
        return;
      }

      setBranchRecordsByProjectId((current) => {
        const next = { ...current };

        for (const result of results) {
          next[result.projectId] = result.branches;
        }

        return next;
      });
    });

    return () => {
      canceled = true;
    };
  }, [branchRecordsByProjectId, branchSourceProjects]);

  function branchesForRow(row: MatrixRow) {
    return mergeBranchChips(
      row.repo?.defaultBranch,
      row.localMatches.map((match) => branchRecordsByProjectId[match.project.id] ?? [])
    );
  }

  useEffect(() => {
    if (machines.length === 0) {
      return;
    }

    if (!activeMachineId || !machinesById.has(activeMachineId)) {
      setSelectedMachineId(localMachineId || machines[0]?.id || '');
    }
  }, [activeMachineId, localMachineId, machines, machinesById]);

  function renderLayoutTabs() {
    return (
      <Tabs
        selectedKey={layout}
        onSelectionChange={(key) => setLayout(key === 'grid' ? 'grid' : 'list')}
      >
        <TabList className="inline-flex rounded-lg bg-neutral-900/70 p-1">
          <Tab id="list" className="min-h-7 px-2.5 text-xs">
            <List className="size-3.5" />
            List
            <TabIndicator />
          </Tab>
          <Tab id="grid" className="min-h-7 px-2.5 text-xs">
            <Grid2X2 className="size-3.5" />
            Grid
            <TabIndicator />
          </Tab>
        </TabList>
      </Tabs>
    );
  }

  function renderMachineCard(machine: MachineRecord) {
    const machineProjects = projectsByMachine[machine.id] ?? [];
    const isSelected = machine.id === activeMachineId;

    return (
      <button
        key={machine.id}
        type="button"
        onClick={() => {
          setSelectedMachineId(machine.id);
          onSelectMachine(machine.id);
        }}
        className={[
          'min-w-0 rounded-lg border bg-neutral-900/40 p-4 text-left transition hover:border-neutral-700 hover:bg-neutral-900/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-neutral-300',
          isSelected ? 'border-neutral-100/50' : 'border-transparent'
        ].join(' ')}
      >
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <MachineDeviceIcon machine={machine} />
            <div className="min-w-0">
              <span className="flex min-w-0 items-center gap-1.5">
                <Text className="block truncate text-sm font-semibold text-neutral-100">
                  {machine.name}
                </Text>
                <MachineOsMark machine={machine} />
              </span>
              <Text className="block truncate text-xs text-neutral-500">
                {[machine.kind, machine.profile, machine.network.localName]
                  .filter(Boolean)
                  .join(' / ') || 'machine'}
              </Text>
            </div>
          </div>
          <div className="mt-0.5 flex shrink-0 items-center gap-2">
            <MachineConnectionIcon machine={machine} />
            <MachineBatteryMeter compact machine={machine} />
            <MachineDetailsTooltip machine={machine} projectCount={machineProjects.length} />
          </div>
        </div>
      </button>
    );
  }

  function renderMachineRow(machine: MachineRecord) {
    const machineProjects = projectsByMachine[machine.id] ?? [];
    const isSelected = machine.id === activeMachineId;

    return (
      <button
        key={machine.id}
        type="button"
        onClick={() => {
          setSelectedMachineId(machine.id);
          onSelectMachine(machine.id);
        }}
        className={[
          'flex min-w-0 items-center gap-3 rounded-lg px-3 py-3 text-left transition hover:bg-neutral-900/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-neutral-300',
          isSelected ? 'bg-neutral-900/70' : ''
        ].join(' ')}
      >
        <MachineConnectionIcon machine={machine} />
        <MachineDeviceIcon machine={machine} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <Text className="block truncate text-sm font-semibold text-neutral-100">
              {machine.name}
            </Text>
            <MachineOsMark machine={machine} />
          </span>
          <Text className="block truncate text-xs text-neutral-500">
            {[machine.kind, machine.profile, machine.network.localName]
              .filter(Boolean)
              .join(' / ') || 'machine'}
          </Text>
        </span>
        <MachineBatteryMeter compact machine={machine} />
        <MachineDetailsTooltip machine={machine} projectCount={machineProjects.length} />
      </button>
    );
  }

  function renderMachineSection(title: string, sectionMachines: MachineRecord[]) {
    if (sectionMachines.length === 0) {
      return null;
    }

    return (
      <section className="space-y-2">
        <Text className="block text-sm font-medium text-neutral-500">{title}</Text>
        <div className={layout === 'grid' ? 'grid gap-3 md:grid-cols-2 xl:grid-cols-3' : 'flex flex-col'}>
          {sectionMachines.map(layout === 'grid' ? renderMachineCard : renderMachineRow)}
        </div>
      </section>
    );
  }

  function projectIdForRow(row: MatrixRow) {
    return row.localMatches[0]?.project.id ?? (row.repo ? `github:${row.repo.fullName}` : '');
  }

  function renderGitHubLink(repo: GitHubCatalogRepository, label: string) {
    return (
      <a
        href={repo.url}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open ${repo.fullName} on GitHub`}
        onClick={(event) => event.stopPropagation()}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-neutral-600 transition hover:bg-neutral-900 hover:text-neutral-200"
        title={label}
      >
        <ExternalLink className="size-3.5" />
      </a>
    );
  }

  function renderProjectRow(row: MatrixRow) {
    const branches = branchesForRow(row);
    const projectId = projectIdForRow(row);

    return (
      <div
        key={row.id}
        className="flex min-w-0 items-center gap-3 rounded-lg px-3 py-2 transition hover:bg-neutral-900/40"
      >
        <button
          type="button"
          onClick={() => projectId && onSelectProject(projectId)}
          className="min-w-0 flex-1 text-left"
        >
          <Text className="block min-w-0 truncate text-sm font-medium text-neutral-100">
            {row.repo?.name ?? row.title}
          </Text>
        </button>
        <BranchChips branches={branches} />
        {row.repo ? renderGitHubLink(row.repo, 'Open on GitHub') : null}
      </div>
    );
  }

  function renderProjectCard(row: MatrixRow) {
    const branches = branchesForRow(row);
    const projectId = projectIdForRow(row);

    return (
      <div
        key={row.id}
        className="group flex min-w-0 flex-col gap-4 rounded-lg border border-neutral-900 bg-neutral-950/45 p-4 transition hover:border-neutral-800 hover:bg-neutral-950/70"
      >
        <div className="flex min-w-0 items-start justify-between gap-3">
          <button
            type="button"
            onClick={() => projectId && onSelectProject(projectId)}
            className="min-w-0 flex-1 text-left"
          >
            <Text className="block min-w-0 truncate text-sm font-semibold text-neutral-100">
              {row.repo?.name ?? row.title}
            </Text>
            <Text className="mt-1 block truncate text-xs text-neutral-500">
              {row.repo?.owner ?? 'Local'}
            </Text>
          </button>
          {row.repo ? renderGitHubLink(row.repo, 'Open on GitHub') : null}
        </div>
        <BranchChips branches={branches} />
      </div>
    );
  }

  return (
    <div className="flex min-h-full w-full flex-col">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          {mode === 'machines' ? (
            <>
              <Text className="block text-sm font-semibold text-neutral-100">Machines</Text>
              <Text className="block text-sm text-neutral-500">
                Connected workstations and their local Project registry.
              </Text>
            </>
          ) : null}
          {mode === 'projects' ? (
            <Text className="block text-sm font-semibold text-neutral-100">Projects</Text>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {renderLayoutTabs()}
          <Button
            aria-label="Refresh machines and projects"
            size="sm"
            variant="ghost"
            isDisabled={isRefreshing || isConnectorRefreshing || isGitHubRefreshing}
            onPress={() => void refresh(true)}
          >
            <RefreshCw
              className={
                isRefreshing || isConnectorRefreshing || isGitHubRefreshing
                  ? 'size-4 animate-spin'
                  : 'size-4'
              }
            />
          </Button>
        </div>
      </div>

      {mode === 'machines' ? (
        <>
          <div className="mb-4 space-y-4">
            {renderMachineSection('Connected', connectedMachines)}
            {renderMachineSection('Disconnected', disconnectedMachines)}
          </div>

          <div className="mb-3">
            <Text className="block text-sm font-semibold text-neutral-100">
              {activeMachine?.name ?? 'Machine'} projects
            </Text>
            <Text className="block text-sm text-neutral-500">
              Local folders are reachable through the connector on this machine.
            </Text>
          </div>

          {activeMachineProjects.length > 0 ? (
            <div className="flex flex-col">
              {activeMachineProjects.map((project) => {
                const status = getTemplateStatus(project);

                return (
                  <button
                    key={project.id}
                    type="button"
                    title={`${project.rootPath} · ${project.kind}`}
                    onClick={() => onSelectProject(project.id)}
                    className="flex min-w-0 items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-neutral-900/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-neutral-300"
                  >
                    <Text className="min-w-0 truncate text-sm font-medium text-neutral-100">
                      {project.name}
                    </Text>
                    {status !== 'implemented' ? (
                      <Chip size="sm" className={['shrink-0', configChipClass(status)].join(' ')}>
                        {templateStatusLabels[status]}
                      </Chip>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="rounded-lg bg-neutral-950/45 px-4 py-6">
              <Text className="text-sm text-neutral-500">
                No local projects reported by this machine yet.
              </Text>
            </div>
          )}
        </>
      ) : null}

      {mode === 'projects' && githubCatalog.status !== 'connected' ? (
        <div className="mb-3 rounded-lg border border-amber-500/20 bg-amber-500/8 px-3 py-2">
          <Text className="text-sm text-amber-200">
            {githubCatalog.message ?? `GitHub is ${githubCatalog.status}.`}
          </Text>
        </div>
      ) : null}

      {mode === 'projects' ? (
        <div className="flex max-h-[70vh] flex-col overflow-y-auto">
          {githubRowGroups.map((group) => (
            <div key={group.owner} className="mb-3 last:mb-0">
              <Text className="mb-1 block px-3 text-xs font-medium text-neutral-600">
                {group.owner}
              </Text>
              <div className={layout === 'grid' ? 'grid gap-3 md:grid-cols-2 xl:grid-cols-3' : 'flex flex-col'}>
                {group.items.map(layout === 'grid' ? renderProjectCard : renderProjectRow)}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
