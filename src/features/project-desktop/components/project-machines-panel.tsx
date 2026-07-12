import { useEffect, useMemo, useState } from 'react';
import { Monitor } from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import {
  Chip,
  SearchField,
  SearchFieldClearButton,
  SearchFieldGroup,
  SearchFieldInput,
  SearchFieldSearchIcon,
  Surface,
  Text
} from '@/app/dotnaos-ui';
import type {
  ConnectorOverviewResult,
  GitHubCatalogRepository,
  MachineRecord,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import { resolvedProjectMachineId } from '../../../shared/project-machine-identity';
import { cn } from '@/lib/utils';
import { matchesFuzzyQuery } from '@/lib/fuzzy-search';
import type { MachineDetailTab } from '../hooks/use-project-desktop';
import { MachineListItem } from './machine-list-item';
import { machineSubtitle } from './project-main-model';
import {
  branchOptions,
  checkoutForProjectPath,
  parseCloneTargetProbeOutput,
  parseWorktreeOutput,
  type CloneTargetInfo,
  type MachineProjectCheckout,
  type MachineWorktreeInfo
} from './project-machine-checkout-model';
import {
  WorktreeBranchList,
  type WorktreeBranchOption
} from './worktree-branch-list';

interface MachineProjectMatch {
  checkout: MachineProjectCheckout;
  machineId: string;
}

interface MachineWorktreeState {
  error?: string;
  worktrees: MachineWorktreeInfo[];
}

interface MachineCloneTargetState {
  error?: string;
  targets: Record<string, CloneTargetInfo>;
}

function basename(path: string) {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function normalizeKey(value: string) {
  return value.trim().replace(/^@/, '').toLowerCase();
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function escapeDoubleQuotedShell(value: string) {
  return value.replace(/["\\$`]/g, (character) => `\\${character}`);
}

function canonicalProjectName(project: ProjectSpaceRecord, repository?: GitHubCatalogRepository) {
  return repository?.name || project.github?.name || project.name.split('/').pop() || basename(project.rootPath);
}

function defaultBranchName(project: ProjectSpaceRecord, repository?: GitHubCatalogRepository) {
  return repository?.defaultBranch || project.github?.defaultBranch || 'main';
}

function isDefaultBranch(branchName: string | undefined, defaultBranch: string) {
  return normalizeKey(branchName || '') === normalizeKey(defaultBranch);
}

function canRunMachineCommand(machine?: MachineRecord) {
  return machine?.connector.status === 'local' || machine?.connector.status === 'online';
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

function compactHomePath(path: string | undefined) {
  if (!path) {
    return '';
  }

  return path.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

function createWorktreeCommand(projectPath: string) {
  return [
    `cd ${shellQuote(projectPath)}`,
    'git worktree list --porcelain 2>/dev/null'
  ].join(' && ');
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
    `  git worktree add --track -b ${shellQuote(branchName)} "$target" ${shellQuote(`origin/${branchName}`)}`,
    'fi'
  ].join('\n');
}

function machineStatusClass(status?: string) {
  if (status === 'local' || status === 'online') {
    return 'text-emerald-300';
  }

  return 'text-neutral-500';
}

function checkoutSortValue(checkout: MachineProjectCheckout) {
  return checkout.kind === 'main' ? `0:${checkout.path}` : `1:${checkout.branchName ?? checkout.path}`;
}

function primaryCheckout(checkouts: MachineProjectCheckout[]) {
  return (
    checkouts.find((checkout) => checkout.kind === 'main') ??
    [...checkouts].sort((left, right) => checkoutSortValue(left).localeCompare(checkoutSortValue(right)))[0]
  );
}

function fallbackWorktrees(checkouts: MachineProjectCheckout[]): MachineWorktreeInfo[] {
  return checkouts.map((checkout) => ({
    branchName: checkout.branchName,
    kind: checkout.kind,
    path: checkout.path
  }));
}

function branchSortValue(defaultBranch: string) {
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

function mergeBranchNames(defaultBranch: string, remoteBranches: string[], worktrees: MachineWorktreeInfo[]) {
  const branches = new Set<string>(remoteBranches);

  for (const worktree of worktrees) {
    if (worktree.branchName) {
      branches.add(worktree.branchName);
    }
  }

  return Array.from(branches).sort(branchSortValue(defaultBranch));
}

export function ProjectMachinesPanel({
  connectorOverview,
  onOpenMachine,
  onOpenWorktreeBranch,
  project,
  projects,
  repository
}: {
  connectorOverview: ConnectorOverviewResult;
  onOpenMachine(machineId: string, tab?: MachineDetailTab): void;
  onOpenWorktreeBranch(machineId: string, branchName: string, path?: string): void;
  project: ProjectSpaceRecord;
  projects: ProjectSpaceRecord[];
  repository?: GitHubCatalogRepository;
}) {
  const [branchState, setBranchState] = useState<Record<string, MachineWorktreeState>>({});
  const [actionMessage, setActionMessage] = useState('');
  const [busyCloneKey, setBusyCloneKey] = useState('');
  const [cloneTargetState, setCloneTargetState] = useState<Record<string, MachineCloneTargetState>>({});
  const [machineQuery, setMachineQuery] = useState('');
  const [repositoryBranches, setRepositoryBranches] = useState<string[]>([]);
  const [repositoryBranchesMessage, setRepositoryBranchesMessage] = useState('');
  const repositoryName = canonicalProjectName(project, repository);
  const defaultBranch = defaultBranchName(project, repository);
  const localMachineId =
    connectorOverview.machines.find((machine) => machine.connector.status === 'local')?.id ??
    connectorOverview.machines[0]?.id ??
    'local';
  const matches = useMemo<MachineProjectMatch[]>(() => {
    return projects
      .filter((candidate) => candidate.kind !== 'github' && candidate.rootPath)
      .map((candidate) => {
        const checkout = checkoutForProjectPath(candidate, repositoryName, defaultBranch);

        if (!checkout) {
          return undefined;
        }

        const machineId = resolvedProjectMachineId(candidate, localMachineId);

        return {
          checkout,
          machineId,
        };
      })
      .filter((match): match is MachineProjectMatch => Boolean(match));
  }, [defaultBranch, localMachineId, projects, repositoryName]);
  const checkoutsByMachineId = useMemo(
    () =>
      matches.reduce((map, match) => {
        const current = map.get(match.machineId) ?? [];
        current.push(match.checkout);
        map.set(
          match.machineId,
          current.sort((left, right) => checkoutSortValue(left).localeCompare(checkoutSortValue(right)))
        );

        return map;
      }, new Map<string, MachineProjectCheckout[]>()),
    [matches]
  );
  const machineRows = useMemo(() => {
    const knownMachineIds = new Set(connectorOverview.machines.map((machine) => machine.id));
    const orphanMatches = matches
      .filter((match) => !knownMachineIds.has(match.machineId))
      .reduce((map, match) => {
        const current = map.get(match.machineId) ?? [];
        current.push(match.checkout);
        map.set(match.machineId, current);

        return map;
      }, new Map<string, MachineProjectCheckout[]>());

    return [
      ...connectorOverview.machines.map((machine) => ({
        checkouts: checkoutsByMachineId.get(machine.id) ?? [],
        machine,
        machineId: machine.id
      })),
      ...Array.from(orphanMatches.entries()).map(([machineId, checkouts]) => ({
        checkouts: checkouts.sort((left, right) => checkoutSortValue(left).localeCompare(checkoutSortValue(right))),
        machine: undefined,
        machineId
      }))
    ];
  }, [checkoutsByMachineId, connectorOverview.machines, matches]);
  const filteredMachineRows = useMemo(
    () =>
      machineRows.filter((row) =>
        matchesFuzzyQuery(
          [
            row.machineId,
            row.machine?.name,
            row.machine?.kind,
            row.machine?.profile,
            row.machine?.primaryUser,
            row.machine?.network.localName,
            row.machine?.network.sshUser,
            row.machine?.network.tailscaleIp,
            row.machine?.connector.status,
            row.checkouts.map((checkout) => checkout.branchName).join(' '),
            row.checkouts.map((checkout) => checkout.path).join(' ')
          ],
          machineQuery
        )
      ),
    [machineQuery, machineRows]
  );
  const repositoryCloneUrl = cloneUrl(repository);
  const checkoutCount = machineRows.reduce(
    (count, row) => count + (branchState[row.machineId]?.worktrees.length ?? row.checkouts.length),
    0
  );
  const cloneBranchNames = useMemo(() => {
    const branches = new Set<string>([defaultBranch]);

    for (const branch of repositoryBranches) {
      branches.add(branch);
    }

    return Array.from(branches).sort((left, right) => {
      if (isDefaultBranch(left, defaultBranch)) {
        return -1;
      }

      if (isDefaultBranch(right, defaultBranch)) {
        return 1;
      }

      return left.localeCompare(right);
    });
  }, [defaultBranch, repositoryBranches]);

  useEffect(() => {
    if (!repository?.fullName) {
      setRepositoryBranches([]);
      setRepositoryBranchesMessage('');
      return;
    }

    let canceled = false;

    setRepositoryBranchesMessage('');
    projectSpaceClient
      .getGitHubRepositoryDetails(repository.fullName)
      .then((details) => {
        if (canceled) {
          return;
        }

        setRepositoryBranches(details.branches.map((branch) => branch.name));
        setRepositoryBranchesMessage(details.message ?? '');
      })
      .catch((error) => {
        if (canceled) {
          return;
        }

        setRepositoryBranches([]);
        setRepositoryBranchesMessage(
          error instanceof Error ? error.message : 'Could not load repository branches.'
        );
      });

    return () => {
      canceled = true;
    };
  }, [repository?.fullName]);

  useEffect(() => {
    let canceled = false;

    void Promise.all(
      machineRows
        .map((row) => ({
          ...row,
          checkout: primaryCheckout(row.checkouts)
        }))
        .filter((row) => row.checkout)
        .map(async (row) => {
          if (!canRunMachineCommand(row.machine)) {
            return {
              key: row.machineId,
              state: {
                error: row.machine
                  ? `${row.machine.name} is ${row.machine.connector.status}.`
                  : 'Machine is not available.',
                worktrees: fallbackWorktrees(row.checkouts)
              }
            };
          }

          const result = await projectSpaceClient.runMachineTerminalCommand({
            command: createWorktreeCommand(row.checkout!.path),
            machineId: row.machineId
          });

          return {
            key: row.machineId,
            state:
              result.exitCode === 0
                ? { worktrees: parseWorktreeOutput(result.stdout, row.checkout!.path) }
                : {
                    error: result.stderr || 'Could not read worktrees.',
                    worktrees: fallbackWorktrees(row.checkouts)
                  }
          };
        })
    ).then((results) => {
      if (canceled) {
        return;
      }

      setBranchState(Object.fromEntries(results.map((result) => [result.key, result.state])));
    });

    return () => {
      canceled = true;
    };
  }, [machineRows]);

  useEffect(() => {
    let canceled = false;
    const runnableRows = machineRows.filter((row) => canRunMachineCommand(row.machine));

    if (cloneBranchNames.length === 0 || runnableRows.length === 0) {
      setCloneTargetState({});
      return;
    }

    void Promise.all(
      runnableRows.map(async (row) => {
        const result = await projectSpaceClient.runMachineTerminalCommand({
          command: createCloneTargetProbeCommand(cloneBranchNames, defaultBranch, repositoryName),
          machineId: row.machineId
        });

        return {
          key: row.machineId,
          state:
            result.exitCode === 0
              ? { targets: parseCloneTargetProbeOutput(result.stdout) }
              : {
                  error: result.stderr || 'Could not inspect clone targets.',
                  targets: {}
                }
        };
      })
    ).then((results) => {
      if (canceled) {
        return;
      }

      setCloneTargetState(Object.fromEntries(results.map((result) => [result.key, result.state])));
    });

    return () => {
      canceled = true;
    };
  }, [cloneBranchNames, defaultBranch, machineRows, repositoryName]);

  async function cloneToMachine(machineId: string, branchName: string) {
    setActionMessage('');
    setBusyCloneKey(`${machineId}:${branchName}`);

    const result = await projectSpaceClient.runMachineTerminalCommand({
      command: createCloneCommand({
        branchName,
        defaultBranch,
        repository: repositoryCloneUrl,
        repositoryName
      }),
      machineId
    });

    setBusyCloneKey('');
    setActionMessage(
      result.exitCode === 0
        ? `${branchName} cloned on ${machineId}. Refresh after the connector reports the new checkout.`
        : result.stderr || result.stdout || `Clone could not be started on ${machineId}.`
    );
  }

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <Surface
        variant="tertiary"
        className="rounded-lg border border-neutral-800 bg-neutral-950/45 px-4 py-3"
      >
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Monitor className="size-4 shrink-0 text-neutral-400" />
            <Text className="text-sm font-semibold text-neutral-100">Project machines</Text>
          </div>
          <Text className="shrink-0 text-xs text-neutral-500">
            {machineRows.length} machines · {checkoutCount} checkouts
          </Text>
        </div>
        {actionMessage ? (
          <Text className="mt-2 block text-xs text-neutral-500">{actionMessage}</Text>
        ) : null}
      </Surface>

      <SearchField aria-label="Search project machines" value={machineQuery} onChange={setMachineQuery}>
        <SearchFieldGroup className="rounded-lg bg-neutral-900/80">
          <SearchFieldSearchIcon />
          <SearchFieldInput className="text-sm" placeholder="Search machines" spellCheck={false} />
          <SearchFieldClearButton />
        </SearchFieldGroup>
      </SearchField>

      {machineRows.length === 0 ? (
        <Text className="px-1 py-4 text-sm text-neutral-500">
          No connector machines are registered yet.
        </Text>
      ) : filteredMachineRows.length === 0 ? (
        <Text className="px-1 py-4 text-sm text-neutral-500">No machines found.</Text>
      ) : (
        <div className="grid gap-3">
          {filteredMachineRows.map((row) => {
            const state = branchState[row.machineId];
            const checkouts = row.checkouts;
            const checkout = primaryCheckout(checkouts);
            const displayedWorktrees = state?.worktrees?.length
              ? state.worktrees
              : fallbackWorktrees(checkouts);
            const worktreeByBranch = new Map<string, NonNullable<WorktreeBranchOption['worktree']>>(
              displayedWorktrees
                .filter((worktree) => worktree.branchName)
                .map((worktree) => [
                  normalizeKey(worktree.branchName!),
                  {
                    branchName: worktree.branchName,
                    id: `${row.machineId}:${worktree.path}`,
                    isBase: isDefaultBranch(worktree.branchName, defaultBranch),
                    name: worktree.branchName || basename(worktree.path),
                    path: worktree.path
                  }
                ])
            );
            const hasCheckout = checkouts.length > 0;
            const selectedTargetState = cloneTargetState[row.machineId];
            const machineBranchNames = mergeBranchNames(defaultBranch, cloneBranchNames, displayedWorktrees);
            const cloneBranchOptions = branchOptions(
              machineBranchNames,
              defaultBranch,
              repositoryName,
              selectedTargetState?.targets,
              worktreeByBranch
            );
            const canNavigate = Boolean(row.machine);
            const targetCheckPending = canRunMachineCommand(row.machine) && !selectedTargetState;
            const canClone =
              Boolean(repositoryCloneUrl) &&
              canRunMachineCommand(row.machine) &&
              !targetCheckPending &&
              !selectedTargetState?.error;
            const checkoutLabel = hasCheckout
              ? 'checkout'
              : targetCheckPending
                ? 'checking target'
                : 'not cloned';
            const checkoutLabelClass = hasCheckout
              ? 'text-sky-300'
              : 'text-neutral-500';
            const machineItemSubtitle = checkout
              ? compactHomePath(checkout.path)
              : row.machine
                ? machineSubtitle(row.machine) || row.machine.connector.status
                : 'Machine not registered';

            return (
              <Surface
                key={row.machineId}
                variant="tertiary"
                role={canNavigate ? 'button' : undefined}
                tabIndex={canNavigate ? 0 : undefined}
                onClick={() => {
                  if (canNavigate) {
                    onOpenMachine(row.machineId, 'projects');
                  }
                }}
                onKeyDown={(event) => {
                  if (!canNavigate || (event.key !== 'Enter' && event.key !== ' ')) {
                    return;
                  }

                  event.preventDefault();
                  onOpenMachine(row.machineId, 'projects');
                }}
                className={cn(
                  'min-w-0 rounded-lg border border-neutral-800 bg-neutral-950/45 p-4 transition',
                  canNavigate
                    ? 'cursor-pointer hover:border-neutral-700 hover:bg-neutral-900/45 focus-visible:border-neutral-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-800'
                    : ''
                )}
              >
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <MachineListItem
                      compact
                      machine={row.machine}
                      fallbackName={row.machineId}
                      subtitle={machineItemSubtitle}
                      className="px-0 py-0 hover:bg-transparent"
                      endContent={
                        <span className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-1.5">
                          <Chip
                            size="sm"
                            className={cn(
                              'rounded-full px-2 py-0.5',
                              machineStatusClass(row.machine?.connector.status)
                            )}
                          >
                            {row.machine?.connector.status ?? 'unknown'}
                          </Chip>
                          <Chip
                            size="sm"
                            className={cn('rounded-full px-2 py-0.5', checkoutLabelClass)}
                          >
                            {checkoutLabel}
                          </Chip>
                          {displayedWorktrees.length > 0 ? (
                            <Chip size="sm" className="rounded-full px-2 py-0.5 text-neutral-400">
                              {displayedWorktrees.length}{' '}
                              {displayedWorktrees.length === 1 ? 'worktree' : 'worktrees'}
                            </Chip>
                          ) : null}
                        </span>
                      }
                    />
                  </div>
                </div>

                <div
                  className="mt-4 min-w-0"
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  {cloneBranchOptions.length > 0 ? (
                    <WorktreeBranchList
                      busyBranchName={
                        busyCloneKey.startsWith(`${row.machineId}:`)
                          ? busyCloneKey.slice(row.machineId.length + 1)
                          : ''
                      }
                      canClone={canClone}
                      cloneMessage={canRunMachineCommand(row.machine) ? 'Clone' : 'Offline'}
                      defaultBranch={defaultBranch}
                      localPathLabel="Local"
                      onCloneBranch={(branchName) => void cloneToMachine(row.machineId, branchName)}
                      onSelectBase={() => onOpenWorktreeBranch(row.machineId, defaultBranch, checkout?.path)}
                      onSelectBranch={(branchName, path) =>
                        onOpenWorktreeBranch(row.machineId, branchName, path)
                      }
                      onSelectWorktree={(worktreeId) => {
                        const branch = cloneBranchOptions.find((option) => option.worktree?.id === worktreeId);
                        if (branch) {
                          onOpenWorktreeBranch(row.machineId, branch.branchName, branch.worktree?.path);
                        }
                      }}
                      options={cloneBranchOptions}
                      projectName={repositoryName}
                      selectedValue=""
                      showMissingPath={false}
                    />
                  ) : (
                    <Text className="block rounded-lg border border-neutral-900 px-3 py-3 text-sm text-neutral-500">
                      No GitHub branches found for this repository.
                    </Text>
                  )}

                  {selectedTargetState?.error || repositoryBranchesMessage ? (
                    <Text className="mt-3 block text-xs text-neutral-500">
                      {selectedTargetState?.error || repositoryBranchesMessage}
                    </Text>
                  ) : null}
                </div>
              </Surface>
            );
          })}
        </div>
      )}
    </div>
  );
}
