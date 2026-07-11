import { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  Info,
  LogOut,
  Network,
  RefreshCw,
  Trash2,
  TerminalSquare
} from 'lucide-react';
import { Button, Chip, Surface, Text } from '@/app/dotnaos-ui';
import { GitHubMark } from './github-mark';
import { projectSpaceClient } from '@/api/project-space-client';
import type {
  AppMeta,
  ConnectorCredentialRecord,
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

function formatCredentialTime(value: string) {
  return new Date(value).toLocaleString([], {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short'
  });
}

export interface SettingsViewProps {
  account?: RailAccount;
  appMeta: AppMeta;
  connectorOverview: ConnectorOverviewResult;
  githubCatalog: GitHubCatalogResult;
  isGitHubRefreshing: boolean;
  onRefreshGitHubCatalog(forceRefresh?: boolean): Promise<GitHubCatalogResult>;
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
  const [installerCredentialId, setInstallerCredentialId] = useState('');
  const [installerExpiresAt, setInstallerExpiresAt] = useState('');
  const [installScriptHref, setInstallScriptHref] = useState('/connector/install.sh');
  const [hasCopiedInstallCommand, setHasCopiedInstallCommand] = useState(false);
  const [isGeneratingInstaller, setIsGeneratingInstaller] = useState(false);
  const [credentials, setCredentials] = useState<ConnectorCredentialRecord[]>([]);
  const [credentialListError, setCredentialListError] = useState('');
  const [revokingCredentialId, setRevokingCredentialId] = useState('');
  const [installerError, setInstallerError] = useState('');

  async function refreshConnectorCredentials() {
    setCredentialListError('');
    try {
      const result = await projectSpaceClient.listConnectorCredentials();
      setCredentials(result.credentials);
    } catch (error) {
      setCredentialListError(
        error instanceof Error ? error.message : 'Could not load connector credentials.'
      );
    }
  }

  useEffect(() => {
    void refreshConnectorCredentials();
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
        await onRefreshGitHubCatalog(true);
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

  async function generateInstallCommand() {
    setIsGeneratingInstaller(true);
    setInstallerError('');
    try {
      const result = await projectSpaceClient.getConnectorInstallCommand();
      setInstallCommand(result.command);
      setInstallerCredentialId(result.credentialId);
      setInstallerExpiresAt(result.expiresAt);
      setInstallScriptHref(result.scriptUrl);
      setHasCopiedInstallCommand(false);
      await refreshConnectorCredentials();
    } catch (error) {
      setInstallerError(error instanceof Error ? error.message : 'Could not create an installer.');
    } finally {
      setIsGeneratingInstaller(false);
    }
  }

  async function revokeCredential(credentialId: string) {
    if (!credentialId) {
      return;
    }

    setRevokingCredentialId(credentialId);
    setInstallerError('');
    try {
      const result = await projectSpaceClient.revokeConnectorCredential(credentialId);
      if (!result.revoked) {
        throw new Error('This connector credential no longer exists.');
      }
      if (credentialId === installerCredentialId) {
        setInstallCommand('');
        setInstallerCredentialId('');
        setInstallerExpiresAt('');
        setHasCopiedInstallCommand(false);
      }
      await refreshConnectorCredentials();
    } catch (error) {
      setInstallerError(error instanceof Error ? error.message : 'Could not revoke the installer.');
    } finally {
      setRevokingCredentialId('');
    }
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
            onPress={() => void onRefreshGitHubCatalog(true)}
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
            onRetry={() => void onRefreshGitHubCatalog(true)}
          />
        )}
      </SettingsSection>

      <SettingsSection
        icon={TerminalSquare}
        title="Connector"
        description="Install the Project Space connector on a machine to make its projects reachable."
      >
        {installCommand ? (
          <div className="space-y-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg border border-neutral-800 bg-neutral-950/80 px-3 py-2 font-mono text-xs text-neutral-200">
                {installCommand}
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
            </div>
            <Text className="block text-xs text-neutral-500">
              This enrollment expires at {new Date(installerExpiresAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit'
              })}. Generating another command revokes this unused one.
            </Text>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                isDisabled={isGeneratingInstaller || Boolean(revokingCredentialId)}
                onPress={() => void generateInstallCommand()}
              >
                {isGeneratingInstaller ? <RefreshCw className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                Replace command
              </Button>
              <Button
                size="sm"
                variant="danger"
                isDisabled={Boolean(revokingCredentialId)}
                onPress={() => void revokeCredential(installerCredentialId)}
              >
                {revokingCredentialId === installerCredentialId ? <RefreshCw className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                Revoke credential
              </Button>
              <a href={installScriptHref} target="_blank" rel="noreferrer">
                <Button size="sm" variant="ghost">
                  <Download className="size-4" />
                  Script
                </Button>
              </a>
            </div>
          </div>
        ) : (
          <Button
            size="sm"
            variant="primary"
            isDisabled={isGeneratingInstaller}
            onPress={() => void generateInstallCommand()}
          >
            {isGeneratingInstaller ? <RefreshCw className="size-4 animate-spin" /> : <TerminalSquare className="size-4" />}
            Generate account installer
          </Button>
        )}
        {installerError ? (
          <Text className="mt-2 block text-xs text-red-300/80">{installerError}</Text>
        ) : null}
        <div className="mt-4 border-t border-neutral-800/80 pt-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <Text className="text-xs font-medium text-neutral-300">Account credentials</Text>
            <Button
              aria-label="Refresh connector credentials"
              isIconOnly
              size="sm"
              variant="ghost"
              onPress={() => void refreshConnectorCredentials()}
              className="h-7 w-7 min-w-0 px-0"
            >
              <RefreshCw className="size-3.5" />
            </Button>
          </div>
          {credentials.length > 0 ? (
            <div className="divide-y divide-neutral-900">
              {credentials.slice(0, 10).map((credential) => {
                const canRevoke = credential.status === 'active' || credential.status === 'pending';
                const detail = credential.status === 'active'
                  ? `Last seen ${formatCredentialTime(credential.lastSeenAt ?? credential.createdAt)}`
                  : credential.status === 'pending'
                    ? `Expires ${formatCredentialTime(credential.expiresAt)}`
                    : credential.status === 'revoked'
                      ? `Revoked ${formatCredentialTime(credential.revokedAt ?? credential.createdAt)}`
                      : `Expired ${formatCredentialTime(credential.expiresAt)}`;

                return (
                  <div key={credential.id} className="flex min-w-0 items-center gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <Text className="block truncate text-sm text-neutral-200">
                        {credential.machineId ?? 'Pending enrollment'}
                      </Text>
                      <Text className="block truncate text-xs text-neutral-600">{detail}</Text>
                    </div>
                    <Chip size="sm" variant="secondary" className="shrink-0">
                      {credential.status}
                    </Chip>
                    {canRevoke ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        isDisabled={Boolean(revokingCredentialId)}
                        onPress={() => void revokeCredential(credential.id)}
                      >
                        {revokingCredentialId === credential.id ? <RefreshCw className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                        Revoke
                      </Button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <Text className="block text-xs text-neutral-600">No connector credentials yet.</Text>
          )}
          {credentials.length > 10 ? (
            <Text className="mt-2 block text-xs text-neutral-600">
              Showing the 10 most relevant of {credentials.length} credentials.
            </Text>
          ) : null}
          {credentialListError ? (
            <Text className="mt-2 block text-xs text-red-300/80">{credentialListError}</Text>
          ) : null}
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
