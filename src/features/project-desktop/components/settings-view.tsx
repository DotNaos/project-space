import { useEffect, useRef, useState } from 'react';
import {
  BookOpenText,
  Check,
  Copy,
  Download,
  Info,
  LogOut,
  MonitorCog,
  Network,
  RefreshCw,
  Trash2,
  TerminalSquare
} from 'lucide-react';
import { Link } from '@heroui/react';
import { Button, Chip, Surface, Text } from '@/app/dotnaos-ui';
import { GitHubMark } from './github-mark';
import { projectSpaceClient } from '@/api/project-space-client';
import type {
  AppMeta,
  ConnectorCredentialRecord,
  ConnectorOverviewResult,
  GitHubCatalogResult,
  GitHubOAuthDeviceStartResult,
  PhysicalMachineRecord,
  PhysicalMachineSaveRequest
} from '@/shared/project-space-api';
import { GitHubConnectPanel } from './github-connect-panel';
import type { RailAccount } from './app-rail';
import { SettingsMachineGroups } from './settings-machine-groups';
import { releasedChangelogHref } from '@/features/pr-preview-changelog/changelog-links';

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
  onRefreshConnectorOverview(): Promise<ConnectorOverviewResult>;
  onRefreshGitHubCatalog(forceRefresh?: boolean): Promise<GitHubCatalogResult>;
}

export function SettingsView({
  account,
  appMeta,
  connectorOverview,
  githubCatalog,
  isGitHubRefreshing,
  onRefreshConnectorOverview,
  onRefreshGitHubCatalog
}: SettingsViewProps) {
  const [githubFlow, setGitHubFlow] = useState<GitHubOAuthDeviceStartResult>();
  const [isConnectingGitHub, setIsConnectingGitHub] = useState(false);
  const [installCommand, setInstallCommand] = useState('');
  const [installScriptHref, setInstallScriptHref] = useState('/connector/install.sh');
  const [hasCopiedInstallCommand, setHasCopiedInstallCommand] = useState(false);
  const [isGeneratingInstaller, setIsGeneratingInstaller] = useState(false);
  const [credentials, setCredentials] = useState<ConnectorCredentialRecord[]>([]);
  const [credentialListError, setCredentialListError] = useState('');
  const [physicalMachines, setPhysicalMachines] = useState<PhysicalMachineRecord[]>([]);
  const [physicalMachinesStatus, setPhysicalMachinesStatus] = useState<
    'error' | 'loading' | 'ready' | 'refreshing'
  >('loading');
  const [physicalMachinesError, setPhysicalMachinesError] = useState('');
  const hasPhysicalMachinesSnapshot = useRef(false);
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

  async function refreshPhysicalMachines() {
    setPhysicalMachinesStatus(hasPhysicalMachinesSnapshot.current ? 'refreshing' : 'loading');
    setPhysicalMachinesError('');
    try {
      const result = await projectSpaceClient.listPhysicalMachines();
      setPhysicalMachines(result.machines);
      hasPhysicalMachinesSnapshot.current = true;
      setPhysicalMachinesStatus('ready');
      return result.machines;
    } catch (error) {
      setPhysicalMachinesStatus(hasPhysicalMachinesSnapshot.current ? 'ready' : 'error');
      setPhysicalMachinesError(
        error instanceof Error ? error.message : 'Could not load machine groups.'
      );
      throw error;
    }
  }

  async function refreshMachineAdministration() {
    await Promise.all([
      refreshConnectorCredentials(),
      refreshPhysicalMachines(),
      onRefreshConnectorOverview()
    ]);
  }

  useEffect(() => {
    void refreshConnectorCredentials();
    void refreshPhysicalMachines().catch(() => undefined);
  }, []);

  async function savePhysicalMachine(request: PhysicalMachineSaveRequest) {
    await projectSpaceClient.savePhysicalMachine(request);
    await refreshPhysicalMachines();
  }

  async function deletePhysicalMachine(machineId: string) {
    await projectSpaceClient.deletePhysicalMachine(machineId);
    await refreshPhysicalMachines();
  }

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
      setInstallScriptHref(result.scriptUrl);
      setHasCopiedInstallCommand(false);
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
      await refreshConnectorCredentials();
    } catch (error) {
      setInstallerError(error instanceof Error ? error.message : 'Could not revoke the installer.');
    } finally {
      setRevokingCredentialId('');
    }
  }

  const tailscale = connectorOverview.tailscale;
  const currentCredentials = credentials.filter(
    (credential) => credential.status === 'active' || credential.status === 'pending'
  );
  const whatsNewHref = releasedChangelogHref(appMeta.version);

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
        {whatsNewHref ? (
          <Link
            className="mt-3 inline-flex w-fit items-center gap-1.5 text-xs text-sky-300"
            href={whatsNewHref}
          >
            What&apos;s new in v{appMeta.version}
            <Link.Icon className="size-3.5">
              <BookOpenText />
            </Link.Icon>
          </Link>
        ) : (
          <Text className="mt-3 block text-xs text-neutral-600">
            What&apos;s new is unavailable because this running version is not
            documented in the changelog.
          </Text>
        )}
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
            onConnect={connectGitHub}
            onPoll={pollGitHubLogin}
            onRetry={() => onRefreshGitHubCatalog(true)}
          />
        )}
      </SettingsSection>

      <SettingsSection
        icon={MonitorCog}
        title="Machines & connectors"
        description="One physical machine can contain multiple independently managed connector installations."
      >
          <SettingsMachineGroups
          connectors={connectorOverview.machines}
          credentials={credentials}
          loadError={physicalMachinesError}
          onDeleteMachine={deletePhysicalMachine}
          onRefresh={refreshMachineAdministration}
          onSaveMachine={savePhysicalMachine}
          physicalMachines={physicalMachines}
          status={physicalMachinesStatus}
        />
      </SettingsSection>

      <SettingsSection
        icon={TerminalSquare}
        title="Install a connector"
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
              The command installs the pinned managed bundle, then opens Project Space approval to
              create this connector installation&apos;s protected identity.
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
            Generate managed installer
          </Button>
        )}
        {installerError ? (
          <Text className="mt-2 block text-xs text-red-300/80">{installerError}</Text>
        ) : null}
        <div className="mt-4 border-t border-neutral-800/80 pt-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <Text className="text-xs font-medium text-neutral-300">Installer credentials</Text>
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
          {currentCredentials.length > 0 ? (
            <div className="divide-y divide-neutral-900">
              {currentCredentials.slice(0, 10).map((credential) => {
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
          {currentCredentials.length > 10 ? (
            <Text className="mt-2 block text-xs text-neutral-600">
              Showing the 10 most relevant of {currentCredentials.length} credentials.
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
