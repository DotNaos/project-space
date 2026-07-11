import { useEffect, useMemo, useState } from 'react';
import { GitBranchPlus } from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import { Button, Chip, Surface, Text } from '@/app/dotnaos-ui';
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
import { WorktreeBranchList, type CloneTargetInfo, type WorktreeBranchOption } from './worktree-branch-list';
import {
  DevServerAccessNotice,
  WorktreeDevServerAction,
  WorktreeDevServerDetails
} from './worktree-dev-server';
import {
  WorktreeGitClientPanel,
  type WorktreeGitStatusSnapshot
} from './worktree-git-client-panel';

function normalizeKey(value: string) {
  return value.trim().replace(/^refs\/heads\//, '').toLowerCase();
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function escapeDoubleQuotedShell(value: string) {
  return value.replace(/["\\$`]/g, (character) => `\\${character}`);
}

function cloneUrl(repository?: GitHubCatalogRepository) {
  if (!repository) {
    return '';
  }

  if (repository.fullName) {
    return `git@github.com:${repository.fullName}.git`;
  }

  return repository.url.endsWith('.git') ? repository.url : `${repository.url}.git`;
}

function isDefaultBranch(branchName: string, defaultBranch: string) {
  return normalizeKey(branchName) === normalizeKey(defaultBranch);
}

function expectedPathForBranch(repositoryName: string, branchName: string, defaultBranch: string) {
  if (isDefaultBranch(branchName, defaultBranch)) {
    return `~/projects/${repositoryName}`;
  }

  return `~/projects/.worktrees/${repositoryName}/${branchName}`;
}

function cloneTargetExpressionForBranch(repositoryName: string, branchName: string, defaultBranch: string) {
  const projectPath = escapeDoubleQuotedShell(repositoryName);
  const worktreePath = escapeDoubleQuotedShell(`${repositoryName}/${branchName}`);

  if (isDefaultBranch(branchName, defaultBranch)) {
    return `$HOME/projects/${projectPath}`;
  }

  return `$HOME/projects/.worktrees/${worktreePath}`;
}

function createCloneTargetProbeCommand(
  branchNames: string[],
  defaultBranch: string,
  repositoryName: string
) {
  return [
    'set -e',
    ...branchNames.flatMap((branch) => [
      `target="${cloneTargetExpressionForBranch(repositoryName, branch, defaultBranch)}"`,
      'if [ -e "$target" ]; then exists=1; else exists=0; fi',
      `printf '%s\\t%s\\t%s\\n' ${shellQuote(branch)} "$exists" "$target"`
    ])
  ].join('\n');
}

function parseCloneTargetProbeOutput(output: string): Record<string, CloneTargetInfo> {
  return Object.fromEntries(
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [branchName, exists, path] = line.split('\t');

        return [
          branchName,
          {
            exists: exists === '1',
            path
          }
        ];
      })
  );
}

function createCloneCommand({
  branchName,
  defaultBranch,
  repository,
  repositoryName
}: {
  branchName: string;
  defaultBranch: string;
  repository: string;
  repositoryName: string;
}) {
  const projectPath = escapeDoubleQuotedShell(repositoryName);
  const worktreePath = escapeDoubleQuotedShell(`${repositoryName}/${branchName}`);

  if (isDefaultBranch(branchName, defaultBranch)) {
    return [
      'set -e',
      `target="$HOME/projects/${projectPath}"`,
      'if [ -e "$target" ]; then echo "Target already exists: $target"; exit 1; fi',
      'mkdir -p "${target%/*}"',
      `git clone --branch ${shellQuote(branchName)} ${shellQuote(repository)} "$target"`
    ].join('\n');
  }

  return [
    'set -e',
    `base="$HOME/projects/${projectPath}"`,
    `target="$HOME/projects/.worktrees/${worktreePath}"`,
    'if [ -e "$target" ]; then echo "Target already exists: $target"; exit 1; fi',
    'if [ ! -d "$base/.git" ]; then',
    '  mkdir -p "${base%/*}"',
    `  git clone --branch ${shellQuote(defaultBranch)} ${shellQuote(repository)} "$base"`,
    'fi',
    'mkdir -p "${target%/*}"',
    'cd "$base"',
    `git fetch origin ${shellQuote(branchName)}`,
    `if git show-ref --verify --quiet ${shellQuote(`refs/heads/${branchName}`)}; then`,
    `  git worktree add "$target" ${shellQuote(branchName)}`,
    'else',
    `  git worktree add --track -b ${shellQuote(branchName)} "$target" ${shellQuote(
      `origin/${branchName}`
    )}`,
    'fi'
  ].join('\n');
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
  onOpenNewWorktree,
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
  onOpenNewWorktree(): void;
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
  const [cloneTargets, setCloneTargets] = useState<Record<string, CloneTargetInfo>>({});
  const [fileGitStatus, setFileGitStatus] = useState<WorktreeGitStatusSnapshot>();
  const [repositoryBranches, setRepositoryBranches] = useState<string[]>([]);
  const [repositoryMessage, setRepositoryMessage] = useState('');
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
  const repositoryName = repository?.name ?? project.github?.name ?? project.name;
  const defaultBranch =
    repository?.defaultBranch ?? project.github?.defaultBranch ?? project.gitStatus?.branchName ?? 'main';
  const repositoryCloneUrl = cloneUrl(repository ?? project.github);
  const branchNames = useMemo(() => {
    const branches = new Set<string>([defaultBranch]);

    for (const branch of repositoryBranches) {
      branches.add(branch);
    }

    for (const worktree of worktrees) {
      const branch = worktree.branchName || worktree.name;

      if (branch) {
        branches.add(branch);
      }
    }

    return Array.from(branches).sort(branchSort(defaultBranch));
  }, [defaultBranch, repositoryBranches, worktrees]);
  const worktreeByBranch = useMemo(
    () =>
      new Map(
        worktrees
          .map((worktree) => [normalizeKey(worktree.branchName || worktree.name), worktree] as const)
          .filter(([branch]) => Boolean(branch))
      ),
    [worktrees]
  );
  const branchOptions = useMemo<WorktreeBranchOption[]>(
    () =>
      branchNames.map((branchName) => ({
        branchName,
        expectedPath: expectedPathForBranch(repositoryName, branchName, defaultBranch),
        target: cloneTargets[branchName],
        worktree: worktreeByBranch.get(normalizeKey(branchName))
      })),
    [branchNames, cloneTargets, defaultBranch, repositoryName, worktreeByBranch]
  );
  const selectedWorktree =
    selectedExplorerTarget.kind === 'worktree'
      ? worktrees.find((worktree) => worktree.id === selectedExplorerTarget.worktreeId)
      : worktrees.find((worktree) => worktree.isBase) ?? worktrees[0];
  const selectedExplorerPath = selectedWorktree?.path ?? '';
  const canClone =
    Boolean(repositoryCloneUrl) && Boolean(selectedMachine) && canRunMachineCommand(selectedMachine);
  const cloneMessage = selectedMachine
    ? canRunMachineCommand(selectedMachine)
      ? 'Clone'
      : 'Offline'
    : 'No machine';

  useEffect(() => {
    setFileGitStatus(undefined);
  }, [selectedWorktree?.id]);

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

  useEffect(() => {
    if (!selectedMachine || !canRunMachineCommand(selectedMachine) || branchNames.length === 0) {
      setCloneTargets({});
      return;
    }

    let canceled = false;

    projectSpaceClient
      .runMachineTerminalCommand({
        command: createCloneTargetProbeCommand(branchNames, defaultBranch, repositoryName),
        machineId: selectedMachine.id
      })
      .then((result) => {
        if (canceled) {
          return;
        }

        setCloneTargets(result.exitCode === 0 ? parseCloneTargetProbeOutput(result.stdout) : {});
      })
      .catch(() => {
        if (!canceled) {
          setCloneTargets({});
        }
      });

    return () => {
      canceled = true;
    };
  }, [branchNames, defaultBranch, repositoryName, selectedMachine?.id, selectedMachine?.connector.status]);

  async function cloneBranch(branchName: string) {
    if (!selectedMachine || !repositoryCloneUrl || !canRunMachineCommand(selectedMachine)) {
      return;
    }

    setActionMessage('');
    setBusyBranchName(branchName);
    try {
      const result = await projectSpaceClient.runMachineTerminalCommand({
        command: createCloneCommand({
          branchName,
          defaultBranch,
          repository: repositoryCloneUrl,
          repositoryName
        }),
        machineId: selectedMachine.id
      });

      if (result.exitCode !== 0) {
        setActionMessage(result.stderr || result.stdout || `Could not clone ${branchName}.`);
        return;
      }

      let nextWorktrees: ProjectWorktreeRecord[];
      try {
        nextWorktrees = await onRefreshWorktrees();
      } catch {
        setActionMessage(
          `${branchName} was cloned on ${selectedMachine.name}, but the worktree list could not be refreshed.`
        );
        return;
      }

      const nextWorktree = nextWorktrees.find(
        (worktree) => normalizeKey(worktree.branchName || worktree.name) === normalizeKey(branchName)
      );

      if (!nextWorktree) {
        setActionMessage(
          `${branchName} was cloned on ${selectedMachine.name}, but it is not visible in the worktree list yet.`
        );
        return;
      }

      onSelectWorktree(nextWorktree.id);
      setActionMessage(`${branchName} cloned on ${selectedMachine.name}.`);
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : `Could not clone ${branchName}.`);
    } finally {
      setBusyBranchName('');
    }
  }

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(22rem,28rem)_minmax(0,1fr)]">
        <div className="flex min-h-0 flex-col gap-4">
          <Surface
            variant="tertiary"
            className="flex min-h-0 flex-col rounded-lg border border-neutral-800 bg-neutral-950/45 p-3"
          >
            <div className="mb-3 flex items-center justify-between gap-3 px-1">
              <div className="min-w-0">
                <Text className="text-sm font-semibold text-neutral-100">Worktrees</Text>
                <Text className="mt-0.5 block text-xs text-neutral-500">
                  {worktrees.length} local · {branchOptions.length} branches
                </Text>
              </div>
              <Button size="sm" variant="ghost" className="shrink-0" onPress={onOpenNewWorktree}>
                <GitBranchPlus className="size-4" />
                New
              </Button>
            </div>

            <DevServerAccessNotice
              access={devServers.access}
              machineName={selectedMachine?.name}
            />
            <DevServerSettings
              access={devServers.access}
              hasActiveServers={devServers.hasActiveServers}
              isSaving={devServers.isSavingSettings}
              onSave={devServers.updateSettings}
              settings={devServers.settings}
            />

            {branchOptions.length > 0 ? (
              <WorktreeBranchList
                busyBranchName={busyBranchName}
                canClone={canClone}
                cloneMessage={cloneMessage}
                defaultBranch={defaultBranch}
                onCloneBranch={(branchName) => void cloneBranch(branchName)}
                onSelectBase={onSelectWorkspace}
                onSelectWorktree={onSelectWorktree}
                options={branchOptions}
                projectName={repositoryName}
                renderWorktreeAction={(worktree) => (
                  <WorktreeDevServerAction
                    access={devServers.access}
                    isChecking={devServers.isChecking}
                    isPending={devServers.pendingWorktreeId === worktree.id}
                    onStart={() => void devServers.start(worktree.id)}
                    onStop={() => void devServers.stop(worktree.id)}
                    server={devServers.serversByWorktreeId.get(worktree.id)}
                  />
                )}
                renderWorktreeDetails={(worktree) => (
                  <WorktreeDevServerDetails
                    machineName={selectedMachine?.name}
                    server={devServers.serversByWorktreeId.get(worktree.id)}
                  />
                )}
                selectedValue={selectedWorktree?.id ?? ''}
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
              <Text className="mt-3 block px-1 text-xs text-neutral-500">
                {actionMessage || repositoryMessage}
              </Text>
            ) : null}
            {devServers.error ? (
              <Text className="mt-2 block px-1 text-xs text-red-300/80">
                {devServers.error}
              </Text>
            ) : null}
          </Surface>

          <WorktreeGitClientPanel
            machine={selectedMachine}
            onStatusChange={(nextStatus) =>
              setFileGitStatus(nextStatus?.isRepository ? nextStatus : undefined)
            }
            worktree={selectedWorktree}
          />
        </div>

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
