import { useEffect, useMemo, useState } from 'react';
import { Bot, Download, GitBranchPlus, Monitor, Terminal } from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import { Button, Chip, Surface, Text } from '@/app/dotnaos-ui';
import type {
  ConnectorOverviewResult,
  GitHubCatalogRepository,
  MachineRecord,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import { cn } from '@/lib/utils';

interface MachineProjectMatch {
  machineId: string;
  project: ProjectSpaceRecord;
}

interface MachineBranchState {
  branches: string[];
  error?: string;
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

function getMachineId(project: ProjectSpaceRecord, localMachineId: string) {
  if (project.id.includes(':')) {
    const candidate = project.id.slice(0, project.id.indexOf(':'));
    return candidate === 'local' ? localMachineId : candidate;
  }

  return localMachineId;
}

function matchesSelectedProject(
  candidate: ProjectSpaceRecord,
  selectedProject: ProjectSpaceRecord,
  repository?: GitHubCatalogRepository
) {
  if (candidate.id === selectedProject.id) {
    return true;
  }

  const candidateName = normalizeKey(candidate.name);
  const candidateFolder = normalizeKey(basename(candidate.rootPath));

  if (repository) {
    const repoName = normalizeKey(repository.name);
    const repoFullName = normalizeKey(repository.fullName);

    return (
      candidateName === repoName ||
      candidateName === repoFullName ||
      candidateFolder === repoName ||
      candidateFolder === repoFullName
    );
  }

  const selectedName = normalizeKey(selectedProject.name);
  const selectedFolder = normalizeKey(basename(selectedProject.rootPath));

  return candidateName === selectedName || candidateFolder === selectedFolder;
}

function parseBranchOutput(output: string) {
  return Array.from(
    new Set(
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    )
  ).sort((left, right) => left.localeCompare(right));
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

function relativeClonePath(projectPath: string, fallbackName: string) {
  const normalized = projectPath.replace(/\/+$/, '');
  const marker = '/projects/';
  const markerIndex = normalized.lastIndexOf(marker);

  if (markerIndex >= 0) {
    return normalized.slice(markerIndex + marker.length) || fallbackName;
  }

  return fallbackName;
}

function createBranchCommand(projectPath: string) {
  return [
    `cd ${shellQuote(projectPath)}`,
    "{ git branch --show-current 2>/dev/null || true; git worktree list --porcelain 2>/dev/null | sed -n 's/^branch refs\\/heads\\///p'; } | awk 'NF && !seen[$0]++'"
  ].join(' && ');
}

function createCloneCommand({
  projectPath,
  repository,
  repositoryName
}: {
  projectPath: string;
  repository: string;
  repositoryName: string;
}) {
  const relativePath = escapeDoubleQuotedShell(relativeClonePath(projectPath, repositoryName));

  return [
    'set -e',
    `target="$HOME/projects/${relativePath}"`,
    'if [ -e "$target" ]; then echo "Target already exists: $target"; exit 1; fi',
    'mkdir -p "${target%/*}"',
    `git clone ${shellQuote(repository)} "$target"`
  ].join('\n');
}

function machineStatusClass(status?: string) {
  if (status === 'local' || status === 'online') {
    return 'text-emerald-300';
  }

  return 'text-neutral-500';
}

export function ProjectMachinesPanel({
  connectorOverview,
  project,
  projects,
  repository
}: {
  connectorOverview: ConnectorOverviewResult;
  project: ProjectSpaceRecord;
  projects: ProjectSpaceRecord[];
  repository?: GitHubCatalogRepository;
}) {
  const [branchState, setBranchState] = useState<Record<string, MachineBranchState>>({});
  const [actionMessage, setActionMessage] = useState('');
  const [busyMachineId, setBusyMachineId] = useState('');
  const localMachineId =
    connectorOverview.machines.find((machine) => machine.connector.status === 'local')?.id ??
    connectorOverview.machines[0]?.id ??
    'local';
  const matches = useMemo<MachineProjectMatch[]>(() => {
    return projects
      .filter((candidate) => candidate.kind !== 'github' && candidate.rootPath)
      .filter((candidate) => matchesSelectedProject(candidate, project, repository))
      .map((candidate) => {
        const machineId = getMachineId(candidate, localMachineId);
        return {
          machineId,
          project: candidate
        };
      });
  }, [localMachineId, project, projects, repository]);
  const matchesByMachineId = useMemo(
    () => new Map(matches.map((match) => [match.machineId, match.project])),
    [matches]
  );
  const machineRows = useMemo(() => {
    const knownMachineIds = new Set(connectorOverview.machines.map((machine) => machine.id));
    const orphanMatches = matches
      .filter((match) => !knownMachineIds.has(match.machineId))
      .map((match) => ({
        machine: undefined,
        machineId: match.machineId,
        project: match.project
      }));

    return [
      ...connectorOverview.machines.map((machine) => ({
        machine,
        machineId: machine.id,
        project: matchesByMachineId.get(machine.id)
      })),
      ...orphanMatches
    ];
  }, [connectorOverview.machines, matches, matchesByMachineId]);
  const repositoryCloneUrl = cloneUrl(repository);
  const repositoryName = repository?.name ?? basename(project.rootPath);
  const checkoutCount = machineRows.filter((row) => row.project).length;

  useEffect(() => {
    let canceled = false;

    void Promise.all(
      machineRows
        .filter((row) => row.project)
        .map(async (row) => {
          if (!canRunMachineCommand(row.machine)) {
            return {
              key: row.machineId,
              state: {
                branches: [],
                error: row.machine
                  ? `${row.machine.name} is ${row.machine.connector.status}.`
                  : 'Machine is not available.'
              }
            };
          }

          const result = await projectSpaceClient.runMachineTerminalCommand({
            command: createBranchCommand(row.project!.rootPath),
            machineId: row.machineId
          });

          return {
            key: row.machineId,
            state:
              result.exitCode === 0
                ? { branches: parseBranchOutput(result.stdout) }
                : {
                    branches: [],
                    error: result.stderr || 'Could not read branches.'
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

  async function openInApp(appId: string, path: string, label: string) {
    setActionMessage('');
    const result =
      appId === 'codex'
        ? await projectSpaceClient.openCodexTarget({ cwd: path })
        : await projectSpaceClient.openPathInApp({ appId, path });

    setActionMessage(
      result.status === 'success'
        ? `${label} opened for ${basename(path)}.`
        : result.message ?? `${label} could not be opened.`
    );
  }

  async function cloneToMachine(machineId: string) {
    setActionMessage('');
    setBusyMachineId(machineId);

    const result = await projectSpaceClient.runMachineTerminalCommand({
      command: createCloneCommand({
        projectPath: project.rootPath,
        repository: repositoryCloneUrl,
        repositoryName
      }),
      machineId
    });

    setBusyMachineId('');
    setActionMessage(
      result.exitCode === 0
        ? `Clone finished on ${machineId}. Refresh after the connector reports the new checkout.`
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

      {machineRows.length === 0 ? (
        <Text className="px-1 py-4 text-sm text-neutral-500">
          No connector machines are registered yet.
        </Text>
      ) : (
        <div className="grid gap-3">
          {machineRows.map((row) => {
            const state = branchState[row.machineId];
            const branches = state?.branches ?? [];
            const hasCheckout = Boolean(row.project);
            const isLocal = row.machine?.connector.status === 'local';
            const canOpen = isLocal && row.project;
            const canClone =
              !hasCheckout && Boolean(repositoryCloneUrl) && canRunMachineCommand(row.machine);

            return (
              <Surface
                key={row.machineId}
                variant="tertiary"
                className="min-w-0 rounded-lg border border-neutral-800 bg-neutral-950/45 p-4"
              >
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <Text className="truncate text-sm font-semibold text-neutral-100">
                        {row.machine?.name ?? row.machineId}
                      </Text>
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
                        className={cn(
                          'rounded-full px-2 py-0.5',
                          hasCheckout ? 'text-sky-300' : 'text-neutral-500'
                        )}
                      >
                        {hasCheckout ? 'checkout' : 'not cloned'}
                      </Chip>
                    </div>
                    <Text className="mt-1 block truncate font-mono text-xs text-neutral-500">
                      {row.project
                        ? row.project.rootPath
                        : `~/projects/${relativeClonePath(project.rootPath, repositoryName)}`}
                    </Text>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {hasCheckout ? (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          isDisabled={!canOpen}
                          onPress={() =>
                            void openInApp('terminal', row.project!.rootPath, 'Terminal')
                          }
                        >
                          <Terminal className="size-4" />
                          Start branch
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          isDisabled={!canOpen}
                          onPress={() => void openInApp('codex', row.project!.rootPath, 'Codex')}
                        >
                          <Bot className="size-4" />
                          New feature
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        isDisabled={!canClone || busyMachineId === row.machineId}
                        onPress={() => void cloneToMachine(row.machineId)}
                      >
                        <Download className="size-4" />
                        {busyMachineId === row.machineId ? 'Cloning...' : 'Clone'}
                      </Button>
                    )}
                  </div>
                </div>

                <div className="mt-3 flex min-w-0 flex-wrap items-center gap-1.5">
                  {!hasCheckout ? (
                    <Text className="text-xs text-neutral-500">
                      Clone source: {repositoryCloneUrl || 'No GitHub repository detected.'}
                    </Text>
                  ) : branches.length > 0 ? (
                    branches.map((branch) => (
                      <span
                        key={branch}
                        className="inline-flex max-w-56 items-center gap-1 rounded-full bg-neutral-900 px-2 py-0.5 text-[11px] font-medium text-neutral-300"
                      >
                        <GitBranchPlus className="size-3 shrink-0 text-neutral-500" />
                        <span className="truncate">{branch}</span>
                      </span>
                    ))
                  ) : (
                    <Text className="text-xs text-neutral-500">
                      {state?.error ?? 'Loading branches...'}
                    </Text>
                  )}
                </div>
              </Surface>
            );
          })}
        </div>
      )}
    </div>
  );
}
