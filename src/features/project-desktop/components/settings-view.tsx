import { useEffect, useRef, useState } from 'react';
import { BookOpenText, LogOut, RefreshCw } from 'lucide-react';
import { Link } from '@heroui/react';
import { Button, Text } from '@/app/dotnaos-ui';
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
import type { SettingsSection } from '../hooks/project-desktop-routing';
import type { RailAccount } from './account-menu';
import { MachinesPage } from './machines-page';
import { releasedChangelogHref } from '@/features/pr-preview-changelog/changelog-links';

function SettingsSectionBlock({
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
    <section className="border-b border-neutral-800/70 py-5 last:border-b-0">
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-neutral-500" />
        <Text className="text-sm font-medium text-neutral-200">{title}</Text>
      </div>
      {description ? (
        <Text className="mt-1 block text-sm text-neutral-500">{description}</Text>
      ) : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function SettingsRow({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 border-b border-neutral-800/40 py-2 last:border-b-0">
      <Text className="shrink-0 text-xs text-neutral-500">{label}</Text>
      <code className="min-w-0 truncate text-right font-mono text-xs text-neutral-300">
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
  onRefreshConnectorOverview(): Promise<ConnectorOverviewResult>;
  onRefreshGitHubCatalog(forceRefresh?: boolean): Promise<GitHubCatalogResult>;
  section?: SettingsSection;
}

export function SettingsView({
  account,
  appMeta,
  connectorOverview,
  githubCatalog,
  isGitHubRefreshing,
  onRefreshConnectorOverview,
  onRefreshGitHubCatalog,
  section = 'machines'
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

  const whatsNewHref = releasedChangelogHref(appMeta.version);

  if (section === 'machines') {
    return (
      <MachinesPage
        computeInventory={connectorOverview.computeInventory}
        connectors={connectorOverview.machines}
        credentials={credentials}
        credentialListError={credentialListError}
        hasCopiedInstallCommand={hasCopiedInstallCommand}
        installCommand={installCommand}
        installScriptHref={installScriptHref}
        installerError={installerError}
        isGeneratingInstaller={isGeneratingInstaller}
        loadError={physicalMachinesError}
        onCopyInstallCommand={() => void copyInstallCommand()}
        onGenerateInstallCommand={() => void generateInstallCommand()}
        onRefresh={refreshMachineAdministration}
        onRefreshCredentials={() => void refreshConnectorCredentials()}
        onRevokeCredential={(credentialId) => void revokeCredential(credentialId)}
        onSaveMachine={savePhysicalMachine}
        physicalMachines={physicalMachines}
        revokingCredentialId={revokingCredentialId}
        status={physicalMachinesStatus}
        tailscale={connectorOverview.tailscale}
      />
    );
  }

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col">
      <header className="shrink-0 border-b border-neutral-800/70 pb-4">
        <Text as="h1" className="block text-2xl font-semibold tracking-[-.02em] text-neutral-50">
          Settings
        </Text>
        <Text className="mt-1 block text-sm text-neutral-500">
          This Project Space instance, its GitHub connection, and your account.
        </Text>
      </header>

      <SettingsSectionBlock
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
            variant="secondary"
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
      </SettingsSectionBlock>

      <SettingsSectionBlock
        icon={BookOpenText}
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
            What&apos;s new is unavailable because this running version is not documented in the
            changelog.
          </Text>
        )}
      </SettingsSectionBlock>

      {account ? (
        <SettingsSectionBlock icon={LogOut} title="Account">
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
            <Button size="sm" variant="secondary" onPress={account.onSignOut}>
              <LogOut className="size-4" />
              Sign out
            </Button>
          </div>
        </SettingsSectionBlock>
      ) : null}
    </section>
  );
}
