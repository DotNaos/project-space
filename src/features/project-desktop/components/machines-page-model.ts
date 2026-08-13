import { matchesFuzzyQuery } from '../../../lib/fuzzy-search';
import type {
  ComputeEnvironmentKind,
  ComputePlatformKind
} from '../../../shared/compute-environment-api';
import type {
  ProjectCliAccessRoute,
  ProjectCliComputeInventory,
  ProjectCliEnvironmentInstance,
  ProjectCliHost,
  ProjectCliInventoryResourceSummary,
  ProjectCliWorkspaceSummary
} from '../../../shared/compute-inventory-cli-api';

export const machineFilters = ['all', 'available', 'attention'] as const;
export type MachineFilter = (typeof machineFilters)[number];

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

export type ComputeRowKind = 'environment' | 'host';
export type ComputeRowRelationship = 'dual-boot' | 'nested';
export type ComputeRowStatus = 'available' | 'attention' | 'unknown';

export interface ComputeRow {
  depth: number;
  environment?: ProjectCliEnvironmentInstance;
  environmentKind?: ComputeEnvironmentKind;
  environmentStatus?: string;
  hostResolutionLabel?: string;
  host?: ProjectCliHost;
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
  workspaceCount: number;
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

function resourceSourceLabel(resources: ProjectCliInventoryResourceSummary | undefined) {
  switch (resources?.source) {
    case 'configured': return 'Configured';
    case 'hostd': return 'hostd';
    case 'provider': return 'Provider';
    case 'connector': return 'Imported snapshot';
    default: return 'Unavailable';
  }
}

function controlledRoutes(routes: readonly ProjectCliAccessRoute[]) {
  return routes.filter((route) => route.type !== 'connector');
}

function environmentStatus(instance: ProjectCliEnvironmentInstance) {
  const states = controlledRoutes(instance.accessRoutes).map((route) => route.state);
  if (states.includes('ready')) return { label: 'Access ready', status: 'available' as const };
  if (states.includes('stale')) return { label: 'Access stale', status: 'attention' as const };
  if (states.some((state) => state === 'unavailable' || state === 'policy_blocked')) {
    return { label: 'Access unavailable', status: 'attention' as const };
  }
  if (states.includes('unverified')) return { label: 'Access not verified', status: 'attention' as const };
  return { label: 'Status unavailable', status: 'unknown' as const };
}

function hostStatus(host: ProjectCliHost) {
  switch (host.capabilities.state) {
    case 'available': return { label: 'Host reachable', status: 'available' as const };
    case 'unavailable': return { label: 'Host unavailable', status: 'attention' as const };
    default: return { label: 'Host status unavailable', status: 'unknown' as const };
  }
}

function hostAssociationLabel(instance: ProjectCliEnvironmentInstance) {
  switch (instance.hostResolution) {
    case 'verified': return 'Verified host';
    case 'manual': return 'Assigned host';
    case 'conflict': return 'Host needs review';
    case 'unresolved': return 'Host not assigned';
    case 'not_applicable': return 'Provider managed';
  }
}

function environmentName(instance: ProjectCliEnvironmentInstance) {
  return instance.alias.trim() || instance.name;
}

function environmentRow(
  instance: ProjectCliEnvironmentInstance,
  depth: number,
  relationship: ComputeRowRelationship | undefined,
  instancesById: ReadonlyMap<string, ProjectCliEnvironmentInstance>
): ComputeRow {
  const state = environmentStatus(instance);
  const workspaces = instance.workspaces;
  const name = environmentName(instance);
  return {
    depth,
    environment: instance,
    environmentKind: instance.kind,
    environmentStatus: state.label,
    hostResolutionLabel: hostAssociationLabel(instance),
    id: instance.id,
    isAvailable: state.status === 'available',
    kind: 'environment',
    name,
    relationship,
    resourceSource: resourceSourceLabel(instance.resources),
    resourcesSummary: resourcesSummaryText(instance.resources),
    searchTerms: [
      name,
      instance.name,
      computeEnvironmentKindLabels[instance.kind],
      hostAssociationLabel(instance),
      ...workspaces.flatMap((workspace) => [workspace.name, workspace.repository ?? '']),
      ...(instance.parentEnvironmentInstanceId
        ? [instancesById.get(instance.parentEnvironmentInstanceId)?.alias ?? '']
        : [])
    ].filter(Boolean),
    status: state.status,
    workspaces
  };
}

function pushEnvironmentRows(
  instances: readonly ProjectCliEnvironmentInstance[],
  childrenByParent: ReadonlyMap<string, ProjectCliEnvironmentInstance[]>,
  depth: number,
  relationship: ComputeRowRelationship | undefined,
  instancesById: ReadonlyMap<string, ProjectCliEnvironmentInstance>,
  rows: ComputeRow[]
) {
  for (const instance of instances) {
    rows.push(environmentRow(instance, depth, relationship, instancesById));
    const children = childrenByParent.get(instance.id) ?? [];
    pushEnvironmentRows(
      children,
      childrenByParent,
      depth + 1,
      'nested',
      instancesById,
      rows
    );
  }
}

function pushHostRows(
  host: ProjectCliHost,
  instances: readonly ProjectCliEnvironmentInstance[],
  childrenByParent: ReadonlyMap<string, ProjectCliEnvironmentInstance[]>,
  instancesById: ReadonlyMap<string, ProjectCliEnvironmentInstance>,
  rows: ComputeRow[]
) {
  const status = hostStatus(host);
  rows.push({
    depth: 0,
    host,
    hostStatus: status.label,
    id: host.id,
    isAvailable: status.status === 'available',
    kind: 'host',
    name: host.name,
    resourceSource: resourceSourceLabel(host.resources),
    resourcesSummary: resourcesSummaryText(host.resources),
    searchTerms: [host.name, host.alias],
    status: status.status,
    workspaces: []
  });

  const roots = instances.filter((instance) => !instance.parentEnvironmentInstanceId);
  const exclusiveRoots = roots.filter((instance) => instance.resourceMode === 'exclusive');
  const relationship = exclusiveRoots.length > 1 ? 'dual-boot' as const : undefined;
  pushEnvironmentRows(roots, childrenByParent, 1, relationship, instancesById, rows);
}

export function computePlatformSections(inventory: ProjectCliComputeInventory) {
  const instancesById = new Map(inventory.environmentInstances.map((instance) => [instance.id, instance] as const));
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

  return inventory.platforms.map((platform) => {
    const platformInstances = inventory.environmentInstances.filter(
      (instance) => instance.platformId === platform.id
    );
    const rows: ComputeRow[] = [];
    for (const host of inventory.hosts.filter((entry) => entry.platformId === platform.id)) {
      pushHostRows(
        host,
        platformInstances.filter((instance) => instance.hostId === host.id),
        childrenByParent,
        instancesById,
        rows
      );
    }
    pushEnvironmentRows(
      platformInstances.filter((instance) => !instance.hostId && !instance.parentEnvironmentInstanceId),
      childrenByParent,
      0,
      undefined,
      instancesById,
      rows
    );
    return {
      availableCount: rows.filter((row) => row.isAvailable).length,
      environmentCount: platformInstances.length,
      hostCount: inventory.hosts.filter((host) => host.platformId === platform.id).length,
      id: platform.id,
      name: platform.name,
      platformKindLabel: computePlatformKindLabels[platform.kind],
      rows,
      workspaceCount: platformInstances.reduce((sum, instance) => sum + instance.workspaces.length, 0)
    } satisfies ComputePlatformSection;
  }).filter((section) => section.rows.length > 0);
}

export function filterComputePlatformSections(
  sections: readonly ComputePlatformSection[],
  query: string,
  filter: MachineFilter
) {
  function rowSurvives(row: ComputeRow) {
    if (filter === 'available' && !row.isAvailable) return false;
    if (filter === 'attention' && row.status === 'available') return false;
    return matchesFuzzyQuery(row.searchTerms, query);
  }

  return sections.flatMap((section) => {
    const survivingEnvironmentIds = new Set(
      section.rows
        .filter((row) => row.kind === 'environment' && rowSurvives(row))
        .map((row) => row.id)
    );
    const rows = section.rows.filter((row, index) => {
      if (row.kind === 'environment') return survivingEnvironmentIds.has(row.id);
      for (let cursor = index + 1; cursor < section.rows.length; cursor += 1) {
        const next = section.rows[cursor]!;
        if (next.depth === 0) break;
        if (next.kind === 'environment' && survivingEnvironmentIds.has(next.id)) return true;
      }
      return filter === 'all' && rowSurvives(row);
    });
    return rows.length > 0 ? [{ ...section, rows }] : [];
  });
}

export function computeInventoryCounts(sections: readonly ComputePlatformSection[]) {
  return sections.reduce(
    (summary, section) => ({
      environments: summary.environments + section.environmentCount,
      hosts: summary.hosts + section.hostCount,
      workspaces: summary.workspaces + section.workspaceCount
    }),
    { environments: 0, hosts: 0, workspaces: 0 }
  );
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
