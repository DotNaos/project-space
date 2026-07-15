import type {
  MachineRecord,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import type { TopologyInventoryResult } from './project-topology-types';

export function normalizeTopologyMachineInventory(
  result: TopologyInventoryResult<MachineRecord[]>
): TopologyInventoryResult<MachineRecord[]> {
  return normalizeInventory(
    result,
    (machine) => machine.id,
    'Machine inventory returned conflicting records for the same machine identity.'
  );
}

export function normalizeTopologyProjectInventory(
  result: TopologyInventoryResult<ProjectSpaceRecord[]>
): TopologyInventoryResult<ProjectSpaceRecord[]> {
  return normalizeInventory(
    result,
    (project) => `${encodeURIComponent(project.machineId ?? 'unknown')}:${encodeURIComponent(project.id)}`,
    'Project inventory returned conflicting records for the same machine/project scope.'
  );
}

function normalizeInventory<T>(
  result: TopologyInventoryResult<T[]>,
  identity: (record: T) => string,
  conflictReason: string
): TopologyInventoryResult<T[]> {
  if (result.state !== 'ready' && result.state !== 'stale') return result;
  const records = new Map<string, { record: T; signature: string }>();
  for (const record of result.data) {
    const key = identity(record);
    const signature = JSON.stringify(canonicalValue(record));
    const previous = records.get(key);
    if (previous && previous.signature !== signature) {
      return {
        checkedAt: result.state === 'ready' ? result.checkedAt : result.lastSafeAt,
        reason: conflictReason,
        state: 'blocked'
      };
    }
    records.set(key, { record, signature });
  }
  return { ...result, data: [...records.values()].map(({ record }) => record) };
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalValue(entry)]));
}
