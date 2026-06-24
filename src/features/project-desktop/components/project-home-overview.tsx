import { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ExternalLink,
  Github,
  Laptop,
  RefreshCw,
  Server
} from 'lucide-react';
import { Button, Chip, Text } from '@/app/dotnaos-ui';
import { projectSpaceClient } from '@/api/project-space-client';
import type {
  ConnectorOverviewResult,
  ConnectorStatus,
  FullstackTemplateStatus,
  GitHubCatalogRepository,
  GitHubCatalogResult,
  GitHubProjectConfigStatus,
  MachineRecord,
  ProjectSpaceRecord,
  ProjectWorktreeRecord
} from '@/shared/project-space-api';

interface ProjectHomeOverviewProps {
  projects: ProjectSpaceRecord[];
  onSelectProject(projectId: string): void;
}

interface LocalMatch {
  machineId: string;
  project: ProjectSpaceRecord;
}

interface MatrixRow {
  description?: string;
  id: string;
  isLocalOnly: boolean;
  localMatches: LocalMatch[];
  repo?: GitHubCatalogRepository;
  title: string;
}

interface WorktreeDetail {
  machineId: string;
  project: ProjectSpaceRecord;
  worktrees: ProjectWorktreeRecord[];
}

const connectorFallback: ConnectorOverviewResult = {
  machines: [],
  machinesRepo: {
    exists: false,
    path: ''
  },
  tailscale: {
    connected: false,
    installed: false,
    ips: [],
    peersOnline: 0,
    serveOrigins: []
  }
};

const githubFallback: GitHubCatalogResult = {
  checkedAt: '',
  repositories: [],
  status: 'auth-required'
};

const templateStatusLabels: Record<FullstackTemplateStatus, string> = {
  implemented: 'ok',
  partial: 'partial',
  'not-detected': 'missing',
  'template-source': 'template'
};

function getMachineId(project: ProjectSpaceRecord) {
  return project.id.includes(':') ? project.id.slice(0, project.id.indexOf(':')) : 'local';
}

function getTemplateStatus(project: ProjectSpaceRecord): FullstackTemplateStatus {
  return project.fullstackTemplate?.status ?? 'not-detected';
}

function basename(path: string) {
  return path.split('/').filter(Boolean).at(-1) ?? path;
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

function connectorChipClass(status: ConnectorStatus) {
  if (status === 'local' || status === 'online') {
    return 'border-emerald-500/30 bg-emerald-500/12 text-emerald-200';
  }

  if (status === 'offline') {
    return 'border-amber-500/30 bg-amber-500/12 text-amber-200';
  }

  return 'border-slate-700 bg-slate-800/70 text-slate-300';
}

function configChipClass(status: GitHubProjectConfigStatus | FullstackTemplateStatus) {
  if (status === 'complete' || status === 'implemented' || status === 'template-source') {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200';
  }

  if (status === 'partial') {
    return 'border-amber-500/30 bg-amber-500/10 text-amber-200';
  }

  return 'border-slate-700 bg-slate-900/80 text-slate-400';
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

function MachineIcon({ machine }: { machine: MachineRecord }) {
  if (machine.kind === 'darwin') {
    return <Laptop className="size-4 text-slate-400" />;
  }

  return <Server className="size-4 text-slate-400" />;
}

function MatrixCell({
  matches,
  onSelectProject
}: {
  matches: LocalMatch[];
  onSelectProject(projectId: string): void;
}) {
  if (matches.length === 0) {
    return <span className="text-sm text-slate-700">-</span>;
  }

  const primary = matches[0];
  const status = getTemplateStatus(primary.project);

  return (
    <button
      type="button"
      onClick={() => onSelectProject(primary.project.id)}
      aria-label={`Open ${primary.project.name} on ${primary.machineId}`}
      className="flex max-w-full items-center gap-2 rounded-md border border-slate-800 bg-slate-950/55 px-2.5 py-1.5 text-left transition hover:border-slate-700 hover:bg-slate-900/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
    >
      <Chip size="sm" className={configChipClass(status)}>
        {templateStatusLabels[status]}
      </Chip>
      {matches.length > 1 ? (
        <Text className="text-xs text-slate-500">{matches.length}</Text>
      ) : null}
    </button>
  );
}

function RepoCell({
  row,
  isExpanded,
  onToggle
}: {
  row: MatrixRow;
  isExpanded: boolean;
  onToggle(row: MatrixRow): void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <button
        type="button"
        onClick={() => onToggle(row)}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-900 hover:text-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
        aria-label={isExpanded ? `Hide ${row.title} details` : `Show ${row.title} details`}
      >
        <ChevronDown className={isExpanded ? 'size-4 rotate-180' : 'size-4'} />
      </button>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <Text className="block truncate text-sm font-semibold text-slate-100">
            {row.title}
          </Text>
          {row.isLocalOnly ? (
            <Chip size="sm" variant="tertiary">
              local only
            </Chip>
          ) : null}
          {row.repo ? (
            <a
              href={row.repo.url}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 text-slate-500 hover:text-slate-200"
              aria-label={`Open ${row.repo.fullName} on GitHub`}
            >
              <ExternalLink className="size-3.5" />
            </a>
          ) : null}
        </div>
        <Text className="mt-0.5 block truncate text-xs text-slate-500">
          {row.description || 'No description'}
        </Text>
      </div>
    </div>
  );
}

function WorktreeDrawer({
  details,
  isLoading,
  machinesById,
  row
}: {
  details?: WorktreeDetail[];
  isLoading: boolean;
  machinesById: Map<string, MachineRecord>;
  row: MatrixRow;
}) {
  return (
    <div className="border-b border-slate-800/70 bg-slate-950/35 px-4 py-3">
      <div className="mb-2 flex items-center gap-2">
        <Text className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
          Checkouts and worktrees
        </Text>
        {isLoading ? (
          <RefreshCw className="size-3.5 animate-spin text-slate-500" />
        ) : null}
      </div>
      {row.localMatches.length === 0 ? (
        <Text className="text-sm text-slate-500">No connector checkout found.</Text>
      ) : null}
      <div className="grid gap-2">
        {(details ?? []).map(({ machineId, project, worktrees }) => (
          <div
            key={`${machineId}:${project.id}`}
            className="rounded-lg border border-slate-800/80 bg-slate-950/55 px-3 py-2"
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Chip size="sm" variant="secondary">
                {machinesById.get(machineId)?.name ?? machineId}
              </Chip>
              <Text className="min-w-0 truncate text-sm font-medium text-slate-200">
                {project.rootPath}
              </Text>
              <Chip size="sm" className={configChipClass(getTemplateStatus(project))}>
                {templateStatusLabels[getTemplateStatus(project)]}
              </Chip>
            </div>
            <div className="mt-2 grid gap-1.5">
              {worktrees.length > 0 ? (
                worktrees.map((worktree) => (
                  <div
                    key={worktree.id}
                    className="grid grid-cols-[minmax(7rem,12rem)_minmax(0,1fr)_auto] items-center gap-2 text-xs"
                  >
                    <Text className="truncate text-slate-300">{worktree.name}</Text>
                    <Text className="truncate font-mono text-slate-500">{worktree.path}</Text>
                    <Chip
                      size="sm"
                      className={
                        worktree.status === 'ready'
                          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                          : 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                      }
                    >
                      {worktree.branchName ?? worktree.status}
                    </Chip>
                  </div>
                ))
              ) : (
                <Text className="text-xs text-slate-600">No extra worktrees detected.</Text>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ProjectHomeOverview({
  projects,
  onSelectProject
}: ProjectHomeOverviewProps) {
  const [connector, setConnector] = useState<ConnectorOverviewResult>(connectorFallback);
  const [githubCatalog, setGitHubCatalog] = useState<GitHubCatalogResult>(githubFallback);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [expandedRowId, setExpandedRowId] = useState<string>('');
  const [loadingRowId, setLoadingRowId] = useState<string>('');
  const [worktreeDetails, setWorktreeDetails] = useState<Record<string, WorktreeDetail[]>>({});

  async function refresh() {
    setIsRefreshing(true);
    try {
      const loadGitHubCatalog = async () => {
        const catalog = await projectSpaceClient.getGitHubCatalog().catch(() => githubFallback);

        if (catalog.status === 'connected') {
          return catalog;
        }

        await new Promise((resolve) => setTimeout(resolve, 1_500));
        return projectSpaceClient.getGitHubCatalog().catch(() => catalog);
      };

      const [nextConnector, nextGitHubCatalog] = await Promise.all([
        projectSpaceClient.getConnectorOverview().catch(() => connectorFallback),
        loadGitHubCatalog()
      ]);
      setConnector(nextConnector ?? connectorFallback);
      setGitHubCatalog(nextGitHubCatalog ?? githubFallback);
    } finally {
      setIsRefreshing(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

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

  const rows = useMemo<MatrixRow[]>(() => {
    const repositories =
      githubCatalog.status === 'connected' ? githubCatalog.repositories : [];
    const matchedProjectIds = new Set<string>();
    const repoRows = repositories.map((repo) => {
      const localMatches = projects
        .filter((project) => projectMatchesRepo(project, repo))
        .map((project) => {
          matchedProjectIds.add(project.id);
          return {
            machineId: getMachineId(project),
            project
          };
        });

      return {
        description: repo.description || repo.defaultBranch,
        id: `github:${repo.id}`,
        isLocalOnly: false,
        localMatches,
        repo,
        title: repo.fullName
      };
    });

    const localOnlyRows = projects
      .filter((project) => !matchedProjectIds.has(project.id))
      .map((project) => ({
        description: project.rootPath,
        id: `local:${project.id}`,
        isLocalOnly: true,
        localMatches: [
          {
            machineId: getMachineId(project),
            project
          }
        ],
        title: project.name
      }));

    return [...repoRows, ...localOnlyRows];
  }, [githubCatalog, projects]);

  const columnTemplate = `minmax(20rem,1.35fr) repeat(${machines.length}, minmax(10rem,12rem))`;

  async function toggleRow(row: MatrixRow) {
    const nextExpandedId = expandedRowId === row.id ? '' : row.id;
    setExpandedRowId(nextExpandedId);

    if (!nextExpandedId || worktreeDetails[row.id]) {
      return;
    }

    setLoadingRowId(row.id);
    try {
      const details = await Promise.all(
        row.localMatches.map(async (match) => ({
          ...match,
          worktrees: await projectSpaceClient
            .loadProjectWorktrees(match.project.rootPath)
            .catch(() => [])
        }))
      );
      setWorktreeDetails((current) => ({ ...current, [row.id]: details }));
    } finally {
      setLoadingRowId('');
    }
  }

  return (
    <div className="flex min-h-full w-full flex-col">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <Text className="block text-sm font-semibold text-slate-100">Project matrix</Text>
          <Text className="block text-sm text-slate-500">
            GitHub repos by workstation. Expand a row for local checkouts and worktrees.
          </Text>
        </div>
        <Button
          size="sm"
          variant="ghost"
          isDisabled={isRefreshing}
          onPress={() => void refresh()}
        >
          <RefreshCw className={isRefreshing ? 'size-4 animate-spin' : 'size-4'} />
        </Button>
      </div>

      {githubCatalog.status !== 'connected' ? (
        <div className="mb-3 rounded-lg border border-amber-500/20 bg-amber-500/8 px-3 py-2">
          <Text className="text-sm text-amber-200">
            {githubCatalog.message ?? `GitHub is ${githubCatalog.status}.`}
          </Text>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-slate-800/80">
        <div className="min-w-max">
          <div
            className="sticky top-0 z-10 grid border-b border-slate-800 bg-slate-950/95"
            style={{ gridTemplateColumns: columnTemplate }}
          >
            <div className="flex items-center gap-2 px-4 py-3">
              <Github className="size-4 text-slate-500" />
              <Text className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                GitHub repository
              </Text>
              {githubCatalog.auth?.login ? (
                <Chip size="sm" variant="tertiary">
                  @{githubCatalog.auth.login}
                </Chip>
              ) : null}
            </div>
            {machines.map((machine) => (
              <div key={machine.id} className="border-l border-slate-800 px-3 py-3">
                <div className="flex min-w-0 items-center gap-2">
                  <MachineIcon machine={machine} />
                  <Text className="min-w-0 truncate text-sm font-semibold text-slate-200">
                    {machine.name}
                  </Text>
                </div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <Chip size="sm" className={connectorChipClass(machine.connector.status)}>
                    {machine.connector.status}
                  </Chip>
                  <Chip size="sm" variant="tertiary">
                    {formatLastSeen(machine.connector.lastSeen)}
                  </Chip>
                </div>
              </div>
            ))}
          </div>

          {rows.map((row) => {
            const isExpanded = expandedRowId === row.id;

            return (
              <div key={row.id}>
                <div
                  className="grid border-b border-slate-900/80 hover:bg-slate-900/30"
                  style={{ gridTemplateColumns: columnTemplate }}
                >
                  <div className="min-w-0 px-4 py-3">
                    <RepoCell row={row} isExpanded={isExpanded} onToggle={toggleRow} />
                  </div>
                  {machines.map((machine) => {
                    const matches = row.localMatches.filter(
                      (match) => match.machineId === machine.id
                    );

                    return (
                      <div
                        key={`${row.id}:${machine.id}`}
                        className="flex items-center border-l border-slate-900/80 px-3 py-3"
                      >
                        <MatrixCell
                          matches={matches}
                          onSelectProject={onSelectProject}
                        />
                      </div>
                    );
                  })}
                </div>
                {isExpanded ? (
                  <WorktreeDrawer
                    details={worktreeDetails[row.id]}
                    isLoading={loadingRowId === row.id}
                    machinesById={machinesById}
                    row={row}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
