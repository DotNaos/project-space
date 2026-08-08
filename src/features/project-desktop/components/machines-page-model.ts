import type { ConnectorInstallationRecord } from '@/shared/project-space-api';
import { matchesFuzzyQuery } from '../../../lib/fuzzy-search';
import type {
  ComputeEnvironmentKind,
  ComputeEnvironmentNode,
  ComputeHostNode,
  ComputeInventory,
  ComputePlatformKind
} from '../../../shared/compute-environment-api';
import { hostAssociationLabel } from '../../../shared/compute-environment-api';
import type {
  SettingsConnectorInstance,
  SettingsMachineGroupingResult
} from './settings-machine-group-model';

export const machineFilters = ['all', 'online', 'offline'] as const;
export type MachineFilter = (typeof machineFilters)[number];

export interface MachineListRow {
  connectorCount: number;
  /** Connector installation used to render the device and platform marks. */
  device: ConnectorInstallationRecord;
  id: string;
  instances: SettingsConnectorInstance[];
  isGrouped: boolean;
  isOnline: boolean;
  name: string;
  onlineConnectorCount: number;
  platformLabel: string;
  searchTerms: string[];
}

function platformLabel(instances: readonly SettingsConnectorInstance[]) {
  const labels = [...new Set(instances.flatMap((instance) => (
    instance.platformLabel ? [instance.platformLabel] : []
  )))];
  return labels.join(', ');
}

function searchTerms(name: string, instances: readonly SettingsConnectorInstance[]) {
  return [
    name,
    ...instances.flatMap((instance) => [
      instance.id,
      instance.machine.name,
      instance.platformLabel,
      instance.runtimeLabel,
      instance.channel,
      instance.machine.connector.status
    ])
  ].flatMap((term) => (term ? [term] : []));
}

/**
 * Flattens the settings grouping into one row per machine. Connector
 * installations that are not assigned to a physical machine each become their
 * own row so the list never hides a reachable machine behind a group.
 */
export function machineListRows(grouping: SettingsMachineGroupingResult): MachineListRow[] {
  const groupRows = grouping.groups.flatMap<MachineListRow>((group) => {
    const device = group.instances[0]?.machine ?? group.archivedInstances[0]?.machine;
    if (!device) return [];

    return [{
      connectorCount: group.connectorCount,
      device,
      id: group.id,
      instances: group.instances,
      isGrouped: true,
      isOnline: group.onlineConnectorCount > 0,
      name: group.name,
      onlineConnectorCount: group.onlineConnectorCount,
      platformLabel: group.platformLabels.join(', '),
      searchTerms: searchTerms(group.name, group.instances)
    }];
  });

  const unscopedRows = grouping.unscopedInstances.map<MachineListRow>((instance) => ({
    connectorCount: 1,
    device: instance.machine,
    id: instance.id,
    instances: [instance],
    isGrouped: false,
    isOnline: instance.isOnline,
    name: instance.machine.name,
    onlineConnectorCount: instance.isOnline ? 1 : 0,
    platformLabel: platformLabel([instance]),
    searchTerms: searchTerms(instance.machine.name, [instance])
  }));

  return [...groupRows, ...unscopedRows].sort((left, right) => {
    const onlineOrder = Number(right.isOnline) - Number(left.isOnline);
    return onlineOrder !== 0 ? onlineOrder : left.name.localeCompare(right.name);
  });
}

export function filterMachineRows({
  filter,
  query,
  rows
}: {
  filter: MachineFilter;
  query: string;
  rows: readonly MachineListRow[];
}): MachineListRow[] {
  return rows.filter((row) => {
    if (filter === 'online' && !row.isOnline) return false;
    if (filter === 'offline' && row.isOnline) return false;
    return matchesFuzzyQuery(row.searchTerms, query);
  });
}

export function machineRowSubtitle(row: MachineListRow) {
  const connectors = `${row.connectorCount} ${row.connectorCount === 1 ? 'connector' : 'connectors'}`;
  const online = row.connectorCount > 1
    ? `${row.onlineConnectorCount} of ${connectors} online`
    : connectors;
  return [row.platformLabel, online].filter(Boolean).join(' · ');
}

// --- Compute environment hierarchy ---------------------------------------
//
// When the connector overview reports a valid compute inventory, machines are
// modelled as Platforms containing optional physical Hosts and isolated
// Environments (which can themselves nest), each naming the connectors that
// run inside them. This is strictly more information than the flat
// physical-machine grouping above, so it takes over the page whenever it is
// available; the flat grouping remains the fallback for accounts that have
// not adopted it yet.

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

export interface ComputeRow {
  connectorCount: number;
  /** Indentation level within its platform section; hosts and top-level
   * environments are 0, each nested environment is one deeper than its parent. */
  depth: number;
  environmentKind?: ComputeEnvironmentKind;
  hasIdentityConflict: boolean;
  hostAssociationLabel?: string;
  id: string;
  instances: SettingsConnectorInstance[];
  isOnline: boolean;
  kind: ComputeRowKind;
  name: string;
  onlineConnectorCount: number;
  resourcesSummary?: string;
  searchTerms: string[];
}

export interface ComputePlatformSection {
  connectorCount: number;
  id: string;
  isOnline: boolean;
  name: string;
  onlineConnectorCount: number;
  platformKindLabel: string;
  rows: ComputeRow[];
}

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

function resourcesSummaryText(resources: ComputeEnvironmentNode['environment']['resources']) {
  if (!resources) return undefined;
  const parts = [
    `${resources.cpu.cores} CPU`,
    formatBytes(resources.memory.limitBytes ?? resources.memory.totalBytes),
    formatBytes(resources.storage.totalBytes),
    resources.gpu?.length ? `${resources.gpu.length} GPU` : undefined
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function environmentRow(
  node: ComputeEnvironmentNode,
  depth: number,
  instancesById: ReadonlyMap<string, SettingsConnectorInstance>
): ComputeRow {
  const instances = node.connectors.flatMap(({ connectorId }) => {
    const instance = instancesById.get(connectorId);
    return instance ? [instance] : [];
  });
  const onlineConnectorCount = instances.filter((instance) => instance.isOnline).length;
  return {
    connectorCount: instances.length,
    depth,
    environmentKind: node.environment.kind,
    hasIdentityConflict: node.environment.identityResolution === 'conflict',
    hostAssociationLabel: hostAssociationLabel(node.environment.hostAssociation),
    id: node.environment.id,
    instances,
    isOnline: onlineConnectorCount > 0,
    kind: 'environment',
    name: node.environment.name,
    onlineConnectorCount,
    resourcesSummary: resourcesSummaryText(node.environment.resources),
    searchTerms: [
      node.environment.name,
      computeEnvironmentKindLabels[node.environment.kind],
      ...instances.flatMap((instance) => [
        instance.id,
        instance.machine.name,
        instance.platformLabel,
        instance.runtimeLabel
      ])
    ].flatMap((term) => (term ? [term] : []))
  };
}

function pushEnvironmentRows(
  nodes: readonly ComputeEnvironmentNode[],
  depth: number,
  instancesById: ReadonlyMap<string, SettingsConnectorInstance>,
  rows: ComputeRow[]
) {
  for (const node of nodes) {
    rows.push(environmentRow(node, depth, instancesById));
    pushEnvironmentRows(node.children, depth + 1, instancesById, rows);
  }
}

/** Sums the connectors of an environment subtree, used for a host's roll-up. */
function environmentSubtreeConnectors(
  nodes: readonly ComputeEnvironmentNode[],
  instancesById: ReadonlyMap<string, SettingsConnectorInstance>
): { online: number; total: number } {
  let total = 0;
  let online = 0;
  for (const node of nodes) {
    for (const { connectorId } of node.connectors) {
      const instance = instancesById.get(connectorId);
      if (!instance) continue;
      total += 1;
      if (instance.isOnline) online += 1;
    }
    const child = environmentSubtreeConnectors(node.children, instancesById);
    total += child.total;
    online += child.online;
  }
  return { online, total };
}

function pushHostRow(
  node: ComputeHostNode,
  instancesById: ReadonlyMap<string, SettingsConnectorInstance>,
  rows: ComputeRow[]
) {
  const summary = environmentSubtreeConnectors(node.environments, instancesById);
  rows.push({
    connectorCount: summary.total,
    depth: 0,
    hasIdentityConflict: false,
    id: node.host.id,
    instances: [],
    isOnline: summary.online > 0,
    kind: 'host',
    name: node.host.name,
    onlineConnectorCount: summary.online,
    resourcesSummary: resourcesSummaryText(node.host.resources),
    searchTerms: [node.host.name]
  });
  pushEnvironmentRows(node.environments, 1, instancesById, rows);
}

/**
 * Projects the compute inventory into one section per platform. Each section's
 * rows interleave host headers with the environment rows nested beneath them,
 * followed by any environments that have no host, in the tree's own order.
 */
export function computePlatformSections(
  inventory: ComputeInventory,
  instancesById: ReadonlyMap<string, SettingsConnectorInstance>
): ComputePlatformSection[] {
  return inventory.platforms.map((platformNode) => {
    const rows: ComputeRow[] = [];
    for (const host of platformNode.hosts) pushHostRow(host, instancesById, rows);
    pushEnvironmentRows(platformNode.environments, 0, instancesById, rows);
    const environmentRows = rows.filter((row) => row.kind === 'environment');
    const connectorCount = environmentRows.reduce((sum, row) => sum + row.connectorCount, 0);
    const onlineConnectorCount = environmentRows.reduce((sum, row) => sum + row.onlineConnectorCount, 0);
    return {
      connectorCount,
      id: platformNode.platform.id,
      isOnline: onlineConnectorCount > 0,
      name: platformNode.platform.name,
      onlineConnectorCount,
      platformKindLabel: computePlatformKindLabels[platformNode.platform.kind],
      rows
    };
  });
}

/**
 * Filters rows within each section and drops a host row only when none of its
 * own environment rows (the ones directly after it, before the next
 * depth-zero row) survive; a section disappears entirely once it has none left.
 */
export function filterComputePlatformSections(
  sections: readonly ComputePlatformSection[],
  query: string,
  filter: MachineFilter
): ComputePlatformSection[] {
  function environmentSurvives(row: ComputeRow) {
    if (filter === 'online' && !row.isOnline) return false;
    if (filter === 'offline' && row.isOnline) return false;
    return matchesFuzzyQuery(row.searchTerms, query);
  }

  return sections.flatMap((section) => {
    const survivingEnvironmentIds = new Set(
      section.rows
        .filter((row) => row.kind === 'environment' && environmentSurvives(row))
        .map((row) => row.id)
    );
    const rows = section.rows.filter((row, index) => {
      if (row.kind === 'environment') return survivingEnvironmentIds.has(row.id);
      // A host's own subtree is every following row until the next depth-zero
      // row (the next host, or a top-level hostless environment).
      let hasSurvivingDescendant = false;
      for (let cursor = index + 1; cursor < section.rows.length; cursor += 1) {
        const next = section.rows[cursor]!;
        if (next.depth === 0) break;
        if (next.kind === 'environment' && survivingEnvironmentIds.has(next.id)) {
          hasSurvivingDescendant = true;
          break;
        }
      }
      return hasSurvivingDescendant ||
        (filter === 'all' && matchesFuzzyQuery(row.searchTerms, query));
    });
    return rows.length > 0 ? [{ ...section, rows }] : [];
  });
}

export function countComputePlatformRows(sections: readonly ComputePlatformSection[]) {
  return sections.reduce((sum, section) => sum + section.rows.length, 0);
}
