import type {
  MachineRecord,
  PhysicalMachineRecord,
  ProjectSpaceRecord
} from '../../shared/project-space-api';
import { connectorInstallationLabel } from '../project-desktop/components/machine-connector-topology-model';
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
  connectorIds: string[];
  connectorLabels: Record<string, string>;
  connectorStatuses: Record<string, CodexMachineStatus>;
  machine: CodexMachine;
  tasks: ProjectCodexTask[];
}

export interface ProjectCodexTaskStatusPresentation {
  indicator: 'dot' | 'spinner';
  label: string;
  loading: boolean;
  status: ProjectCodexTaskStatus;
}

export type ProjectCodexTaskBucket = 'running' | 'attention' | 'ready' | 'history';

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
    const terminalInventoryStatus: ProjectCodexTaskStatus | undefined = [
      'archived',
      'missing',
      'offline',
      'unavailable'
    ].includes(session.status) ? session.status : undefined;
    const snapshotStatus: ProjectCodexTaskStatus | undefined = terminalInventoryStatus
      ?? (session.activity?.currentTurnState === 'waiting-for-approval'
      ? 'waiting-approval'
      : session.activity?.currentTurnState === 'waiting-for-user'
        ? 'waiting-input'
        : session.activity?.conversationState === 'running'
          ? 'active'
          : session.activity?.machineState === 'offline'
            ? 'offline'
            : session.activity?.processState === 'failed'
              ? 'unavailable'
              : undefined);
    const status: ProjectCodexTaskStatus = attentionByTaskId[id]
      ?? (session.attention === 'approval'
        ? 'waiting-approval'
        : session.attention === 'input'
          ? 'waiting-input'
          : snapshotStatus ?? session.status);
    const title = parseProjectCodexTaskTitle(session.title);
    const issueNumber = session.taskIdentity?.issueNumber ?? title.issueNumber;
    const task: ProjectCodexTask = {
      ...session,
      active: status === 'active' || status === 'waiting-approval' || status === 'waiting-input',
      id,
      ...(issueNumber ? { issueNumber } : {}),
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
  scopedMachineIds: readonly string[] = [],
  topology: {
    connectors?: readonly MachineRecord[];
    physicalMachines?: readonly PhysicalMachineRecord[];
  } = {}
): ProjectCodexTaskMachineGroup[] {
  const machineById = new Map(machines.map((machine) => [machine.id, machine]));
  const connectorRecordById = new Map(
    (topology.connectors ?? []).map((connector) => [connector.id, connector])
  );
  const physicalMachines = topology.physicalMachines ?? [];
  const physicalMemberships = new Map<string, PhysicalMachineRecord[]>();
  for (const physicalMachine of physicalMachines) {
    for (const connectorId of new Set(physicalMachine.connectorIds)) {
      const memberships = physicalMemberships.get(connectorId) ?? [];
      memberships.push(physicalMachine);
      physicalMemberships.set(connectorId, memberships);
    }
  }
  const physicalMachineByConnectorId = new Map(
    [...physicalMemberships].flatMap(([connectorId, memberships]) =>
      memberships.length === 1 ? [[connectorId, memberships[0]!] as const] : [])
  );
  const orderedMachineIds = [...new Set([
    ...machines.map((machine) => machine.id),
    ...scopedMachineIds,
    ...tasks.map((task) => task.machineId)
  ])];
  const groupIdForConnector = (connectorId: string) =>
    physicalMachineByConnectorId.get(connectorId)?.id ?? connectorId;
  const orderById = new Map<string, number>();
  for (const [index, connectorId] of orderedMachineIds.entries()) {
    const groupId = groupIdForConnector(connectorId);
    if (!orderById.has(groupId)) orderById.set(groupId, index);
  }
  const grouped = new Map<string, { connectorIds: Set<string>; tasks: ProjectCodexTask[] }>();
  for (const machineId of scopedMachineIds) {
    const groupId = groupIdForConnector(machineId);
    const group = grouped.get(groupId) ?? { connectorIds: new Set<string>(), tasks: [] };
    group.connectorIds.add(machineId);
    grouped.set(groupId, group);
  }
  for (const task of tasks) {
    const groupId = groupIdForConnector(task.machineId);
    const group = grouped.get(groupId) ?? { connectorIds: new Set<string>(), tasks: [] };
    group.connectorIds.add(task.machineId);
    group.tasks.push(task);
    grouped.set(groupId, group);
  }
  return [...grouped.entries()].map(([groupId, group]) => {
    const connectorIds = [...group.connectorIds];
    const connectorMachines = connectorIds.map((id) => machineById.get(id)).filter(
      (machine): machine is CodexMachine => Boolean(machine)
    );
    const physicalMachine = physicalMachines.find((machine) => machine.id === groupId);
    const aggregateStatus: CodexMachineStatus = connectorMachines.some((machine) => machine.status === 'connected')
      ? 'connected'
      : connectorMachines.length > 0 && connectorMachines.every((machine) => machine.status === 'offline')
        ? 'offline'
        : 'unavailable';
    const fallbackConnector = connectorMachines[0];
    const machine: CodexMachine = physicalMachine
      ? {
          id: physicalMachine.id,
          name: physicalMachine.name,
          status: aggregateStatus,
          statusDetail: connectorMachines.map((connector) => connector.statusDetail).find(Boolean)
        }
      : fallbackConnector ?? {
          id: groupId,
          name: 'Unavailable connector',
          status: 'unavailable',
          statusDetail: 'This task\'s owning connector is not in the current authenticated inventory.'
        };
    return {
      connectorIds,
      connectorLabels: Object.fromEntries(connectorIds.map((connectorId) => {
        const connector = connectorRecordById.get(connectorId);
        return [connectorId, connector ? connectorInstallationLabel(connector) : machineById.get(connectorId)?.name ?? connectorId];
      })),
      connectorStatuses: Object.fromEntries(connectorIds.map((connectorId) => [
        connectorId,
        machineById.get(connectorId)?.status ?? 'unavailable'
      ])),
      machine,
      tasks: [...group.tasks].sort(compareTasks)
    };
  }).sort((left, right) => {
    const leftOrder = orderById.get(left.machine.id) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = orderById.get(right.machine.id) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.machine.name.localeCompare(right.machine.name);
  });
}

export function countActiveProjectCodexTasks(
  tasks: readonly ProjectCodexTask[],
  groups: readonly ProjectCodexTaskMachineGroup[]
) {
  const connectorStatus = new Map(groups.flatMap((group) =>
    Object.entries(group.connectorStatuses)
  ));
  return tasks.filter((task) => task.active && connectorStatus.get(task.machineId) === 'connected').length;
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
    return { indicator: 'spinner', label: 'Running', loading: true, status: effectiveStatus };
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

export function projectCodexTaskBucket(
  task: ProjectCodexTask,
  machineStatus: CodexMachineStatus = 'connected'
): ProjectCodexTaskBucket {
  if (machineStatus !== 'connected' || ['archived', 'missing', 'offline', 'unavailable'].includes(task.status) || task.activity?.freshness === 'stale') {
    return 'history';
  }
  if (task.status === 'waiting-approval' || task.status === 'waiting-input' || task.activity?.conversationState === 'failed') {
    return 'attention';
  }
  if (task.status === 'active' || task.activity?.conversationState === 'running') return 'running';
  return 'ready';
}

export function projectCodexTaskPrimaryAction(
  task: ProjectCodexTask,
  machineStatus: CodexMachineStatus = 'connected'
) {
  const bucket = projectCodexTaskBucket(task, machineStatus);
  if (bucket === 'attention' || machineStatus !== 'connected') return 'Resolve problem' as const;
  if (bucket === 'ready') return 'Continue' as const;
  return 'Open task' as const;
}

/**
 * Resolves the project a Codex thread runs in by matching its working directory
 * against each project root and its managed worktrees, on the same machine.
 */
export function projectForCodexSession(
  session: Pick<CodexSession, 'cwd' | 'machineId'>,
  projects: readonly ProjectSpaceRecord[]
): ProjectSpaceRecord | undefined {
  if (!session.cwd) return undefined;
  let match: { depth: number; project: ProjectSpaceRecord } | undefined;
  for (const project of projects) {
    for (const scope of projectPathScope(project)) {
      if (!sessionMatchesScope(session, scope)) continue;
      // A worktree root is longer than its project root, so the deepest scope
      // wins when nested projects both contain the directory.
      const depth = scope.projectRoot.length;
      if (!match || depth > match.depth) match = { depth, project };
    }
  }
  return match?.project;
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

function sessionMatchesScope(
  session: Pick<CodexSession, 'cwd' | 'machineId'>,
  scope: ProjectPathScope
) {
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
  const bucketOrder: Record<ProjectCodexTaskBucket, number> = {
    running: 0,
    attention: 1,
    ready: 2,
    history: 3
  };
  return bucketOrder[projectCodexTaskBucket(left)] - bucketOrder[projectCodexTaskBucket(right)]
    || activityTimestamp(right) - activityTimestamp(left)
    || left.title.localeCompare(right.title)
    || left.id.localeCompare(right.id);
}
