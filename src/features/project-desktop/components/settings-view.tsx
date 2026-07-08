import { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  Info,
  LogOut,
  Network,
  RefreshCw,
  TerminalSquare
} from 'lucide-react';
import { Button, Chip, Surface, Text } from '@/app/dotnaos-ui';
import { GitHubMark } from './github-mark';
import { projectSpaceClient } from '@/api/project-space-client';
import type {
  AppMeta,
  ConnectorOverviewResult,
  GitHubCatalogResult,
  GitHubOAuthDeviceStartResult
} from '@/shared/project-space-api';
import { GitHubConnectPanel } from './project-home-overview-widgets';
import type { RailAccount } from './app-rail';

function SettingsSection({
  children,
  description,
  icon: Icon,
  title
}: {
  children: React.ReactNode;
  description?: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
}) {
  return (
    <Surface
      variant="tertiary"
      className="rounded-lg border border-neutral-800 bg-neutral-950/45 p-4"
    >
      <div className="mb-3 flex items-center gap-2">
        <Icon className="size-4 text-neutral-400" />
        <Text className="text-sm font-semibold text-neutral-100">{title}</Text>
      </div>
      {description ? (
        <Text className="mb-3 block text-sm text-neutral-500">{description}</Text>
      ) : null}
      {children}
    </Surface>
  );
}

function StatusChip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Chip size="sm" variant={ok ? 'primary' : 'secondary'}>
      {label}
    </Chip>
  );
}

function SettingsRow({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 border-b border-neutral-900 py-2 last:border-b-0">
      <Text className="shrink-0 text-xs text-neutral-500">{label}</Text>
      <code className="min-w-0 truncate text-right font-mono text-xs text-neutral-200">
        {value || 'unknown'}
      </code>
    </div>
  );
}

export interface SettingsViewProps {
  account?: RailAccount;
  appMeta: AppMeta;
  connectorOverview: ConnectorOverviewResult;
  githubCatalog: GitHubCatalogResult;
  isGitHubRefreshing: boolean;
  onRefreshGitHubCatalog(): Promise<GitHubCatalogResult>;
}

export function SettingsView({
  account,
  appMeta,
  connectorOverview,
  githubCatalog,
  isGitHubRefreshing,
  onRefreshGitHubCatalog
}: SettingsViewProps) {
  const [githubFlow, setGitHubFlow] = useState<GitHubOAuthDeviceStartResult>();
  const [isConnectingGitHub, setIsConnectingGitHub] = useState(false);
  const [installCommand, setInstallCommand] = useState('');
  const [installScriptHref, setInstallScriptHref] = useState('/connector/install.sh');
  const [hasCopiedInstallCommand, setHasCopiedInstallCommand] = useState(false);

  useEffect(() => {
    let canceled = false;

    projectSpaceClient
      .getConnectorInstallCommand()
      .then((result) => {
        if (canceled) {
          return;
        }

        setInstallCommand(result.command);
        setInstallScriptHref(result.scriptUrl);
      })
      .catch(() => undefined);

    return () => {
      canceled = true;
    };
  }, []);

  async function connectGitHub() {
    setIsConnectingGitHub(true);
    try {
      setGitHubFlow(await projectSpaceClient.startGitHubOAuthDeviceFlow());
    } finally {
      setIsConnectingGitHub(false);
    }
  }

  async function pollGitHubLogin() {
    if (!githubFlow?.deviceCode) {
      return;
    }

    setIsConnectingGitHub(true);
    try {
      const result = await projectSpaceClient.pollGitHubOAuthDeviceFlow({
        deviceCode: githubFlow.deviceCode
      });

      if (result.status !== 'pending') {
        setGitHubFlow(undefined);
      }

      if (result.status === 'connected') {
        await onRefreshGitHubCatalog();
      }
    } finally {
      setIsConnectingGitHub(false);
    }
  }

  async function copyInstallCommand() {
    await navigator.clipboard?.writeText(installCommand);
    setHasCopiedInstallCommand(true);
    window.setTimeout(() => setHasCopiedInstallCommand(false), 1_500);
  }

  const tailscale = connectorOverview.tailscale;

  return (
    <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-4">
      <section className="shrink-0 border-b border-neutral-800/70 pb-4">
        <Text className="block text-xl font-semibold text-neutral-50">Settings</Text>
        <Text className="mt-1 block text-sm text-neutral-500">
          Connections, connector setup, and account.
        </Text>
      </section>

      <SettingsSection
        icon={Info}
        title="Software"
        description="The version currently served by this Project Space instance."
      >
        <div className="grid gap-0">
          <SettingsRow label="Version" value={appMeta.version} />
          <SettingsRow
            label="Commit"
            value={
              appMeta.commit
                ? `${appMeta.commitShort ?? appMeta.commit.slice(0, 8)} (${appMeta.ref ?? 'unknown ref'})`
                : undefined
            }
          />
          <SettingsRow label="Build" value={appMeta.buildTime} />
          <SettingsRow label="Environment" value={appMeta.environment} />
          <SettingsRow
            label="Runtime"
            value={[appMeta.platform, appMeta.nodeVersion].filter(Boolean).join(' / ')}
          />
        </div>
      </SettingsSection>

      <SettingsSection
        icon={GitHubMark}
        title="GitHub"
        description={
          githubCatalog.status === 'connected'
            ? `Connected — ${githubCatalog.repositories.length} repositories in the catalog.`
            : undefined
        }
      >
        {githubCatalog.status === 'connected' ? (
          <Button
            size="sm"
            variant="outline"
            isDisabled={isGitHubRefreshing}
            onPress={() => void onRefreshGitHubCatalog()}
          >
            <RefreshCw className={isGitHubRefreshing ? 'size-4 animate-spin' : 'size-4'} />
            Refresh catalog
          </Button>
        ) : (
          <GitHubConnectPanel
            flow={githubFlow}
            githubCatalog={githubCatalog}
            isConnecting={isConnectingGitHub}
            onConnect={() => void connectGitHub()}
            onPoll={() => void pollGitHubLogin()}
            onRetry={() => void onRefreshGitHubCatalog()}
          />
        )}
      </SettingsSection>

      <SettingsSection
        icon={TerminalSquare}
        title="Connector"
        description="Install the Project Space connector on a machine to make its projects reachable."
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg border border-neutral-800 bg-neutral-950/80 px-3 py-2 font-mono text-xs text-neutral-200">
            {installCommand || 'Loading install command…'}
          </code>
          <Button
            aria-label="Copy install command"
            isIconOnly
            size="sm"
            variant="outline"
            isDisabled={!installCommand}
            onPress={() => void copyInstallCommand()}
            className="h-9 w-9 min-w-0 px-0"
          >
            {hasCopiedInstallCommand ? <Check className="size-4" /> : <Copy className="size-4" />}
          </Button>
          <a href={installScriptHref} target="_blank" rel="noreferrer">
            <Button size="sm" variant="ghost">
              <Download className="size-4" />
              Script
            </Button>
          </a>
        </div>
      </SettingsSection>

      <SettingsSection icon={Network} title="Tailscale">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip
            ok={tailscale.installed}
            label={tailscale.installed ? 'installed' : 'missing'}
          />
          <StatusChip
            ok={tailscale.connected}
            label={tailscale.connected ? 'connected' : 'offline'}
          />
          <Chip size="sm" variant="secondary">
            {tailscale.peersOnline} peers online
          </Chip>
        </div>
        <Text className="mt-2 block truncate text-xs text-neutral-500">
          {tailscale.serveOrigins[0] ?? tailscale.ips[0] ?? 'No tailnet address reported.'}
        </Text>
      </SettingsSection>

      {account ? (
        <SettingsSection icon={LogOut} title="Account">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              {account.name ? (
                <Text className="block truncate text-sm font-medium text-neutral-200">
                  {account.name}
                </Text>
              ) : null}
              <Text className="block truncate text-xs text-neutral-500">
                {account.email ?? 'Signed in'}
              </Text>
            </div>
            <Button size="sm" variant="outline" onPress={account.onSignOut}>
              <LogOut className="size-4" />
              Sign out
            </Button>
          </div>
        </SettingsSection>
      ) : null}
    </div>
  );
}
