import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Chip,
  ScrollShadow,
  Surface,
  Text
} from '@/app/dotnaos-ui';
import {
  ExternalLink,
  Network,
  Play,
  PlugZap,
  RefreshCw,
  Rocket,
  Server
} from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import type {
  ConnectorOverviewResult,
  GitActionResult,
  ProjectCliCommandResult,
  ProjectDeployEnvironment
} from '@/shared/project-space-api';
import { ScopeDevboxJobPanel } from './scope-devbox-job-panel';

interface ProjectOperationsPanelProps {
  projectName: string;
  showJobs?: boolean;
  targetPath: string;
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

function formatAction(action?: GitActionResult) {
  if (!action) {
    return '';
  }

  return [action.message, action.stdout?.trim(), action.stderr?.trim()].filter(Boolean).join('\n');
}

interface DeployEnvironmentStatus {
  apiUrl: string;
  branch: string;
  composeProject: string;
  docsUrl: string;
  environment: ProjectDeployEnvironment;
  remotePath: string;
  status?: string;
  webUrl: string;
}

interface DeployStatusReport {
  environments: DeployEnvironmentStatus[];
  host: string;
  projectName: string;
  projectRoot: string;
}

function parseDeployStatus(result?: ProjectCliCommandResult) {
  if (!result || result.exitCode !== 0 || !result.stdout.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(result.stdout) as DeployStatusReport;
  } catch {
    return undefined;
  }
}

function statusSummary(status?: string) {
  if (!status) {
    return 'unknown';
  }
  if (status.includes('status unavailable')) {
    return 'unavailable';
  }
  if (status.includes('app status unavailable')) {
    return 'partial';
  }
  if (status.includes('repo missing')) {
    return 'repo missing';
  }
  if (status.includes('repo present')) {
    return 'repo present';
  }
  return 'checked';
}

function statusIsOk(label: string) {
  return label === 'checked' || label === 'repo present';
}

function StatusChip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Chip size="sm" variant={ok ? 'primary' : 'secondary'}>
      {label}
    </Chip>
  );
}

function DeploymentUrlLink({ label, url }: { label: string; url: string }) {
  if (!url) {
    return null;
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="group flex min-w-0 items-start gap-1 text-xs text-neutral-400 transition hover:text-neutral-100"
    >
      <span className="shrink-0 text-neutral-500">{label}:</span>
      <span className="min-w-0 break-all underline decoration-neutral-700 underline-offset-2 group-hover:decoration-neutral-200">
        {url}
      </span>
      <ExternalLink className="mt-0.5 size-3 shrink-0 text-neutral-500 group-hover:text-neutral-200" />
    </a>
  );
}

export function ProjectOperationsPanel({
  projectName,
  showJobs = true,
  targetPath
}: ProjectOperationsPanelProps) {
  const [connector, setConnector] = useState<ConnectorOverviewResult>(connectorFallback);
  const [deployStatusResult, setDeployStatusResult] = useState<ProjectCliCommandResult>();
  const [actionResult, setActionResult] = useState<GitActionResult>();
  const [isBusy, setIsBusy] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);

  async function refresh() {
    setIsRefreshing(true);
    const [nextConnector, nextDeployStatus] = await Promise.all([
      projectSpaceClient.getConnectorOverview().catch(() => connectorFallback),
      targetPath
        ? projectSpaceClient
            .runProjectCliCommand({ command: 'deploy-status', cwd: targetPath })
            .catch(() => undefined)
        : Promise.resolve(undefined)
    ]);

    setConnector(nextConnector ?? connectorFallback);
    setDeployStatusResult(nextDeployStatus);
    setHasLoaded(true);
    setIsRefreshing(false);
  }

  useEffect(() => {
    void refresh();
  }, []);

  const localMachine = useMemo(
    () => connector.machines.find((machine) => machine.connector.status === 'local'),
    [connector.machines]
  );
  const deployStatus = useMemo(() => parseDeployStatus(deployStatusResult), [deployStatusResult]);

  async function runDeployDryRun(environment: ProjectDeployEnvironment) {
    setIsBusy(true);
    try {
      const result = await projectSpaceClient.runProjectCliCommand({
        command: 'deploy-dry-run',
        cwd: targetPath,
        environment
      });

      setActionResult({
        message: result.exitCode === 0 ? 'Deploy dry run ready.' : 'Deploy dry run failed.',
        status: result.exitCode === 0 ? 'success' : 'error',
        stderr: result.stderr,
        stdout: result.stdout
      });
      await refresh();
    } finally {
      setIsBusy(false);
    }
  }

  const isInitialLoading = isRefreshing && !hasLoaded;

  return (
    <Surface
      variant="transparent"
      className="grid shrink-0 gap-4 rounded-none xl:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]"
    >
      <div className="grid min-w-0 gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <PlugZap className="size-4 shrink-0 text-neutral-400" />
            <Text className="truncate text-sm font-semibold text-neutral-100">Connectors</Text>
          </div>
          <Button size="sm" variant="ghost" onPress={() => void refresh()}>
            <RefreshCw className="size-4" />
          </Button>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <Surface variant="tertiary" className="rounded-lg border border-neutral-800 bg-black/20 p-3">
            <div className="mb-2 flex items-center gap-2">
              <Network className="size-4 text-neutral-400" />
              <Text className="text-xs font-semibold uppercase tracking-[0.16em] text-neutral-500">
                Tailscale
              </Text>
            </div>
            <div className="flex flex-wrap gap-2">
              <StatusChip
                ok={connector.tailscale.installed}
                label={connector.tailscale.installed ? 'installed' : 'missing'}
              />
              <StatusChip
                ok={connector.tailscale.connected}
                label={connector.tailscale.connected ? 'connected' : 'offline'}
              />
            </div>
            <Text className="mt-2 truncate text-xs text-neutral-400">
              {connector.tailscale.serveOrigins[0] ??
                connector.tailscale.selfName ??
                localMachine?.name ??
                'No local tailnet name'}
            </Text>
          </Surface>

          <Surface variant="tertiary" className="rounded-lg border border-neutral-800 bg-black/20 p-3">
            <div className="mb-2 flex items-center gap-2">
              <Server className="size-4 text-neutral-400" />
              <Text className="text-xs font-semibold uppercase tracking-[0.16em] text-neutral-500">
                Machines
              </Text>
            </div>
            <div className="flex flex-wrap gap-2">
              <StatusChip
                ok={connector.machinesRepo.exists}
                label={connector.machinesRepo.exists ? 'repo linked' : 'repo missing'}
              />
              <Chip size="sm" variant="secondary">
                {connector.machines.length} hosts
              </Chip>
            </div>
            <Text className="mt-2 truncate text-xs text-neutral-400">
              {connector.machinesRepo.path || 'machines repo not found'}
            </Text>
          </Surface>
        </div>

        <ScrollShadow className="max-h-36" hideScrollBar>
          <div className="grid gap-2">
            {connector.machines.map((machine) => (
              <Surface
                key={machine.id}
                variant="tertiary"
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-neutral-800 bg-black/20 px-3 py-2"
              >
                <div className="min-w-0">
                  <Text className="block truncate text-sm text-neutral-100">{machine.name}</Text>
                  <Text className="block truncate text-xs text-neutral-500">
                    {[machine.kind, machine.profile, machine.network.localName]
                      .filter(Boolean)
                      .join(' / ')}
                  </Text>
                </div>
                <Chip size="sm" variant={machine.connector.status === 'local' ? 'primary' : 'secondary'}>
                  {machine.connector.status}
                </Chip>
              </Surface>
            ))}
          </div>
        </ScrollShadow>
      </div>

      <div className="grid min-w-0 gap-3">
        <div className="flex items-center gap-2">
          <Rocket className="size-4 text-neutral-400" />
          <Text className="truncate text-sm font-semibold text-neutral-100">Deployments</Text>
          <div className="ml-auto flex gap-2">
            <a href="/connector" target="_blank">
              <Button size="sm" variant="ghost">
                Install connector
              </Button>
            </a>
            <StatusChip
              ok={isRefreshing || deployStatusResult?.exitCode === 0}
              label={
                isRefreshing
                  ? 'loading status'
                  : deployStatusResult?.exitCode === 0
                    ? 'cli status'
                    : 'status unavailable'
              }
            />
            <StatusChip
              ok={Boolean(deployStatus)}
              label={
                isInitialLoading ? 'loading config' : deployStatus ? 'config loaded' : 'config missing'
              }
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            isDisabled={isBusy || isRefreshing || !targetPath}
            onPress={() => void refresh()}
          >
            <RefreshCw className={isRefreshing ? 'size-4 animate-spin' : 'size-4'} />
            Refresh
          </Button>
        </div>

        {actionResult ? (
          <pre className="max-h-20 overflow-auto rounded-lg border border-neutral-800 bg-black/30 p-2 text-xs text-neutral-300">
            {formatAction(actionResult)}
          </pre>
        ) : null}

        <div className="grid gap-2">
            {isInitialLoading ? (
              <Surface
                variant="tertiary"
                className="rounded-md border border-neutral-800 bg-black/20 px-3 py-3"
              >
                <div className="flex items-center gap-3">
                  <RefreshCw className="size-4 animate-spin text-neutral-400" />
                  <div className="min-w-0">
                    <Text className="block text-sm font-medium text-neutral-200">
                      Loading deployment status...
                    </Text>
                    <Text className="block text-xs text-neutral-500">
                      Reading connector state and deployment config for this project.
                    </Text>
                  </div>
                </div>
              </Surface>
            ) : null}

            {isRefreshing && hasLoaded ? (
              <Surface
                variant="tertiary"
                className="rounded-md border border-neutral-800 bg-black/20 px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <RefreshCw className="size-4 animate-spin text-neutral-400" />
                  <Text className="text-sm text-neutral-300">Refreshing deployment status...</Text>
                </div>
              </Surface>
            ) : null}

            {!isInitialLoading ? (deployStatus?.environments ?? []).map((entry) => (
              <Surface
                key={entry.environment}
                variant="tertiary"
                className="grid gap-2 rounded-md border border-neutral-800 bg-black/20 px-3 py-2 md:grid-cols-[auto_minmax(0,1fr)_auto]"
              >
                <Chip size="sm" variant={entry.environment === 'prod' ? 'primary' : 'secondary'}>
                  {entry.environment}
                </Chip>
                <div className="min-w-0">
                  <Text className="block truncate text-sm text-neutral-100">
                    {entry.branch} / {entry.composeProject}
                  </Text>
                  <Text className="block truncate text-xs text-neutral-500">
                    {entry.remotePath}
                  </Text>
                  <div className="mt-1 grid gap-0.5">
                    <DeploymentUrlLink label="web" url={entry.webUrl} />
                    <DeploymentUrlLink label="api" url={entry.apiUrl} />
                    <DeploymentUrlLink label="docs" url={entry.docsUrl} />
                  </div>
                </div>
                <div className="flex min-w-0 items-center justify-end gap-2">
                  <StatusChip
                    ok={statusIsOk(statusSummary(entry.status))}
                    label={statusSummary(entry.status)}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    isDisabled={!targetPath || isBusy || isRefreshing}
                    onPress={() => void runDeployDryRun(entry.environment)}
                  >
                    <Play className="size-4" />
                    Dry run
                  </Button>
                </div>
              </Surface>
            )) : null}
            {!isInitialLoading && !deployStatus ? (
              <Surface variant="tertiary" className="rounded-md border border-neutral-800 bg-black/20 px-3 py-2">
                <Text className="text-sm text-neutral-400">
                  {deployStatusResult?.stderr || 'Deploy config status is not loaded.'}
                </Text>
              </Surface>
            ) : null}
        </div>
      </div>

      {showJobs ? (
        <div className="min-w-0 xl:col-span-2">
          <ScopeDevboxJobPanel
            connector={connector}
            projectName={projectName}
            targetPath={targetPath}
          />
        </div>
      ) : null}
    </Surface>
  );
}
