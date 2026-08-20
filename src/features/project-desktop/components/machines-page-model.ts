import { matchesFuzzyQuery } from '../../../lib/fuzzy-search';
import type { GitHubCodespaceInventoryItem } from '../../../shared/github-codespace-inventory-api';
import type { TailscaleInventoryDevice } from '../../../shared/tailscale-inventory-api';

export const machineFilters = ['all', 'available', 'attention'] as const;
export type MachineFilter = (typeof machineFilters)[number];

export type ComputeSourceRow =
  | {
      id: string;
      kind: 'tailscale';
      record: TailscaleInventoryDevice;
      searchTerms: string[];
      status: 'available' | 'attention' | 'unknown';
    }
  | {
      id: string;
      kind: 'github';
      record: GitHubCodespaceInventoryItem;
      searchTerms: string[];
      status: 'available' | 'attention' | 'unknown';
    };

export interface ComputeSourceSection {
  id: 'tailscale' | 'github';
  label: string;
  rows: ComputeSourceRow[];
}

function codespaceStatus(state: string): ComputeSourceRow['status'] {
  switch (state.trim().toLowerCase()) {
    case 'available':
    case 'running':
      return 'available';
    case 'shutdown':
    case 'shuttingdown':
    case 'starting':
    case 'stopping':
    case 'unavailable':
      return 'attention';
    default:
      return 'unknown';
  }
}

function tailscaleStatus(device: TailscaleInventoryDevice): ComputeSourceRow['status'] {
  if (device.network.state === 'online') return 'available';
  if (device.network.state === 'offline' || device.network.state === 'stale') return 'attention';
  return 'unknown';
}

function uniqueById<T>(records: readonly T[], getId: (record: T) => string) {
  const seen = new Set<string>();
  return records.filter((record) => {
    const id = getId(record);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function computeSourceSections(input: {
  codespaces?: readonly GitHubCodespaceInventoryItem[];
  tailscaleDevices?: readonly TailscaleInventoryDevice[];
}): ComputeSourceSection[] {
  return [
    {
      id: 'tailscale',
      label: 'Tailscale',
      rows: uniqueById(input.tailscaleDevices ?? [], (record) => record.id).map((record) => ({
        id: `tailscale:${record.id}`,
        kind: 'tailscale' as const,
        record,
        searchTerms: [
          record.name ?? '',
          ...record.addresses,
          record.os ?? '',
          ...record.tags,
          record.classification,
          record.network.state
        ],
        status: tailscaleStatus(record)
      }))
    },
    {
      id: 'github',
      label: 'GitHub Codespaces',
      rows: uniqueById(input.codespaces ?? [], (record) => record.name).map((record) => ({
        id: `github:${record.name}`,
        kind: 'github' as const,
        record,
        searchTerms: [
          record.displayName ?? '',
          record.name,
          record.repositoryFullName,
          record.ref ?? '',
          record.state
        ],
        status: codespaceStatus(record.state)
      }))
    }
  ];
}

export function filterComputeSourceSections(
  sections: readonly ComputeSourceSection[],
  query: string,
  filter: MachineFilter
) {
  return sections.map((section) => ({
    ...section,
    rows: section.rows.filter((row) => {
      if (filter === 'available' && row.status !== 'available') return false;
      if (filter === 'attention' && row.status === 'available') return false;
      return matchesFuzzyQuery(row.searchTerms, query);
    })
  }));
}

export function countComputeSourceRows(sections: readonly ComputeSourceSection[]) {
  return sections.reduce((sum, section) => sum + section.rows.length, 0);
}
