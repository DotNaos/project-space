import type {
  ProjectSpaceRecord,
  ProjectWorktreeRecord
} from '@/shared/project-space-api';
import type { CodexSessionRecord } from '@/shared/codex-sessions-api';
import { validateCodexInventory } from './project-topology-evidence';
import {
  comparablePath,
  containsPath,
  dedupeSessions,
  worktreeInventoryFor,
  worktreesFor
} from './project-topology-inventory-evidence';
import {
  topologyTaskId,
  type ProjectTopologyInventory
} from './project-topology-types';

interface MatchProjectGroup {
  id: string;
  records: ProjectSpaceRecord[];
}

export interface ProjectTopologyTaskMatch {
  canonicalCwd: string;
  current: boolean;
  lastSafeAt?: string;
  matchedPath: string;
  projectId: string;
  projectRecord: ProjectSpaceRecord;
  score: number;
  type: 'project-root' | 'worktree';
  worktree?: ProjectWorktreeRecord;
}

interface ProjectTopologyTaskBoundary {
  match?: ProjectTopologyTaskMatch;
  specificity: number;
}

export function matchCodexTasks(
  groups: MatchProjectGroup[],
  inventory: ProjectTopologyInventory
): Map<string, ProjectTopologyTaskMatch> {
  const candidates = groups.flatMap((group) => group.records.map((record) => ({
    group,
    record,
    worktreeInventory: worktreeInventoryFor(record, inventory),
    worktrees: worktreesFor(record, inventory)
  })));
  const matches = new Map<string, ProjectTopologyTaskMatch>();
  for (const [machineId, unvalidated] of Object.entries(inventory.codexByMachineId)) {
    const result = validateCodexInventory(machineId, unvalidated);
    if (result.state !== 'ready' && result.state !== 'stale') continue;
    for (const session of dedupeSessions(result.data.sessions)) {
      const canonicalCwd = canonicalTaskCwd(session, inventory);
      if (!canonicalCwd || session.machineId !== machineId) continue;
      const boundaries = candidates
        .filter(({ record }) => record.machineId === machineId)
        .flatMap(({ group, record, worktreeInventory, worktrees }) => taskBoundaries(
          group.id,
          record,
          worktrees,
          canonicalCwd,
          worktreeInventory.state === 'ready' || worktreeInventory.state === 'proven-empty',
          worktreeInventory.state === 'stale' ? worktreeInventory.lastSafeAt : undefined
        ));
      const highestSpecificity = Math.max(
        ...boundaries.map((boundary) => boundary.specificity)
      );
      const ranked = boundaries
        .filter((boundary) => boundary.specificity === highestSpecificity)
        .flatMap((boundary) => boundary.match ? [boundary.match] : [])
        .sort((left, right) => right.score - left.score);
      const bestScore = ranked[0]?.score;
      const strongest = ranked.filter((candidate) => candidate.score === bestScore);
      const match = new Set(strongest.map((candidate) => candidate.projectId)).size === 1
        && new Set(strongest.map(taskMatchIdentity)).size === 1
        ? strongest[0]
        : undefined;
      if (match) matches.set(topologyTaskId(machineId, session.id), match);
    }
  }
  return matches;
}

function taskBoundaries(
  projectId: string,
  projectRecord: ProjectSpaceRecord,
  worktrees: ProjectWorktreeRecord[],
  canonicalCwd: string,
  current: boolean,
  lastSafeAt: string | undefined
): ProjectTopologyTaskBoundary[] {
  const boundaries: ProjectTopologyTaskBoundary[] = [];
  const cwd = comparablePath(canonicalCwd);
  if (!cwd) return boundaries;
  let insideKnownWorktree = false;
  for (const worktree of worktrees) {
    const path = comparablePath(worktree.path);
    if (!containsPath(path, cwd)) continue;
    insideKnownWorktree = true;
    const usable = worktree.status === 'ready' || worktree.status === 'locked';
    boundaries.push({
      match: usable ? {
        canonicalCwd: cwd,
        current,
        lastSafeAt,
        matchedPath: worktree.path,
        projectId,
        projectRecord,
        score: 10_000 + path.length + (cwd === path ? 1_000 : 0),
        type: 'worktree',
        worktree
      } : undefined,
      specificity: path.length
    });
  }
  const rootPath = comparablePath(projectRecord.rootPath);
  if (containsPath(rootPath, cwd)) {
    boundaries.push({
      match: current && !insideKnownWorktree ? {
        canonicalCwd: cwd,
        current: true,
        matchedPath: projectRecord.rootPath,
        projectId,
        projectRecord,
        score: 1_000 + rootPath.length + (cwd === rootPath ? 500 : 0),
        type: 'project-root'
      } : undefined,
      specificity: rootPath.length
    });
  }
  return boundaries;
}

function taskMatchIdentity(match: ProjectTopologyTaskMatch) {
  return [
    match.projectRecord.id,
    match.type,
    comparablePath(match.matchedPath),
    match.worktree?.id ?? ''
  ].join(':');
}

function canonicalTaskCwd(
  session: CodexSessionRecord,
  inventory: ProjectTopologyInventory
) {
  const evidence = inventory.taskLocationsByTaskId?.[
    topologyTaskId(session.machineId, session.id)
  ];
  if (
    !evidence
    || evidence.machineId !== session.machineId
    || evidence.threadId !== session.id
    || evidence.source !== 'connector-realpath'
  ) return undefined;
  const checkedAt = Date.parse(evidence.checkedAt);
  const sessionLastActivityAt = Date.parse(session.lastActivityAt);
  const snapshotCheckedAt = Date.parse(inventory.checkedAt);
  const canonicalCwd = comparablePath(evidence.canonicalCwd);
  return Number.isFinite(checkedAt)
    && Number.isFinite(snapshotCheckedAt)
    && Number.isFinite(sessionLastActivityAt)
    && sessionLastActivityAt <= checkedAt
    && checkedAt <= snapshotCheckedAt
    && snapshotCheckedAt - checkedAt <= 30_000
    && canonicalCwd
    ? canonicalCwd
    : undefined;
}
