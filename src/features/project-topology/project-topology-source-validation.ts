import type { ProjectSpaceRecord } from '@/shared/project-space-api';
import {
  projectTopologyWorktreeEntryScope,
  type ProjectTopologyWorktreeSnapshot
} from '../../shared/project-topology-api';
import { topologyProjectScope } from './project-topology-inventory-evidence';
import type {
  TopologyInventoryResult,
  TopologyWorktreeInventory
} from './project-topology-types';

export const maxReadyEvidenceAgeMs = 30_000;
const expiredSourceReason = 'Source evidence expired before the topology snapshot was published.';

export function validateProjectTopologySourceResult<T>(
  result: Exclude<TopologyInventoryResult<T>, { state: 'checking' }>,
  observedAt: string
): TopologyInventoryResult<T> {
  if (result.state === 'blocked') return result;
  const evidenceAt = result.state === 'ready' ? result.checkedAt : result.lastSafeAt;
  const evidenceTime = Date.parse(evidenceAt);
  const observedTime = Date.parse(observedAt);
  const nestedCheckedAt = checkedAtFromData(result.data);
  const nestedValue = nestedCheckedAt.present ? nestedCheckedAt.value : undefined;
  const nestedTime = nestedValue === undefined ? undefined : Date.parse(nestedValue);
  const nestedTimeValid = !nestedCheckedAt.present
    || (Number.isFinite(nestedTime) && nestedTime === evidenceTime);
  const readyTimeValid = result.state !== 'ready'
    || observedTime - evidenceTime <= maxReadyEvidenceAgeMs;
  const valid = Number.isFinite(evidenceTime)
    && Number.isFinite(observedTime)
    && evidenceTime <= observedTime
    && nestedTimeValid;
  if (!valid) return {
    checkedAt: observedAt,
    reason: 'Source evidence timestamp was malformed, future-dated, or internally inconsistent.',
    state: 'blocked'
  };
  return readyTimeValid ? result : {
    data: result.data,
    lastSafeAt: result.checkedAt,
    reason: expiredSourceReason,
    state: 'stale'
  };
}

export function worktreesFromTopologySnapshot(
  projects: ProjectSpaceRecord[],
  snapshot: Extract<
    TopologyInventoryResult<ProjectTopologyWorktreeSnapshot>,
    { state: 'ready' | 'stale' }
  >,
  clock: () => string
) {
  const entries = new Map(snapshot.data.worktrees.map((entry) => [
    projectTopologyWorktreeEntryScope(entry),
    entry.result
  ]));
  return Object.fromEntries(projects.map((project) => {
    const scope = topologyProjectScope(project);
    const result = entries.get(scope);
    if (!result) return [scope, {
      checkedAt: clock(),
      message: 'The topology inventory omitted this authorized project scope.',
      reason: 'source-disagreement' as const,
      state: 'blocked' as const
    }] as const;
    const completed = completeTopologyWorktreeSource(result, clock());
    if (
      snapshot.state === 'stale'
      && (completed.state === 'ready' || completed.state === 'proven-empty')
    ) return [scope, {
      data: completed,
      lastSafeAt: completed.evidence.checkedAt,
      reason: snapshot.reason,
      state: 'stale' as const
    }] as const;
    return [scope, completed] as const;
  }));
}

export function completeTopologyWorktreeSource(
  result: TopologyWorktreeInventory,
  checkedAt: string
): TopologyWorktreeInventory {
  if (result.state === 'blocked') return result;
  const observedTime = Date.parse(checkedAt);
  const evidenceAt = result.state === 'stale'
    ? result.data.evidence.checkedAt
    : result.state === 'checking'
      ? undefined
      : result.evidence.checkedAt;
  const evidenceTime = evidenceAt ? Date.parse(evidenceAt) : Number.NaN;
  const lastSafeTime = result.state === 'stale' ? Date.parse(result.lastSafeAt) : undefined;
  const internallyValid = result.state !== 'checking'
    && Number.isFinite(observedTime)
    && Number.isFinite(evidenceTime)
    && evidenceTime <= observedTime
    && (result.state !== 'stale'
      || (Number.isFinite(lastSafeTime) && evidenceTime === lastSafeTime));
  if (!internallyValid) return {
    checkedAt,
    message: result.state === 'checking'
      ? 'Worktree source completed without a final evidence state.'
      : 'Worktree source evidence was malformed, future-dated, or internally inconsistent.',
    reason: 'source-disagreement',
    state: 'blocked'
  };
  if (result.state === 'stale' || observedTime - evidenceTime <= maxReadyEvidenceAgeMs) {
    return result;
  }
  return {
    data: result,
    lastSafeAt: result.evidence.checkedAt,
    reason: expiredSourceReason,
    state: 'stale'
  };
}

function checkedAtFromData(data: unknown) {
  if (!data || typeof data !== 'object' || !('checkedAt' in data)) {
    return { present: false as const };
  }
  const checkedAt = (data as { checkedAt?: unknown }).checkedAt;
  return {
    present: true as const,
    ...(typeof checkedAt === 'string' ? { value: checkedAt } : {})
  };
}
