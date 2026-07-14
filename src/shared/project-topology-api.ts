import type {
  ProjectDiscoveryResult,
  ProjectSpaceRecord,
  ProjectWorktreeDiscoveryResult,
  ProjectWorktreeRecord
} from './project-space-api';

export interface ProjectTopologyProjectWorktreeEntry {
  machineId?: string;
  projectId: string;
  result: ProjectWorktreeDiscoveryResult;
}

export interface ProjectTopologyWorktreeSnapshot {
  authorization: {
    connectorOverviewCheckedAt: string;
    projectDiscoveryCheckedAt: string;
  };
  checkedAt: string;
  publishedAt: string;
  projectDiscovery: ProjectDiscoveryResult;
  worktrees: ProjectTopologyProjectWorktreeEntry[];
}

const blockedReasons = new Set([
  'connector-update-required',
  'project-mismatch',
  'request-failed',
  'scan-failed',
  'source-disagreement'
]);
const projectKinds = new Set(['github', 'standalone', 'workspace']);
const worktreeKinds = new Set(['codex', 'external', 'project-managed']);
const worktreeStatuses = new Set([
  'broken',
  'locked',
  'missing',
  'prunable',
  'ready',
  'unavailable'
]);

export function projectTopologyProjectScope(
  project: { id: string; machineId?: string }
) {
  return projectTopologyWorktreeEntryScope({
    machineId: project.machineId,
    projectId: project.id
  });
}

export function projectTopologyWorktreeEntryScope(
  entry: Pick<ProjectTopologyProjectWorktreeEntry, 'machineId' | 'projectId'>
) {
  return `${encodeURIComponent(entry.machineId ?? 'unknown')}:${encodeURIComponent(entry.projectId)}`;
}

export function parseProjectTopologyWorktreeSnapshot(
  value: unknown
): ProjectTopologyWorktreeSnapshot {
  if (!isRecord(value) || !validSnapshotTimes(value)) {
    throw malformedSnapshot();
  }
  const discovery = value.projectDiscovery;
  if (!validDiscovery(discovery) || !Array.isArray(value.worktrees)) {
    throw malformedSnapshot();
  }
  const publishedAt = Date.parse(value.publishedAt as string);
  const projectsByScope = new Map<string, ProjectSpaceRecord[]>();
  for (const project of discovery.projects) {
    const scope = projectTopologyProjectScope(project);
    projectsByScope.set(scope, [...(projectsByScope.get(scope) ?? []), project]);
  }
  const entries = new Map<string, ProjectTopologyProjectWorktreeEntry>();
  for (const candidate of value.worktrees) {
    if (!validEntry(candidate, publishedAt)) throw malformedSnapshot();
    const scope = projectTopologyWorktreeEntryScope(candidate);
    const projects = projectsByScope.get(scope);
    if (!projects || entries.has(scope)) throw malformedSnapshot();
    const roots = new Set(projects.map((project) => project.rootPath));
    if (!resultMatchesRoots(candidate.result, roots)) throw malformedSnapshot();
    entries.set(scope, candidate);
  }
  if (entries.size !== projectsByScope.size) throw malformedSnapshot();

  return value as unknown as ProjectTopologyWorktreeSnapshot;
}

function validSnapshotTimes(value: Record<string, unknown>) {
  if (
    !validTimestamp(value.checkedAt)
    || !validTimestamp(value.publishedAt)
    || !isRecord(value.authorization)
    || !validTimestamp(value.authorization.connectorOverviewCheckedAt)
    || !validTimestamp(value.authorization.projectDiscoveryCheckedAt)
  ) return false;
  const checkedAt = Date.parse(value.checkedAt);
  const publishedAt = Date.parse(value.publishedAt);
  const connectorAt = Date.parse(value.authorization.connectorOverviewCheckedAt);
  const discoveryAt = Date.parse(value.authorization.projectDiscoveryCheckedAt);
  return checkedAt === Math.min(connectorAt, discoveryAt)
    && connectorAt <= publishedAt
    && discoveryAt <= publishedAt;
}

function validDiscovery(value: unknown): value is ProjectDiscoveryResult {
  return isRecord(value)
    && typeof value.rootPath === 'string'
    && Array.isArray(value.groups)
    && Array.isArray(value.projects)
    && Array.isArray(value.rootItems)
    && Array.isArray(value.structureViolations)
    && value.projects.every(validProject);
}

function validProject(value: unknown): value is ProjectSpaceRecord {
  return isRecord(value)
    && typeof value.id === 'string'
    && value.id.length > 0
    && typeof value.name === 'string'
    && typeof value.rootPath === 'string'
    && value.rootPath.length > 0
    && projectKinds.has(String(value.kind))
    && (value.machineId === undefined || typeof value.machineId === 'string');
}

function validEntry(
  value: unknown,
  publishedAt: number
): value is ProjectTopologyProjectWorktreeEntry {
  return isRecord(value)
    && typeof value.projectId === 'string'
    && value.projectId.length > 0
    && (value.machineId === undefined || typeof value.machineId === 'string')
    && validWorktreeResult(value.result, publishedAt);
}

function validWorktreeResult(value: unknown, publishedAt: number) {
  if (!isRecord(value) || typeof value.state !== 'string') return false;
  if (value.state === 'blocked') {
    return validTimestampAtOrBefore(value.checkedAt, publishedAt)
      && typeof value.message === 'string'
      && value.message.length > 0
      && blockedReasons.has(String(value.reason));
  }
  if (value.state !== 'ready' && value.state !== 'proven-empty') return false;
  if (!isRecord(value.evidence) || !Array.isArray(value.worktrees)) return false;
  if (
    !validTimestampAtOrBefore(value.evidence.checkedAt, publishedAt)
    || typeof value.evidence.projectPath !== 'string'
    || value.evidence.source !== 'git-worktree-list'
    || !value.worktrees.every(validWorktree)
  ) return false;
  return value.state === 'ready' ? value.worktrees.length > 0 : value.worktrees.length === 0;
}

function validWorktree(value: unknown): value is ProjectWorktreeRecord {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.path === 'string'
    && typeof value.detached === 'boolean'
    && typeof value.isBase === 'boolean'
    && typeof value.locked === 'boolean'
    && typeof value.prunable === 'boolean'
    && worktreeKinds.has(String(value.kind))
    && worktreeStatuses.has(String(value.status));
}

function resultMatchesRoots(
  result: ProjectWorktreeDiscoveryResult,
  roots: ReadonlySet<string>
) {
  if (roots.size !== 1) {
    return result.state === 'blocked' && result.reason === 'source-disagreement';
  }
  return result.state === 'blocked'
    || roots.has(result.evidence.projectPath);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validTimestampAtOrBefore(value: unknown, latest: number) {
  return validTimestamp(value) && Date.parse(value) <= latest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function malformedSnapshot() {
  return new Error('The topology project inventory response was malformed or inconsistent.');
}
