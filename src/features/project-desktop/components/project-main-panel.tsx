import type {
  ConnectorOverviewResult,
  ExplorerTarget,
  GitHubCatalogRepository,
  GitHubCatalogResult,
  GitHubRepositoryDetailsResult,
  LauncherAppRecord,
  MachineRecord,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectMainView } from '../hooks/use-project-desktop';
import {
  ChevronDown,
  ExternalLink,
  GitBranch,
  ListChecks,
  Play,
  Server,
  Terminal as TerminalIcon
} from 'lucide-react';
import { WTerm } from '@wterm/dom';
import '@wterm/dom/css';
import { Button, Card, Chip, Surface, Text } from '@/app/dotnaos-ui';
import { projectSpaceClient } from '@/api/project-space-client';
import { OpenTargetDropdown } from './open-target-dropdown';
import { ProjectCliCommandPanel } from './project-cli-command-panel';
import { ProjectHomeOverview } from './project-home-overview';
import { ProjectOperationsPanel } from './project-operations-panel';
import { ProjectTemplateCheckPanel } from './project-template-check';
import { ProjectWorkspaceTools } from './project-workspace-tools';
import { ProjectctlManifestPanel } from './projectctl-manifest-panel';
import {
  isMachineConnected,
  MachineBatteryMeter,
  MachineConnectionIcon,
  MachineDeviceIcon,
  MachineOsMark
} from './machine-visuals';

interface ProjectMainPanelProps {
  connectorOverview: ConnectorOverviewResult;
  githubCatalog: GitHubCatalogResult;
  hasBottomTabBar?: boolean;
  isConnectorRefreshing: boolean;
  isGitHubRefreshing: boolean;
  isSidebarOpen: boolean;
  launcherApps: LauncherAppRecord[];
  launcherError: string;
  mainView: ProjectMainView;
  selectedApp?: LauncherAppRecord;
  selectedAppLabel?: string;
  selectedExplorerTarget: ExplorerTarget;
  selectedMachine?: MachineRecord;
  selectedMachineId: string;
  selectedTargetName: string;
  selectedTargetPath: string;
  sidebarClosedPaddingLeft: number;
  project?: ProjectSpaceRecord;
  projects: ProjectSpaceRecord[];
  onCreateProject(): void;
  onOpenMachines(): void;
  onOpenMachine(machineId: string): void;
  onOpenProjects(): void;
  onOpenSelectedTarget(): void;
  onRefreshConnectorOverview(): Promise<ConnectorOverviewResult>;
  onRefreshGitHubCatalog(): Promise<GitHubCatalogResult>;
  onSelectLauncherApp(appId: string): void;
  onSelectProject(projectId: string): void;
}

function getProjectTimestamp(project: ProjectSpaceRecord) {
  const value = project.github?.updatedAt ?? project.github?.pushedAt;
  const timestamp = value ? Date.parse(value) : NaN;

  return Number.isFinite(timestamp) ? timestamp : 0;
}

function formatRelativeTime(timestamp: number) {
  if (!timestamp) {
    return '';
  }

  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));

  if (minutes < 1) {
    return 'now';
  }

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.round(minutes / 60);

  if (hours < 24) {
    return `${hours}h`;
  }

  return `${Math.round(hours / 24)}d`;
}

function machineSubtitle(machine: MachineRecord) {
  return [machine.kind, machine.profile, machine.network.localName].filter(Boolean).join(' / ');
}

function getMachineId(project: ProjectSpaceRecord) {
  return project.id.includes(':') ? project.id.slice(0, project.id.indexOf(':')) : 'local';
}

function getProjectMachineId(project: ProjectSpaceRecord, localMachineId: string) {
  const machineId = getMachineId(project);
  return machineId === 'local' ? localMachineId : machineId;
}

function formatOptionalTime(value?: string) {
  if (!value) {
    return 'not seen';
  }

  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    return value;
  }

  return formatRelativeTime(timestamp);
}

function isVisibleProject(project: ProjectSpaceRecord) {
  if (project.kind === 'github') {
    return true;
  }

  const folder = project.rootPath.split('/').filter(Boolean).pop() ?? '';

  return !folder.startsWith('.') && !folder.endsWith('.worktrees');
}

function basenamePath(path: string) {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function normalizeKey(value: string) {
  return value.trim().replace(/^@/, '').toLowerCase();
}

function projectMatchesRepository(project: ProjectSpaceRecord, repo: GitHubCatalogRepository) {
  const projectName = normalizeKey(project.name);
  const projectFolder = normalizeKey(basenamePath(project.rootPath));
  const repoFullName = normalizeKey(repo.fullName);
  const repoName = normalizeKey(repo.name);

  return (
    projectName === repoFullName ||
    projectName === repoName ||
    projectFolder === repoFullName ||
    projectFolder === repoName
  );
}

function resolveProjectRepository(
  project: ProjectSpaceRecord | undefined,
  githubCatalog: GitHubCatalogResult
) {
  if (!project || githubCatalog.status !== 'connected') {
    return project?.github;
  }

  return (
    project.github ??
    githubCatalog.repositories.find((repo) => projectMatchesRepository(project, repo))
  );
}

function repositoryDetailsFallback(
  status: GitHubCatalogResult['status']
): GitHubRepositoryDetailsResult {
  return {
    branches: [],
    checkedAt: new Date().toISOString(),
    issues: [],
    status
  };
}

function RootOverview({
  connector,
  onOpenMachines,
  onOpenMachine,
  onOpenProjects,
  onSelectProject,
  projects
}: {
  connector: ConnectorOverviewResult;
  onOpenMachines(): void;
  onOpenMachine(machineId: string): void;
  onOpenProjects(): void;
  onSelectProject(projectId: string): void;
  projects: ProjectSpaceRecord[];
}) {
  const connectedMachines = connector.machines.filter(isMachineConnected);
  const recentProjects = projects
    .filter(isVisibleProject)
    .sort((left, right) => {
      const timestampDelta = getProjectTimestamp(right) - getProjectTimestamp(left);

      return timestampDelta || left.name.localeCompare(right.name);
    })
    .slice(0, 8);
  const hasProjectTimestamps = recentProjects.some((project) => getProjectTimestamp(project) > 0);

  return (
    <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 pt-4">
      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <Text className="text-sm font-semibold text-neutral-100">Running machines</Text>
          <Button size="sm" variant="ghost" onPress={onOpenMachines}>
            View all
          </Button>
        </div>

        {connectedMachines.length > 0 ? (
          <div className="divide-y divide-neutral-900/80">
            {connectedMachines.map((machine) => (
              <button
                key={machine.id}
                type="button"
                onClick={() => onOpenMachine(machine.id)}
                className="flex w-full min-w-0 items-center gap-3 rounded-lg px-3 py-3 text-left transition hover:bg-neutral-900/50"
              >
                <MachineConnectionIcon machine={machine} />
                <MachineDeviceIcon machine={machine} />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Text className="block truncate text-sm font-medium text-neutral-100">
                      {machine.name}
                    </Text>
                    <MachineOsMark machine={machine} />
                  </span>
                  <Text className="block truncate text-xs text-neutral-500">
                    {machineSubtitle(machine) || machine.connector.status}
                  </Text>
                </span>
                <MachineBatteryMeter compact machine={machine} />
              </button>
            ))}
          </div>
        ) : (
          <div className="rounded-lg bg-neutral-950/45 px-4 py-5">
            <Text className="text-sm text-neutral-500">No machines are currently connected.</Text>
          </div>
        )}
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <Text className="text-sm font-semibold text-neutral-100">
            {hasProjectTimestamps ? 'Recent projects' : 'Projects'}
          </Text>
          <Button size="sm" variant="ghost" onPress={onOpenProjects}>
            View all
          </Button>
        </div>

        {recentProjects.length > 0 ? (
          <div className="divide-y divide-neutral-900/80">
            {recentProjects.map((entry) => {
              const timestamp = getProjectTimestamp(entry);
              const label = entry.github?.name ?? entry.name;
              const sublabel = entry.github?.owner ?? (entry.kind === 'github' ? 'GitHub' : 'Local');
              const relative = formatRelativeTime(timestamp);

              return (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => onSelectProject(entry.id)}
                  className="flex w-full min-w-0 items-center justify-between gap-3 rounded-lg px-3 py-3 text-left transition hover:bg-neutral-900/50"
                >
                  <span className="min-w-0">
                    <Text className="block truncate text-sm font-medium text-neutral-100">
                      {label}
                    </Text>
                    <Text className="block truncate text-xs text-neutral-500">{sublabel}</Text>
                  </span>
                  {relative ? (
                    <Text className="shrink-0 text-xs text-neutral-500">{relative}</Text>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="rounded-lg bg-neutral-950/45 px-4 py-5">
            <Text className="text-sm text-neutral-500">No projects discovered yet.</Text>
          </div>
        )}
      </section>
    </div>
  );
}

function MachineDetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-4 border-b border-neutral-900/70 py-2 last:border-b-0">
      <Text className="shrink-0 text-xs font-medium text-neutral-500">{label}</Text>
      <Text className="min-w-0 truncate text-right text-sm text-neutral-200">{value}</Text>
    </div>
  );
}

type MachineTerminalStatus = 'connecting' | 'connected' | 'closed' | 'error';

const MachineTerminalSession = memo(function MachineTerminalSession({
  canRun,
  machineId,
  onStatusChange,
  sessionVersion
}: {
  canRun: boolean;
  machineId: string;
  onStatusChange(status: MachineTerminalStatus, message?: string): void;
  sessionVersion: number;
}) {
  const terminalElementRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<WTerm | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const sizeRef = useRef({ cols: 100, rows: 28 });

  useEffect(() => {
    const element = terminalElementRef.current;

    if (!element) {
      return;
    }

    let canceled = false;
    const terminal = new WTerm(element, {
      autoResize: true,
      cols: 100,
      cursorBlink: true,
      onData(data) {
        const socket = socketRef.current;

        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ data, type: 'input' }));
        }
      },
      onResize(cols, rows) {
        sizeRef.current = { cols, rows };
        const socket = socketRef.current;

        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ cols, rows, type: 'resize' }));
        }
      },
      rows: 28
    });
    terminalRef.current = terminal;

    terminal
      .init()
      .then(() => {
        if (canceled) {
          return;
        }

        if (!canRun) {
          onStatusChange('closed');
          return;
        }

        const { cols, rows } = sizeRef.current;
        const baseUrl =
          import.meta.env.VITE_PROJECT_SPACE_API_BASE_URL ||
          new URL(window.location.href).searchParams.get('projectSpaceApi') ||
          window.location.origin;
        const url = new URL(`/api/machines/${encodeURIComponent(machineId)}/terminal`, baseUrl);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.searchParams.set('cols', String(cols));
        url.searchParams.set('rows', String(rows));
        const socket = new WebSocket(url);
        socketRef.current = socket;

        onStatusChange('connecting');
        terminal.write('\x1bc');

        socket.addEventListener('open', () => {
          if (canceled) {
            return;
          }

          onStatusChange('connected');
          terminal.focus();
        });

        socket.addEventListener('message', (event) => {
          try {
            const message = JSON.parse(String(event.data)) as {
              data?: string;
              exitCode?: number;
              signal?: number;
              type: 'output' | 'exit';
            };

            if (message.type === 'output' && typeof message.data === 'string') {
              terminal.write(message.data);
              return;
            }

            if (message.type === 'exit') {
              terminal.write(
                `\r\n[session exited: ${message.exitCode ?? message.signal ?? 'closed'}]\r\n`
              );
            }
          } catch {
            terminal.write(String(event.data));
          }
        });

        socket.addEventListener('close', () => {
          if (socketRef.current === socket) {
            socketRef.current = null;
          }

          if (!canceled) {
            onStatusChange('closed');
          }
        });

        socket.addEventListener('error', () => {
          if (!canceled) {
            onStatusChange('error');
            terminal.write('\r\n[terminal connection failed]\r\n');
          }
        });
      })
      .catch((error) => {
        if (canceled) {
          return;
        }

        onStatusChange(
          'error',
          `wterm failed to initialize: ${
            error instanceof Error ? error.message : 'unknown error'
          }`
        );
      });

    return () => {
      canceled = true;
      socketRef.current?.close();
      socketRef.current = null;
      terminal.destroy();
      if (terminalRef.current === terminal) {
        terminalRef.current = null;
      }
      onStatusChange('closed');
    };
  }, [canRun, machineId, onStatusChange, sessionVersion]);

  return <div ref={terminalElementRef} className="project-machine-terminal h-[28rem] w-full" />;
}, (previous, next) => {
  return (
    previous.canRun === next.canRun &&
    previous.machineId === next.machineId &&
    previous.sessionVersion === next.sessionVersion
  );
});

function MachineTerminalPanel({ machine }: { machine: MachineRecord }) {
  const [sessionVersion, setSessionVersion] = useState(0);
  const [errorMessage, setErrorMessage] = useState('');
  const [status, setStatus] = useState<MachineTerminalStatus>('closed');
  const canRun = isMachineConnected(machine);
  const handleStatusChange = useCallback((nextStatus: MachineTerminalStatus, message?: string) => {
    setErrorMessage(message ?? '');
    setStatus(nextStatus);
  }, []);

  function reconnect() {
    setSessionVersion((current) => current + 1);
  }

  return (
    <Surface
      variant="tertiary"
      className="rounded-lg border border-neutral-800 bg-neutral-950/45 p-4"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <TerminalIcon className="size-4 text-neutral-400" />
          <Text className="text-sm font-semibold text-neutral-100">Terminal</Text>
        </div>
        <Button size="sm" isDisabled={!canRun || status === 'connecting'} onPress={reconnect}>
          {status === 'connected' ? 'Reconnect' : 'Connect'}
        </Button>
      </div>

      {!canRun ? (
        <Text className="block text-xs text-neutral-500">
          This machine is not connected, so no shell is available right now.
        </Text>
      ) : null}
      <div className="overflow-hidden rounded-lg border border-neutral-800 bg-black">
        <MachineTerminalSession
          canRun={canRun}
          machineId={machine.id}
          onStatusChange={handleStatusChange}
          sessionVersion={sessionVersion}
        />
      </div>
      <Text className="mt-2 block text-xs text-neutral-600">
        {status === 'connected'
          ? 'Live shell connected.'
          : status === 'connecting'
            ? 'Connecting shell...'
            : status === 'error'
              ? errorMessage || 'Terminal connection failed.'
              : 'Terminal disconnected.'}
      </Text>
    </Surface>
  );
}

function RepositoryActivityPanel({
  repository
}: {
  repository?: GitHubCatalogRepository;
}) {
  const [details, setDetails] = useState<GitHubRepositoryDetailsResult>();
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!repository) {
      setDetails(undefined);
      return;
    }

    let canceled = false;

    setError('');
    setIsLoading(true);
    projectSpaceClient
      .getGitHubRepositoryDetails(repository.fullName)
      .then((nextDetails) => {
        if (!canceled) {
          setDetails(nextDetails);
        }
      })
      .catch((requestError) => {
        if (!canceled) {
          setError(
            requestError instanceof Error
              ? requestError.message
              : 'Could not load repository details.'
          );
        }
      })
      .finally(() => {
        if (!canceled) {
          setIsLoading(false);
        }
      });

    return () => {
      canceled = true;
    };
  }, [repository]);

  if (!repository) {
    return null;
  }

  const safeDetails = details ?? repositoryDetailsFallback('connected');
  const issuesMessage =
    error || safeDetails.message || (isLoading ? 'Loading repository details...' : '');

  return (
    <section className="grid gap-3 lg:grid-cols-2">
      <Surface
        variant="tertiary"
        className="rounded-lg border border-neutral-800 bg-neutral-950/45 p-4"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <GitBranch className="size-4 text-neutral-400" />
            <Text className="text-sm font-semibold text-neutral-100">Branches</Text>
          </div>
          <Text className="text-xs text-neutral-500">{safeDetails.branches.length}</Text>
        </div>
        {safeDetails.branches.length > 0 ? (
          <div className="flex max-h-64 flex-col overflow-auto">
            {safeDetails.branches.map((branch) => (
              <a
                key={branch.name}
                href={branch.url ?? repository.url}
                target="_blank"
                rel="noreferrer"
                className="flex min-w-0 items-center justify-between gap-3 rounded-lg px-2 py-2 text-sm transition hover:bg-neutral-900/60"
              >
                <Text className="truncate text-neutral-200">{branch.name}</Text>
                {branch.isDefault ? (
                  <Chip size="sm" className="text-neutral-100">
                    base
                  </Chip>
                ) : null}
              </a>
            ))}
          </div>
        ) : (
          <Text className="text-sm text-neutral-500">
            {issuesMessage || 'No branches loaded yet.'}
          </Text>
        )}
      </Surface>

      <Surface
        variant="tertiary"
        className="rounded-lg border border-neutral-800 bg-neutral-950/45 p-4"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ListChecks className="size-4 text-neutral-400" />
            <Text className="text-sm font-semibold text-neutral-100">Issues</Text>
          </div>
          <Text className="text-xs text-neutral-500">{safeDetails.issues.length}</Text>
        </div>
        {safeDetails.issues.length > 0 ? (
          <div className="flex max-h-64 flex-col overflow-auto">
            {safeDetails.issues.map((issue) => (
              <a
                key={issue.number}
                href={issue.url}
                target="_blank"
                rel="noreferrer"
                className="flex min-w-0 items-start gap-3 rounded-lg px-2 py-2 transition hover:bg-neutral-900/60"
              >
                <Text className="shrink-0 text-xs text-neutral-500">#{issue.number}</Text>
                <span className="min-w-0 flex-1">
                  <Text className="block truncate text-sm font-medium text-neutral-100">
                    {issue.title}
                  </Text>
                  {issue.author ? (
                    <Text className="block truncate text-xs text-neutral-500">
                      {issue.author}
                    </Text>
                  ) : null}
                </span>
              </a>
            ))}
          </div>
        ) : (
          <Text className="text-sm text-neutral-500">
            {issuesMessage || 'No open issues.'}
          </Text>
        )}
      </Surface>
    </section>
  );
}

function MachineDetailView({
  connector,
  machine,
  machineId,
  onOpenMachines,
  onSelectProject,
  projects
}: {
  connector: ConnectorOverviewResult;
  machine?: MachineRecord;
  machineId: string;
  onOpenMachines(): void;
  onSelectProject(projectId: string): void;
  projects: ProjectSpaceRecord[];
}) {
  const localMachineId =
    connector.machines.find((entry) => entry.connector.status === 'local')?.id ??
    connector.machines[0]?.id ??
    'local';
  const machineProjects = machine
    ? projects
        .filter(isVisibleProject)
        .filter((project) => project.kind !== 'github')
        .filter((project) => getProjectMachineId(project, localMachineId) === machine.id)
        .sort((left, right) => left.name.localeCompare(right.name))
    : [];

  if (!machine) {
    return (
      <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center gap-4">
        <Text className="block text-2xl font-semibold text-neutral-100">Machine not found</Text>
        <Text className="block text-sm text-neutral-500">
          {machineId || 'This machine'} is not currently in the connector registry.
        </Text>
        <Button className="w-fit" variant="secondary" onPress={onOpenMachines}>
          Back to machines
        </Button>
      </div>
    );
  }

  const origin =
    machine.connector.origin ?? machine.network.tailscaleIp ?? machine.connector.installCommand;

  return (
    <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-5">
      <section className="border-b border-neutral-800/70 pb-5">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <MachineDeviceIcon machine={machine} />
              <Text className="truncate text-2xl font-semibold text-neutral-50">
                {machine.name}
              </Text>
              <MachineOsMark machine={machine} />
            </div>
            <Text className="mt-1 block text-sm text-neutral-500">
              {machineSubtitle(machine) || 'machine'}
            </Text>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            <MachineConnectionIcon machine={machine} />
            <MachineBatteryMeter machine={machine} />
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Surface
          variant="tertiary"
          className="rounded-lg border border-neutral-800 bg-neutral-950/45 p-4"
        >
          <Text className="mb-3 block text-sm font-semibold text-neutral-100">Connection</Text>
          <MachineDetailRow label="Status" value={machine.connector.status} />
          <MachineDetailRow label="Service" value={machine.connector.serviceName ?? 'unknown'} />
          <MachineDetailRow label="Last seen" value={formatOptionalTime(machine.connector.lastSeen)} />
          <MachineDetailRow label="Origin" value={origin ?? 'unknown'} />
        </Surface>

        <Surface
          variant="tertiary"
          className="rounded-lg border border-neutral-800 bg-neutral-950/45 p-4"
        >
          <Text className="mb-3 block text-sm font-semibold text-neutral-100">System</Text>
          <MachineDetailRow label="OS" value={[machine.os?.family, machine.os?.version].filter(Boolean).join(' ') || 'unknown'} />
          <MachineDetailRow label="Device" value={machine.kind || 'unknown'} />
          <MachineDetailRow label="Profile" value={machine.profile ?? 'unknown'} />
          <MachineDetailRow label="User" value={machine.primaryUser ?? machine.network.sshUser ?? 'unknown'} />
        </Surface>
      </section>

      <MachineTerminalPanel machine={machine} />

      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <Text className="text-sm font-semibold text-neutral-100">Projects on this machine</Text>
          <Text className="text-xs text-neutral-500">{machineProjects.length}</Text>
        </div>

        {machineProjects.length > 0 ? (
          <div className="flex flex-col divide-y divide-neutral-900/80">
            {machineProjects.map((project) => (
              <button
                key={project.id}
                type="button"
                title={project.rootPath}
                onClick={() => onSelectProject(project.id)}
                className="flex min-w-0 items-center justify-between gap-3 rounded-lg px-3 py-3 text-left transition hover:bg-neutral-900/50"
              >
                <span className="min-w-0">
                  <Text className="block truncate text-sm font-medium text-neutral-100">
                    {project.name}
                  </Text>
                  <Text className="block truncate font-mono text-xs text-neutral-500">
                    {project.rootPath}
                  </Text>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="rounded-lg bg-neutral-950/45 px-4 py-6">
            <Text className="text-sm text-neutral-500">
              No local projects reported by this machine yet.
            </Text>
          </div>
        )}
      </section>
    </div>
  );
}

export function ProjectMainPanel({
  connectorOverview,
  githubCatalog,
  hasBottomTabBar = false,
  isConnectorRefreshing,
  isGitHubRefreshing,
  isSidebarOpen,
  launcherApps,
  launcherError,
  mainView,
  selectedApp,
  selectedAppLabel,
  selectedExplorerTarget,
  selectedMachine,
  selectedMachineId,
  selectedTargetName,
  selectedTargetPath,
  sidebarClosedPaddingLeft,
  project,
  projects,
  onCreateProject,
  onOpenMachines,
  onOpenMachine,
  onOpenProjects,
  onOpenSelectedTarget,
  onRefreshConnectorOverview,
  onRefreshGitHubCatalog,
  onSelectLauncherApp,
  onSelectProject
}: ProjectMainPanelProps) {
  const headerSafeInset = isSidebarOpen ? 0 : sidebarClosedPaddingLeft;
  const targetLabel =
    selectedExplorerTarget.kind === 'worktree' ? 'Worktree path' : 'Workspace path';
  const selectedRepository = useMemo(
    () => resolveProjectRepository(project, githubCatalog),
    [githubCatalog, project]
  );

  return (
    <Surface
      variant="transparent"
      className="flex min-h-0 flex-col rounded-none bg-app-panel"
    >
      <div
        className="relative flex h-14 items-center justify-between pr-4 sm:pr-6"
        style={{
          paddingLeft: isSidebarOpen ? '2rem' : `${sidebarClosedPaddingLeft}px`
        }}
      >
        <div
          className="app-drag absolute inset-y-0 right-0"
          style={{
            left: `${headerSafeInset}px`
          }}
        />

        <div className="relative flex min-w-0 items-center gap-3 leading-none">
          <Text className="truncate text-[15px] font-semibold text-neutral-100">
            {mainView === 'root'
              ? 'Project Space'
              : mainView === 'machines'
              ? 'Machines'
              : mainView === 'machine'
                ? selectedMachine?.name ?? 'Machine'
              : mainView === 'projects'
                ? 'Projects'
                : project?.name ?? 'No project selected'}
          </Text>
          {mainView === 'project' && project && project.kind !== 'github' ? (
            <div className="hidden sm:block">
              <Chip
                color="default"
                size="sm"
                variant="tertiary"
                className="shrink-0 text-neutral-400"
              >
                {selectedTargetName}
              </Chip>
            </div>
          ) : null}
        </div>

        {mainView === 'project' && project?.kind !== 'github' ? (
          <div className="app-no-drag relative">
            <OpenTargetDropdown
              apps={launcherApps}
              disabled={!project || !selectedTargetPath}
              onOpen={onOpenSelectedTarget}
              onSelectApp={onSelectLauncherApp}
              selectedApp={selectedApp}
              selectedAppLabel={selectedAppLabel}
            />
          </div>
        ) : null}
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 pt-4 sm:px-8"
        style={{
          paddingBottom: hasBottomTabBar ? 'calc(6.75rem + env(safe-area-inset-bottom))' : '2rem'
        }}
      >
        {mainView === 'machines' || mainView === 'projects' ? (
          <ProjectHomeOverview
            connector={connectorOverview}
            githubCatalog={githubCatalog}
            isConnectorRefreshing={isConnectorRefreshing}
            isGitHubRefreshing={isGitHubRefreshing}
            mode={mainView}
            onRefreshConnector={onRefreshConnectorOverview}
            onRefreshGitHubCatalog={onRefreshGitHubCatalog}
            onSelectMachine={onOpenMachine}
            projects={projects}
            onSelectProject={onSelectProject}
          />
        ) : mainView === 'machine' ? (
          <MachineDetailView
            connector={connectorOverview}
            machine={selectedMachine}
            machineId={selectedMachineId}
            onOpenMachines={onOpenMachines}
            onSelectProject={onSelectProject}
            projects={projects}
          />
        ) : mainView === 'root' ? (
          <RootOverview
            connector={connectorOverview}
            onOpenMachine={onOpenMachine}
            onOpenMachines={onOpenMachines}
            onOpenProjects={onOpenProjects}
            onSelectProject={onSelectProject}
            projects={projects}
          />
        ) : project?.kind === 'github' && project.github ? (
          <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-4">
            <section className="shrink-0 border-b border-neutral-800/70 pb-4">
              <Text className="block text-[11px] font-medium text-neutral-500">
                GitHub repository
              </Text>
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
                className="rounded-lg border border-neutral-800 bg-neutral-950/45 p-4"
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
                className="rounded-lg border border-neutral-800 bg-neutral-950/45 p-4"
              >
                <Text className="block text-sm font-semibold text-neutral-100">
                  Project config
                </Text>
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

            <RepositoryActivityPanel repository={selectedRepository} />
          </div>
        ) : project ? (
          <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-4">
            <section className="shrink-0 border-b border-neutral-800/70 pb-4">
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <Text className="block text-[11px] font-medium text-neutral-500">
                    {targetLabel}
                  </Text>
                  <Text
                    title={selectedTargetPath}
                    className="mt-2 block truncate font-mono text-base font-medium text-neutral-50"
                  >
                    {selectedTargetPath}
                  </Text>
                </div>
                <div className="min-w-[18rem] max-w-full">
                  <ProjectTemplateCheckPanel check={project.fullstackTemplate} />
                </div>
              </div>

              {launcherError ? (
                <Surface
                  variant="tertiary"
                  className="mt-3 rounded-lg border border-amber-400/20 bg-amber-500/8 px-4 py-3 text-sm text-amber-300"
                >
                  {launcherError}
                </Surface>
              ) : null}
            </section>

            <RepositoryActivityPanel repository={selectedRepository} />

            <section className="grid gap-3 lg:grid-cols-2">
              <Surface
                variant="tertiary"
                className="rounded-lg border border-neutral-800 bg-neutral-950/45 p-4"
              >
                <div className="mb-3 flex items-center gap-2">
                  <Play className="size-4 text-neutral-400" />
                  <Text className="text-sm font-semibold text-neutral-100">Actions</Text>
                </div>
                <Button variant="secondary" isDisabled={!project}>
                  Start developing a new feature
                </Button>
              </Surface>

              <Surface
                variant="tertiary"
                className="rounded-lg border border-neutral-800 bg-neutral-950/45 p-4"
              >
                <div className="mb-3 flex items-center gap-2">
                  <Server className="size-4 text-neutral-400" />
                  <Text className="text-sm font-semibold text-neutral-100">
                    Machines developing this project
                  </Text>
                </div>
                <div className="rounded-md border border-neutral-800 bg-neutral-950/50 px-3 py-2">
                  <Text className="block text-sm text-neutral-300">Local connector</Text>
                  <Text className="block truncate font-mono text-xs text-neutral-500">
                    {selectedTargetPath}
                  </Text>
                </div>
              </Surface>
            </section>

            <ProjectWorkspaceTools targetPath={selectedTargetPath} />
            <ProjectCliCommandPanel project={project} targetPath={selectedTargetPath} />

            <details className="group shrink-0 border-t border-neutral-800/70 pt-3">
              <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg py-2 text-sm font-medium text-neutral-300 hover:text-neutral-100">
                <ChevronDown
                  className="size-4 text-neutral-500 transition group-open:rotate-180"
                  strokeWidth={1.8}
                />
                Infrastructure and automation
                <Text className="text-xs font-normal text-neutral-500">
                  connector, deploy, backup, scoped jobs
                </Text>
              </summary>
              <div className="grid gap-3 pt-2">
                <ProjectctlManifestPanel targetPath={selectedTargetPath} />
                <ProjectOperationsPanel projectName={project.name} targetPath={selectedTargetPath} />
              </div>
            </details>
          </div>
        ) : (
          <div className="mx-auto flex h-full w-full max-w-6xl flex-col justify-center gap-4">
            <Card
              variant="secondary"
              className="w-full border border-neutral-800/80 bg-neutral-950/70"
            >
              <Card.Header className="gap-3">
                <Text className="text-[11px] uppercase tracking-[0.18em] text-neutral-500">
                  No Projects
                </Text>
                <Card.Title className="text-2xl font-semibold tracking-tight text-neutral-50">
                  Nothing selected yet
                </Card.Title>
                <Card.Description className="text-base text-neutral-400">
                  Add projects to discover them.
                </Card.Description>
              </Card.Header>
              <Card.Footer>
                <Button variant="outline" onPress={onCreateProject}>
                  Select project
                </Button>
              </Card.Footer>
            </Card>
            <ProjectOperationsPanel projectName="project-space" targetPath="" />
          </div>
        )}
      </div>
    </Surface>
  );
}
