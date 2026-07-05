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
  PlugZap,
  RefreshCw,
  Rocket,
  Server
} from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import type {
  ConnectorOverviewResult,
  DeploymentRecordSummary,
  PlatformOverviewResult
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

function StatusChip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Chip size="sm" variant={ok ? 'primary' : 'secondary'}>
      {label}
    </Chip>
  );
}

function deploymentUrl(deployment: DeploymentRecordSummary) {
  if (deployment.live?.url) {
    return deployment.live.url;
  }

  if (deployment.routeKind === 'public' && deployment.routeHost) {
    return `https://${deployment.routeHost}`;
  }

  return '';
}

function deploymentMatchesProject(deployment: DeploymentRecordSummary, projectName: string) {
  const expected = projectName.toLowerCase();
  const appSlug = deployment.appSlug.toLowerCase();

  return appSlug === expected || appSlug === `${expected}-beta`;
}

function formatDate(value?: string) {
  if (!value) {
    return 'unknown';
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? 'unknown' : date.toLocaleString();
}

function liveStatusLabel(deployment: DeploymentRecordSummary) {
  if (!deployment.live || deployment.live.status === 'unknown') {
    return 'not checked';
  }

  if (deployment.live.status === 'online') {
    return deployment.live.statusCode
      ? `online ${deployment.live.statusCode}`
      : 'online';
  }

  return deployment.live.statusCode
    ? `offline ${deployment.live.statusCode}`
    : 'offline';
}

function DeploymentUrlLink({ label, url }: { label: string; url?: string }) {
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
  const [platform, setPlatform] = useState<PlatformOverviewResult>();
  const [isRefreshing, setIsRefreshing] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);

  async function refresh() {
    setIsRefreshing(true);
    const [nextConnector, nextPlatform] = await Promise.all([
      projectSpaceClient.getConnectorOverview().catch(() => connectorFallback),
      projectSpaceClient.getPlatformOverview().catch(() => undefined)
    ]);

    setConnector(nextConnector ?? connectorFallback);
    setPlatform(nextPlatform);
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
  const projectDeployments = useMemo(
    () =>
      (platform?.deployments ?? [])
        .filter((deployment) => deploymentMatchesProject(deployment, projectName))
        .sort((left, right) => {
          const leftTime = Date.parse(left.updatedAt || left.createdAt || '');
          const rightTime = Date.parse(right.updatedAt || right.createdAt || '');

          return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
        }),
    [platform?.deployments, projectName]
  );
  const onlineCount = projectDeployments.filter(
    (deployment) => deployment.live?.status === 'online'
  ).length;

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
              ok={isRefreshing || Boolean(platform?.apiReachable)}
              label={
                isRefreshing
                  ? 'checking platform'
                  : platform?.apiReachable
                    ? 'platform online'
                    : 'platform offline'
              }
            />
            <StatusChip
              ok={projectDeployments.length > 0}
              label={
                isInitialLoading
                  ? 'loading deployments'
                  : projectDeployments.length > 0
                    ? `${projectDeployments.length} deployments`
                    : 'no deployments'
              }
            />
            {projectDeployments.length > 0 ? (
              <StatusChip
                ok={onlineCount === projectDeployments.length}
                label={`${onlineCount}/${projectDeployments.length} reachable`}
              />
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            isDisabled={isRefreshing}
            onPress={() => void refresh()}
          >
            <RefreshCw className={isRefreshing ? 'size-4 animate-spin' : 'size-4'} />
            Refresh
          </Button>
        </div>

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
                      Reading VPS platform status and checking public routes.
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

            {!isInitialLoading && platform?.error ? (
              <Surface
                variant="tertiary"
                className="rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2"
              >
                <Text className="text-sm text-red-200">{platform.error}</Text>
              </Surface>
            ) : null}

            {!isInitialLoading ? projectDeployments.map((entry) => {
              const url = deploymentUrl(entry);
              const liveOnline = entry.live?.status === 'online';

              return (
              <Surface
                key={entry.id || `${entry.appSlug}-${entry.environment}`}
                variant="tertiary"
                className="grid gap-2 rounded-md border border-neutral-800 bg-black/20 px-3 py-2 md:grid-cols-[auto_minmax(0,1fr)_auto]"
              >
                <Chip size="sm" variant={entry.environment === 'prod' ? 'primary' : 'secondary'}>
                  {entry.environment}
                </Chip>
                <div className="min-w-0">
                  <Text className="block truncate text-sm text-neutral-100">
                    {entry.appSlug}
                  </Text>
                  <Text className="block truncate text-xs text-neutral-500">
                    {entry.sourceRef || entry.runtimeDir || 'no source recorded'}
                  </Text>
                  <Text className="block truncate text-xs text-neutral-600">
                    deployed {formatDate(entry.updatedAt || entry.createdAt)}
                  </Text>
                  <div className="mt-1 grid gap-0.5">
                    <DeploymentUrlLink label="site" url={url} />
                    {entry.runtimeDir ? (
                      <Text className="block truncate font-mono text-xs text-neutral-600">
                        {entry.runtimeDir}
                      </Text>
                    ) : null}
                  </div>
                </div>
                <div className="flex min-w-0 items-center justify-end gap-2">
                  <StatusChip
                    ok={entry.status === 'deployed' || entry.status === 'running'}
                    label={entry.status || 'unknown'}
                  />
                  <StatusChip ok={liveOnline} label={liveStatusLabel(entry)} />
                </div>
              </Surface>
              );
            }) : null}
            {!isInitialLoading && !platform?.error && projectDeployments.length === 0 ? (
              <Surface variant="tertiary" className="rounded-md border border-neutral-800 bg-black/20 px-3 py-2">
                <Text className="text-sm text-neutral-400">
                  No deployments were found for this project on the VPS platform.
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
