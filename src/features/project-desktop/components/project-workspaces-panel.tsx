import { useEffect, useMemo, useState } from 'react';
import { GitBranchPlus, LoaderCircle } from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import { Button, Surface, Text } from '@/app/dotnaos-ui';
import type {
  ConnectorOverviewResult,
  ExplorerTarget,
  GitHubCatalogRepository,
  MachineRecord,
  ProjectSpaceRecord,
  ProjectWorktreeRecord
} from '@/shared/project-space-api';
import { useWorktreeDevServers } from '../hooks/use-worktree-dev-servers';
import { FileExplorer } from './file-explorer';
import { DevServerSettings } from './dev-server-settings';
import { DevServerAccessNotice } from './worktree-dev-server';
import { WorktreeRuntimeTable } from './worktree-runtime-table';
import { runtimeRowsForWorktrees, unmaterializedBranchesFor } from './worktree-runtime-model';
import { useWorktreeSetup } from '../hooks/use-worktree-setup';
import {
  WorktreeGitClientPanel,
  type WorktreeGitStatusSnapshot
} from './worktree-git-client-panel';

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
  const unmaterializedBranches = useMemo(
    () => unmaterializedBranchesFor(branchNames, worktrees),
    [branchNames, worktrees]
  );
  const selectedWorktree =
    selectedExplorerTarget.kind === 'worktree'
      ? worktrees.find((worktree) => worktree.id === selectedExplorerTarget.worktreeId)
      : (worktrees.find((worktree) => worktree.isBase) ?? worktrees[0]);
  const selectedExplorerPath = selectedWorktree?.status === 'ready' ? selectedWorktree.path : '';
  const canCreate =
    Boolean(repository?.fullName ?? project.github?.fullName) &&
    Boolean(selectedMachine) &&
    canRunMachineCommand(selectedMachine);
  const createLabel = selectedMachine
    ? canRunMachineCommand(selectedMachine)
      ? 'Create'
      : 'Offline'
    : 'No machine';

  useEffect(() => {
    setFileGitStatus(undefined);
  }, [selectedWorktree?.id]);

  useEffect(() => {
    if (!unmaterializedBranches.includes(selectedCreateBranch)) {
      setSelectedCreateBranch(unmaterializedBranches[0] ?? '');
    }
  }, [selectedCreateBranch, unmaterializedBranches]);

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
        <div className="mb-3 flex items-center justify-between gap-3 px-1">
          <div className="min-w-0">
            <Text className="text-sm font-semibold text-neutral-100">Worktrees</Text>
            <Text className="mt-0.5 block text-xs text-neutral-500">
              {worktrees.length} worktrees ·{' '}
              {Array.from(devServers.serversForWorktree.values()).reduce(
                (total, servers) => total + servers.length,
                0
              )}{' '}
              servers
            </Text>
          </div>
          <Button
            size="sm"
            variant="primary"
            className="shrink-0 bg-sky-500 text-white hover:bg-sky-400"
            isDisabled={unmaterializedBranches.length === 0}
            onPress={() => setShowCreate((value) => !value)}
          >
            <GitBranchPlus className="size-4" />
            New worktree
          </Button>
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

        {runtimeRows.length > 0 ? (
          <WorktreeRuntimeTable
            access={devServers.access}
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
              This machine has no valid checkout for this project yet.
            </Text>
          </div>
        )}
        {actionMessage || repositoryMessage ? (
          <Text aria-live="polite" className="mt-3 block px-1 text-xs text-neutral-500">
            {actionMessage || repositoryMessage}
          </Text>
        ) : null}
        {devServers.error ? (
          <Text aria-live="polite" className="mt-2 block px-1 text-xs text-red-300/80">
            {devServers.error}
          </Text>
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
