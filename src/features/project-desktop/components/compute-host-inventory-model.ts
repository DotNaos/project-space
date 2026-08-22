import { matchesFuzzyQuery } from '../../../lib/fuzzy-search';
import type {
  ProjectCliComputeInventory,
  ProjectCliEnvironmentInstance,
  ProjectCliHost
} from '../../../shared/compute-inventory-cli-api';
import type { TailscaleInventoryDevice } from '../../../shared/tailscale-inventory-api';
import {
  isSupportedTailnetComputeDevice,
  tailnetMachineName
} from './machines-page-model';

export type ComputeHostStatusFilter = 'all' | 'available' | 'attention';
export type ComputeHostSectionFilter = 'all' | 'codespaces' | 'hosts' | 'available';
export type ComputeHostSortOrder = 'online' | 'name';
export type TailnetDeviceStatus = 'available' | 'attention' | 'unknown';

export interface TailnetDeviceRow {
  addresses: string[];
  device: TailscaleInventoryDevice;
  id: string;
  name: string;
  operatingSystem?: string;
  searchTerms: string[];
  status: TailnetDeviceStatus;
  statusLabel: string;
}

export interface ComputeHostGroup {
  devices: TailnetDeviceRow[];
  host?: ProjectCliHost;
  id: string;
  name: string;
  searchTerms: string[];
  status: TailnetDeviceStatus;
}

export interface CodespaceRow {
  environment: ProjectCliEnvironmentInstance;
  id: string;
  name: string;
  operatingSystem: string;
  searchTerms: string[];
}

export interface ComputeHostInventory {
  available: TailnetDeviceRow[];
  codespaces: CodespaceRow[];
  excluded: TailnetDeviceRow[];
  hosts: ComputeHostGroup[];
}

export interface ComputeHostInventoryFilter {
  query: string;
  section: ComputeHostSectionFilter;
  status: ComputeHostStatusFilter;
}

function deviceStatus(device: TailscaleInventoryDevice) {
  switch (device.network.state) {
    case 'online': return { label: 'Online', status: 'available' as const };
    case 'offline': return { label: 'Offline', status: 'attention' as const };
    case 'stale': return { label: 'Stale', status: 'attention' as const };
    default: return { label: 'Unknown', status: 'unknown' as const };
  }
}

function deviceRow(device: TailscaleInventoryDevice): TailnetDeviceRow {
  const state = deviceStatus(device);
  const name = tailnetMachineName(device);
  return {
    addresses: [...device.addresses],
    device,
    id: device.id,
    name,
    ...(device.os ? { operatingSystem: device.os } : {}),
    searchTerms: [
      name,
      device.name ?? '',
      ...device.addresses,
      device.os ?? '',
      ...device.tags,
      state.label
    ].filter(Boolean),
    status: state.status,
    statusLabel: state.label
  };
}

function hostStatus(devices: readonly TailnetDeviceRow[]): TailnetDeviceStatus {
  if (devices.some(({ status }) => status === 'available')) return 'available';
  if (devices.some(({ status }) => status === 'attention')) return 'attention';
  return 'unknown';
}

function codespaceName(environment: ProjectCliEnvironmentInstance) {
  return environment.alias.trim() || environment.name;
}

function codespaceOperatingSystem(environment: ProjectCliEnvironmentInstance) {
  const reported = environment.resources?.operatingSystem?.trim();
  return reported || 'Linux';
}

export function buildComputeHostInventory(
  inventory: ProjectCliComputeInventory,
  devices: readonly TailscaleInventoryDevice[]
): ComputeHostInventory {
  const hostsById = new Map(inventory.hosts.map((host) => [host.id, host] as const));
  const hostDevices = new Map<string, TailnetDeviceRow[]>();
  const available: TailnetDeviceRow[] = [];
  const excluded: TailnetDeviceRow[] = [];
  const seen = new Set<string>();

  for (const device of devices) {
    if (seen.has(device.id)) continue;
    seen.add(device.id);
    const row = deviceRow(device);
    if (!isSupportedTailnetComputeDevice(device)) {
      excluded.push(row);
      continue;
    }
    if (!device.hostId) {
      available.push(row);
      continue;
    }
    const assigned = hostDevices.get(device.hostId) ?? [];
    assigned.push(row);
    hostDevices.set(device.hostId, assigned);
  }

  const hosts = [...hostDevices].map(([id, assignedDevices]) => {
    const host = hostsById.get(id);
    const name = host?.name.trim() || assignedDevices[0]?.name || 'Unnamed Host';
    return {
      devices: assignedDevices,
      ...(host ? { host } : {}),
      id,
      name,
      searchTerms: [name, host?.alias ?? '', ...assignedDevices.flatMap(({ searchTerms }) => searchTerms)],
      status: hostStatus(assignedDevices)
    } satisfies ComputeHostGroup;
  });

  const codespaces = inventory.environmentInstances
    .filter(({ kind }) => kind === 'github_codespace')
    .map((environment) => {
      const name = codespaceName(environment);
      const operatingSystem = codespaceOperatingSystem(environment);
      return {
        environment,
        id: environment.id,
        name,
        operatingSystem,
        searchTerms: [name, environment.name, operatingSystem]
      } satisfies CodespaceRow;
    });

  return { available, codespaces, excluded, hosts };
}

function statusMatches(status: TailnetDeviceStatus, filter: ComputeHostStatusFilter) {
  if (filter === 'all') return true;
  if (filter === 'available') return status === 'available';
  return status !== 'available';
}

function queryMatches(terms: readonly string[], query: string) {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  if (/[-.:]/.test(normalized) || /^\d/.test(normalized)) {
    return terms.some((term) => term.toLocaleLowerCase().includes(normalized));
  }
  return matchesFuzzyQuery([...terms], query);
}

function hostNameMatches(terms: readonly string[], query: string) {
  const normalized = query.trim().toLocaleLowerCase();
  return !normalized || terms.some((term) => term.toLocaleLowerCase().includes(normalized));
}

export function filterComputeHostInventory(
  inventory: ComputeHostInventory,
  filter: ComputeHostInventoryFilter
): ComputeHostInventory {
  const includeCodespaces = filter.section === 'all' || filter.section === 'codespaces';
  const includeHosts = filter.section === 'all' || filter.section === 'hosts';
  const includeAvailable = filter.section === 'all' || filter.section === 'available';
  const filterDevices = (devices: readonly TailnetDeviceRow[]) => devices.filter((device) =>
    statusMatches(device.status, filter.status) && queryMatches(device.searchTerms, filter.query)
  );

  const hosts = includeHosts ? inventory.hosts.flatMap((host) => {
    const hostMatches = hostNameMatches(host.searchTerms.slice(0, 2), filter.query);
    const devices = host.devices.filter((device) => statusMatches(device.status, filter.status) &&
      (hostMatches || queryMatches(device.searchTerms, filter.query)));
    return devices.length > 0 ? [{ ...host, devices, status: hostStatus(devices) }] : [];
  }) : [];

  return {
    available: includeAvailable ? filterDevices(inventory.available) : [],
    codespaces: includeCodespaces && filter.status === 'all'
      ? inventory.codespaces.filter(({ searchTerms }) => queryMatches(searchTerms, filter.query))
      : [],
    excluded: includeAvailable ? filterDevices(inventory.excluded) : [],
    hosts,
  };
}

const statusOrder: Record<TailnetDeviceStatus, number> = {
  available: 0,
  unknown: 1,
  attention: 2
};

function sortDevices(devices: readonly TailnetDeviceRow[], sort: ComputeHostSortOrder) {
  return [...devices].sort((left, right) => {
    if (sort === 'online') {
      const difference = statusOrder[left.status] - statusOrder[right.status];
      if (difference !== 0) return difference;
    }
    return left.name.localeCompare(right.name);
  });
}

export function sortComputeHostInventory(
  inventory: ComputeHostInventory,
  sort: ComputeHostSortOrder
): ComputeHostInventory {
  return {
    available: sortDevices(inventory.available, sort),
    codespaces: [...inventory.codespaces].sort((left, right) => left.name.localeCompare(right.name)),
    excluded: sortDevices(inventory.excluded, sort),
    hosts: inventory.hosts
      .map((host) => ({ ...host, devices: sortDevices(host.devices, sort) }))
      .sort((left, right) => {
        if (sort === 'online') {
          const difference = statusOrder[left.status] - statusOrder[right.status];
          if (difference !== 0) return difference;
        }
        return left.name.localeCompare(right.name);
      })
  };
}

export function countVisibleComputeHostInventory(inventory: ComputeHostInventory) {
  return inventory.codespaces.length + inventory.available.length + inventory.excluded.length +
    inventory.hosts.reduce((sum, host) => sum + host.devices.length, 0);
}
