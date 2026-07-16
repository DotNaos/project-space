import type {
  MachineRecord,
  ProjectSpaceRecord,
  ProjectWorktreeDiscoveryState,
  ProjectWorktreeRecord
} from '@/shared/project-space-api';
import type {
  CodexSessionListResult,
  CodexSessionRecord
} from '@/shared/codex-sessions-api';
import type {
  ProjectTopologyInventory,
  TopologyInventoryResult,
  TopologyMachine,
  TopologyMultiMachineState,
  TopologyProject,
  TopologyTruthState,
  TopologyWorktreeInventory
} from './project-topology-types';

export function mergeWorktreeInventories(
  records: ProjectSpaceRecord[],
  inventory: ProjectTopologyInventory
): TopologyWorktreeInventory {
  const states = records.map((record) => worktreeInventoryFor(record, inventory));
  if (states.some((state) => state.state === 'checking')) return { state: 'checking' };
  const blocked = states.find((state): state is Extract<
    ProjectWorktreeDiscoveryState,
    { state: 'blocked' }
  > => state.state === 'blocked');
  if (blocked) return blocked;
  const stale = states.filter((state): state is Extract<
    TopologyWorktreeInventory,
    { state: 'stale' }
  > => state.state === 'stale');
  const current = states.flatMap((state) => state.state === 'stale' ? [state.data] : [state]);
  const ready = current.filter((state): state is Extract<
    ProjectWorktreeDiscoveryState,
    { state: 'ready' }
  > => state.state === 'ready');
  let data: Extract<ProjectWorktreeDiscoveryState, { state: 'ready' | 'proven-empty' }>;
  if (ready.length > 0) {
    const discovered = ready.flatMap((state) => state.worktrees);
    if (hasConflictingWorktreeDuplicates(discovered)) {
      return conflictingWorktreeEvidence(ready[0]!.evidence.checkedAt);
    }
    const worktrees = dedupeWorktrees(discovered);
    data = {
      evidence: ready[0]!.evidence,
      state: 'ready',
      worktrees: worktrees as [ProjectWorktreeRecord, ...ProjectWorktreeRecord[]]
    };
  } else {
    const empty = current.find((state): state is Extract<
      ProjectWorktreeDiscoveryState,
      { state: 'proven-empty' }
    > => state.state === 'proven-empty');
    if (!empty) return { state: 'checking' };
    data = empty;
  }
  if (stale.length === 0) return data;
  const oldest = stale.reduce((candidate, state) => (
    Date.parse(state.lastSafeAt) < Date.parse(candidate.lastSafeAt) ? state : candidate
  ));
  return {
    data,
    lastSafeAt: oldest.lastSafeAt,
    reason: oldest.reason,
    state: 'stale'
  };
}

export function resolveMultiMachineState(
  projectId: string,
  repositoryFullName: string | undefined,
  machines: TopologyMachine[],
  intentional: string[]
): TopologyMultiMachineState {
  if (machines.length <= 1) return 'single';
  if (machines.some((machine) => (
    machine.inventory.state === 'stale'
    || machine.taskInventory.state === 'stale'
    || machine.worktreeInventory.state === 'stale'
  ))) return 'stale';
  if (intentional.includes(projectId) || (
    repositoryFullName && intentional.includes(repositoryFullName)
  )) return 'intentional-difference';
  if (machines.some((machine) => machine.inventory.state !== 'ready')) return 'ambiguous';
  const signatures = machines.map((machine) => {
    if (machine.worktreeInventory.state !== 'ready') return undefined;
    const bases = machine.worktrees.filter((worktree) => (
      worktree.isBase && usableWorktree(worktree)
    ));
    const values = bases.map(baseSignature);
    return values.length > 0
      && values.every((value): value is string => Boolean(value))
      && new Set(values).size === 1
      ? values[0]
      : undefined;
  });
  return signatures.length === machines.length && new Set(signatures).size === 1
    && signatures.every(Boolean)
    ? 'synchronized'
    : 'ambiguous';
}

export function multiMachineWarning(project: TopologyProject) {
  switch (project.multiMachineState) {
    case 'ambiguous':
      return `${project.name} is present on multiple machines without proof of a primary or synchronized checkout.`;
    case 'stale':
      return `${project.name} has multi-machine occupancy with at least one stale machine snapshot.`;
    case 'intentional-difference':
    case 'synchronized':
    case 'single':
      return undefined;
  }
}

export function machineTruth(
  machine: MachineRecord | undefined,
  source: TopologyInventoryResult<MachineRecord[]>
): TopologyTruthState {
  if (source.state === 'checking' || source.state === 'blocked') return source;
  if (source.state === 'stale') {
    return { lastSafeAt: source.lastSafeAt, reason: source.reason, state: 'stale' };
  }
  if (!machine) {
    return {
      reason: 'The project registry names this machine, but machine inventory did not return it.',
      state: 'limited'
    };
  }
  if (machine.connector.status === 'local' || machine.connector.status === 'online') {
    return { checkedAt: source.checkedAt, state: 'ready' };
  }
  if (machine.connector.status === 'offline') {
    const lastSeen = machine.connector.lastSeen;
    const lastSeenTime = lastSeen ? Date.parse(lastSeen) : Number.NaN;
    const sourceTime = Date.parse(source.checkedAt);
    if (!Number.isFinite(lastSeenTime) || lastSeenTime > sourceTime) {
      return {
        checkedAt: source.checkedAt,
        reason: 'The machine connector is offline and its last-seen evidence is invalid.',
        state: 'limited'
      };
    }
    return {
      lastSafeAt: lastSeen!,
      reason: 'The machine connector is offline.',
      state: 'stale'
    };
  }
  return {
    checkedAt: source.checkedAt,
    reason: 'The machine connector is not installed.',
    state: 'limited'
  };
}

export function inventoryTruth<T>(
  result: TopologyInventoryResult<T>
): TopologyTruthState {
  if (result.state === 'checking' || result.state === 'blocked') return result;
  if (result.state === 'stale') {
    return { lastSafeAt: result.lastSafeAt, reason: result.reason, state: 'stale' };
  }
  return { checkedAt: result.checkedAt, state: 'ready' };
}

export function projectTruth(
  source: TopologyInventoryResult<ProjectSpaceRecord[]>,
  machines: TopologyMachine[]
): TopologyTruthState {
  return aggregateProjectTruth(inventoryTruth(source), machines);
}

export function aggregateProjectTruth(
  sourceTruth: TopologyTruthState,
  machines: TopologyMachine[]
): TopologyTruthState {
  if (sourceTruth.state === 'checking' || sourceTruth.state === 'blocked') {
    return sourceTruth;
  }
  if (sourceTruth.state === 'limited') return sourceTruth;
  if (machines.length === 0) {
    return {
      reason: 'No current machine evidence is available for this project.',
      state: 'limited'
    };
  }

  const machineTruths = machines.map(({ inventory }) => inventory);
  if (machineTruths.some(({ state }) => state === 'checking')) return { state: 'checking' };
  const blocked = machineTruths.filter((truth): truth is Extract<
    TopologyTruthState,
    { state: 'blocked' }
  > => truth.state === 'blocked');
  if (blocked.length === machineTruths.length) return blocked[0]!;
  if (blocked.length > 0 || machineTruths.some(({ state }) => state === 'limited')) {
    return {
      ...(sourceTruth.state === 'ready' ? { checkedAt: sourceTruth.checkedAt } : {}),
      reason: 'One or more project machines do not have current trustworthy inventory.',
      state: 'limited'
    };
  }

  const stale = [sourceTruth, ...machineTruths].filter((truth): truth is Extract<
    TopologyTruthState,
    { state: 'stale' }
  > => truth.state === 'stale');
  if (stale.length > 0) {
    return stale.reduce((oldest, truth) => (
      Date.parse(truth.lastSafeAt) < Date.parse(oldest.lastSafeAt) ? truth : oldest
    ));
  }
  return sourceTruth;
}

export function codexTruth(
  result: TopologyInventoryResult<CodexSessionListResult>
): TopologyTruthState {
  if (result.state === 'checking' || result.state === 'blocked') return result;
  if (result.state === 'stale') {
    return { lastSafeAt: result.lastSafeAt, reason: result.reason, state: 'stale' };
  }
  return result.data.machine.online
    ? { checkedAt: result.checkedAt, state: 'ready' }
    : {
        lastSafeAt: result.checkedAt,
        reason: result.data.machine.statusMessage ?? 'Codex inventory is offline.',
        state: 'stale'
      };
}

export function worktreesFor(
  project: ProjectSpaceRecord,
  inventory: ProjectTopologyInventory
) {
  const result = worktreeInventoryFor(project, inventory);
  if (result.state === 'ready') return result.worktrees;
  return result.state === 'stale' && result.data.state === 'ready'
    ? result.data.worktrees
    : [];
}

export function worktreeInventoryFor(
  project: ProjectSpaceRecord,
  inventory: ProjectTopologyInventory
): TopologyWorktreeInventory {
  const result = inventory.worktreesByProjectScope[topologyProjectScope(project)]
    ?? { state: 'checking' as const };
  if (result.state === 'checking' || result.state === 'blocked') return result;
  const data = result.state === 'stale' ? result.data : result;
  const expectedPath = comparablePath(project.rootPath);
  const evidencePath = comparablePath(data.evidence.projectPath);
  const evidenceAt = Date.parse(data.evidence.checkedAt);
  const snapshotAt = Date.parse(inventory.checkedAt);
  const lastSafeAt = result.state === 'stale' ? Date.parse(result.lastSafeAt) : snapshotAt;
  if (data.state === 'ready' && hasConflictingWorktreeDuplicates(data.worktrees)) {
    return conflictingWorktreeEvidence(inventory.checkedAt);
  }
  const valid = Boolean(expectedPath)
    && evidencePath === expectedPath
    && [evidenceAt, snapshotAt, lastSafeAt].every(Number.isFinite)
    && evidenceAt <= lastSafeAt
    && lastSafeAt <= snapshotAt
    && (result.state === 'stale'
      ? evidenceAt === lastSafeAt
      : snapshotAt - evidenceAt <= 30_000)
    && (data.state !== 'ready' || data.worktrees.every((worktree) => (
      Boolean(comparablePath(worktree.path))
    )));
  return valid ? result : {
    checkedAt: inventory.checkedAt,
    message: 'Worktree evidence did not match the requested project root or snapshot.',
    reason: 'source-disagreement',
    state: 'blocked'
  };
}

function conflictingWorktreeEvidence(checkedAt: string): TopologyWorktreeInventory {
  return {
    checkedAt,
    message: 'Worktree evidence returned conflicting records for the same checkout identity.',
    reason: 'source-disagreement',
    state: 'blocked'
  };
}

function hasConflictingWorktreeDuplicates(worktrees: ProjectWorktreeRecord[]) {
  const byId = new Map<string, string>();
  const byPath = new Map<string, string>();
  for (const worktree of worktrees) {
    const path = comparablePath(worktree.path);
    const signature = JSON.stringify([
      worktree.id,
      worktree.name,
      path,
      worktree.branchName,
      worktree.detached,
      worktree.headCommittedAt,
      worktree.headSha,
      worktree.isBase,
      worktree.kind,
      worktree.locked,
      worktree.lockedReason,
      worktree.prunable,
      worktree.prunableReason,
      worktree.status,
      worktree.statusReason
    ]);
    const idSignature = byId.get(worktree.id);
    const pathSignature = byPath.get(path);
    if (
      (idSignature !== undefined && idSignature !== signature)
      || (pathSignature !== undefined && pathSignature !== signature)
    ) return true;
    byId.set(worktree.id, signature);
    byPath.set(path, signature);
  }
  return false;
}

export function topologyProjectScope(project: Pick<ProjectSpaceRecord, 'id' | 'machineId'>) {
  return `${encodeURIComponent(project.machineId ?? 'unknown')}:${encodeURIComponent(project.id)}`;
}

export function dedupeSessions(sessions: CodexSessionRecord[]) {
  return [...new Map(sessions.map((session) => [
    `${encodeURIComponent(session.machineId)}:${encodeURIComponent(session.id)}`,
    session
  ])).values()];
}

export function mapInventory<T, U>(
  result: TopologyInventoryResult<T>,
  select: (data: T) => U
): TopologyInventoryResult<U> {
  return result.state === 'ready' || result.state === 'stale'
    ? { ...result, data: select(result.data) }
    : result;
}

export function comparablePath(value: string) {
  if (/[\u0000-\u001f\u007f]/.test(value) || value !== value.trim()) return '';
  const windowsPath = /^[A-Za-z]:[\\/]/.test(value);
  if (!windowsPath && value.includes('\\')) return '';
  const normalized = (windowsPath ? value.replace(/\\/g, '/') : value)
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '');
  if (!normalized.startsWith('/') && !/^[A-Za-z]:\//.test(normalized)) return '';
  if (normalized.split('/').some((segment) => segment === '.' || segment === '..')) return '';
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function containsPath(root: string, path: string) {
  return root.length > 1 && (path === root || path.startsWith(`${root}/`));
}

function dedupeWorktrees(worktrees: ProjectWorktreeRecord[]) {
  return [...new Map(worktrees.map((worktree) => [
    comparablePath(worktree.path),
    worktree
  ])).values()];
}

function usableWorktree(worktree: ProjectWorktreeRecord) {
  return worktree.status === 'ready' || worktree.status === 'locked';
}

function normalizeBranch(value: string) {
  return value.trim().replace(/^refs\/heads\//, '');
}

function baseSignature(worktree: ProjectWorktreeRecord) {
  const branch = worktree.branchName ? normalizeBranch(worktree.branchName) : '';
  return branch && /^[0-9a-f]{40}$/i.test(worktree.headSha ?? '')
    ? `${branch}:${worktree.headSha!.toLowerCase()}`
    : undefined;
}
