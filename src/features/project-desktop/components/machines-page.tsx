import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Chip, Container, Icon, Input, Select, Spinner, Text } from '@dotnaos/ui/base';
import type { ProjectCliComputeInventory, ProjectCliHost } from '@/shared/compute-inventory-cli-api';
import type { TailscaleInventoryDevice } from '@/shared/tailscale-inventory-api';
import { DataTable, type DataTableColumn } from '../../../components/ui/data-table';
import { CollapsibleSection } from '../../../components/ui/collapsible-section';
import {
  useTailnetComputeInventory,
  type TailnetHostAssignmentDraft
} from '../hooks/use-tailnet-compute-inventory';
import {
  buildComputeHostInventory,
  countVisibleComputeHostInventory,
  filterComputeHostInventory,
  sortComputeHostInventory,
  type CodespaceRow,
  type ComputeHostGroup,
  type ComputeHostSectionFilter,
  type ComputeHostSortOrder,
  type ComputeHostStatusFilter,
  type TailnetDeviceRow,
  type TailnetDeviceStatus
} from './compute-host-inventory-model';
import { isComputeInventoryStale } from './machines-page-model';
import type { SettingsMachineGroupsStatus } from './settings-machine-groups-view-model';
import { TailnetProviderStatus } from './tailscale-device-classification';
import { TailnetHostAssignmentDrawer } from './tailnet-host-assignment-drawer';
import { LegacyConnectorCleanup } from './legacy-connector-cleanup';
import {
  codespaceDeviceDescriptor,
  hostsDeviceRoute,
  parseHostsDeviceRoute,
  tailnetDeviceDescriptor,
  type HostsDeviceKind,
  type HostsDeviceRoute
} from './hosts-device-model';
import { OperatingSystem } from './hosts-device-visuals';
import { HostsDeviceWorkspace } from './hosts-device-workspace';

const statusFilterOptions: Array<{ value: ComputeHostStatusFilter; label: string }> = [
  { value: 'all', label: 'All statuses' },
  { value: 'available', label: 'Online' },
  { value: 'attention', label: 'Needs attention' }
];
const sectionFilterOptions: Array<{ value: ComputeHostSectionFilter; label: string }> = [
  { value: 'all', label: 'All sections' },
  { value: 'hosts', label: 'Hosts' },
  { value: 'available', label: 'Available devices' },
  { value: 'codespaces', label: 'Codespaces' }
];
const sortOptions: Array<{ value: ComputeHostSortOrder; label: string }> = [
  { value: 'online', label: 'Online first' },
  { value: 'name', label: 'Name A–Z' }
];

function emptyComputeInventory(): ProjectCliComputeInventory {
  return {
    checkedAt: new Date(0).toISOString(), environmentCatalog: [], environmentInstances: [],
    hosts: [], inventoryState: 'ready', platforms: [], privateNetworks: [], schemaVersion: 3,
    violations: []
  };
}

function StatusChip({ label, status }: { label: string; status: TailnetDeviceStatus }) {
  return (
    <Chip
      icon={status === 'available' ? 'check-circle' : status === 'attention' ? 'alert-triangle' : 'circle'}
      label={label}
      size="sm"
      tone={status === 'available' ? 'success' : status === 'attention' ? 'warning' : 'default'}
      variant="soft"
    />
  );
}

function DeviceName({ onOpen, row }: { onOpen(): void; row: TailnetDeviceRow }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full min-w-0 items-center overflow-hidden rounded-md text-left outline-none transition hover:text-accent focus-visible:ring-2 focus-visible:ring-accent"
    >
      <span className="truncate font-medium text-text">{row.name}</span>
    </button>
  );
}

function DeviceDetails({ device }: {
  device: TailscaleInventoryDevice;
}) {
  return (
    <Container.Stack gap={2} customize={{
      reason: 'Keep source-specific network evidence secondary to the compact device row.',
      className: 'min-w-0'
    }}>
      <Container.Stack direction="horizontal" align="center" gap={2} customize={{
        reason: 'Allow direct Tailnet addresses to wrap on narrow screens.',
        className: 'min-w-0 flex-wrap'
      }}>
        <Icon color="text" name="globe" size="s" />
        {device.addresses.map((address) => (
          <span key={address} className="break-all font-mono text-xs text-text-muted">{address}</span>
        ))}
      </Container.Stack>
    </Container.Stack>
  );
}

function DeviceTable({ assignmentDisabled, hosts, onAssign, onOpenDevice, readOnly = false, rows }: {
  assignmentDisabled: boolean;
  hosts: readonly ProjectCliHost[];
  onAssign(device: TailscaleInventoryDevice, request: TailnetHostAssignmentDraft): Promise<unknown>;
  onOpenDevice(kind: HostsDeviceKind, id: string): void;
  readOnly?: boolean;
  rows: readonly TailnetDeviceRow[];
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [assignmentDevice, setAssignmentDevice] = useState<TailscaleInventoryDevice>();
  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  const columns: DataTableColumn<TailnetDeviceRow>[] = [
    { id: 'device', header: 'Device', width: '48%', cell: (row) => <DeviceName onOpen={() => onOpenDevice('tailnet', row.id)} row={row} /> },
    {
      id: 'os', header: 'Operating system', width: '22%', hideOnMobile: true,
      cell: (row) => <OperatingSystem value={row.operatingSystem} />
    },
    {
      id: 'status', header: 'Status', width: '18%',
      cell: (row) => <StatusChip label={row.statusLabel} status={row.status} />
    },
    {
      id: 'action', header: '', width: '6rem',
      cell: (row) => (
        <Button
          accessibilityLabel={readOnly
            ? `${expanded.has(row.id) ? 'Hide' : 'Show'} details for ${row.name}`
            : `${row.device.hostId ? 'Move' : 'Assign'} ${row.name} ${row.device.hostId ? 'to another Host' : 'to a Host'}`}
          disabled={!readOnly && assignmentDisabled}
          icon={readOnly ? (expanded.has(row.id) ? 'chevron-down' : 'chevron-right') : row.device.hostId ? 'arrow-right' : 'plus'}
          label={readOnly ? 'Details' : row.device.hostId ? 'Move' : 'Assign'}
          onPress={() => readOnly ? toggle(row.id) : setAssignmentDevice(row.device)}
          variant="ghost"
        />
      )
    }
  ];
  return (
    <>
      <DataTable
        caption="Tailnet devices"
        columns={columns}
        details={readOnly ? (row) => expanded.has(row.id) ? <DeviceDetails device={row.device} /> : null : undefined}
        rowKey={(row) => row.id}
        rows={rows}
      />
      <TailnetHostAssignmentDrawer
        device={assignmentDevice}
        disabled={assignmentDisabled}
        hosts={hosts}
        onAssign={onAssign}
        onClose={() => setAssignmentDevice(undefined)}
      />
    </>
  );
}

function HostGroupView({ assignmentDisabled, group, hosts, onAssign, onOpenDevice }: {
  assignmentDisabled: boolean;
  group: ComputeHostGroup;
  hosts: readonly ProjectCliHost[];
  onAssign(device: TailscaleInventoryDevice, request: TailnetHostAssignmentDraft): Promise<unknown>;
  onOpenDevice(kind: HostsDeviceKind, id: string): void;
}) {
  return (
    <CollapsibleSection
      id={`compute-host-${group.id}`}
      insetContent
      summary={group.devices.length > 1 ? group.devices.length : undefined}
      title={group.name}
    >
      <DeviceTable assignmentDisabled={assignmentDisabled} hosts={hosts} onAssign={onAssign} onOpenDevice={onOpenDevice} rows={group.devices} />
    </CollapsibleSection>
  );
}

function CodespacesTable({ onOpenDevice, rows }: {
  onOpenDevice(kind: HostsDeviceKind, id: string): void;
  rows: readonly CodespaceRow[];
}) {
  const columns: DataTableColumn<CodespaceRow>[] = [
    {
      id: 'codespace', header: 'Codespace', width: '70%', cell: (row) => (
        <button
          type="button"
          onClick={() => onOpenDevice('codespace', row.id)}
          className="flex w-full min-w-0 items-center overflow-hidden rounded-md text-left outline-none transition hover:text-accent focus-visible:ring-2 focus-visible:ring-accent"
        >
          <span className="truncate font-medium text-text">{row.name}</span>
        </button>
      )
    },
    {
      id: 'os', header: 'Operating system', width: '30%',
      cell: (row) => <OperatingSystem value={row.operatingSystem} />
    }
  ];
  return <DataTable caption="GitHub Codespaces" columns={columns} rowKey={(row) => row.id} rows={rows} />;
}

function EmptySection({ text }: { text: string }) {
  return <p className="px-3 py-3 text-xs text-text-muted">{text}</p>;
}

export interface MachinesPageProps {
  computeInventory?: ProjectCliComputeInventory;
  inventoryStatus: SettingsMachineGroupsStatus;
  localSimulation: boolean;
  loadError: string;
  onRefresh(): Promise<unknown>;
}

export function MachinesPage({ computeInventory, inventoryStatus, localSimulation, loadError, onRefresh }: MachinesPageProps) {
  const [query, setQuery] = useState('');
  const [sectionFilter, setSectionFilter] = useState<ComputeHostSectionFilter>('all');
  const [sortOrder, setSortOrder] = useState<ComputeHostSortOrder>('online');
  const [statusFilter, setStatusFilter] = useState<ComputeHostStatusFilter>('all');
  const [selectedDevice, setSelectedDevice] = useState<HostsDeviceRoute | undefined>(() =>
    typeof window === 'undefined' ? undefined : parseHostsDeviceRoute(window.location.pathname)
  );
  const onRefreshRef = useRef(onRefresh);
  const tailnet = useTailnetComputeInventory(onRefresh);
  const tailnetDevices = tailnet.result?.devices ?? [];
  const sourceInventory = computeInventory ?? emptyComputeInventory();
  const inventory = useMemo(
    () => buildComputeHostInventory(sourceInventory, tailnetDevices),
    [sourceInventory, tailnetDevices]
  );
  const assignableHosts = useMemo(
    () => inventory.hosts.flatMap(({ host }) => host ? [host] : []),
    [inventory.hosts]
  );
  const visible = useMemo(() => sortComputeHostInventory(filterComputeHostInventory(inventory, {
    query, section: sectionFilter, status: statusFilter
  }), sortOrder), [inventory, query, sectionFilter, sortOrder, statusFilter]);
  const isStale = Boolean(computeInventory && isComputeInventoryStale(computeInventory.checkedAt));
  const hasInventory = countVisibleComputeHostInventory(inventory) > 0;
  const visibleCount = countVisibleComputeHostInventory(visible);
  const blockingLoading = !hasInventory && (inventoryStatus === 'loading' || tailnet.status === 'loading');
  const blockingError = !hasInventory && inventoryStatus === 'error' && tailnet.status === 'error';
  const connectionState = tailnet.result?.provider.connectionState;
  const providerRefreshState = tailnet.result?.provider.refreshState;
  const assignmentDisabled = localSimulation || tailnet.status === 'error' ||
    !['configured', 'connected', 'legacy'].includes(connectionState ?? '') ||
    !['available', 'partial'].includes(providerRefreshState ?? '');
  const checkedAt = [computeInventory?.checkedAt, ...tailnetDevices.map((device) => device.network.checkedAt)]
    .filter((value): value is string => Boolean(value)).sort().at(-1);
  const showCodespaces = sectionFilter === 'all' || sectionFilter === 'codespaces';
  const showHosts = sectionFilter === 'all' || sectionFilter === 'hosts';
  const showAvailable = sectionFilter === 'all' || sectionFilter === 'available';

  useEffect(() => {
    const syncRoute = () => setSelectedDevice(parseHostsDeviceRoute(window.location.pathname));
    window.addEventListener('popstate', syncRoute);
    return () => window.removeEventListener('popstate', syncRoute);
  }, []);

  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  useEffect(() => {
    if (!selectedDevice) return;
    const refresh = () => void onRefreshRef.current();
    refresh();
    const interval = window.setInterval(refresh, 10_000);
    return () => window.clearInterval(interval);
  }, [selectedDevice?.id, selectedDevice?.kind]);

  const selectedDescriptor = useMemo(() => {
    if (!selectedDevice) return undefined;
    if (selectedDevice.kind === 'codespace') {
      const row = inventory.codespaces.find(({ id }) => id === selectedDevice.id);
      return row ? codespaceDeviceDescriptor(row) : undefined;
    }
    const devices = [
      ...inventory.available,
      ...inventory.excluded,
      ...inventory.hosts.flatMap(({ devices: hostDevices }) => hostDevices)
    ];
    const row = devices.find(({ id }) => id === selectedDevice.id);
    return row ? tailnetDeviceDescriptor(row, sourceInventory) : undefined;
  }, [inventory, selectedDevice, sourceInventory]);

  function openDevice(kind: HostsDeviceKind, id: string) {
    const next = { id, kind } satisfies HostsDeviceRoute;
    window.history.pushState(null, '', hostsDeviceRoute(kind, id));
    setSelectedDevice(next);
  }

  function closeDevice() {
    window.history.pushState(null, '', '/settings');
    setSelectedDevice(undefined);
  }

  async function refreshAll() {
    await Promise.allSettled([onRefresh(), tailnet.refresh(true)]);
  }

  if (selectedDescriptor) {
    return <HostsDeviceWorkspace device={selectedDescriptor} onBack={closeDevice} />;
  }

  if (selectedDevice && blockingLoading) {
    return <div className="flex min-h-64 items-center justify-center gap-3 text-text-muted"><Spinner size="s" /><span>Loading device…</span></div>;
  }

  if (selectedDevice && hasInventory) {
    return (
      <div className="grid min-h-64 place-items-center gap-3 px-6 text-center">
        <div>
          <Text text="Device not found" variant="heading" level={1} size="m" />
          <p className="mt-2 text-sm text-text-muted">This device is no longer present in the current inventory.</p>
        </div>
        <Button icon="arrow-left" label="Back to Hosts" onPress={closeDevice} variant="secondary" />
      </div>
    );
  }

  return (
    <Container.Stack as="section" fullWidth gap={0} customize={{
      reason: 'Fill the settings content region without adding a framed page surface.', className: 'h-full min-h-0'
    }}>
      <header className="shrink-0 border-b border-border/80 pb-2">
        <Container.Stack direction="horizontal" align="center" gap={2}>
          <Icon color="accent" name="box" size="m" />
          <span className="[&>h1]:mb-0"><Text text="Hosts" variant="heading" level={1} size="m" /></span>
        </Container.Stack>
        <LegacyConnectorCleanup onChanged={onRefresh} />
      </header>

      <Container.Stack direction="horizontal" align="center" gap={1} padding={1} customize={{
        reason: 'Keep search, filters, sorting, and refresh in one compact responsive toolbar.',
        className: 'shrink-0 flex-wrap border-b border-border/80'
      }}>
        <div className="min-w-40 flex-1">
          <Input accessibilityLabel="Search Hosts inventory" fullWidth onValueChange={setQuery} placeholder="Search Hosts" size="sm" type="search" value={query} />
        </div>
        <div className="w-36 shrink-0"><Select accessibilityLabel="Filter by status" fullWidth onValueChange={(value) => setStatusFilter(value as ComputeHostStatusFilter)} options={statusFilterOptions} size="sm" value={statusFilter} /></div>
        <div className="w-40 shrink-0"><Select accessibilityLabel="Filter by section" fullWidth onValueChange={(value) => setSectionFilter(value as ComputeHostSectionFilter)} options={sectionFilterOptions} size="sm" value={sectionFilter} /></div>
        <div className="w-32 shrink-0"><Select accessibilityLabel="Sort Hosts inventory" fullWidth onValueChange={(value) => setSortOrder(value as ComputeHostSortOrder)} options={sortOptions} size="sm" value={sortOrder} /></div>
        <Button accessibilityLabel="Refresh Hosts inventory" disabled={inventoryStatus === 'refreshing' || tailnet.status === 'refreshing'} icon="refresh" onPress={() => void refreshAll()} variant="icon" />
      </Container.Stack>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {loadError && (computeInventory || tailnet.result) ? <p role="alert" className="border-y border-warning/30 px-3 py-2 text-xs text-warning">{loadError} Showing the last known Hosts data.</p> : null}
        {tailnet.error && (tailnet.result || computeInventory) ? <p role="alert" className="border-y border-warning/30 px-3 py-2 text-xs text-warning">{tailnet.error} Showing the last known Tailnet devices.</p> : null}
        {providerRefreshState === 'partial' ? <p role="status" className="border-y border-warning/30 px-3 py-2 text-xs text-warning">Tailnet returned a partial inventory. Available device evidence remains visible.</p> : null}
        {tailnet.result ? <TailnetProviderStatus provider={tailnet.result.provider} /> : null}
        {isStale ? <p role="status" className="border-y border-accent/30 px-3 py-2 text-xs text-accent">Hosts data may be out of date. Refresh to check again.</p> : null}

        {blockingLoading ? (
          <div className="flex min-h-48 items-center justify-center gap-3 text-text-muted"><Spinner size="s" /><span>Loading inventory…</span></div>
        ) : blockingError ? (
          <div className="grid min-h-48 place-items-center gap-3 px-6 text-center"><p className="max-w-md text-sm text-text-muted">Hosts and Tailnet inventory are temporarily unavailable.</p><Button label="Try again" onPress={() => void refreshAll()} variant="secondary" /></div>
        ) : !hasInventory ? (
          <div className="grid min-h-48 place-items-center px-6 text-center text-sm text-text-muted">No Hosts or devices were reported.</div>
        ) : (
          <Container.Stack gap={5} padding={3} customize={{
            reason: 'Present one compact hierarchy of independently collapsible Compute sections.',
            className: 'min-w-0'
          }}>
            {showCodespaces ? (
              <CollapsibleSection insetContent separated id="compute-codespaces" summary={visible.codespaces.length} title="GitHub Codespaces">
                {visible.codespaces.length > 0 ? <CodespacesTable onOpenDevice={openDevice} rows={visible.codespaces} /> : <EmptySection text="No Codespaces match the current filters." />}
              </CollapsibleSection>
            ) : null}
            {showHosts ? (
              <CollapsibleSection insetContent separated id="compute-hosts" summary={visible.hosts.length} title="Hosts">
                {visible.hosts.length > 0 ? visible.hosts.map((group) => (
                  <HostGroupView key={group.id} assignmentDisabled={assignmentDisabled} group={group} hosts={assignableHosts} onAssign={tailnet.assignHost} onOpenDevice={openDevice} />
                )) : <EmptySection text="No Hosts match the current filters. Assign an available device to create one." />}
              </CollapsibleSection>
            ) : null}
            {showAvailable ? (
              <CollapsibleSection insetContent separated id="compute-available-devices" summary={visible.available.length} title="Available Tailnet devices">
                {visible.available.length > 0 ? <DeviceTable assignmentDisabled={assignmentDisabled} hosts={assignableHosts} onAssign={tailnet.assignHost} onOpenDevice={openDevice} rows={visible.available} /> : <EmptySection text="No available devices match the current filters." />}
              </CollapsibleSection>
            ) : null}
            {showAvailable && inventory.excluded.length > 0 ? (
              <CollapsibleSection insetContent separated defaultExpanded={false} id="compute-excluded-devices" summary={visible.excluded.length} title="Excluded Tailnet devices">
                {visible.excluded.length > 0 ? <DeviceTable assignmentDisabled hosts={assignableHosts} onAssign={tailnet.assignHost} onOpenDevice={openDevice} readOnly rows={visible.excluded} /> : <EmptySection text="No excluded devices match the current filters." />}
              </CollapsibleSection>
            ) : null}
            {visibleCount === 0 ? <div className="grid min-h-24 place-items-center px-6 text-center text-sm text-text-muted">No resources match this search or filter.</div> : null}
          </Container.Stack>
        )}
        <Container.Stack as="footer" direction="horizontal" align="center" justify="between" gap={2} padding={3} customize={{
          reason: 'Keep totals in document flow so they never cover inventory rows.',
          className: 'flex-wrap border-t border-border/80'
        }}>
          <Text color="muted" size="s" text={`${visible.hosts.length} Hosts · ${visible.available.length} available · ${visible.codespaces.length} Codespaces · ${visible.excluded.length} excluded`} />
          {checkedAt ? <span className="hidden sm:block"><Text color="muted" size="s" text={`Updated ${new Date(checkedAt).toLocaleTimeString()}`} /></span> : null}
        </Container.Stack>
      </div>
    </Container.Stack>
  );
}
