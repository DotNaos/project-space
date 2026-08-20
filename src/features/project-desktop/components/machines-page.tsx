import { useMemo, useState } from 'react';
import {
  Boxes,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Cloud,
  Copy,
  Cpu,
  LoaderCircle,
  MonitorCog,
  Plus,
  RefreshCw
} from 'lucide-react';
import type {
  ProjectCliComputeInventory,
  ProjectCliControlledAccessRoute
} from '@/shared/compute-inventory-cli-api';
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
import {
  computeEnvironmentKindLabels,
  computeInventoryCounts,
  computePlatformSections,
  countComputePlatformRows,
  filterComputePlatformSections,
  isComputeInventoryStale,
  type ComputePlatformSection,
  type ComputeRow,
  type MachineFilter
} from './machines-page-model';
import type { SettingsMachineGroupsStatus } from './settings-machine-groups-view-model';
import { LegacyConnectorCleanup } from './legacy-connector-cleanup';
import { TailscaleDeviceClassification } from './tailscale-device-classification';

const filters: Array<{ id: MachineFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'available', label: 'Available' },
  { id: 'attention', label: 'Needs attention' }
];

function StatusChip({ label, status }: { label: string; status: ComputeRow['status'] }) {
  return (
    <Chip
      size="sm"
      className={cn(
        'shrink-0 gap-1.5',
        status === 'available' && 'text-emerald-300',
        status === 'attention' && 'text-amber-300',
        status === 'unknown' && 'text-neutral-500'
      )}
    >
      <span
        aria-hidden
        className={cn(
          'size-1.5 rounded-full',
          status === 'available' && 'bg-emerald-400',
          status === 'attention' && 'bg-amber-400',
          status === 'unknown' && 'bg-neutral-700'
        )}
      />
      {label}
    </Chip>
  );
}

function evidenceLabel(value: string | undefined) {
  switch (value) {
    case 'available': return 'Available';
    case 'stale': return 'Stale';
    case 'unavailable': return 'Unavailable';
    case 'verified': return 'Verified';
    case 'unverified': return 'Not verified';
    default: return 'Unknown';
  }
}

function providerLabel(value: string | undefined) {
  switch (value) {
    case 'provider_native': return 'Provider';
    case 'tailscale': return 'Tailscale';
    case 'wireguard': return 'WireGuard';
    case 'other': return 'Private network';
    default: return 'Unavailable';
  }
}

function HostRow({ row }: { row: ComputeRow }) {
  const capabilities = row.hostCapabilities;
  return (
    <div className="flex min-w-0 items-center gap-3 px-1 py-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-neutral-900">
        <Cpu className="size-4 text-emerald-300" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-neutral-200">{row.name}</span>
        <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-neutral-600">
          {capabilities ? (
            <span className="truncate">
              Power {evidenceLabel(capabilities.power)} · Reset {evidenceLabel(capabilities.reset)} · Wake-on-LAN {evidenceLabel(capabilities.wakeOnLan)} · Console {evidenceLabel(capabilities.console)} · {capabilities.provider === 'jetkvm' ? 'JetKVM' : 'Console provider unavailable'}
            </span>
          ) : <span className="truncate">Host capabilities unavailable</span>}
          {row.resourcesSummary ? <span className="truncate">· {row.resourcesSummary}</span> : null}
          {row.resourceSource ? <span className="truncate">· {row.resourceSource}</span> : null}
        </span>
      </span>
      <StatusChip label={row.hostStatus ?? 'Host status unavailable'} status={row.status} />
    </div>
  );
}

function EnvironmentRow({ row, onSelect }: { row: ComputeRow; onSelect(): void }) {
  const instance = row.environment!;
  return (
    <button
      type="button"
      className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg py-3 pr-1 text-left transition hover:bg-neutral-900/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60"
      style={{ paddingLeft: `${0.25 + row.depth * 1.25}rem` }}
      onClick={onSelect}
    >
      <span className="flex min-w-0 items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-neutral-900">
          <Boxes className="size-4 text-violet-300" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            {row.depth > 0 ? <ChevronRight className="size-3 shrink-0 text-neutral-700" /> : null}
            <span className="truncate text-sm font-medium text-neutral-200">{row.name}</span>
            <Chip size="sm" className="shrink-0 gap-1 text-neutral-500">
              {computeEnvironmentKindLabels[instance.kind]}
            </Chip>
            {row.relationship === 'dual-boot' ? (
              <Chip size="sm" className="shrink-0 text-sky-300">Dual-boot alternative</Chip>
            ) : row.relationship === 'nested' ? (
              <Chip size="sm" className="shrink-0 text-violet-300">Nested</Chip>
            ) : null}
          </span>
          <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-neutral-600">
            <span>{row.environmentStatus}</span>
            <span>· {row.hostResolutionLabel ?? 'Environment Instance'}</span>
            {row.accessSummary ? <span>· {providerLabel(row.accessSummary.providerKind)}</span> : null}
            {row.resourcesSummary ? <span>· {row.resourcesSummary}</span> : null}
            {row.resourceSource ? <span>· {row.resourceSource}</span> : null}
            {row.workspaces.length > 0 ? (
              <span>· {row.workspaces.length} Workspace Runtime{row.workspaces.length === 1 ? '' : 's'}</span>
            ) : null}
          </span>
          {row.workspaces.length > 0 ? (
            <span className="mt-1 block truncate text-[11px] text-neutral-500">
              {row.workspaces.map((workspace) => (
                <span key={workspace.id} className="mr-2 inline-block max-w-full truncate align-bottom">
                  Workspace Runtime · {workspace.name}
                  {workspace.repository && workspace.repository !== workspace.name
                    ? ` · ${workspace.repository}`
                    : ''}
                </span>
              ))}
            </span>
          ) : null}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <StatusChip label={row.environmentStatus ?? 'Status unavailable'} status={row.status} />
        <ChevronRight aria-hidden className="hidden size-4 text-neutral-700 sm:block" />
      </span>
    </button>
  );
}

function ComputePlatformSectionView({
  onSelectEnvironment,
  section
}: {
  onSelectEnvironment(id: string): void;
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
          {section.environmentCount} Environment{section.environmentCount === 1 ? '' : 's'}
          {section.hostCount ? ` · ${section.hostCount} Host${section.hostCount === 1 ? '' : 's'}` : ''}
        </span>
      </div>
      <div className="divide-y divide-neutral-800/50">
        {section.rows.map((row) => (
          row.kind === 'host'
            ? <HostRow key={row.id} row={row} />
            : <EnvironmentRow key={row.id} row={row} onSelect={() => onSelectEnvironment(row.id)} />
        ))}
      </div>
    </div>
  );
}

function EnvironmentDetails({
  inventory,
  instance,
  onClose
}: {
  inventory: ProjectCliComputeInventory;
  instance: NonNullable<ComputeRow['environment']>;
  onClose(): void;
}) {
  const [copied, setCopied] = useState(false);
  const host = instance.hostId
    ? inventory.hosts.find((entry) => entry.id === instance.hostId)
    : undefined;
  const parent = instance.parentEnvironmentInstanceId
    ? inventory.environmentInstances.find((entry) => entry.id === instance.parentEnvironmentInstanceId)
    : undefined;
  const hostLabel = host?.name ?? (
    instance.hostResolution === 'not_applicable'
      ? 'Provider managed'
      : instance.hostResolution === 'conflict'
        ? 'Host needs review'
        : instance.hostResolution === 'unresolved'
          ? 'Host not assigned'
          : 'Host unavailable'
  );
  const hostStatus = host?.capabilities.state === 'available'
    ? 'Host reachable'
    : host?.capabilities.state === 'unavailable'
      ? 'Host unavailable'
      : 'Host status unavailable';
  const resources = instance.resources
    ? `${instance.resources.cpuCores} CPU · ${formatDetailBytes(instance.resources.memoryLimitBytes ?? instance.resources.memoryTotalBytes)} · ${formatDetailBytes(instance.resources.storageTotalBytes)}`
    : 'Not reported';
  const definition = inventory.environmentCatalog.find((entry) => entry.id === instance.environmentDefinitionId);
  const access = instance.accessSummary ?? {
    providerKind: instance.hostResolution === 'not_applicable' ? 'provider_native' as const : 'none' as const,
    route: instance.accessRoutes.some((route) => route.type !== 'connector') ? 'unknown' as const : 'unavailable' as const,
    ssh: {
      hostKey: 'unknown' as const,
      projectCli: 'unknown' as const,
      readiness: 'unknown' as const
    }
  };
  const clientRoute = instance.accessRoutes.find((route): route is ProjectCliControlledAccessRoute =>
    route.type !== 'connector' && Boolean(route.clientAccess));
  const command = `project ssh --environment-id ${instance.id}`;

  async function copyCommand() {
    if (!navigator.clipboard) return;
    await navigator.clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  return (
    <aside aria-label="Environment Instance details" className="border-t border-neutral-800/70 bg-neutral-950/60 px-4 py-4 sm:px-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Text className="text-[11px] font-medium uppercase tracking-[.08em] text-neutral-500">
            Environment Instance
          </Text>
          <Text as="h2" className="mt-1 truncate text-lg font-semibold text-neutral-100">
            {instance.alias}
          </Text>
        </div>
        <Button size="sm" variant="ghost" onPress={onClose}>Close</Button>
      </div>
      <div className="mt-4 grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2">
        <DetailSectionLabel label="Identity" />
        <DetailValue label="Definition" value={definition?.name ?? computeEnvironmentKindLabels[instance.kind]} />
        <DetailValue label="Definition type" value={definition?.slug ?? computeEnvironmentKindLabels[instance.kind]} />
        <DetailValue label="Bootstrap" value={definition?.bootstrapStrategy.replace('_', ' ')} />
        <DetailValue label="Ownership" value={definition?.ownership.replace('_', ' ')} />
        <DetailValue label="Operating system" value={definition?.operatingSystemFamily} />
        <DetailValue label="Supported architectures" value={definition?.supportedArchitectures.join(' · ')} />
        <DetailValue label="Platform" value={inventory.platforms.find((platform) => platform.id === instance.platformId)?.name} />
        <DetailValue label="Host" value={hostLabel} />
        <DetailValue label="Host status" value={host ? hostStatus : instance.hostResolution === 'not_applicable' ? 'Provider managed' : 'Not reported'} />
        <DetailValue label="Parent environment" value={parent?.alias ?? 'None'} />
        <DetailSectionLabel label="Access" />
        <DetailValue label="Provider" value={providerLabel(access.providerKind)} />
        <DetailValue label="Route readiness" value={evidenceLabel(access.route)} />
        <DetailValue label="SSH readiness" value={evidenceLabel(access.ssh.readiness)} />
        <DetailValue label="SSH host key" value={evidenceLabel(access.ssh.hostKey)} />
        <DetailValue label="Project CLI" value={evidenceLabel(access.ssh.projectCli)} />
        <DetailValue label="Client-owned SSH" value={clientRoute ? `Ready · ${clientRoute.clientAccess!.address}` : 'Unavailable until fresh local Tailnet evidence'} />
        <DetailSectionLabel label="Resources" />
        <DetailValue label="Capacity" value={resources} />
        <DetailValue label="Resource source" value={resourceSourceLabel(instance.resources, instance.hostd.state)} />
      </div>
      <div className="mt-4 border-t border-neutral-800/70 pt-3">
        <Text className="block text-[11px] font-medium uppercase tracking-[.08em] text-neutral-500">Workspace Runtimes</Text>
        <Text className="mt-1 block text-xs text-neutral-500">
          {instance.workspaceInventory.state === 'available' ? `${instance.workspaces.length} available` : 'Not reported'}
        </Text>
        {instance.workspaces.length > 0 ? (
          <div className="mt-2 space-y-2">
            {instance.workspaces.map((workspace) => (
              <div key={workspace.id} className="border-l border-neutral-800 pl-3 text-xs">
                <Text className="block truncate text-neutral-200">{workspace.name}</Text>
                {workspace.repository !== workspace.name ? (
                  <Text className="mt-0.5 block truncate text-neutral-500">{workspace.repository ?? 'Repository unavailable'}</Text>
                ) : null}
                {workspace.runtime ? (
                  <>
                    <Text className="mt-1 block text-neutral-400">
                      Lifecycle {workspace.runtime.lifecycle} · Codex {evidenceLabel(workspace.runtime.codex)} · Connection {workspace.runtime.connection}
                    </Text>
                    {workspace.runtime.devServers.length > 0 ? (
                      <Text className="mt-0.5 block truncate text-neutral-500">
                        Development servers · {workspace.runtime.devServers.map((server) => `${server.name} (${server.state})`).join(' · ')}
                      </Text>
                    ) : (
                      <Text className="mt-0.5 block text-neutral-500">No declared development servers</Text>
                    )}
                  </>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <Text className="mt-2 text-xs text-neutral-500">No Workspace Runtimes reported.</Text>
        )}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-neutral-800/70 bg-neutral-900/40 px-3 py-2">
        <code className="min-w-0 flex-1 truncate text-xs text-neutral-300">{command}</code>
        <Button size="sm" variant="secondary" isDisabled={!clientRoute} onPress={() => void copyCommand()}>
          <Copy className="size-3.5" />
          {copied ? 'Copied' : 'Copy command'}
        </Button>
      </div>
    </aside>
  );
}

function resourceSourceLabel(
  resources: NonNullable<NonNullable<ComputeRow['environment']>['resources']> | undefined,
  hostdState: NonNullable<ComputeRow['environment']>['hostd']['state']
) {
  if (hostdState === 'stale') return 'Stale';
  switch (resources?.source) {
    case 'connector': return 'SSH snapshot';
    case 'configured': return 'SSH snapshot';
    case 'hostd': return 'project-hostd';
    case 'provider': return 'Provider';
    default: return 'Unavailable';
  }
}

function DetailValue({ label, value }: { label: string; value?: string }) {
  return (
    <div className="min-w-0">
      <Text className="block text-[11px] text-neutral-600">{label}</Text>
      <Text className="mt-0.5 block truncate text-neutral-300">{value ?? 'Unavailable'}</Text>
    </div>
  );
}

function DetailSectionLabel({ label }: { label: string }) {
  return (
    <Text className="block border-b border-neutral-800/70 pb-1 text-[11px] font-medium uppercase tracking-[.08em] text-neutral-500 sm:col-span-2">
      {label}
    </Text>
  );
}

function formatDetailBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 'Unavailable';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1_024 && unit < units.length - 1) {
    amount /= 1_024;
    unit += 1;
  }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

export interface MachinesPageProps {
  computeInventory?: ProjectCliComputeInventory;
  inventoryStatus: SettingsMachineGroupsStatus;
  localSimulation: boolean;
  loadError: string;
  onRefresh(): Promise<unknown>;
}

export function MachinesPage({
  computeInventory,
  inventoryStatus,
  localSimulation,
  loadError,
  onRefresh
}: MachinesPageProps) {
  const [filter, setFilter] = useState<MachineFilter>('all');
  const [query, setQuery] = useState('');
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<string>();
  const platformSections = useMemo(
    () => (computeInventory ? computePlatformSections(computeInventory) : []),
    [computeInventory]
  );
  const visibleSections = useMemo(
    () => filterComputePlatformSections(platformSections, query, filter),
    [filter, platformSections, query]
  );
  const counts = computeInventoryCounts(platformSections);
  const selectedEnvironment = computeInventory?.environmentInstances.find(
    (instance) => instance.id === selectedEnvironmentId
  );
  const isReady = computeInventory?.inventoryState === 'ready' && computeInventory.violations.length === 0;
  const isStale = Boolean(computeInventory && isComputeInventoryStale(computeInventory.checkedAt));
  const showBlockingLoading = inventoryStatus === 'loading' && !computeInventory;
  const showBlockingError = inventoryStatus === 'error' && !computeInventory;
  const showEmpty = isReady && counts.environments === 0 && counts.hosts === 0;

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-neutral-800/70 pb-4">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <Text as="h1" className="block text-2xl font-semibold tracking-[-.02em] text-neutral-50">Compute</Text>
            <Text className="mt-1 block text-sm text-neutral-500">Platforms, Hosts, Environment Instances, and Workspace Runtimes.</Text>
          </div>
          {!localSimulation ? (
            <a href="/docs/environments/setup">
              <Button size="sm" variant="primary"><Plus className="size-4" />Add environment</Button>
            </a>
          ) : null}
          <TailscaleDeviceClassification />
        </div>
        <LegacyConnectorCleanup onChanged={onRefresh} />
      </header>

      <div className="flex shrink-0 flex-col gap-3 border-b border-neutral-800/70 py-4 lg:flex-row lg:items-center lg:justify-between">
        <SearchField aria-label="Search compute environments" className="w-full lg:max-w-sm" onChange={setQuery} value={query}>
          <SearchFieldGroup className="h-10 rounded-full bg-neutral-900/80">
            <SearchFieldSearchIcon />
            <SearchFieldInput placeholder="Search platforms and environments" spellCheck={false} />
            <SearchFieldClearButton />
          </SearchFieldGroup>
        </SearchField>
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {filters.map(({ id, label }) => (
            <Button key={id} size="sm" variant={filter === id ? 'secondary' : 'ghost'} className="shrink-0 rounded-full" onPress={() => setFilter(id)}>
              {label}
            </Button>
          ))}
          <Button aria-label="Refresh compute inventory" isIconOnly size="sm" variant="ghost" className="ml-1 size-8 shrink-0 rounded-full px-0" onPress={() => void onRefresh()}>
            <RefreshCw className={cn('size-3.5', inventoryStatus === 'refreshing' && 'animate-spin')} />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {loadError && computeInventory ? (
          <div role="alert" className="mt-3 flex items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[.07] px-4 py-3">
            <CircleAlert className="size-4 shrink-0 text-amber-300" />
            <Text className="block text-xs text-amber-200">{loadError} Showing the last known inventory.</Text>
          </div>
        ) : null}
        {isStale && computeInventory ? (
          <div role="status" className="mt-3 rounded-xl border border-sky-500/20 bg-sky-500/[.05] px-4 py-3 text-xs text-sky-200">
            This inventory may be out of date. Refresh to check again.
          </div>
        ) : null}

        {showBlockingLoading ? (
          <div className="flex min-h-48 items-center justify-center gap-2 text-neutral-500"><LoaderCircle className="size-4 animate-spin" /><Text className="text-sm">Loading compute inventory…</Text></div>
        ) : showBlockingError ? (
          <div className="grid min-h-48 place-items-center gap-3 px-6 text-center"><MonitorCog className="size-6 text-neutral-700" /><Text className="max-w-md text-sm text-neutral-500">{loadError || 'Compute is temporarily unavailable.'}</Text><Button size="sm" variant="secondary" onPress={() => void onRefresh()}>Try again</Button></div>
        ) : !isReady ? (
          <div className="grid min-h-48 place-items-center gap-3 px-6 text-center"><MonitorCog className="size-6 text-neutral-700" /><Text className="max-w-md text-sm text-neutral-500">Compute details are not available right now.</Text></div>
        ) : showEmpty ? (
          <div className="grid min-h-48 place-items-center gap-3 px-6 text-center"><CheckCircle2 className="size-6 text-neutral-700" /><Text className="text-sm text-neutral-500">No compute environments are configured yet.</Text></div>
        ) : visibleSections.length === 0 ? (
          <div className="grid min-h-48 place-items-center px-6 text-center"><Text className="text-sm text-neutral-500">No environments match this search or filter.</Text></div>
        ) : (
          visibleSections.map((section) => <ComputePlatformSectionView key={section.id} section={section} onSelectEnvironment={setSelectedEnvironmentId} />)
        )}
      </div>

      {computeInventory && selectedEnvironment ? <EnvironmentDetails inventory={computeInventory} instance={selectedEnvironment} onClose={() => setSelectedEnvironmentId(undefined)} /> : null}
      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-neutral-800/70 py-3 text-xs text-neutral-600">
        <span>{countComputePlatformRows(visibleSections)} visible · {counts.hosts} Host{counts.hosts === 1 ? '' : 's'} · {counts.environments} Environment{counts.environments === 1 ? '' : 's'} · {counts.workspaces} Workspace Runtime{counts.workspaces === 1 ? '' : 's'}</span>
        {computeInventory ? <span>Checked {new Date(computeInventory.checkedAt).toLocaleString()}</span> : null}
      </footer>
    </section>
  );
}
