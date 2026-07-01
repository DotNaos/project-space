import { useEffect, useMemo, useState } from 'react';
import {
  Grid2X2,
  List,
  Plus,
  RefreshCw,
} from 'lucide-react';
import {
  Button,
  Chip,
  Tab,
  TabIndicator,
  TabList,
  Tabs,
  Text,
  Tooltip
} from '@/app/dotnaos-ui';
import { projectSpaceClient } from '@/api/project-space-client';
import type {
  ConnectorOverviewResult,
  GitHubCatalogResult,
  GitHubOAuthDeviceStartResult,
  MachineRecord,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import {
  isMachineConnected,
  MachineBatteryMeter,
  MachineConnectionIcon,
  MachineDeviceIcon,
  MachineOsMark
} from './machine-visuals';
import {
  AddMachineDialog,
  BranchChips,
  GitHubConnectPanel,
  MachineDetailsTooltip,
  MainListSearch,
  ProjectListItem
} from './project-home-overview-widgets';
import {
  branchesFromWorktrees,
  configChipClass,
  getMachineId,
  getProjectMachineId,
  getTemplateStatus,
  installScriptUrl,
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
  onRefreshGitHubCatalog(): Promise<GitHubCatalogResult>;
  onSelectMachine(machineId: string): void;
  projects: ProjectSpaceRecord[];
  onSelectProject(projectId: string): void;
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
  const [githubFlow, setGitHubFlow] = useState<GitHubOAuthDeviceStartResult>();
  const [isConnectingGitHub, setIsConnectingGitHub] = useState(false);
  const [isInstallDialogOpen, setIsInstallDialogOpen] = useState(false);
  const [installCommand, setInstallCommand] = useState(`curl -fsSL ${installScriptUrl()} | bash`);
  const [installScriptHref, setInstallScriptHref] = useState('/connector/install.sh');
  const [hasCopiedInstallCommand, setHasCopiedInstallCommand] = useState(false);
  const [layout, setLayout] = useState<'grid' | 'list'>('list');
  const [machineQuery, setMachineQuery] = useState('');
  const [projectQuery, setProjectQuery] = useState('');
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
        await onRefreshGitHubCatalog();
      }
    } finally {
      setIsConnectingGitHub(false);
    }
  }

  async function copyInstallCommand() {
    await navigator.clipboard?.writeText(installCommand);
    setHasCopiedInstallCommand(true);
    window.setTimeout(() => setHasCopiedInstallCommand(false), 1_500);
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
  const filteredGithubRows = useMemo(
    () =>
      githubRows.filter((row) =>
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
      ),
    [githubRows, projectQuery]
  );
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

    for (const row of filteredGithubRows) {
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
  }, [filteredGithubRows]);

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

  useEffect(() => {
    if (!isInstallDialogOpen) {
      return;
    }

    let canceled = false;

    projectSpaceClient
      .getConnectorInstallCommand()
      .then((result) => {
        if (canceled) {
          return;
        }

        setInstallCommand(result.command);
        setInstallScriptHref(result.scriptUrl);
      })
      .catch(() => undefined);

    return () => {
      canceled = true;
    };
  }, [isInstallDialogOpen]);

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

  return (
    <div className="flex min-h-full w-full flex-col">
      {isInstallDialogOpen ? (
        <AddMachineDialog
          hasCopiedInstallCommand={hasCopiedInstallCommand}
          installCommand={installCommand}
          installScriptHref={installScriptHref}
          onClose={() => setIsInstallDialogOpen(false)}
          onCopy={() => void copyInstallCommand()}
        />
      ) : null}
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
          {mode === 'machines' ? (
            <Button size="sm" variant="outline" onPress={() => setIsInstallDialogOpen(true)}>
              <Plus className="size-4" />
              Add machine
            </Button>
          ) : null}
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

      {mode === 'machines' || githubCatalog.status === 'connected' ? (
        <div className="mb-4">
          {mode === 'machines' ? (
            <MainListSearch
              label="Search machines"
              placeholder="Search machines"
              value={machineQuery}
              onChange={setMachineQuery}
            />
          ) : (
            <MainListSearch
              label="Search projects"
              placeholder="Search projects"
              value={projectQuery}
              onChange={setProjectQuery}
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

      {mode === 'projects' ? (
        <GitHubConnectPanel
          flow={githubFlow}
          githubCatalog={githubCatalog}
          isConnecting={isConnectingGitHub}
          onConnect={() => void connectGitHub()}
          onPoll={() => void pollGitHubLogin()}
        />
      ) : null}

      {mode === 'projects' ? (
        <div className="flex max-h-[70vh] flex-col overflow-y-auto">
          {githubRowGroups.map((group) => (
            <div key={group.owner} className="mb-3 last:mb-0">
              <Text className="mb-1 block px-3 text-xs font-medium text-neutral-600">
                {group.owner}
              </Text>
              <div className={layout === 'grid' ? 'grid gap-3 md:grid-cols-2 xl:grid-cols-3' : 'flex flex-col'}>
                {group.items.map((row) => (
                  <ProjectListItem
                    key={row.id}
                    branches={branchesForRow(row)}
                    layout={layout}
                    onSelectProject={onSelectProject}
                    row={row}
                  />
                ))}
              </div>
            </div>
          ))}
          {githubCatalog.status === 'connected' && filteredGithubRows.length === 0 ? (
            <div className="rounded-lg bg-neutral-950/45 px-4 py-6">
              <Text className="text-sm text-neutral-500">No projects found.</Text>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
