import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import {
  Check,
  ChevronDown,
  Filter,
  Grid2X2,
  List,
  Plus,
  RefreshCw,
  SlidersHorizontal
} from 'lucide-react';
import {
  Button,
  Chip,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownPopover,
  DropdownTrigger,
  SearchField,
  SearchFieldClearButton,
  SearchFieldGroup,
  SearchFieldInput,
  SearchFieldSearchIcon,
  Tab,
  TabIndicator,
  TabList,
  Tabs,
  Text
} from '@/app/dotnaos-ui';
import { projectSpaceClient } from '@/api/project-space-client';
import { cn } from '@/lib/utils';
import type {
  ConnectorOverviewResult,
  GitHubCatalogResult,
  GitHubOAuthDeviceStartResult,
  MachineRecord,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import { isMachineConnected } from './machine-visuals';
import { MachineListItem } from './machine-list-item';
import { MachineConnectorActionsMenu } from './machine-connector-actions-menu';
import { runtimeVersionLabel } from './machine-connector-runtime-model';
import { machineSubtitle } from './project-main-model';
import {
  AddMachineDialog,
  BranchChips,
  MainListSearch,
  ProjectListItem,
  ProjectListTableHeader,
  sourceLabelForRow
} from './project-home-overview-widgets';
import { GitHubConnectPanel } from './github-connect-panel';
import {
  branchesFromWorktrees,
  configChipClass,
  getMachineId,
  getProjectMachineId,
  getTemplateStatus,
  isVisibleLocalProject,
  matchesQuery,
  mergeBranchChips,
  projectMatchesRepo,
  templateStatusLabels,
  type BranchChipRecord,
  type MatrixRow
} from './project-home-overview-model';

interface ProjectHomeOverviewProps {
  connector: ConnectorOverviewResult;
  githubCatalog: GitHubCatalogResult;
  isConnectorRefreshing: boolean;
  isGitHubRefreshing: boolean;
  mode: 'machines' | 'projects';
  onRefreshConnector(): Promise<ConnectorOverviewResult>;
  onRefreshGitHubCatalog(forceRefresh?: boolean): Promise<GitHubCatalogResult>;
  onSelectMachine(machineId: string): void;
  projects: ProjectSpaceRecord[];
  onSelectProject(projectId: string): void;
  recentProjectIds: string[];
}

type ProjectSortKey = 'name' | 'recent' | 'unstaged';

const projectSortLabels: Record<ProjectSortKey, string> = {
  name: 'Name',
  recent: 'Recently opened',
  unstaged: 'Unstaged changes'
};

function matrixRowProjectId(row: MatrixRow) {
  return row.localMatches[0]?.project.id ?? (row.repo ? `github:${row.repo.fullName}` : '');
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
  onSelectProject,
  recentProjectIds
}: ProjectHomeOverviewProps) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [branchRecordsByProjectId, setBranchRecordsByProjectId] = useState<
    Record<string, BranchChipRecord[]>
  >({});
  const [githubFlow, setGitHubFlow] = useState<GitHubOAuthDeviceStartResult>();
  const [isConnectingGitHub, setIsConnectingGitHub] = useState(false);
  const [isInstallDialogOpen, setIsInstallDialogOpen] = useState(false);
  const [installCommand, setInstallCommand] = useState('');
  const [installerError, setInstallerError] = useState('');
  const [isGeneratingInstaller, setIsGeneratingInstaller] = useState(false);
  const [installScriptHref, setInstallScriptHref] = useState('/connector/install.sh');
  const [hasCopiedInstallCommand, setHasCopiedInstallCommand] = useState(false);
  const [layout, setLayout] = useState<'grid' | 'list'>('list');
  const [machineQuery, setMachineQuery] = useState('');
  const [projectQuery, setProjectQuery] = useState('');
  const [projectSort, setProjectSort] = useState<ProjectSortKey>('name');
  const [activeMachineSearchIndex, setActiveMachineSearchIndex] = useState(0);
  const [activeProjectSearchIndex, setActiveProjectSearchIndex] = useState(0);
  const [sourceFilter, setSourceFilter] = useState('all');
  const [sourceFilterQuery, setSourceFilterQuery] = useState('');
  const [sourceFilterOpen, setSourceFilterOpen] = useState(false);
  const [activeSourceFilterIndex, setActiveSourceFilterIndex] = useState(0);
  const [selectedMachineId, setSelectedMachineId] = useState('');
  const hasRequestedGitHubCatalog = isGitHubRefreshing || Boolean(githubCatalog.checkedAt);
  const isPendingGitHubCatalog =
    mode === 'projects' && githubCatalog.status !== 'connected' && isGitHubRefreshing;

  async function refresh(includeConnector: boolean) {
    setIsRefreshing(true);
    try {
      const refreshTasks: Promise<unknown>[] = [];

      if (mode === 'projects') {
        refreshTasks.push(onRefreshGitHubCatalog(true));
      }

      if (includeConnector) {
        refreshTasks.push(onRefreshConnector());
      }

      await Promise.all(refreshTasks);
    } finally {
      setIsRefreshing(false);
    }
  }

  async function connectGitHub() {
    setIsConnectingGitHub(true);
    try {
      const nextFlow = await projectSpaceClient.startGitHubOAuthDeviceFlow();
      setGitHubFlow(nextFlow);
    } finally {
      setIsConnectingGitHub(false);
    }
  }

  async function pollGitHubLogin() {
    if (!githubFlow?.deviceCode) {
      return;
    }

    setIsConnectingGitHub(true);
    try {
      const result = await projectSpaceClient.pollGitHubOAuthDeviceFlow({
        deviceCode: githubFlow.deviceCode
      });

      if (result.status !== 'pending') {
        setGitHubFlow(undefined);
      }

      if (result.status === 'connected') {
        await onRefreshGitHubCatalog(true);
      }
    } finally {
      setIsConnectingGitHub(false);
    }
  }

  async function copyInstallCommand() {
    if (!installCommand) {
      return;
    }
    await navigator.clipboard?.writeText(installCommand);
    setHasCopiedInstallCommand(true);
    window.setTimeout(() => setHasCopiedInstallCommand(false), 1_500);
  }

  async function generateInstallCommand() {
    setIsGeneratingInstaller(true);
    setInstallerError('');
    try {
      const result = await projectSpaceClient.getConnectorInstallCommand();
      setInstallCommand(result.command);
      setInstallScriptHref(result.scriptUrl);
      setHasCopiedInstallCommand(false);
    } catch (error) {
      setInstallerError(error instanceof Error ? error.message : 'Could not create an installer.');
    } finally {
      setIsGeneratingInstaller(false);
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
  const filteredMachines = useMemo(
    () =>
      machines.filter((machine) =>
        matchesQuery(
          [
            machine.name,
            machine.id,
            machine.kind,
            machine.profile,
            machine.primaryUser,
            machine.network.localName,
            machine.network.sshUser,
            machine.network.tailscaleIp,
            machine.connector.serviceName,
            machine.connector.status
          ],
          machineQuery
        )
      ),
    [machineQuery, machines]
  );
  const connectedMachines = filteredMachines.filter(isMachineConnected);
  const disconnectedMachines = filteredMachines.filter((machine) => !isMachineConnected(machine));
  const activeMachineId = selectedMachineId || localMachineId || machines[0]?.id || '';
  const activeMachine = machinesById.get(activeMachineId);

  useEffect(() => {
    setActiveMachineSearchIndex(0);
  }, [machineQuery, layout]);

  useEffect(() => {
    if (activeMachineSearchIndex >= filteredMachines.length) {
      setActiveMachineSearchIndex(Math.max(0, filteredMachines.length - 1));
    }
  }, [activeMachineSearchIndex, filteredMachines.length]);

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
      .filter((project) => isVisibleLocalProject(project) && !matchedProjectIds.has(project.id))
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
    return projects
      .filter(isVisibleLocalProject)
      .reduce<Record<string, ProjectSpaceRecord[]>>((groups, project) => {
        const machineId = getProjectMachineId(project, localMachineId);
        groups[machineId] = [...(groups[machineId] ?? []), project];
        return groups;
      }, {});
  }, [localMachineId, projects]);
  const activeMachineProjects = activeMachineId ? (projectsByMachine[activeMachineId] ?? []) : [];
  const recentRankByProjectId = useMemo(() => {
    return new Map(recentProjectIds.map((projectId, index) => [projectId, index]));
  }, [recentProjectIds]);
  function rowRecentRank(row: MatrixRow) {
    const localRanks = row.localMatches
      .map((match) => recentRankByProjectId.get(match.project.id))
      .filter((rank): rank is number => rank !== undefined);
    const githubRank = row.repo
      ? recentRankByProjectId.get(`github:${row.repo.fullName}`)
      : undefined;
    const ranks = githubRank === undefined ? localRanks : [...localRanks, githubRank];

    return ranks.length > 0 ? Math.min(...ranks) : Number.POSITIVE_INFINITY;
  }

  function rowUnstagedCount(row: MatrixRow) {
    return row.localMatches.reduce(
      (count, match) => count + (match.project.gitStatus?.unstaged ?? 0),
      0
    );
  }

  function compareRows(left: MatrixRow, right: MatrixRow) {
    if (projectSort === 'recent') {
      const recentDelta = rowRecentRank(left) - rowRecentRank(right);
      if (recentDelta !== 0) {
        return recentDelta;
      }
    }

    if (projectSort === 'unstaged') {
      const unstagedDelta = rowUnstagedCount(right) - rowUnstagedCount(left);
      if (unstagedDelta !== 0) {
        return unstagedDelta;
      }
    }

    return left.title.localeCompare(right.title);
  }

  const projectSourceOptions = useMemo(() => {
    const sources = Array.from(new Set(rows.map(sourceLabelForRow))).sort((left, right) =>
      left.localeCompare(right)
    );

    return ['all', ...sources];
  }, [rows]);
  const filteredProjectSourceOptions = useMemo(
    () =>
      projectSourceOptions.filter((source) =>
        matchesQuery([source === 'all' ? 'All sources' : source], sourceFilterQuery)
      ),
    [projectSourceOptions, sourceFilterQuery]
  );

  useEffect(() => {
    if (sourceFilter !== 'all' && !projectSourceOptions.includes(sourceFilter)) {
      setSourceFilter('all');
    }
  }, [projectSourceOptions, sourceFilter]);

  useEffect(() => {
    setActiveSourceFilterIndex(0);
  }, [sourceFilterQuery, sourceFilterOpen]);

  useEffect(() => {
    if (activeSourceFilterIndex >= filteredProjectSourceOptions.length) {
      setActiveSourceFilterIndex(Math.max(0, filteredProjectSourceOptions.length - 1));
    }
  }, [activeSourceFilterIndex, filteredProjectSourceOptions.length]);

  const filteredProjectRows = useMemo(
    () =>
      rows
        .filter((row) => sourceFilter === 'all' || sourceLabelForRow(row) === sourceFilter)
        .filter((row) =>
          matchesQuery(
            [
              row.title,
              row.repo?.fullName,
              row.repo?.name,
              row.repo?.owner,
              row.repo?.description,
              row.localMatches.map((match) => match.project.name).join(' ')
            ],
            projectQuery
          )
        )
        .sort(compareRows),
    [projectQuery, projectSort, recentRankByProjectId, rows, sourceFilter]
  );

  useEffect(() => {
    setActiveProjectSearchIndex(0);
  }, [projectQuery, sourceFilter, projectSort, layout]);

  useEffect(() => {
    if (activeProjectSearchIndex >= filteredProjectRows.length) {
      setActiveProjectSearchIndex(Math.max(0, filteredProjectRows.length - 1));
    }
  }, [activeProjectSearchIndex, filteredProjectRows.length]);
  const recentProjectRows = useMemo(() => {
    if (projectQuery.trim()) {
      return [];
    }

    const rowsByProjectId = new Map<string, MatrixRow>();

    for (const row of filteredProjectRows) {
      if (row.repo) {
        rowsByProjectId.set(`github:${row.repo.fullName}`, row);
      }

      for (const match of row.localMatches) {
        rowsByProjectId.set(match.project.id, row);
      }
    }

    const seen = new Set<string>();
    const recentRows: MatrixRow[] = [];

    for (const projectId of recentProjectIds) {
      const row = rowsByProjectId.get(projectId);
      if (!row || seen.has(row.id)) {
        continue;
      }

      seen.add(row.id);
      recentRows.push(row);
    }

    return recentRows.slice(0, 5);
  }, [filteredProjectRows, projectQuery, recentProjectIds]);
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
  const projectRowGroups = useMemo(() => {
    return [
      {
        items: filteredProjectRows,
        owner:
          projectSort === 'recent'
            ? 'Recently sorted'
            : projectSort === 'unstaged'
              ? 'Most changes'
              : 'All projects'
      }
    ];
  }, [filteredProjectRows, projectSort]);

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
        const discovery = await projectSpaceClient
          .discoverProjectWorktrees(project.id, project.machineId)
          .catch(() => undefined);
        const worktrees = discovery?.state === 'ready' ? discovery.worktrees : [];

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

  function moveIndex(currentIndex: number, delta: number, itemCount: number) {
    if (itemCount <= 0) {
      return 0;
    }

    return Math.min(itemCount - 1, Math.max(0, currentIndex + delta));
  }

  function handleMachineSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (filteredMachines.length === 0) {
        return;
      }
      setActiveMachineSearchIndex((index) => moveIndex(index, 1, filteredMachines.length));
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (filteredMachines.length === 0) {
        return;
      }
      setActiveMachineSearchIndex((index) => moveIndex(index, -1, filteredMachines.length));
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      if (filteredMachines.length === 0) {
        return;
      }
      const machine = filteredMachines[activeMachineSearchIndex] ?? filteredMachines[0];

      if (machine) {
        setSelectedMachineId(machine.id);
        onSelectMachine(machine.id);
      }
    }
  }

  function handleProjectSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (filteredProjectRows.length === 0) {
        return;
      }
      setActiveProjectSearchIndex((index) => moveIndex(index, 1, filteredProjectRows.length));
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (filteredProjectRows.length === 0) {
        return;
      }
      setActiveProjectSearchIndex((index) => moveIndex(index, -1, filteredProjectRows.length));
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      if (filteredProjectRows.length === 0) {
        return;
      }
      const row = filteredProjectRows[activeProjectSearchIndex] ?? filteredProjectRows[0];
      const projectId = row ? matrixRowProjectId(row) : '';

      if (projectId) {
        onSelectProject(projectId);
      }
    }
  }

  function applySourceFilter(source: string) {
    setSourceFilter(source);
    setSourceFilterQuery('');
    setSourceFilterOpen(false);
  }

  function handleSourceFilterKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (filteredProjectSourceOptions.length === 0) {
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveSourceFilterIndex((index) =>
        moveIndex(index, 1, filteredProjectSourceOptions.length)
      );
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveSourceFilterIndex((index) =>
        moveIndex(index, -1, filteredProjectSourceOptions.length)
      );
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const source =
        filteredProjectSourceOptions[activeSourceFilterIndex] ?? filteredProjectSourceOptions[0];

      if (source) {
        applySourceFilter(source);
      }
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      setSourceFilterOpen(false);
    }
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

  function renderProjectSortMenu() {
    const sortKeys: ProjectSortKey[] = ['name', 'recent', 'unstaged'];

    return (
      <Dropdown>
        <DropdownTrigger
          aria-label="Sort projects"
          className="min-h-9 gap-2 rounded-lg border-neutral-800 bg-neutral-900/70 px-2.5 text-xs text-neutral-300 hover:border-neutral-700 hover:bg-neutral-900"
        >
          <SlidersHorizontal className="size-3.5 text-neutral-500" />
          <span className="hidden text-neutral-500 sm:inline">Sort</span>
          <span className="font-medium text-neutral-100">{projectSortLabels[projectSort]}</span>
          <ChevronDown className="size-3.5 text-neutral-500" />
        </DropdownTrigger>
        <DropdownPopover className="w-52">
          <DropdownMenu aria-label="Project sort options">
            {sortKeys.map((sortKey) => (
              <DropdownItem key={sortKey} onPress={() => setProjectSort(sortKey)}>
                <span className="inline-flex w-full items-center justify-between gap-3">
                  <span className="min-w-0 flex-1 truncate">{projectSortLabels[sortKey]}</span>
                  {projectSort === sortKey ? <Check className="size-3.5" /> : null}
                </span>
              </DropdownItem>
            ))}
          </DropdownMenu>
        </DropdownPopover>
      </Dropdown>
    );
  }

  function renderProjectSourceFilter() {
    const label = sourceFilter === 'all' ? 'All sources' : sourceFilter;

    return (
      <Dropdown
        open={sourceFilterOpen}
        onOpenChange={(open) => {
          setSourceFilterOpen(open);

          if (!open) {
            setSourceFilterQuery('');
          }
        }}
      >
        <DropdownTrigger
          aria-label="Filter projects by source"
          className="min-h-9 w-48 justify-start gap-2 rounded-lg border-neutral-800 bg-neutral-900/70 px-2.5 text-xs text-neutral-300 hover:border-neutral-700 hover:bg-neutral-900 sm:w-56"
        >
          <Filter className="size-3.5 shrink-0 text-neutral-500" />
          <span className="hidden text-neutral-500 sm:inline">Source</span>
          <span className="min-w-0 flex-1 truncate text-left font-medium text-neutral-100">
            {label}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-neutral-500" />
        </DropdownTrigger>
        <DropdownPopover
          className="left-0 right-auto"
          style={{
            maxWidth: 'calc(100vw - 2rem)',
            minWidth: 0,
            width: '16rem'
          }}
        >
          <div className="border-b border-neutral-900 p-1.5">
            <SearchField value={sourceFilterQuery} onChange={setSourceFilterQuery}>
              <SearchFieldGroup className="rounded-md bg-neutral-900/80 px-2 py-1.5">
                <SearchFieldSearchIcon />
                <SearchFieldInput
                  autoFocus
                  className="text-sm"
                  placeholder="Search sources"
                  spellCheck={false}
                  onKeyDown={handleSourceFilterKeyDown}
                />
                <SearchFieldClearButton />
              </SearchFieldGroup>
            </SearchField>
          </div>
          <DropdownMenu
            aria-label="Project source filter options"
            className="max-h-72 overflow-y-auto"
          >
            {filteredProjectSourceOptions.map((source, index) => (
              <DropdownItem
                key={source}
                className={[
                  'min-w-0',
                  activeSourceFilterIndex === index ? 'bg-neutral-800 text-neutral-50' : ''
                ].join(' ')}
                title={source === 'all' ? 'All sources' : source}
                onPress={() => applySourceFilter(source)}
              >
                <span className="inline-flex w-full items-center justify-between gap-3">
                  <span className="min-w-0 flex-1 truncate">
                    {source === 'all' ? 'All sources' : source}
                  </span>
                  {sourceFilter === source ? <Check className="size-3.5 shrink-0" /> : null}
                </span>
              </DropdownItem>
            ))}
            {filteredProjectSourceOptions.length === 0 ? (
              <div className="px-3 py-2 text-sm text-neutral-500">No sources found.</div>
            ) : null}
          </DropdownMenu>
        </DropdownPopover>
      </Dropdown>
    );
  }

  function renderMachineCard(machine: MachineRecord) {
    const machineProjects = projectsByMachine[machine.id] ?? [];
    const isSelected =
      machine.id === activeMachineId ||
      filteredMachines[activeMachineSearchIndex]?.id === machine.id;

    return (
      <div
        key={machine.id}
        className={cn(
          'flex min-w-0 items-center rounded-lg border bg-neutral-900/40 transition hover:border-neutral-700 hover:bg-neutral-900/70',
          isSelected ? 'border-neutral-100/50' : 'border-transparent'
        )}
      >
        <MachineListItem
          machine={machine}
          subtitle={machineSubtitle(machine) || 'machine'}
          className="min-w-0 flex-1 bg-transparent p-4 hover:bg-transparent focus-visible:outline focus-visible:outline-2 focus-visible:outline-neutral-300"
          onPress={() => {
            setSelectedMachineId(machine.id);
            onSelectMachine(machine.id);
          }}
        />
        <div className="flex shrink-0 items-center gap-1.5 pr-2">
          {machine.connector.runtime ? (
            <span className="rounded-full bg-neutral-950/80 px-2 py-0.5 text-[11px] text-neutral-500">
              {runtimeVersionLabel(machine)}
            </span>
          ) : null}
          <span className="rounded-full bg-neutral-950/80 px-2 py-0.5 text-[11px] text-neutral-500">
            {machineProjects.length}
          </span>
          <MachineConnectorActionsMenu machine={machine} />
        </div>
      </div>
    );
  }

  function renderMachineRow(machine: MachineRecord) {
    const machineProjects = projectsByMachine[machine.id] ?? [];
    const isSelected =
      machine.id === activeMachineId ||
      filteredMachines[activeMachineSearchIndex]?.id === machine.id;

    return (
      <div
        key={machine.id}
        className={cn('flex min-w-0 items-center rounded-lg', isSelected ? 'bg-neutral-800/90' : '')}
      >
        <MachineListItem
          compact
          machine={machine}
          subtitle={machineSubtitle(machine) || 'machine'}
          className="min-w-0 flex-1 hover:bg-neutral-900/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-neutral-300"
          onPress={() => {
            setSelectedMachineId(machine.id);
            onSelectMachine(machine.id);
          }}
        />
        <div className="flex shrink-0 items-center gap-1 pr-1.5">
          <span className="rounded-full bg-neutral-950/80 px-2 py-0.5 text-[11px] text-neutral-500">
            {machineProjects.length}
          </span>
          <MachineConnectorActionsMenu machine={machine} />
        </div>
      </div>
    );
  }

  function renderMachineSection(title: string, sectionMachines: MachineRecord[]) {
    if (sectionMachines.length === 0) {
      return null;
    }

    return (
      <section className="space-y-2">
        <Text className="block text-sm font-medium text-neutral-500">{title}</Text>
        <div
          className={
            layout === 'grid' ? 'grid gap-3 md:grid-cols-2 xl:grid-cols-3' : 'flex flex-col'
          }
        >
          {sectionMachines.map(layout === 'grid' ? renderMachineCard : renderMachineRow)}
        </div>
      </section>
    );
  }

  return (
    <div className="flex min-h-full w-full flex-col">
      {isInstallDialogOpen ? (
        <AddMachineDialog
          hasCopiedInstallCommand={hasCopiedInstallCommand}
          installCommand={installCommand}
          installScriptHref={installScriptHref}
          installerError={installerError}
          isGeneratingInstaller={isGeneratingInstaller}
          onClose={() => setIsInstallDialogOpen(false)}
          onCopy={() => void copyInstallCommand()}
          onGenerate={() => void generateInstallCommand()}
        />
      ) : null}
      <div className="mb-3 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
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
        <div className="flex w-full shrink-0 flex-wrap items-center justify-between gap-2 sm:w-auto sm:justify-end">
          {mode === 'machines' ? (
            <Button size="sm" variant="outline" onPress={() => setIsInstallDialogOpen(true)}>
              <Plus className="size-4" />
              Add machine
            </Button>
          ) : null}
          {mode === 'projects' ? (
            <div className="order-1 inline-flex min-w-0 flex-wrap items-center gap-2">
              {renderProjectSourceFilter()}
              {renderProjectSortMenu()}
            </div>
          ) : null}
          <div className="order-3 w-full sm:order-2 sm:w-auto">{renderLayoutTabs()}</div>
          <Button
            aria-label="Refresh machines and projects"
            className="order-2 sm:order-3"
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

      {mode === 'machines' || mode === 'projects' ? (
        <div className="mb-4">
          {mode === 'machines' ? (
            <MainListSearch
              label="Search machines"
              placeholder="Search machines"
              value={machineQuery}
              onChange={setMachineQuery}
              onKeyDown={handleMachineSearchKeyDown}
            />
          ) : (
            <MainListSearch
              label="Search projects"
              placeholder="Search projects"
              value={projectQuery}
              onChange={setProjectQuery}
              onKeyDown={handleProjectSearchKeyDown}
            />
          )}
        </div>
      ) : null}

      {mode === 'machines' ? (
        <>
          <div className="mb-4 space-y-4">
            {renderMachineSection('Connected', connectedMachines)}
            {renderMachineSection('Disconnected', disconnectedMachines)}
            {filteredMachines.length === 0 ? (
              <div className="rounded-lg bg-neutral-950/45 px-4 py-6">
                <Text className="text-sm text-neutral-500">No machines found.</Text>
              </div>
            ) : null}
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

      {mode === 'projects' && githubCatalog.cache ? (
        <div className="mb-3 flex items-center justify-between gap-3 border-b border-neutral-900 pb-3">
          <Text className="text-xs text-neutral-500">
            {githubCatalog.cache.state === 'refreshing'
              ? 'Showing saved projects · Updating in the background…'
              : githubCatalog.cache.state === 'refresh-failed'
                ? 'Update failed · Showing the last saved projects'
                : githubCatalog.cache.lastUpdated
                  ? `Project catalog updated ${new Date(githubCatalog.cache.lastUpdated).toLocaleString()}`
                  : 'Project catalog is not cached yet'}
          </Text>
          <Button
            size="sm"
            variant="outline"
            isDisabled={isGitHubRefreshing}
            onPress={() => void refresh(false)}
          >
            <RefreshCw className={isGitHubRefreshing ? 'size-4 animate-spin' : 'size-4'} />
            Refresh
          </Button>
        </div>
      ) : null}

      {mode === 'projects' && hasRequestedGitHubCatalog && !isPendingGitHubCatalog ? (
        <div className="mb-4 rounded-lg bg-neutral-950/60 px-4 py-4">
          <GitHubConnectPanel
            flow={githubFlow}
            githubCatalog={githubCatalog}
            isConnecting={isConnectingGitHub}
            onConnect={connectGitHub}
            onPoll={pollGitHubLogin}
            onRetry={() => refresh(false)}
          />
        </div>
      ) : null}

      {mode === 'projects' ? (
        <div
          className={[
            'flex max-h-[70vh] flex-col',
            layout === 'grid' ? 'overflow-y-auto' : 'overflow-auto'
          ].join(' ')}
        >
          {layout === 'list' ? <ProjectListTableHeader /> : null}
          {isPendingGitHubCatalog ? (
            <div className="flex min-h-56 min-w-[38rem] items-center justify-center border-t border-neutral-950/80 px-4 py-12">
              <div className="flex items-center gap-3 rounded-lg bg-neutral-950/50 px-4 py-3 text-sm text-neutral-400">
                <RefreshCw className="size-4 animate-spin text-neutral-500" />
                <span>Loading project catalog</span>
              </div>
            </div>
          ) : null}
          {layout === 'list' && !isPendingGitHubCatalog ? (
            <div className="flex min-w-[38rem] flex-col">
              {filteredProjectRows.map((row) => (
                <ProjectListItem
                  key={row.id}
                  branches={branchesForRow(row)}
                  isActive={filteredProjectRows[activeProjectSearchIndex]?.id === row.id}
                  layout={layout}
                  onSelectProject={onSelectProject}
                  row={row}
                />
              ))}
            </div>
          ) : null}
          {layout === 'grid' &&
          !isPendingGitHubCatalog &&
          recentProjectRows.length > 0 &&
          projectSort !== 'recent' ? (
            <div className="mb-4">
              <Text className="mb-1 block px-3 text-xs font-medium text-neutral-600">
                Recently opened
              </Text>
              <div
                className={
                  layout === 'grid'
                    ? 'grid gap-3 md:grid-cols-2 xl:grid-cols-3'
                    : 'flex min-w-[38rem] flex-col'
                }
              >
                {recentProjectRows.map((row) => (
                  <ProjectListItem
                    key={`recent:${row.id}`}
                    branches={branchesForRow(row)}
                    isActive={filteredProjectRows[activeProjectSearchIndex]?.id === row.id}
                    layout={layout}
                    onSelectProject={onSelectProject}
                    row={row}
                  />
                ))}
              </div>
            </div>
          ) : null}
          {layout === 'grid' && !isPendingGitHubCatalog
            ? projectRowGroups.map((group) => (
                <div key={group.owner} className="mb-3 last:mb-0">
                  <Text className="mb-1 block px-3 text-xs font-medium text-neutral-600">
                    {group.owner}
                  </Text>
                  <div
                    className={
                      layout === 'grid'
                        ? 'grid gap-3 md:grid-cols-2 xl:grid-cols-3'
                        : 'flex min-w-[38rem] flex-col'
                    }
                  >
                    {group.items.map((row) => (
                      <ProjectListItem
                        key={row.id}
                        branches={branchesForRow(row)}
                        isActive={filteredProjectRows[activeProjectSearchIndex]?.id === row.id}
                        layout={layout}
                        onSelectProject={onSelectProject}
                        row={row}
                      />
                    ))}
                  </div>
                </div>
              ))
            : null}
          {!isPendingGitHubCatalog && filteredProjectRows.length === 0 ? (
            <div className="rounded-lg bg-neutral-950/45 px-4 py-6">
              <Text className="text-sm text-neutral-500">No projects found.</Text>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
