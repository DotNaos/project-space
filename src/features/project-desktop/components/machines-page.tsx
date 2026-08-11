import { useMemo, useState } from 'react';
import { Disclosure } from '@heroui/react';
import {
  Archive,
  Boxes,
  ChevronRight,
  Circle,
  CircleOff,
  Cloud,
  Cpu,
  ExternalLink,
  Link2,
  ListFilter,
  LoaderCircle,
  MonitorCog,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  ShieldAlert
} from 'lucide-react';
import {
  Button,
  Chip,
  SearchField,
  SearchFieldClearButton,
  SearchFieldGroup,
  SearchFieldInput,
  SearchFieldSearchIcon,
  Text
} from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type {
  ConnectorCredentialRecord,
  ConnectorInstallationRecord,
  ConnectorOverviewResult,
  PhysicalMachineRecord,
  PhysicalMachineSaveRequest
} from '@/shared/project-space-api';
import type { ComputeInventorySnapshot } from '@/shared/compute-environment-api';
import { groupComputeInventory } from '@/shared/compute-environment-api';
import { ConnectorChannelChip } from './connector-channel-chip';
import { ConnectorRuntimeStatusChip } from './connector-runtime-status-chip';
import { MachineConnectorActionsMenu } from './machine-connector-actions-menu';
import { MachinesInstallerPanel } from './machines-installer-panel';
import { MachineDeviceIcon, MachineOsMark } from './machine-visuals';
import {
  groupSettingsMachines,
  safeConnectorOrigin,
  type SettingsConnectorInstance
} from './settings-machine-group-model';
import { SettingsMachineRuntimeStop } from './settings-machine-runtime-stop';
import { SettingsConnectorMachineEditor } from './settings-connector-machine-editor';
import {
  settingsMachineGroupsPresentation,
  type SettingsMachineGroupsStatus
} from './settings-machine-groups-view-model';
import {
  computeEnvironmentKindLabels,
  computePlatformSections,
  countComputePlatformRows,
  filterComputePlatformSections,
  filterMachineRows,
  machineListRows,
  machineRowSubtitle,
  type ComputePlatformSection,
  type ComputeRow,
  type MachineFilter,
  type MachineListRow
} from './machines-page-model';

const filters: Array<{ icon: typeof ListFilter; id: MachineFilter; label: string }> = [
  { icon: ListFilter, id: 'all', label: 'All' },
  { icon: Circle, id: 'online', label: 'Online' },
  { icon: CircleOff, id: 'offline', label: 'Offline' }
];

function StatusChip({ isOnline }: { isOnline: boolean }) {
  return (
    <Chip
      size="sm"
      className={cn('shrink-0 gap-1.5', isOnline ? 'text-emerald-300' : 'text-neutral-600')}
    >
      <span
        aria-hidden
        className={cn('size-1.5 rounded-full', isOnline ? 'bg-emerald-400' : 'bg-neutral-700')}
      />
      {isOnline ? 'Online' : 'Offline'}
    </Chip>
  );
}

function ConnectorRow({
  instance,
  onEdit,
  onRefresh
}: {
  instance: SettingsConnectorInstance;
  onEdit(): void;
  onRefresh(): Promise<unknown>;
}) {
  const origin = instance.machine.connector.origin;
  const safeOrigin = safeConnectorOrigin(origin);

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2 border-t border-neutral-800/50 py-3 first:border-t-0 sm:items-center">
      <div className="flex min-w-0 items-start gap-2.5">
        <MachineOsMark className="mt-0.5 size-3.5" machine={instance.machine} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <Text className="truncate text-sm text-neutral-300">
              {instance.platformLabel ?? 'Operating system not reported'}
            </Text>
            <ConnectorChannelChip machine={instance.machine} />
            <StatusChip isOnline={instance.isOnline} />
            <ConnectorRuntimeStatusChip update={instance.machine.connector.update} />
          </div>
          <Text className="mt-1 block truncate font-mono text-[11px] text-neutral-600">
            {instance.machine.name} · {instance.runtimeLabel}
          </Text>
          {safeOrigin ? (
            <a
              className="mt-1 inline-flex max-w-full items-center gap-1 text-[11px] text-sky-400/90 transition hover:text-sky-300"
              href={safeOrigin}
              rel="noreferrer"
              target="_blank"
            >
              <span className="truncate">{safeOrigin}</span>
              <ExternalLink className="size-3 shrink-0" />
            </a>
          ) : origin ? (
            <Text className="mt-1 block truncate text-[11px] text-neutral-700">{origin}</Text>
          ) : null}
        </div>
      </div>
      <div className="flex items-center justify-end gap-1">
        <Button
          aria-label={`Edit connector ${instance.machine.name}`}
          isIconOnly
          size="sm"
          variant="ghost"
          className="size-8 min-w-0 px-0"
          onPress={onEdit}
        >
          <Pencil className="size-3.5" />
        </Button>
        <SettingsMachineRuntimeStop machine={instance.machine} onStopped={onRefresh} />
        <MachineConnectorActionsMenu
          machine={instance.machine}
          onOperationSettled={() => void onRefresh()}
        />
      </div>
    </div>
  );
}

function HostRow({ row }: { row: ComputeRow }) {
  return (
    <div className="flex min-w-0 items-center gap-3 px-1 py-2.5">
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-neutral-900">
        <Cpu className="size-4 text-emerald-300" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-neutral-200">{row.name}</span>
        <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-neutral-600">
          {row.resourcesSummary ? <span className="truncate">{row.resourcesSummary}</span> : null}
          {row.connectorCount > 0 ? (
            <span className="shrink-0">
              {row.resourcesSummary ? '· ' : ''}
              {row.onlineConnectorCount} of {row.connectorCount} connector{row.connectorCount === 1 ? '' : 's'} online
            </span>
          ) : null}
        </span>
      </span>
    </div>
  );
}

function EnvironmentRow({
  defaultExpanded,
  onEditConnector,
  onRefresh,
  row
}: {
  defaultExpanded: boolean;
  onEditConnector(instance: SettingsConnectorInstance): void;
  onRefresh(): Promise<unknown>;
  row: ComputeRow;
}) {
  const verified = row.hostAssociationLabel !== undefined &&
    (row.hostAssociationLabel.startsWith('Verified') || row.hostAssociationLabel === 'Manually assigned');

  return (
    <Disclosure defaultExpanded={defaultExpanded}>
      <Disclosure.Heading>
        <Disclosure.Trigger
          className="group grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-2.5 pr-1 text-left outline-none transition hover:bg-neutral-900/35 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400/50"
          style={{ paddingLeft: `${0.25 + row.depth * 1.25}rem` }}
        >
          <span className="flex min-w-0 items-center gap-3">
            <Disclosure.Indicator className="ms-0 size-3.5 shrink-0 text-neutral-600 transition-transform group-aria-expanded:rotate-90 motion-reduce:transition-none">
              <ChevronRight />
            </Disclosure.Indicator>
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-neutral-900">
              <Boxes className="size-4 text-violet-300" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="truncate text-sm font-medium text-neutral-200">{row.name}</span>
                {row.environmentKind ? (
                  <Chip size="sm" className="shrink-0 gap-1 text-neutral-500">
                    <Boxes className="size-3" />
                    {computeEnvironmentKindLabels[row.environmentKind]}
                  </Chip>
                ) : null}
                {row.hostAssociationLabel ? (
                  <Chip
                    size="sm"
                    className={cn('hidden shrink-0 gap-1 sm:inline-flex', verified ? 'text-sky-300' : 'text-neutral-600')}
                  >
                    <Link2 className="size-3" />
                    {row.hostAssociationLabel}
                  </Chip>
                ) : null}
                {row.hasIdentityConflict ? (
                  <Chip size="sm" className="shrink-0 gap-1 text-amber-300">
                    <ShieldAlert className="size-3" />
                    Identity conflict
                  </Chip>
                ) : null}
              </span>
              <span className="mt-1 block truncate text-[11px] text-neutral-600">
                {row.resourcesSummary ?? `${row.connectorCount} connector${row.connectorCount === 1 ? '' : 's'}`}
              </span>
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <ConnectorRuntimeStatusChip
              updates={row.instances.map((instance) => instance.machine.connector.update)}
            />
            <StatusChip isOnline={row.isOnline} />
          </span>
        </Disclosure.Trigger>
      </Disclosure.Heading>
      <Disclosure.Content>
        <Disclosure.Body
          className="pb-1 pr-1"
          style={{ paddingLeft: `${2.25 + row.depth * 1.25}rem` }}
        >
          {row.instances.map((instance) => (
            <ConnectorRow
              key={instance.id}
              instance={instance}
              onEdit={() => onEditConnector(instance)}
              onRefresh={onRefresh}
            />
          ))}
        </Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}

function ComputePlatformSectionView({
  onEditConnector,
  onRefresh,
  section
}: {
  onEditConnector(instance: SettingsConnectorInstance): void;
  onRefresh(): Promise<unknown>;
  section: ComputePlatformSection;
}) {
  return (
    <div className="border-b border-neutral-800/70 pb-1 last:border-b-0">
      <div className="flex min-w-0 items-center gap-2 px-1 pt-4 pb-1">
        <Cloud className="size-3.5 shrink-0 text-sky-300" />
        <Text className="truncate text-[11px] font-medium uppercase tracking-[.06em] text-neutral-500">
          {section.name} · {section.platformKindLabel}
        </Text>
        <span className="ml-auto shrink-0 text-[11px] text-neutral-600">
          {section.onlineConnectorCount} of {section.connectorCount} online
        </span>
      </div>
      <div className="divide-y divide-neutral-800/50">
        {section.rows.map((row) => (
          row.kind === 'host'
            ? <HostRow key={row.id} row={row} />
            : (
              <EnvironmentRow
                key={row.id}
                defaultExpanded={section.rows.length <= 4}
                onEditConnector={onEditConnector}
                onRefresh={onRefresh}
                row={row}
              />
            )
        ))}
      </div>
    </div>
  );
}

function MachineRow({
  defaultExpanded,
  onEditConnector,
  onRefresh,
  row,
  showGrouping
}: {
  defaultExpanded: boolean;
  onEditConnector(instance: SettingsConnectorInstance): void;
  onRefresh(): Promise<unknown>;
  row: MachineListRow;
  showGrouping: boolean;
}) {
  return (
    <Disclosure defaultExpanded={defaultExpanded}>
      <Disclosure.Heading>
        <Disclosure.Trigger className="group grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-1 py-3 text-left outline-none transition hover:bg-neutral-900/35 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400/50">
          <span className="flex min-w-0 items-center gap-3">
            <Disclosure.Indicator className="ms-0 size-3.5 shrink-0 text-neutral-600 transition-transform group-aria-expanded:rotate-90 motion-reduce:transition-none">
              <ChevronRight />
            </Disclosure.Indicator>
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-neutral-900">
              <MachineDeviceIcon machine={row.device} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-neutral-200">{row.name}</span>
              <span className="mt-1 block truncate text-[11px] text-neutral-600">
                {machineRowSubtitle(row)}
              </span>
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {showGrouping && !row.isGrouped ? (
              <Chip size="sm" className={cn('hidden shrink-0 sm:inline-flex',
                row.hasIdentityConflict ? 'text-amber-300' : 'text-neutral-600')}>
                {row.hasIdentityConflict ? <><ShieldAlert className="size-3" />
                  Identity conflict</> : 'Ungrouped'}
              </Chip>
            ) : null}
            <ConnectorRuntimeStatusChip
              updates={row.instances.map((instance) => instance.machine.connector.update)}
            />
            <StatusChip isOnline={row.isOnline} />
          </span>
        </Disclosure.Trigger>
      </Disclosure.Heading>
      <Disclosure.Content>
        <Disclosure.Body className="pb-1 pl-8 pr-1">
          {row.instances.map((instance) => (
            <ConnectorRow
              key={instance.id}
              instance={instance}
              onEdit={() => onEditConnector(instance)}
              onRefresh={onRefresh}
            />
          ))}
        </Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}

export interface MachinesPageProps {
  computeInventory?: ComputeInventorySnapshot;
  connectors: readonly ConnectorInstallationRecord[];
  credentials: readonly ConnectorCredentialRecord[];
  credentialListError: string;
  hasCopiedInstallCommand: boolean;
  installCommand: string;
  installScriptHref: string;
  installerError: string;
  isGeneratingInstaller: boolean;
  loadError: string;
  onCopyInstallCommand(): void;
  onGenerateInstallCommand(): void;
  onRefresh(): Promise<unknown>;
  onRefreshCredentials(): void;
  onRevokeCredential(credentialId: string): void;
  onSaveMachine(request: PhysicalMachineSaveRequest): Promise<void>;
  physicalMachines: readonly PhysicalMachineRecord[];
  revokingCredentialId: string;
  status: SettingsMachineGroupsStatus;
  tailscale: ConnectorOverviewResult['tailscale'];
}

export function MachinesPage({
  computeInventory,
  connectors,
  credentials,
  credentialListError,
  hasCopiedInstallCommand,
  installCommand,
  installScriptHref,
  installerError,
  isGeneratingInstaller,
  loadError,
  onCopyInstallCommand,
  onGenerateInstallCommand,
  onRefresh,
  onRefreshCredentials,
  onRevokeCredential,
  onSaveMachine,
  physicalMachines,
  revokingCredentialId,
  status,
  tailscale
}: MachinesPageProps) {
  const [editingConnector, setEditingConnector] = useState<SettingsConnectorInstance>();
  const [filter, setFilter] = useState<MachineFilter>('all');
  const [isInstallerOpen, setIsInstallerOpen] = useState(false);
  const [query, setQuery] = useState('');

  const presentation = settingsMachineGroupsPresentation(status);
  const grouping = useMemo(
    () => groupSettingsMachines({ connectors, credentials, physicalMachines }),
    [connectors, credentials, physicalMachines]
  );
  const computeHierarchy = useMemo(
    () => (computeInventory && computeInventory.violations.length === 0
      ? groupComputeInventory(computeInventory)
      : undefined),
    [computeInventory]
  );
  const instancesById = useMemo(() => new Map(
    grouping.groups
      .flatMap((group) => [...group.instances, ...group.archivedInstances])
      .concat(grouping.unscopedInstances, grouping.archivedUnscopedInstances)
      .map((instance) => [instance.id, instance] as const)
  ), [grouping]);
  const platformSections = useMemo(
    () => (computeHierarchy ? computePlatformSections(computeHierarchy, instancesById) : []),
    [computeHierarchy, instancesById]
  );
  const isComputeMode = Boolean(computeHierarchy);
  const rows = useMemo(() => machineListRows(grouping), [grouping]);
  const visibleRows = useMemo(
    () => filterMachineRows({ filter, query, rows }),
    [filter, query, rows]
  );
  const visibleSections = useMemo(
    () => filterComputePlatformSections(platformSections, query, filter),
    [filter, platformSections, query]
  );
  const totalConnectorCount = useMemo(
    () => platformSections.reduce((sum, section) => sum + section.connectorCount, 0),
    [platformSections]
  );
  const onlineConnectorCount = useMemo(
    () => platformSections.reduce((sum, section) => sum + section.onlineConnectorCount, 0),
    [platformSections]
  );
  const archivedInstances = useMemo(
    () => grouping.groups
      .flatMap((group) => group.archivedInstances)
      .concat(grouping.archivedUnscopedInstances),
    [grouping]
  );
  const archivedCredentials = useMemo(
    () => grouping.unmatchedCredentials.filter(
      (credential) => credential.status === 'revoked' || credential.status === 'expired'
    ),
    [grouping.unmatchedCredentials]
  );
  const archivedCount = archivedInstances.length + archivedCredentials.length;
  const showPhysicalGrouping = physicalMachines.length > 0;
  const currentCredentials = useMemo(
    () => credentials.filter(
      (credential) => credential.status === 'active' || credential.status === 'pending'
    ),
    [credentials]
  );
  const tailscaleLabel = tailscale.connected
    ? 'Tailscale connected'
    : tailscale.installed
      ? 'Tailscale offline'
      : 'Tailscale not installed';
  const tailnetAddress = tailscale.serveOrigins[0] ?? tailscale.ips[0];

  function openInstaller() {
    setIsInstallerOpen(true);
    if (!installCommand && !isGeneratingInstaller) onGenerateInstallCommand();
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-neutral-800/70 pb-4">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <Text as="h1" className="block text-2xl font-semibold tracking-[-.02em] text-neutral-50">
              Machines
            </Text>
            <Text className="mt-1 block text-sm text-neutral-500">
              Every machine that runs a connector and makes its projects reachable here.
            </Text>
          </div>
          <Button
            size="sm"
            variant={isInstallerOpen ? 'secondary' : 'primary'}
            onPress={() => (isInstallerOpen ? setIsInstallerOpen(false) : openInstaller())}
          >
            <Plus className="size-4" />
            Add machine
          </Button>
        </div>
      </header>

      {isInstallerOpen ? (
        <MachinesInstallerPanel
          credentials={currentCredentials}
          credentialListError={credentialListError}
          hasCopied={hasCopiedInstallCommand}
          installCommand={installCommand}
          installScriptHref={installScriptHref}
          installerError={installerError}
          isGenerating={isGeneratingInstaller}
          onCopy={onCopyInstallCommand}
          onGenerate={onGenerateInstallCommand}
          onRefreshCredentials={onRefreshCredentials}
          onRevoke={onRevokeCredential}
          revokingCredentialId={revokingCredentialId}
        />
      ) : null}

      <div className="flex shrink-0 flex-col gap-3 border-b border-neutral-800/70 py-4 lg:flex-row lg:items-center lg:justify-between">
        <SearchField
          aria-label="Search machines and connectors"
          className="w-full lg:max-w-sm"
          onChange={setQuery}
          value={query}
        >
          <SearchFieldGroup className="h-10 rounded-full bg-neutral-900/80">
            <SearchFieldSearchIcon />
            <SearchFieldInput placeholder="Search machines and connectors" spellCheck={false} />
            <SearchFieldClearButton />
          </SearchFieldGroup>
        </SearchField>
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {filters.map(({ icon: Icon, id, label }) => (
            <Button
              key={id}
              size="sm"
              variant={filter === id ? 'secondary' : 'ghost'}
              className="shrink-0 rounded-full"
              onPress={() => setFilter(id)}
            >
              <Icon className="size-3.5" />
              {label}
            </Button>
          ))}
          <Button
            aria-label="Refresh machines"
            isIconOnly
            size="sm"
            variant="ghost"
            className="ml-1 size-8 shrink-0 rounded-full px-0"
            onPress={() => void onRefresh()}
          >
            <RefreshCw className={cn('size-3.5', presentation.showRefreshing && 'animate-spin')} />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {loadError && presentation.showContent ? (
          <div
            role="alert"
            className="mt-3 rounded-xl border border-amber-500/25 bg-amber-500/[.07] px-4 py-3"
          >
            <Text className="block text-xs text-amber-200">{loadError}</Text>
          </div>
        ) : null}

        {presentation.showBlockingLoading ? (
          <div className="flex min-h-48 items-center justify-center gap-2 text-neutral-500">
            <LoaderCircle className="size-4 animate-spin" />
            <Text className="text-sm">Loading machines…</Text>
          </div>
        ) : presentation.showBlockingError ? (
          <div className="grid min-h-48 place-items-center gap-3 px-6 text-center">
            <Text className="max-w-md text-sm text-red-300/80">
              {loadError || 'Machines could not be loaded.'}
            </Text>
            <Button size="sm" variant="ghost" onPress={() => void onRefresh()}>
              Retry
            </Button>
          </div>
        ) : (isComputeMode ? platformSections.length === 0 : rows.length === 0) ? (
          <div className="grid min-h-48 place-items-center gap-3 px-6 text-center">
            <MonitorCog className="size-6 text-neutral-700" />
            <Text className="text-sm text-neutral-500">
              {isComputeMode ? 'No platform reports a machine yet.' : 'No machine runs a connector yet.'}
            </Text>
            <Button size="sm" variant="secondary" onPress={openInstaller}>
              <Plus className="size-4" />
              Add your first machine
            </Button>
          </div>
        ) : (isComputeMode ? visibleSections.length === 0 : visibleRows.length === 0) ? (
          <div className="grid min-h-48 place-items-center px-6 text-center">
            <Text className="text-sm text-neutral-500">
              No machines match this search and filter.
            </Text>
          </div>
        ) : isComputeMode ? (
          visibleSections.map((section) => (
            <ComputePlatformSectionView
              key={section.id}
              onEditConnector={setEditingConnector}
              onRefresh={onRefresh}
              section={section}
            />
          ))
        ) : (
          <div className="divide-y divide-neutral-800/70">
            {visibleRows.map((row) => (
              <MachineRow
                key={row.id}
                defaultExpanded={visibleRows.length <= 3}
                onEditConnector={setEditingConnector}
                onRefresh={onRefresh}
                row={row}
                showGrouping={showPhysicalGrouping}
              />
            ))}
          </div>
        )}

        {archivedCount > 0 && presentation.showContent ? (
          <Disclosure className="mt-2 border-t border-neutral-800/70">
            <Disclosure.Heading>
              <Disclosure.Trigger className="group flex items-center gap-2 px-1 py-3 text-xs text-neutral-600 transition hover:text-neutral-400">
                <Disclosure.Indicator className="ms-0 size-3.5 transition-transform group-aria-expanded:rotate-90 motion-reduce:transition-none">
                  <ChevronRight />
                </Disclosure.Indicator>
                <Archive className="size-3.5" />
                Archived connector history ({archivedCount})
              </Disclosure.Trigger>
            </Disclosure.Heading>
            <Disclosure.Content>
              <Disclosure.Body className="space-y-1 pb-3 pl-8">
                {archivedInstances.map((instance) => (
                  <div
                    key={instance.id}
                    className="flex min-w-0 items-center gap-2 text-[11px] text-neutral-600"
                  >
                    <MachineOsMark className="size-3.5" machine={instance.machine} />
                    <span className="truncate">
                      {instance.machine.name} ·{' '}
                      {instance.platformLabel ?? 'Operating system not reported'}
                    </span>
                    <ConnectorChannelChip machine={instance.machine} />
                    <ConnectorRuntimeStatusChip update={instance.machine.connector.update} />
                  </div>
                ))}
                {archivedCredentials.map((credential) => (
                  <Text
                    key={credential.id}
                    className="block truncate text-[11px] text-neutral-600"
                  >
                    {credential.machineId ?? 'Unfinished enrollment'} · {credential.status}
                  </Text>
                ))}
              </Disclosure.Body>
            </Disclosure.Content>
          </Disclosure>
        ) : null}
      </div>

      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-neutral-800/70 py-3 text-xs text-neutral-600">
        <span>
          {isComputeMode
            ? `${countComputePlatformRows(visibleSections)} of ${countComputePlatformRows(platformSections)} machines · ${onlineConnectorCount} of ${totalConnectorCount} connectors online`
            : `${visibleRows.length} of ${rows.length} ${rows.length === 1 ? 'machine' : 'machines'}`}
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          <Network
            className={cn('size-3.5 shrink-0', tailscale.connected ? 'text-emerald-500/80' : '')}
          />
          <span className="truncate">
            {tailscaleLabel} · {tailscale.peersOnline} peers
            {tailnetAddress ? ` · ${tailnetAddress}` : ''}
          </span>
        </span>
      </footer>

      {editingConnector ? (
        <SettingsConnectorMachineEditor
          key={editingConnector.id}
          connector={editingConnector.machine}
          onClose={() => setEditingConnector(undefined)}
          onSave={onSaveMachine}
          physicalMachines={physicalMachines}
        />
      ) : null}
    </section>
  );
}
