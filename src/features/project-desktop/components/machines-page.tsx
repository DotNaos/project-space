import { useMemo, useState } from 'react';
import {
  Boxes,
  Circle,
  CircleOff,
  Cloud,
  Cpu,
  Link2,
  ListFilter,
  LoaderCircle,
  MonitorCog,
  Network,
  Plus,
  RefreshCw,
  ShieldAlert,
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
  ConnectorInstallationRecord,
  ConnectorOverviewResult,
} from '@/shared/project-space-api';
import type { ComputeInventorySnapshot } from '@/shared/compute-environment-api';
import { groupComputeInventory } from '@/shared/compute-environment-api';
import { settingsConnectorInstances } from './settings-machine-group-model';
import {
  settingsMachineGroupsPresentation,
  type SettingsMachineGroupsStatus
} from './settings-machine-groups-view-model';
import {
  computeEnvironmentKindLabels,
  computePlatformSections,
  countComputePlatformRows,
  filterComputePlatformSections,
  type ComputePlatformSection,
  type ComputeRow,
  type MachineFilter,
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
          {!row.resourcesSummary ? <span>Host capability record</span> : null}
        </span>
      </span>
      <StatusChip isOnline={row.isOnline} />
    </div>
  );
}

function EnvironmentRow({
  row
}: {
  row: ComputeRow;
}) {
  const verified = row.hostAssociationLabel !== undefined &&
    (row.hostAssociationLabel.startsWith('Verified') || row.hostAssociationLabel === 'Manually assigned');

  return (
    <div
      className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-2.5 pr-1"
      style={{ paddingLeft: `${0.25 + row.depth * 1.25}rem` }}
    >
      <span className="flex min-w-0 items-center gap-3">
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
            {row.resourcesSummary ?? 'Environment Instance'}
          </span>
        </span>
      </span>
      <StatusChip isOnline={row.isOnline} />
    </div>
  );
}

function ComputePlatformSectionView({
  section
}: {
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
          {section.rows.filter((row) => row.isOnline).length} of {section.rows.length} targets online
        </span>
      </div>
      <div className="divide-y divide-neutral-800/50">
        {section.rows.map((row) => (
          row.kind === 'host'
            ? <HostRow key={row.id} row={row} />
            : (
              <EnvironmentRow
                key={row.id}
                row={row}
              />
            )
        ))}
      </div>
    </div>
  );
}

export interface MachinesPageProps {
  computeInventory?: ComputeInventorySnapshot;
  connectors: readonly ConnectorInstallationRecord[];
  localSimulation: boolean;
  loadError: string;
  onRefresh(): Promise<unknown>;
  status: SettingsMachineGroupsStatus;
  tailscale: ConnectorOverviewResult['tailscale'];
}

export function MachinesPage({
  computeInventory,
  connectors,
  localSimulation,
  loadError,
  onRefresh,
  status,
  tailscale
}: MachinesPageProps) {
  const [filter, setFilter] = useState<MachineFilter>('all');
  const [query, setQuery] = useState('');

  const presentation = settingsMachineGroupsPresentation(status);
  const instancesById = useMemo(() => new Map(
    settingsConnectorInstances(connectors).map((instance) => [instance.id, instance] as const)
  ), [connectors]);
  const computeHierarchy = useMemo(
    () => (computeInventory && computeInventory.violations.length === 0
      ? groupComputeInventory(computeInventory)
      : undefined),
    [computeInventory]
  );
  const platformSections = useMemo(
    () => (computeHierarchy ? computePlatformSections(computeHierarchy, instancesById) : []),
    [computeHierarchy, instancesById]
  );
  const isComputeMode = Boolean(computeHierarchy);
  const visibleSections = useMemo(
    () => filterComputePlatformSections(platformSections, query, filter),
    [filter, platformSections, query]
  );
  const onlineTargetCount = useMemo(
    () => platformSections.reduce(
      (sum, section) => sum + section.rows.filter((row) => row.isOnline).length,
      0
    ),
    [platformSections]
  );
  const tailscaleLabel = tailscale.connected
    ? 'Tailscale connected'
    : tailscale.installed
      ? 'Tailscale offline'
      : 'Tailscale not installed';
  const tailnetAddress = tailscale.serveOrigins[0] ?? tailscale.ips[0];

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-neutral-800/70 pb-4">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <Text as="h1" className="block text-2xl font-semibold tracking-[-.02em] text-neutral-50">
              Compute
            </Text>
            <Text className="mt-1 block text-sm text-neutral-500">
              Platforms, Hosts, and Environment Instances available to Project Space.
            </Text>
          </div>
          {!localSimulation ? (
            <a href="/environments/setup">
              <Button size="sm" variant="primary">
                <Plus className="size-4" />
                Add environment
              </Button>
            </a>
          ) : null}
        </div>
      </header>

      <div className="flex shrink-0 flex-col gap-3 border-b border-neutral-800/70 py-4 lg:flex-row lg:items-center lg:justify-between">
        <SearchField
          aria-label="Search compute targets"
          className="w-full lg:max-w-sm"
          onChange={setQuery}
          value={query}
        >
          <SearchFieldGroup className="h-10 rounded-full bg-neutral-900/80">
            <SearchFieldSearchIcon />
            <SearchFieldInput placeholder="Search Platforms, Hosts, and Environments" spellCheck={false} />
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
            aria-label="Refresh compute inventory"
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
            <Text className="text-sm">Loading compute inventory…</Text>
          </div>
        ) : presentation.showBlockingError ? (
          <div className="grid min-h-48 place-items-center gap-3 px-6 text-center">
            <Text className="max-w-md text-sm text-red-300/80">
              {loadError || 'Compute inventory could not be loaded.'}
            </Text>
            <Button size="sm" variant="ghost" onPress={() => void onRefresh()}>
              Retry
            </Button>
          </div>
        ) : !isComputeMode ? (
          <div className="grid min-h-48 place-items-center gap-3 px-6 text-center">
            <MonitorCog className="size-6 text-neutral-700" />
            <Text className="text-sm text-neutral-500">
              Canonical compute inventory is unavailable.
            </Text>
          </div>
        ) : platformSections.length === 0 ? (
          <div className="grid min-h-48 place-items-center gap-3 px-6 text-center">
            <MonitorCog className="size-6 text-neutral-700" />
            <Text className="text-sm text-neutral-500">
              No Platform reports a Host or Environment Instance yet.
            </Text>
          </div>
        ) : visibleSections.length === 0 ? (
          <div className="grid min-h-48 place-items-center px-6 text-center">
            <Text className="text-sm text-neutral-500">
              No compute targets match this search and filter.
            </Text>
          </div>
        ) : (
          visibleSections.map((section) => (
            <ComputePlatformSectionView
              key={section.id}
              section={section}
            />
          ))
        )}

      </div>

      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-neutral-800/70 py-3 text-xs text-neutral-600">
        <span>
          {isComputeMode
            ? `${countComputePlatformRows(visibleSections)} of ${countComputePlatformRows(platformSections)} compute targets · ${onlineTargetCount} online`
            : 'Canonical compute inventory unavailable'}
        </span>
        {!localSimulation ? <span className="flex min-w-0 items-center gap-1.5">
          <Network
            className={cn('size-3.5 shrink-0', tailscale.connected ? 'text-emerald-500/80' : '')}
          />
          <span className="truncate">
            {tailscaleLabel} · {tailscale.peersOnline} peers
            {tailnetAddress ? ` · ${tailnetAddress}` : ''}
          </span>
        </span> : null}
      </footer>

    </section>
  );
}
