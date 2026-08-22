import { matchesFuzzyQuery } from '../../../lib/fuzzy-search';
import type {
  ComputeEnvironmentKind,
  ComputePlatformKind
} from '../../../shared/compute-environment-api';
import type {
  ProjectCliAccessRoute,
  ProjectCliComputeInventory,
  ProjectCliEnvironmentAccessSummary,
  ProjectCliEnvironmentInstance,
  ProjectCliHost,
  ProjectCliHostCapabilitySummary,
  ProjectCliInventoryResourceSummary,
  ProjectCliPlatform,
  ProjectCliWorkspaceSummary
} from '../../../shared/compute-inventory-cli-api';
import type { TailscaleInventoryDevice } from '../../../shared/tailscale-inventory-api';

export const machineFilters = ['all', 'available', 'attention'] as const;
export type MachineFilter = (typeof machineFilters)[number];
export const computeResourceFilters = ['all', 'environment', 'host', 'tailnet'] as const;
export type ComputeResourceFilter = (typeof computeResourceFilters)[number];
export const computeSortOrders = ['online', 'name'] as const;
export type ComputeSortOrder = (typeof computeSortOrders)[number];

export const computeEnvironmentKindLabels: Record<ComputeEnvironmentKind, string> = {
  cloud_sandbox: 'Cloud sandbox',
  devbox: 'Devbox',
  docker: 'Docker',
  github_codespace: 'GitHub Codespace',
  kubernetes_workload: 'Kubernetes workload',
  native_linux: 'Linux',
  native_macos: 'macOS',
  native_windows: 'Windows',
  other: 'Environment',
  virtual_machine: 'Virtual machine',
  wsl: 'WSL'
};

export const computePlatformKindLabels: Record<ComputePlatformKind, string> = {
  cloud_sandbox: 'Cloud sandbox',
  github_codespaces: 'GitHub Codespaces',
  kubernetes: 'Kubernetes',
  local: 'Local',
  other: 'Platform',
  virtualization: 'Virtualization'
};

export type ComputeRowKind = 'environment' | 'host' | 'tailnet';
export type ComputeRowRelationship = 'dual-boot' | 'nested';
export type ComputeRowStatus = 'available' | 'attention' | 'unknown';

export interface ComputeRow {
  accessSummary?: ProjectCliEnvironmentAccessSummary;
  baseSearchTerms: string[];
  baseStatus?: ComputeRowStatus;
  depth: number;
  environment?: ProjectCliEnvironmentInstance;
  environmentKind?: ComputeEnvironmentKind;
  environmentStatus?: string;
  host?: ProjectCliHost;
  hostCapabilities?: ProjectCliHostCapabilitySummary;
  hostResolutionLabel?: string;
  hostStatus?: string;
  id: string;
  isAvailable: boolean;
  kind: ComputeRowKind;
  name: string;
  relationship?: ComputeRowRelationship;
  resourceSource?: string;
  resourcesSummary?: string;
  searchTerms: string[];
  status: ComputeRowStatus;
  tailnetDevice?: TailscaleInventoryDevice;
  tailnetDevices?: TailscaleInventoryDevice[];
  workspaces: ProjectCliWorkspaceSummary[];
}

export interface ComputePlatformSection {
  availableCount: number;
  environmentCount: number;
  hostCount: number;
  id: string;
  name: string;
  platformKindLabel: string;
  rows: ComputeRow[];
  tailnetCount: number;
  workspaceCount: number;
}

function summarizeRows(rows: readonly ComputeRow[]) {
  return {
    availableCount: rows.filter((row) => row.isAvailable).length,
    environmentCount: rows.filter((row) => row.kind === 'environment').length,
    hostCount: rows.filter((row) => row.kind === 'host').length,
    tailnetCount: rows.reduce((sum, row) => sum + (row.tailnetDevices?.length ?? (row.tailnetDevice ? 1 : 0)), 0),
    workspaceCount: rows.reduce((sum, row) => sum + row.workspaces.length, 0)
  };
}

const staleInventoryThresholdMs = 15 * 60 * 1_000;

function formatBytes(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1_024 && unit < units.length - 1) {
    amount /= 1_024;
    unit += 1;
  }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

function resourcesSummaryText(resources: ProjectCliInventoryResourceSummary | undefined) {
  if (!resources) return undefined;
  return [
    `${resources.cpuCores} CPU`,
    formatBytes(resources.memoryLimitBytes ?? resources.memoryTotalBytes),
    formatBytes(resources.storageTotalBytes),
    resources.gpu?.length ? `${resources.gpu.length} GPU` : undefined
  ].filter((part): part is string => Boolean(part)).join(' · ');
}

function resourceSourceLabel(
  resources: ProjectCliInventoryResourceSummary | undefined,
  hostdState?: ProjectCliEnvironmentInstance['hostd']['state']
) {
  if (hostdState === 'stale') return 'Stale';
  switch (resources?.source) {
    case 'configured':
    case 'connector': return 'SSH snapshot';
    case 'hostd': return 'project-hostd';
    case 'provider': return 'Provider';
    default: return undefined;
  }
}

function controlledRoutes(routes: readonly ProjectCliAccessRoute[]) {
  return routes.filter((route) => route.type !== 'connector');
}

function tailnetStatus(device: TailscaleInventoryDevice) {
  switch (device.network.state) {
    case 'online': return { label: 'Online', status: 'available' as const };
    case 'offline': return { label: 'Offline', status: 'attention' as const };
    case 'stale': return { label: 'Stale', status: 'attention' as const };
    default: return { label: 'Connectivity not reported', status: 'unknown' as const };
  }
}

const tailnetFqdnSuffix = /\.tail[a-z0-9-]+\.ts\.net\.?$/i;

export function tailnetMachineName(device: Pick<TailscaleInventoryDevice, 'id' | 'name'>) {
  const reportedName = device.name?.trim();
  if (!reportedName) return 'Unnamed Tailnet device';
  return reportedName.replace(tailnetFqdnSuffix, '') || reportedName;
}

const supportedTailnetOperatingSystems = new Set(['darwin', 'linux', 'macos', 'windows']);

export function isSupportedTailnetComputeDevice(
  device: Pick<TailscaleInventoryDevice, 'os'>
) {
  const operatingSystem = device.os?.trim().toLocaleLowerCase().replace(/[\s_-]+/g, '');
  return operatingSystem ? supportedTailnetOperatingSystems.has(operatingSystem) : false;
}

function tailnetGroupStatus(devices: readonly TailscaleInventoryDevice[]) {
  if (devices.some((device) => device.network.state === 'online')) {
    return { label: 'Online', status: 'available' as const };
  }
  if (devices.some((device) => device.network.state === 'offline')) {
    return { label: 'Offline', status: 'attention' as const };
  }
  if (devices.some((device) => device.network.state === 'stale')) {
    return { label: 'Stale', status: 'attention' as const };
  }
  return { label: 'Connectivity not reported', status: 'unknown' as const };
}

function environmentStatus(instance: ProjectCliEnvironmentInstance) {
  if (instance.accessSummary) {
    if (instance.accessSummary.route === 'available') {
      return { label: 'Access ready', status: 'available' as const };
    }
    if (instance.accessSummary.route === 'stale') {
      return { label: 'Access stale', status: 'attention' as const };
    }
    if (instance.accessSummary.route === 'unavailable') {
      return { label: 'Access unavailable', status: 'attention' as const };
    }
  }
  const states = controlledRoutes(instance.accessRoutes).map((route) => route.state);
  if (states.includes('ready')) return { label: 'Access ready', status: 'available' as const };
  if (states.includes('stale')) return { label: 'Access stale', status: 'attention' as const };
  if (states.some((state) => state === 'unavailable' || state === 'policy_blocked')) {
    return { label: 'Access unavailable', status: 'attention' as const };
  }
  if (states.includes('unverified')) return { label: 'Access not verified', status: 'attention' as const };
  return { label: 'Access not reported', status: 'unknown' as const };
}

function hostStatus(host: ProjectCliHost) {
  switch (host.capabilities.state) {
    case 'available': return { label: 'Host reachable', status: 'available' as const };
    case 'unavailable': return { label: 'Host unavailable', status: 'attention' as const };
    default: return { label: 'Host state not reported', status: 'unknown' as const };
  }
}

function hostAssociationLabel(instance: ProjectCliEnvironmentInstance) {
  switch (instance.hostResolution) {
    case 'verified': return 'Verified host';
    case 'manual': return 'Assigned host';
    case 'conflict': return 'Host needs review';
    case 'unresolved': return 'No Host';
    case 'not_applicable': return 'Provider managed';
  }
}

function environmentName(instance: ProjectCliEnvironmentInstance) {
  return instance.alias.trim() || instance.name;
}

function canonicalMachineKey(value: string) {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(tailnetFqdnSuffix, '')
    .replace(/-tail[a-z0-9-]+-ts-net$/i, '')
    .replace(/[\s._-]+/g, '-');
}

function isLegacyCodespaceHost(host: ProjectCliHost) {
  return canonicalMachineKey(host.alias).startsWith('github-codespace-') ||
    canonicalMachineKey(host.name).startsWith('github-codespace-');
}

function environmentRow(
  instance: ProjectCliEnvironmentInstance,
  depth: number,
  relationship: ComputeRowRelationship | undefined,
  instancesById: ReadonlyMap<string, ProjectCliEnvironmentInstance>,
  tailnetByEnvironment: ReadonlyMap<string, TailscaleInventoryDevice[]>
): ComputeRow {
  const tailnetDevices = tailnetByEnvironment.get(instance.id) ?? [];
  const tailnetDevice = tailnetDevices[0];
  const environmentState = environmentStatus(instance);
  const tailnetState = tailnetDevices.length > 0 ? tailnetGroupStatus(tailnetDevices) : undefined;
  const state = tailnetState?.status === 'available'
    ? tailnetState
    : environmentState.status !== 'unknown'
      ? environmentState
      : tailnetState ?? environmentState;
  const workspaces = instance.workspaces;
  const environmentLabel = environmentName(instance);
  const name = tailnetDevice ? tailnetMachineName(tailnetDevice) : environmentLabel;
  const baseSearchTerms = [
    name,
    environmentLabel,
    instance.name,
    computeEnvironmentKindLabels[instance.kind],
    hostAssociationLabel(instance),
    ...workspaces.flatMap((workspace) => [workspace.name, workspace.repository ?? '']),
    ...(instance.parentEnvironmentInstanceId
      ? [instancesById.get(instance.parentEnvironmentInstanceId)?.alias ?? '']
      : [])
  ].filter(Boolean);
  return {
    accessSummary: instance.accessSummary,
    baseSearchTerms,
    baseStatus: environmentState.status,
    depth,
    environment: instance,
    environmentKind: instance.kind,
    environmentStatus: environmentState.label,
    hostResolutionLabel: hostAssociationLabel(instance),
    id: instance.id,
    isAvailable: state.status === 'available',
    kind: 'environment',
    name,
    relationship,
    resourceSource: resourceSourceLabel(instance.resources, instance.hostd.state),
    resourcesSummary: resourcesSummaryText(instance.resources),
    searchTerms: [
      ...baseSearchTerms,
      ...tailnetDevices.flatMap((device) => [
        device.name ?? '', ...device.addresses, device.classification, device.network.state
      ])
    ].filter(Boolean),
    status: state.status,
    ...(tailnetDevice ? { tailnetDevice, tailnetDevices } : {}),
    workspaces
  };
}

function pushEnvironmentRows(
  instances: readonly ProjectCliEnvironmentInstance[],
  childrenByParent: ReadonlyMap<string, ProjectCliEnvironmentInstance[]>,
  depth: number,
  relationship: ComputeRowRelationship | undefined,
  instancesById: ReadonlyMap<string, ProjectCliEnvironmentInstance>,
  tailnetByEnvironment: ReadonlyMap<string, TailscaleInventoryDevice[]>,
  rows: ComputeRow[]
) {
  for (const instance of instances) {
    rows.push(environmentRow(instance, depth, relationship, instancesById, tailnetByEnvironment));
    pushEnvironmentRows(
      childrenByParent.get(instance.id) ?? [],
      childrenByParent,
      depth + 1,
      'nested',
      instancesById,
      tailnetByEnvironment,
      rows
    );
  }
}

function pushHostRows(
  host: ProjectCliHost,
  instances: readonly ProjectCliEnvironmentInstance[],
  childrenByParent: ReadonlyMap<string, ProjectCliEnvironmentInstance[]>,
  instancesById: ReadonlyMap<string, ProjectCliEnvironmentInstance>,
  tailnetByEnvironment: ReadonlyMap<string, TailscaleInventoryDevice[]>,
  rows: ComputeRow[]
) {
  const state = hostStatus(host);
  const hostRow: ComputeRow = {
    baseSearchTerms: [host.name, host.alias],
    baseStatus: state.status,
    depth: 0,
    host,
    hostCapabilities: host.capabilities.summary,
    hostStatus: state.label,
    id: host.id,
    isAvailable: state.status === 'available',
    kind: 'host',
    name: host.name,
    resourceSource: resourceSourceLabel(host.resources),
    resourcesSummary: resourcesSummaryText(host.resources),
    searchTerms: [host.name, host.alias],
    status: state.status,
    workspaces: []
  };
  const roots = instances.filter((instance) => !instance.parentEnvironmentInstanceId);
  const exclusiveRoots = roots.filter((instance) => instance.resourceMode === 'exclusive');
  const relationship = exclusiveRoots.length > 1 ? 'dual-boot' as const : undefined;
  const environmentRows: ComputeRow[] = [];
  pushEnvironmentRows(
    roots,
    childrenByParent,
    1,
    relationship,
    instancesById,
    tailnetByEnvironment,
    environmentRows
  );

  const rootEnvironment = environmentRows[0];
  const canMergeMachine = roots.length === 1 && rootEnvironment &&
    canonicalMachineKey(host.name) === canonicalMachineKey(rootEnvironment.name);
  if (canMergeMachine) {
    const hostTerms = [host.name, host.alias];
    Object.assign(rootEnvironment, {
      baseSearchTerms: [...new Set([...rootEnvironment.baseSearchTerms, ...hostTerms])],
      depth: 0,
      host,
      hostCapabilities: host.capabilities.summary,
      hostStatus: state.label,
      searchTerms: [...new Set([...rootEnvironment.searchTerms, ...hostTerms])]
    });
    for (const row of environmentRows.slice(1)) row.depth -= 1;
    rows.push(...environmentRows);
    return;
  }

  rows.push(hostRow, ...environmentRows);
}

function tailnetRow(devices: TailscaleInventoryDevice[]): ComputeRow {
  const state = tailnetGroupStatus(devices);
  const primary = devices[0]!;
  const name = tailnetMachineName(primary);
  return {
    baseSearchTerms: [name],
    depth: 0,
    id: `tailnet-machine:${name.toLocaleLowerCase()}`,
    isAvailable: state.status === 'available',
    kind: 'tailnet',
    name,
    searchTerms: [name, ...devices.flatMap((device) => [device.name ?? '', ...device.addresses,
      device.os ?? '', ...device.tags, device.classification, device.network.state])].filter(Boolean),
    status: state.status,
    tailnetDevice: primary,
    tailnetDevices: devices,
    workspaces: []
  };
}

function groupStandaloneTailnetDevices(devices: readonly TailscaleInventoryDevice[]) {
  const groups = new Map<string, TailscaleInventoryDevice[]>();
  for (const device of devices) {
    const key = tailnetMachineName(device).toLocaleLowerCase();
    const group = groups.get(key) ?? [];
    group.push(device);
    groups.set(key, group);
  }
  return [...groups.values()].map((devices) => devices.sort((left, right) => {
    const stateOrder = { online: 0, offline: 1, stale: 2, unknown: 3 } as const;
    return stateOrder[left.network.state] - stateOrder[right.network.state] || left.id.localeCompare(right.id);
  }));
}

function uniqueTailnetDevices(devices: readonly TailscaleInventoryDevice[]) {
  const seen = new Set<string>();
  return devices.filter((device) => {
    if (seen.has(device.id)) return false;
    seen.add(device.id);
    return true;
  });
}

export function computePlatformSections(
  inventory: ProjectCliComputeInventory,
  tailnetDevices: readonly TailscaleInventoryDevice[] = []
) {
  const uniqueDevices = uniqueTailnetDevices(tailnetDevices);
  const instancesById = new Map(inventory.environmentInstances.map((instance) => [instance.id, instance] as const));
  const tailnetByEnvironment = new Map<string, TailscaleInventoryDevice[]>();
  for (const device of uniqueDevices) {
    if (!device.environmentId || !instancesById.has(device.environmentId)) continue;
    const devices = tailnetByEnvironment.get(device.environmentId) ?? [];
    devices.push(device);
    tailnetByEnvironment.set(device.environmentId, devices);
  }
  const attachedTailnetIds = new Set(
    [...tailnetByEnvironment.values()].flatMap((devices) => devices.map((device) => device.id))
  );
  const standaloneTailnet = uniqueDevices.filter((device) => !attachedTailnetIds.has(device.id));
  const standaloneTailnetGroups = groupStandaloneTailnetDevices(standaloneTailnet);
  const localPlatform = inventory.platforms.find((platform) => platform.kind === 'local');
  const platforms: ProjectCliPlatform[] = localPlatform || standaloneTailnet.length === 0
    ? inventory.platforms
    : [...inventory.platforms, {
        alias: 'tailnet', id: 'tailnet', kind: 'local', name: 'Local & self-hosted'
      }];
  const localPlatformId = localPlatform?.id ?? (standaloneTailnet.length > 0 ? 'tailnet' : undefined);
  const childrenByParent = new Map<string, ProjectCliEnvironmentInstance[]>();
  for (const instance of inventory.environmentInstances) {
    if (!instance.parentEnvironmentInstanceId) continue;
    const children = childrenByParent.get(instance.parentEnvironmentInstanceId) ?? [];
    children.push(instance);
    childrenByParent.set(instance.parentEnvironmentInstanceId, children);
  }
  for (const children of childrenByParent.values()) {
    children.sort((left, right) => environmentName(left).localeCompare(environmentName(right)));
  }

  const sections = platforms.map((platform) => {
    const platformInstances = inventory.environmentInstances.filter((instance) => instance.platformId === platform.id);
    const platformHosts = inventory.hosts.filter((host) => host.platformId === platform.id);
    const rows: ComputeRow[] = [];
    for (const host of platformHosts.filter((candidate) => !isLegacyCodespaceHost(candidate))) {
      pushHostRows(
        host,
        platformInstances.filter((instance) => instance.hostId === host.id),
        childrenByParent,
        instancesById,
        tailnetByEnvironment,
        rows
      );
    }
    pushEnvironmentRows(
      platformInstances.filter((instance) => !instance.hostId && !instance.parentEnvironmentInstanceId),
      childrenByParent,
      0,
      undefined,
      instancesById,
      tailnetByEnvironment,
      rows
    );
    if (platform.id === localPlatformId) rows.push(...standaloneTailnetGroups.map(tailnetRow));
    return {
      ...summarizeRows(rows),
      id: platform.id,
      name: platform.name,
      platformKindLabel: computePlatformKindLabels[platform.kind],
      rows
    } satisfies ComputePlatformSection;
  }).filter((section) => section.rows.length > 0);
  const merged = new Map<string, ComputePlatformSection>();
  for (const section of sections) {
    const key = `${section.platformKindLabel}:${section.name}`.toLocaleLowerCase();
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, section);
      continue;
    }
    const rows = [...existing.rows, ...section.rows];
    merged.set(key, { ...existing, ...summarizeRows(rows), rows });
  }
  return [...merged.values()];
}

export function filterComputePlatformSections(
  sections: readonly ComputePlatformSection[],
  query: string,
  filter: MachineFilter,
  resourceFilter: ComputeResourceFilter = 'all'
) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const requiresLiteralMatch = /[.:]/.test(normalizedQuery) || /^\d/.test(normalizedQuery);
  function termsMatch(terms: readonly string[]) {
    if (!normalizedQuery) return true;
    if (requiresLiteralMatch) {
      return terms.some((term) => term.toLocaleLowerCase().includes(normalizedQuery));
    }
    return matchesFuzzyQuery([...terms], query);
  }
  function statusMatches(status: ComputeRowStatus | undefined) {
    if (filter === 'all') return true;
    if (filter === 'available') return status === 'available';
    return status !== 'available';
  }
  function tailnetDeviceMatches(device: TailscaleInventoryDevice) {
    const status = tailnetStatus(device).status;
    if (!statusMatches(status)) return false;
    return termsMatch([
      device.name ?? '',
      ...device.addresses,
      device.os ?? '',
      ...device.tags,
      device.classification,
      device.network.state
    ]);
  }
  function filteredRow(row: ComputeRow): ComputeRow | undefined {
    const resourceMatches = resourceFilter === 'all' ||
      (resourceFilter === 'environment' && row.kind === 'environment') ||
      (resourceFilter === 'host' && (row.kind === 'host' || Boolean(row.host))) ||
      (resourceFilter === 'tailnet' && Boolean(row.tailnetDevices?.length || row.tailnetDevice));
    if (!resourceMatches) return undefined;
    const baseMatches = termsMatch(row.baseSearchTerms) && statusMatches(row.baseStatus ?? row.status);
    const tailnetDevices = row.tailnetDevices?.filter((device) => {
      const matchesQuery = termsMatch(row.baseSearchTerms) || tailnetDeviceMatches(device);
      return matchesQuery && statusMatches(tailnetStatus(device).status);
    }) ?? [];
    if (row.kind === 'tailnet' && tailnetDevices.length === 0) return undefined;
    if (!baseMatches && tailnetDevices.length === 0) return undefined;
    if (!row.tailnetDevices || tailnetDevices.length === row.tailnetDevices.length) return row;
    const tailnetState = tailnetDevices.length > 0 ? tailnetGroupStatus(tailnetDevices) : undefined;
    const baseStatus = row.baseStatus;
    const status = tailnetState?.status === 'available'
      ? tailnetState.status
      : baseStatus && baseStatus !== 'unknown'
        ? baseStatus
        : tailnetState?.status ?? baseStatus ?? row.status;
    const { tailnetDevice: _tailnetDevice, tailnetDevices: _tailnetDevices, ...rest } = row;
    return {
      ...rest,
      isAvailable: status === 'available',
      status,
      ...(tailnetDevices.length > 0
        ? { tailnetDevice: tailnetDevices[0], tailnetDevices }
        : {})
    };
  }
  return sections.flatMap((section) => {
    const filteredRows = new Map(section.rows.flatMap((row) => {
      const next = row.kind === 'host' ? undefined : filteredRow(row);
      return next ? [[row.id, next] as const] : [];
    }));
    const rows = section.rows.flatMap((row, index) => {
      if (row.kind !== 'host') {
        const next = filteredRows.get(row.id);
        return next ? [next] : [];
      }
      let hasSurvivingChild = false;
      for (let cursor = index + 1; cursor < section.rows.length; cursor += 1) {
        const next = section.rows[cursor]!;
        if (next.depth === 0) break;
        if (next.kind !== 'host' && filteredRows.has(next.id)) {
          hasSurvivingChild = true;
          break;
        }
      }
      const nextHost = filteredRow(row);
      return hasSurvivingChild || nextHost ? [row] : [];
    });
    return rows.length > 0 ? [{ ...section, ...summarizeRows(rows), rows }] : [];
  });
}

function sortRowGroups(rows: readonly ComputeRow[], sortOrder: ComputeSortOrder) {
  const groups: ComputeRow[][] = [];
  for (const row of rows) {
    if (row.depth === 0 || groups.length === 0) groups.push([row]);
    else groups.at(-1)!.push(row);
  }
  const statusOrder: Record<ComputeRowStatus, number> = { available: 0, unknown: 1, attention: 2 };
  return groups.sort((left, right) => {
    const leftRoot = left[0]!;
    const rightRoot = right[0]!;
    if (sortOrder === 'online') {
      const statusDifference = statusOrder[leftRoot.status] - statusOrder[rightRoot.status];
      if (statusDifference !== 0) return statusDifference;
    }
    return leftRoot.name.localeCompare(rightRoot.name);
  }).flat();
}

export function sortComputePlatformSections(
  sections: readonly ComputePlatformSection[],
  sortOrder: ComputeSortOrder
) {
  return sections.map((section) => ({ ...section, rows: sortRowGroups(section.rows, sortOrder) }));
}

export function computeInventoryCounts(sections: readonly ComputePlatformSection[]) {
  const summary = summarizeRows(sections.flatMap((section) => section.rows));
  return {
    environments: summary.environmentCount,
    hosts: summary.hostCount,
    tailnet: summary.tailnetCount,
    workspaces: summary.workspaceCount
  };
}

export function countComputePlatformRows(sections: readonly ComputePlatformSection[]) {
  return sections.reduce((sum, section) => sum + section.rows.length, 0);
}

export function isComputeInventoryStale(
  checkedAt: string,
  now = Date.now(),
  thresholdMs = staleInventoryThresholdMs
) {
  const timestamp = Date.parse(checkedAt);
  return !Number.isFinite(timestamp) || now - timestamp > thresholdMs;
}
