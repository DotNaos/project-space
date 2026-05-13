import { useEffect, useMemo, useState } from 'react';
import { Button, Chip, ScrollShadow, Surface, Text } from '@heroui/react';
import {
  DatabaseBackup,
  Network,
  PlugZap,
  RefreshCw,
  Rocket,
  Server
} from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import type {
  ConnectorOverviewResult,
  DeploymentVisibility,
  GitActionResult,
  PlatformOverviewResult
} from '@/shared/project-space-api';

interface ProjectOperationsPanelProps {
  projectName: string;
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

const platformFallback: PlatformOverviewResult = {
  apiReachable: false,
  backups: [],
  deployments: [],
  platformRepo: {
    exists: false,
    path: ''
  }
};

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function formatAction(action?: GitActionResult) {
  if (!action) {
    return '';
  }

  return [action.message, action.stdout?.trim(), action.stderr?.trim()].filter(Boolean).join('\n');
}

function StatusChip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Chip size="sm" variant={ok ? 'primary' : 'secondary'}>
      {label}
    </Chip>
  );
}

export function ProjectOperationsPanel({
  projectName,
  targetPath
}: ProjectOperationsPanelProps) {
  const [connector, setConnector] = useState<ConnectorOverviewResult>(connectorFallback);
  const [platform, setPlatform] = useState<PlatformOverviewResult>(platformFallback);
  const [environment, setEnvironment] = useState('prod');
  const [visibility, setVisibility] = useState<DeploymentVisibility>('private');
  const [planOnly, setPlanOnly] = useState(true);
  const [projectSlug, setProjectSlug] = useState(() => slugify(projectName));
  const [backupTarget, setBackupTarget] = useState('default');
  const [actionResult, setActionResult] = useState<GitActionResult>();
  const [isBusy, setIsBusy] = useState(false);

  useEffect(() => {
    setProjectSlug((current) => current || slugify(projectName));
  }, [projectName]);

  async function refresh() {
    const [nextConnector, nextPlatform] = await Promise.all([
      projectSpaceClient.getConnectorOverview().catch(() => connectorFallback),
      projectSpaceClient.getPlatformOverview().catch(() => platformFallback)
    ]);

    setConnector(nextConnector);
    setPlatform(nextPlatform);
  }

  useEffect(() => {
    void refresh();
  }, []);

  const localMachine = useMemo(
    () => connector.machines.find((machine) => machine.connector.status === 'local'),
    [connector.machines]
  );

  async function runDeploy() {
    setIsBusy(true);
    try {
      const result = await projectSpaceClient.deployProject({
        cwd: targetPath,
        displayName: projectName,
        environment,
        planOnly,
        projectSlug,
        visibility
      });

      setActionResult(result);
      await refresh();
    } finally {
      setIsBusy(false);
    }
  }

  async function runBackup() {
    setIsBusy(true);
    try {
      const result = await projectSpaceClient.backupProject({
        environment,
        projectSlug,
        target: backupTarget
      });

      setActionResult(result);
      await refresh();
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <Surface
      variant="secondary"
      className="grid shrink-0 gap-3 rounded-lg border border-slate-800 bg-slate-950/55 p-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]"
    >
      <div className="grid min-w-0 gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <PlugZap className="size-4 shrink-0 text-slate-400" />
            <Text className="truncate text-sm font-semibold text-slate-100">Connectors</Text>
          </div>
          <Button size="sm" variant="ghost" onPress={() => void refresh()}>
            <RefreshCw className="size-4" />
          </Button>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <Surface variant="tertiary" className="rounded-lg border border-slate-800 bg-black/20 p-3">
            <div className="mb-2 flex items-center gap-2">
              <Network className="size-4 text-slate-400" />
              <Text className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
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
            <Text className="mt-2 truncate text-xs text-slate-400">
              {connector.tailscale.serveOrigins[0] ??
                connector.tailscale.selfName ??
                localMachine?.name ??
                'No local tailnet name'}
            </Text>
          </Surface>

          <Surface variant="tertiary" className="rounded-lg border border-slate-800 bg-black/20 p-3">
            <div className="mb-2 flex items-center gap-2">
              <Server className="size-4 text-slate-400" />
              <Text className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
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
            <Text className="mt-2 truncate text-xs text-slate-400">
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
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-slate-800 bg-black/20 px-3 py-2"
              >
                <div className="min-w-0">
                  <Text className="block truncate text-sm text-slate-100">{machine.name}</Text>
                  <Text className="block truncate text-xs text-slate-500">
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
          <Rocket className="size-4 text-slate-400" />
          <Text className="truncate text-sm font-semibold text-slate-100">Deployments</Text>
          <div className="ml-auto flex gap-2">
            <a href="/connector" target="_blank">
              <Button size="sm" variant="ghost">
                Install connector
              </Button>
            </a>
            <StatusChip
              ok={platform.platformRepo.exists}
              label={platform.platformRepo.exists ? 'platform repo' : 'repo missing'}
            />
            <StatusChip
              ok={platform.apiReachable}
              label={platform.apiReachable ? 'api online' : 'api offline'}
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <input
            value={projectSlug}
            onChange={(event) => setProjectSlug(event.target.value)}
            className="min-w-44 flex-1 rounded-lg border border-slate-800 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-500"
          />
          <input
            value={environment}
            onChange={(event) => setEnvironment(event.target.value)}
            className="w-28 rounded-lg border border-slate-800 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-500"
          />
          <select
            value={visibility}
            onChange={(event) => setVisibility(event.target.value as DeploymentVisibility)}
            className="w-32 rounded-lg border border-slate-800 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-500"
          >
            <option value="private">private</option>
            <option value="public">public</option>
          </select>
          <label className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/80 px-3 py-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={planOnly}
              onChange={(event) => setPlanOnly(event.target.checked)}
            />
            plan
          </label>
          <Button
            size="sm"
            variant="secondary"
            isDisabled={!platform.apiReachable || !targetPath || !projectSlug || !environment || isBusy}
            onPress={() => void runDeploy()}
          >
            <Rocket className="size-4" />
            Deploy
          </Button>
        </div>

        <div className="grid gap-2 lg:grid-cols-[1fr_auto_auto]">
          <input
            value={backupTarget}
            onChange={(event) => setBackupTarget(event.target.value)}
            className="min-w-0 rounded-lg border border-slate-800 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-500"
          />
          <Button
            size="sm"
            variant="outline"
            isDisabled={!platform.apiReachable || !projectSlug || !environment || !backupTarget || isBusy}
            onPress={() => void runBackup()}
          >
            <DatabaseBackup className="size-4" />
            Backup
          </Button>
        </div>

        {actionResult ? (
          <pre className="max-h-20 overflow-auto rounded-lg border border-slate-800 bg-black/30 p-2 text-xs text-slate-300">
            {formatAction(actionResult)}
          </pre>
        ) : null}

        <div className="grid gap-2 md:grid-cols-2">
          <ScrollShadow className="max-h-32" hideScrollBar>
            <div className="grid gap-2">
              {platform.deployments.slice(0, 4).map((deployment) => (
                <Surface
                  key={`deployment:${deployment.id}`}
                  variant="tertiary"
                  className="rounded-md border border-slate-800 bg-black/20 px-3 py-2"
                >
                  <Text className="truncate text-sm text-slate-100">
                    {deployment.appSlug}/{deployment.environment}
                  </Text>
                  <Text className="truncate text-xs text-slate-500">
                    {[deployment.status, deployment.routeHost].filter(Boolean).join(' / ')}
                  </Text>
                </Surface>
              ))}
            </div>
          </ScrollShadow>
          <ScrollShadow className="max-h-32" hideScrollBar>
            <div className="grid gap-2">
              {platform.backups.slice(0, 4).map((backup) => (
                <Surface
                  key={`backup:${backup.id}`}
                  variant="tertiary"
                  className="rounded-md border border-slate-800 bg-black/20 px-3 py-2"
                >
                  <Text className="truncate text-sm text-slate-100">
                    {backup.appSlug}/{backup.environment}
                  </Text>
                  <Text className="truncate text-xs text-slate-500">
                    {[backup.status, backup.target].filter(Boolean).join(' / ')}
                  </Text>
                </Surface>
              ))}
            </div>
          </ScrollShadow>
        </div>
      </div>
    </Surface>
  );
}
