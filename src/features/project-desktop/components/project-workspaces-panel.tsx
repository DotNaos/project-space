import { useEffect, useMemo, useState } from 'react';
import { GitBranchPlus, LoaderCircle, Play } from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import { Button, Surface, Text } from '@/app/dotnaos-ui';
import type {
  ConnectorOverviewResult,
  ExplorerTarget,
  GitHubCatalogRepository,
  MachineRecord,
  ProjectSpaceRecord,
  ProjectWorktreeDiscoveryState,
  ProjectWorktreeRecord
} from '@/shared/project-space-api';
import { useWorktreeDevServers } from '../hooks/use-worktree-dev-servers';
import { FileExplorer } from './file-explorer';
import { DevServerSettings } from './dev-server-settings';
import { DevServerAccessNotice } from './worktree-dev-server';
import { WorktreeRuntimeTable } from './worktree-runtime-table';
import {
  runtimeRowsForWorktrees,
  startableDevServers,
  unmaterializedBranchesFor
} from './worktree-runtime-model';
import { projectWorktreeDiscoverySummary } from './project-worktree-discovery-model';
import {
  selectedProjectWorktree,
  selectedWorktreeExplorerPath
} from './project-worktree-selection';
import { useWorktreeSetup } from '../hooks/use-worktree-setup';
import {
  WorktreeGitClientPanel,
  type WorktreeGitStatusSnapshot
} from './worktree-git-client-panel';
import { MachineConnectorActionsMenu } from './machine-connector-actions-menu';

function normalizeKey(value: string) {
  return value
    .trim()
    .replace(/^refs\/heads\//, '')
    .toLowerCase();
}

function isDefaultBranch(branchName: string, defaultBranch: string) {
  return normalizeKey(branchName) === normalizeKey(defaultBranch);
}

function canRunMachineCommand(machine?: MachineRecord) {
  return machine?.connector.status === 'local' || machine?.connector.status === 'online';
}

function branchSort(defaultBranch: string) {
  return (left: string, right: string) => {
    if (isDefaultBranch(left, defaultBranch)) {
      return -1;
    }

    if (isDefaultBranch(right, defaultBranch)) {
      return 1;
    }

    return left.localeCompare(right);
  };
}

export function ProjectWorkspacesPanel({
  connectorOverview,
  onRefreshWorktrees,
  onSelectWorkspace,
  onSelectWorktree,
  project,
  repository,
  selectedExplorerTarget,
  selectedMachineId,
  worktreeDiscovery,
  worktrees
}: {
  connectorOverview: ConnectorOverviewResult;
  onRefreshWorktrees(): Promise<ProjectWorktreeRecord[]>;
  onSelectWorkspace(): void;
  onSelectWorktree(worktreeId: string): void;
  project: ProjectSpaceRecord;
  repository?: GitHubCatalogRepository;
  selectedExplorerTarget: ExplorerTarget;
  selectedMachineId: string;
  worktreeDiscovery: ProjectWorktreeDiscoveryState;
  worktrees: ProjectWorktreeRecord[];
}) {
  const [actionMessage, setActionMessage] = useState('');
  const [busyBranchName, setBusyBranchName] = useState('');
  const [fileGitStatus, setFileGitStatus] = useState<WorktreeGitStatusSnapshot>();
  const [repositoryBranches, setRepositoryBranches] = useState<string[]>([]);
  const [repositoryMessage, setRepositoryMessage] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [selectedCreateBranch, setSelectedCreateBranch] = useState('');
  const selectedMachine =
    connectorOverview.machines.find(
      (machine) => machine.id === (project.machineId ?? selectedMachineId)
    ) ??
    connectorOverview.machines.find((machine) => machine.connector.status === 'local') ??
    connectorOverview.machines[0];
  const devServers = useWorktreeDevServers({
    machineId: selectedMachine?.id,
    projectId: project.id
  });
  const worktreeIds = useMemo(
    () =>
      devServers.access === 'owner' || devServers.access === 'member'
        ? worktrees.filter((worktree) => worktree.status === 'ready').map((worktree) => worktree.id)
        : [],
    [devServers.access, worktrees]
  );
  const setup = useWorktreeSetup({
    machineId: selectedMachine?.id,
    projectId: project.id,
    worktreeIds
  });
  const defaultBranch =
    repository?.defaultBranch ??
    project.github?.defaultBranch ??
    project.gitStatus?.branchName ??
    'main';
  const branchNames = useMemo(() => {
    const branches = new Set<string>([defaultBranch]);

    for (const branch of repositoryBranches) {
      branches.add(branch);
    }

    for (const worktree of worktrees) {
      if (worktree.branchName) {
        branches.add(worktree.branchName);
      }
    }

    return Array.from(branches).sort(branchSort(defaultBranch));
  }, [defaultBranch, repositoryBranches, worktrees]);
  const runtimeRows = useMemo(() => runtimeRowsForWorktrees(worktrees), [worktrees]);
  const allDevServers = useMemo(
    () => Array.from(devServers.serversForWorktree.values()).flat(),
    [devServers.serversForWorktree]
  );
  const startableServers = useMemo(
    () => startableDevServers(allDevServers, worktrees, setup.results),
    [allDevServers, setup.results, worktrees]
  );
  const serverCount = Array.from(devServers.serversForWorktree.values()).reduce(
    (total, servers) => total + servers.length,
    0
  );
  const unmaterializedBranches = useMemo(
    () => unmaterializedBranchesFor(branchNames, worktrees),
    [branchNames, worktrees]
  );
  const selectedWorktree = selectedProjectWorktree(worktrees, selectedExplorerTarget);
  const selectedExplorerPath = selectedWorktreeExplorerPath(selectedWorktree);
  const canCreate =
    Boolean(repository?.fullName ?? project.github?.fullName) &&
    Boolean(selectedMachine) &&
    canRunMachineCommand(selectedMachine) &&
    worktreeDiscovery.state !== 'checking' &&
    worktreeDiscovery.state !== 'blocked';
  const createLabel = selectedMachine
    ? canRunMachineCommand(selectedMachine)
      ? 'Create'
      : 'Offline'
    : 'No machine';
  const connectorUpdateRequired =
    worktreeDiscovery.state === 'blocked' &&
    worktreeDiscovery.reason === 'connector-update-required';

  useEffect(() => {
    setFileGitStatus(undefined);
  }, [selectedWorktree?.id]);

  useEffect(() => {
    if (!unmaterializedBranches.includes(selectedCreateBranch)) {
      setSelectedCreateBranch(unmaterializedBranches[0] ?? '');
    }
  }, [selectedCreateBranch, unmaterializedBranches]);

  useEffect(() => {
    if (!canCreate) setShowCreate(false);
  }, [canCreate]);

  useEffect(() => {
    if (!repository?.fullName) {
      setRepositoryBranches([]);
      setRepositoryMessage('');
      return;
    }

    let canceled = false;

    setRepositoryMessage('');
    projectSpaceClient
      .getGitHubRepositoryDetails(repository.fullName)
      .then((details) => {
        if (canceled) {
          return;
        }

        setRepositoryBranches(details.branches.map((branch) => branch.name));
        setRepositoryMessage(details.message ?? '');
      })
      .catch((error) => {
        if (canceled) {
          return;
        }

        setRepositoryBranches([]);
        setRepositoryMessage(
          error instanceof Error ? error.message : 'Could not load repository branches.'
        );
      });

    return () => {
      canceled = true;
    };
  }, [repository?.fullName]);

  async function createWorktree(branchName: string) {
    if (!selectedMachine || !canCreate) {
      return;
    }

    setActionMessage('');
    setBusyBranchName(branchName);
    try {
      const result = await projectSpaceClient.materializeWorktree({
        branchName,
        machineId: selectedMachine.id,
        projectId: project.id
      });

      if (result.state === 'error') {
        setActionMessage(result.lastError || `Could not create ${branchName}.`);
        return;
      }

      let nextWorktrees: ProjectWorktreeRecord[];
      try {
        nextWorktrees = await onRefreshWorktrees();
      } catch {
        setActionMessage(
          `${branchName} was created on ${selectedMachine.name}, but the worktree list could not be refreshed.`
        );
        return;
      }

      const nextWorktree = result.worktreeId
        ? nextWorktrees.find((worktree) => worktree.id === result.worktreeId)
        : undefined;

      if (!nextWorktree) {
        setActionMessage(
          `${branchName} was created on ${selectedMachine.name}, but it is not visible in the worktree list yet.`
        );
        return;
      }

      onSelectWorktree(nextWorktree.id);
      setActionMessage(`${branchName} is ready on ${selectedMachine.name}.`);
      setShowCreate(false);
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : `Could not create ${branchName}.`);
    } finally {
      setBusyBranchName('');
    }
  }

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <Surface
        variant="tertiary"
        className="flex min-h-0 flex-col rounded-lg border border-neutral-800 bg-neutral-950/45 p-3"
      >
        <div className="mb-3 flex flex-col gap-3 px-1 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <Text className="text-sm font-semibold text-neutral-100">Worktrees</Text>
            <Text className="mt-0.5 block text-xs text-neutral-500">
              {connectorUpdateRequired
                ? 'Connector action needed'
                : projectWorktreeDiscoverySummary(worktreeDiscovery, serverCount)}
            </Text>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">
            <Button
              size="sm"
              variant="secondary"
              isDisabled={
                devServers.access !== 'owner' && devServers.access !== 'member' ||
                devServers.isChecking ||
                setup.isChecking ||
                devServers.isStartingAll ||
                startableServers.length === 0
              }
              onPress={() => void devServers.startAll(startableServers)}
              title={
                setup.isChecking
                  ? 'Checking trusted setup before starting development servers'
                  : startableServers.length > 0
                  ? `Start ${startableServers.length} configured development server${startableServers.length === 1 ? '' : 's'}`
                  : 'No configured development servers are ready to start'
              }
            >
              {devServers.isStartingAll ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <Play className="size-3.5 fill-current" />
              )}
              {devServers.isStartingAll ? 'Starting' : 'Start all'}
            </Button>
            <Button
              size="sm"
              variant="primary"
              className="shrink-0 bg-sky-500 text-white hover:bg-sky-400"
              isDisabled={!canCreate || unmaterializedBranches.length === 0}
              onPress={() => setShowCreate((value) => !value)}
            >
              <GitBranchPlus className="size-4" />
              New worktree
            </Button>
          </div>
        </div>

        {showCreate ? (
          <div className="mb-3 flex flex-col gap-2 rounded-lg border border-sky-400/20 bg-sky-400/[0.06] p-3 sm:flex-row sm:items-end">
            <label className="grid min-w-0 flex-1 gap-1.5">
              <Text className="text-xs font-medium text-neutral-300">GitHub branch</Text>
              <select
                aria-label="GitHub branch to create on this machine"
                value={selectedCreateBranch}
                onChange={(event) => setSelectedCreateBranch(event.currentTarget.value)}
                className="min-h-9 min-w-0 rounded-lg border border-neutral-700 bg-neutral-950 px-3 text-sm text-neutral-100 outline-none focus-visible:border-sky-400 focus-visible:ring-2 focus-visible:ring-sky-400/25"
              >
                {unmaterializedBranches.map((branchName) => (
                  <option key={branchName} value={branchName}>
                    {branchName}
                  </option>
                ))}
              </select>
            </label>
            <Button
              size="sm"
              variant="primary"
              isDisabled={!canCreate || !selectedCreateBranch || Boolean(busyBranchName)}
              onPress={() => void createWorktree(selectedCreateBranch)}
              className="bg-sky-500 text-white hover:bg-sky-400"
            >
              {busyBranchName ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <GitBranchPlus className="size-3.5" />
              )}
              {busyBranchName ? 'Creating' : createLabel}
            </Button>
          </div>
        ) : null}

        <DevServerAccessNotice access={devServers.access} machineName={selectedMachine?.name} />
        <DevServerSettings
          access={devServers.access}
          hasActiveServers={devServers.hasActiveServers}
          isSaving={devServers.isSavingSettings}
          onSave={devServers.updateSettings}
          settings={devServers.settings}
        />

        {worktreeDiscovery.state === 'checking' ? (
          <div className="flex items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-3">
            <LoaderCircle className="size-4 animate-spin text-neutral-400" />
            <Text className="text-sm text-neutral-300">Checking registered Git worktrees…</Text>
          </div>
        ) : connectorUpdateRequired ? (
          <div className="flex flex-col gap-3 rounded-lg border border-amber-500/30 bg-amber-500/8 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <Text className="block text-sm font-medium text-amber-200">
                Connector update required{selectedMachine ? ` on ${selectedMachine.name}` : ''}
              </Text>
              <Text className="mt-1 block text-xs leading-5 text-amber-200/70">
                Worktrees will become available after this machine reconnects with the current discovery support.
              </Text>
            </div>
            {selectedMachine ? (
              <MachineConnectorActionsMenu
                className="w-full justify-center sm:w-auto"
                machine={selectedMachine}
                onOperationSettled={() => {
                  void onRefreshWorktrees().catch(() => undefined);
                }}
                trigger="button"
              />
            ) : null}
          </div>
        ) : worktreeDiscovery.state === 'blocked' ? (
          <div className="rounded-lg border border-red-500/30 bg-red-500/8 px-3 py-3">
            <Text className="block text-sm font-medium text-red-200">
              Worktree discovery is blocked.
            </Text>
            <Text className="mt-1 block text-xs text-red-200/70">
              {worktreeDiscovery.message}
            </Text>
          </div>
        ) : worktreeDiscovery.state === 'ready' ? (
          <WorktreeRuntimeTable
            access={devServers.access}
            actionsDisabled={devServers.isStartingAll}
            machineName={selectedMachine?.name}
            onPrepare={(worktreeId, setupStepId) => void setup.prepare(worktreeId, setupStepId)}
            onSelect={(worktreeId) => {
              const worktree = worktrees.find((candidate) => candidate.id === worktreeId);
              if (worktree?.isBase) onSelectWorkspace();
              else onSelectWorktree(worktreeId);
            }}
            onStart={(worktreeId, serverId) => void devServers.start(worktreeId, serverId)}
            onStop={(worktreeId, serverId) => void devServers.stop(worktreeId, serverId)}
            pendingServerKey={devServers.pendingServerKey}
            pendingSetupKeys={setup.pendingKeys}
            rows={runtimeRows}
            selectedWorktreeId={selectedWorktree?.id ?? ''}
            serversForWorktree={devServers.serversForWorktree}
            setupErrors={setup.errors}
            setupEnabled={devServers.access === 'owner' || devServers.access === 'member'}
            setupResults={setup.results}
          />
        ) : (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/8 px-3 py-3">
            <Text className="block text-sm font-medium text-amber-200">
              No branches or local worktrees found.
            </Text>
            <Text className="mt-1 block text-xs text-amber-200/70">
              The authoritative Git scan completed successfully and found no registered worktrees.
            </Text>
          </div>
        )}
        {actionMessage || repositoryMessage ? (
          <Text aria-live="polite" className="mt-3 block px-1 text-xs text-neutral-500">
            {actionMessage || repositoryMessage}
          </Text>
        ) : null}
        {devServers.error || devServers.startAllResults.some((result) => result.status === 'failed') ? (
          <div aria-live="polite" className="mt-2 space-y-1 px-1">
            {devServers.error ? (
              <Text className="block text-xs text-red-300/80">{devServers.error}</Text>
            ) : null}
            {devServers.startAllResults
              .filter((result) => result.status === 'failed')
              .map((result) => (
                <Text key={result.key} className="block text-xs text-red-300/80">
                  {result.serverLabel}: {result.message || 'Could not start this server.'}
                </Text>
              ))}
          </div>
        ) : null}
      </Surface>

      <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(22rem,28rem)_minmax(0,1fr)]">
        <WorktreeGitClientPanel
          machine={selectedMachine}
          onStatusChange={(nextStatus) =>
            setFileGitStatus(nextStatus?.isRepository ? nextStatus : undefined)
          }
          worktree={selectedWorktree}
        />

        <Surface
          variant="tertiary"
          className="flex min-h-[24rem] flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950/45"
        >
          {selectedExplorerPath ? (
            <FileExplorer
              gitStatus={fileGitStatus}
              machineId={selectedMachine?.id}
              rootPath={selectedExplorerPath}
            />
          ) : (
            <div className="flex min-h-[24rem] items-center justify-center px-6 text-center">
              <Text className="max-w-sm text-sm text-neutral-500">
                Clone or select a valid worktree to inspect files here.
              </Text>
            </div>
          )}
        </Surface>
      </div>
    </div>
  );
}
