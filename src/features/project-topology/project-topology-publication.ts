import type {
  ProjectTopologyInventory,
  TopologyInventoryResult,
  TopologyTaskEvidence,
  TopologyTaskLocationEvidence,
  TopologyTaskWriteCapability,
  TopologyWorktreeInventory
} from './project-topology-types';

const maxReadyAgeMs = 30_000;
const expiredReason = 'Source evidence expired before the topology snapshot was published.';
const invalidReason = 'Source evidence was invalid at the topology publication boundary.';

export function revalidateTopologyPublication(
  inventory: ProjectTopologyInventory
): ProjectTopologyInventory {
  const publishedAt = inventory.checkedAt;
  const [locations, locationFailures] = revalidateLocations(inventory, publishedAt);
  return {
    ...inventory,
    codexByMachineId: mapValues(inventory.codexByMachineId, (result) => (
      revalidateEnvelope(result, publishedAt)
    )),
    deploymentsByRepository: mapValues(inventory.deploymentsByRepository, (result) => (
      revalidateEnvelope(result, publishedAt)
    )),
    machines: revalidateEnvelope(inventory.machines, publishedAt),
    projects: revalidateEnvelope(inventory.projects, publishedAt),
    repositoriesByFullName: mapValues(inventory.repositoriesByFullName, (result) => (
      revalidateEnvelope(result, publishedAt)
    )),
    taskLocationFailuresByTaskId: locationFailures,
    taskLocationsByTaskId: locations,
    worktreesByProjectScope: mapValues(inventory.worktreesByProjectScope, (result) => (
      revalidateWorktrees(result, publishedAt)
    )),
    ...(inventory.conversationsByTaskId ? {
      conversationsByTaskId: mapValues(inventory.conversationsByTaskId, (result) => (
        revalidateEnvelope(result, publishedAt)
      ))
    } : {}),
    ...(inventory.taskEvidenceByTaskId ? {
      taskEvidenceByTaskId: mapValues(inventory.taskEvidenceByTaskId, (evidence) => (
        revalidateTaskEvidence(evidence, publishedAt)
      ))
    } : {}),
    ...(inventory.writeCapabilitiesByTaskId ? {
      writeCapabilitiesByTaskId: mapValues(
        inventory.writeCapabilitiesByTaskId,
        (capability) => revalidateWriteCapability(capability, publishedAt)
      )
    } : {})
  };
}

function revalidateEnvelope<T>(
  result: TopologyInventoryResult<T>,
  publishedAt: string
): TopologyInventoryResult<T> {
  if (result.state !== 'ready') return result;
  const freshness = evidenceFreshness(result.checkedAt, publishedAt);
  const nested = nestedCheckedAt(result.data);
  if (freshness === 'invalid' || (nested.present && nested.value !== result.checkedAt)) {
    return { checkedAt: publishedAt, reason: invalidReason, state: 'blocked' };
  }
  return freshness === 'expired'
    ? { data: result.data, lastSafeAt: result.checkedAt, reason: expiredReason, state: 'stale' }
    : result;
}

function revalidateWorktrees(
  result: TopologyWorktreeInventory,
  publishedAt: string
): TopologyWorktreeInventory {
  if (result.state !== 'ready' && result.state !== 'proven-empty') return result;
  const freshness = evidenceFreshness(result.evidence.checkedAt, publishedAt);
  if (freshness === 'invalid') {
    return {
      checkedAt: publishedAt,
      message: invalidReason,
      reason: 'source-disagreement',
      state: 'blocked'
    };
  }
  return freshness === 'expired'
    ? {
        data: result,
        lastSafeAt: result.evidence.checkedAt,
        reason: expiredReason,
        state: 'stale'
      }
    : result;
}

function revalidateLocations(
  inventory: ProjectTopologyInventory,
  publishedAt: string
): [
  Record<string, TopologyTaskLocationEvidence>,
  Record<string, { checkedAt: string; reason: string }>
] {
  const locations: Record<string, TopologyTaskLocationEvidence> = {};
  const failures = { ...inventory.taskLocationFailuresByTaskId };
  for (const [id, evidence] of Object.entries(inventory.taskLocationsByTaskId ?? {})) {
    const freshness = evidenceFreshness(evidence.checkedAt, publishedAt);
    if (freshness === 'current') {
      locations[id] = evidence;
    } else {
      failures[id] = {
        checkedAt: publishedAt,
        reason: freshness === 'expired' ? expiredReason : invalidReason
      };
    }
  }
  return [locations, failures];
}

function revalidateWriteCapability(
  capability: TopologyTaskWriteCapability,
  publishedAt: string
): TopologyTaskWriteCapability {
  if (capability.state !== 'ready') return capability;
  const checkedAt = Date.parse(capability.checkedAt);
  const expiresAt = Date.parse(capability.expiresAt);
  const sessionAt = Date.parse(capability.sessionLastActivityAt);
  const publicationAt = Date.parse(publishedAt);
  const valid = [checkedAt, expiresAt, sessionAt, publicationAt].every(Number.isFinite)
    && sessionAt <= checkedAt
    && checkedAt <= publicationAt
    && publicationAt <= expiresAt
    && expiresAt - checkedAt <= 5 * 60 * 1000;
  const current = valid && publicationAt - checkedAt <= maxReadyAgeMs;
  return current ? capability : {
    checkedAt: publishedAt,
    reason: valid ? expiredReason : invalidReason,
    state: 'blocked'
  };
}

function revalidateTaskEvidence(
  evidence: TopologyTaskEvidence,
  publishedAt: string
): TopologyTaskEvidence {
  const publicationAt = Date.parse(publishedAt);
  const validObservedAt = (sessionAt: string, observedAt: string) => {
    const sessionTime = Date.parse(sessionAt);
    const observedTime = Date.parse(observedAt);
    return [sessionTime, observedTime, publicationAt].every(Number.isFinite)
      && sessionTime <= observedTime
      && observedTime <= publicationAt;
  };
  const awaitingDecision = evidence.awaitingDecision;
  const expiresAt = awaitingDecision ? Date.parse(awaitingDecision.expiresAt) : Number.NaN;
  const validDecision = Boolean(awaitingDecision)
    && validObservedAt(awaitingDecision!.sessionLastActivityAt, awaitingDecision!.observedAt)
    && Number.isFinite(expiresAt)
    && publicationAt <= expiresAt
    && expiresAt - Date.parse(awaitingDecision!.observedAt) <= 15 * 60 * 1000;
  const delivery = evidence.delivery;
  const verification = evidence.verification;
  return {
    machineId: evidence.machineId,
    threadId: evidence.threadId,
    ...(validDecision ? { awaitingDecision } : {}),
    ...(delivery && validObservedAt(delivery.sessionLastActivityAt, delivery.observedAt)
      ? { delivery }
      : {}),
    ...(verification && validObservedAt(
      verification.sessionLastActivityAt,
      verification.verifiedAt
    ) ? { verification } : {})
  };
}

function evidenceFreshness(evidenceAt: string, publishedAt: string) {
  const evidenceTime = Date.parse(evidenceAt);
  const publicationTime = Date.parse(publishedAt);
  if (!Number.isFinite(evidenceTime) || !Number.isFinite(publicationTime)) return 'invalid';
  if (evidenceTime > publicationTime) return 'invalid';
  return publicationTime - evidenceTime <= maxReadyAgeMs ? 'current' : 'expired';
}

function nestedCheckedAt(data: unknown) {
  if (!data || typeof data !== 'object' || !('checkedAt' in data)) {
    return { present: false as const, value: undefined };
  }
  const checkedAt = (data as { checkedAt?: unknown }).checkedAt;
  return {
    present: true as const,
    value: typeof checkedAt === 'string' ? checkedAt : undefined
  };
}

function mapValues<T, R>(values: Record<string, T>, transform: (value: T) => R) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [
    key,
    transform(value)
  ]));
}
