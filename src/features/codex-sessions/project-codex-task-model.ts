import type { ProjectSpaceRecord } from '../../shared/project-space-api';
import type {
  CodexMachine,
  CodexMachineStatus,
  CodexSession,
  ProjectCodexTaskStatus
} from './codex-sessions-types';

export type ProjectCodexTaskAttention = 'waiting-approval' | 'waiting-input';

export interface ProjectCodexTask extends Omit<CodexSession, 'status' | 'title'> {
  active: boolean;
  id: string;
  issueNumber?: number;
  pullRequestNumber?: number;
  rawTitle: string;
  status: ProjectCodexTaskStatus;
  title: string;
}

export interface ProjectCodexTaskMachineGroup {
  machine: CodexMachine;
  tasks: ProjectCodexTask[];
}

export interface ProjectCodexTaskStatusPresentation {
  indicator: 'dot' | 'spinner';
  label: string;
  loading: boolean;
  status: ProjectCodexTaskStatus;
}

interface ProjectPathScope {
  machineId: string;
  managedWorktreesRoot: string;
  projectRoot: string;
}

export function projectCodexTaskId(machineId: string, threadId: string) {
  return `codex-task:${encodeURIComponent(machineId)}:${encodeURIComponent(threadId)}`;
}

export function projectCodexTasks(
  sessions: readonly CodexSession[],
  projectRecords: readonly ProjectSpaceRecord[],
  attentionByTaskId: Readonly<Partial<Record<string, ProjectCodexTaskAttention>>> = {}
): ProjectCodexTask[] {
  const scopes = projectRecords.flatMap(projectPathScope);
  const tasks = new Map<string, ProjectCodexTask>();
  for (const session of sessions) {
    if (!session.cwd || !scopes.some((scope) => sessionMatchesScope(session, scope))) continue;
    const id = projectCodexTaskId(session.machineId, session.threadId);
    const status: ProjectCodexTaskStatus = attentionByTaskId[id]
      ?? (session.attention === 'approval'
        ? 'waiting-approval'
        : session.attention === 'input'
          ? 'waiting-input'
          : session.status);
    const title = parseProjectCodexTaskTitle(session.title);
    const task: ProjectCodexTask = {
      ...session,
      active: status === 'active' || status === 'waiting-approval' || status === 'waiting-input',
      id,
      ...(title.issueNumber ? { issueNumber: title.issueNumber } : {}),
      ...(title.pullRequestNumber ? { pullRequestNumber: title.pullRequestNumber } : {}),
      rawTitle: session.title,
      status,
      title: title.title
    };
    const existing = tasks.get(id);
    if (!existing || activityTimestamp(task) > activityTimestamp(existing)) tasks.set(id, task);
  }
  return [...tasks.values()].sort(compareTasks);
}

export function groupProjectCodexTasks(
  tasks: readonly ProjectCodexTask[],
  machines: readonly CodexMachine[],
  scopedMachineIds: readonly string[] = []
): ProjectCodexTaskMachineGroup[] {
  const machineById = new Map(machines.map((machine) => [machine.id, machine]));
  const orderedMachineIds = [...new Set([
    ...machines.map((machine) => machine.id),
    ...scopedMachineIds,
    ...tasks.map((task) => task.machineId)
  ])];
  const orderById = new Map(orderedMachineIds.map((machineId, index) => [machineId, index]));
  const grouped = new Map<string, ProjectCodexTask[]>();
  for (const machineId of scopedMachineIds) grouped.set(machineId, []);
  for (const task of tasks) {
    grouped.set(task.machineId, [...(grouped.get(task.machineId) ?? []), task]);
  }
  return [...grouped.entries()].map(([machineId, machineTasks]) => ({
    machine: machineById.get(machineId) ?? {
      id: machineId,
      name: 'Unavailable machine',
      status: 'unavailable' as const,
      statusDetail: 'This task\'s owning machine is not in the current authenticated inventory.'
    },
    tasks: [...machineTasks].sort(compareTasks)
  })).sort((left, right) => {
    const leftOrder = orderById.get(left.machine.id) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = orderById.get(right.machine.id) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.machine.name.localeCompare(right.machine.name);
  });
}

export function countActiveProjectCodexTasks(
  tasks: readonly ProjectCodexTask[],
  groups: readonly ProjectCodexTaskMachineGroup[]
) {
  const machineStatus = new Map(groups.map((group) => [group.machine.id, group.machine.status]));
  return tasks.filter((task) => task.active && machineStatus.get(task.machineId) === 'connected').length;
}

export function presentProjectCodexTaskStatus(
  status: ProjectCodexTaskStatus,
  machineStatus: CodexMachineStatus = 'connected'
): ProjectCodexTaskStatusPresentation {
  const effectiveStatus = machineStatus === 'offline'
    ? 'offline'
    : machineStatus === 'unavailable'
      ? 'unavailable'
      : status;
  if (effectiveStatus === 'active') {
    return { indicator: 'spinner', label: 'Active', loading: true, status: effectiveStatus };
  }
  const label: Record<Exclude<ProjectCodexTaskStatus, 'active'>, string> = {
    archived: 'Archived',
    idle: 'Idle',
    missing: 'No longer available',
    offline: 'Offline',
    unavailable: 'Unavailable',
    'waiting-approval': 'Waiting for approval',
    'waiting-input': 'Waiting for input'
  };
  return { indicator: 'dot', label: label[effectiveStatus], loading: false, status: effectiveStatus };
}

function projectPathScope(project: ProjectSpaceRecord): ProjectPathScope[] {
  if (!project.machineId) return [];
  const projectRoot = comparablePath(project.rootPath);
  if (!projectRoot) return [];
  const separator = projectRoot.lastIndexOf('/');
  if (separator < 1 || separator === projectRoot.length - 1) return [];
  const parent = projectRoot.slice(0, separator);
  const repositoryName = projectRoot.slice(separator + 1);
  return [{
    machineId: project.machineId,
    managedWorktreesRoot: `${parent}/.worktrees/${repositoryName}`,
    projectRoot
  }];
}

function sessionMatchesScope(session: CodexSession, scope: ProjectPathScope) {
  if (session.machineId !== scope.machineId) return false;
  const cwd = comparablePath(session.cwd);
  return Boolean(cwd) && (
    containsPath(scope.projectRoot, cwd!)
    || containsPath(scope.managedWorktreesRoot, cwd!)
  );
}

function comparablePath(value: string | undefined) {
  if (!value) return undefined;
  const normalized = value.trim().replaceAll('\\', '/').replace(/\/{2,}/g, '/');
  if (!normalized || normalized.split('/').some((segment) => segment === '..')) return undefined;
  const withoutTrailingSlash = normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
  return /^[A-Za-z]:\//.test(withoutTrailingSlash)
    ? withoutTrailingSlash.toLocaleLowerCase()
    : withoutTrailingSlash;
}

function containsPath(root: string, candidate: string) {
  return candidate === root || candidate.startsWith(`${root}/`);
}

export function parseProjectCodexTaskTitle(rawTitle: string) {
  const parts = rawTitle.split(/\s*·\s*/).map((part) => part.trim()).filter(Boolean);
  let issueNumber: number | undefined;
  let pullRequestNumber: number | undefined;
  let consumed = 0;
  for (const part of parts) {
    const issue = part.match(/^(?:issue\s*)?#(\d+)$/i);
    const pullRequest = part.match(/^(?:pr|pull request)\s*#?(\d+)$/i);
    if (issue && issueNumber === undefined) {
      issueNumber = Number(issue[1]);
      consumed += 1;
      continue;
    }
    if (pullRequest && pullRequestNumber === undefined) {
      pullRequestNumber = Number(pullRequest[1]);
      consumed += 1;
      continue;
    }
    break;
  }
  return {
    issueNumber,
    pullRequestNumber,
    title: parts.slice(consumed).join(' · ') || rawTitle.trim() || 'Untitled Codex task'
  };
}

function activityTimestamp(task: ProjectCodexTask) {
  const timestamp = Date.parse(task.lastActivityAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function compareTasks(left: ProjectCodexTask, right: ProjectCodexTask) {
  return activityTimestamp(right) - activityTimestamp(left)
    || left.title.localeCompare(right.title)
    || left.id.localeCompare(right.id);
}
