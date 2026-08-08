import type {
  MachineRecord,
  PhysicalMachineRecord,
  ProjectSpaceRecord
} from '../../shared/project-space-api';
import { matchesFuzzyQuery } from '../../lib/fuzzy-search';
import type {
  CodexMachine,
  CodexMachineStatus,
  CodexSession,
  ProjectCodexTaskStatus
} from './codex-sessions-types';
import {
  parseProjectCodexTaskTitle,
  projectCodexTaskId,
  projectForCodexSession
} from './project-codex-task-model';

export interface CodexThreadDirectoryEntry {
  active: boolean;
  connectorId: string;
  cwd?: string;
  id: string;
  issueNumber?: number;
  lastActivityAt: string;
  /** Project the working directory belongs to, when one owns it. */
  projectId?: string;
  projectName?: string;
  pullRequestNumber?: number;
  searchTerms: string[];
  status: ProjectCodexTaskStatus;
  threadId: string;
  title: string;
}

export interface CodexThreadDirectoryMachine {
  entries: CodexThreadDirectoryEntry[];
  id: string;
  name: string;
  status: CodexMachineStatus;
  statusDetail?: string;
}

export interface CodexThreadDirectoryInput {
  connectors?: readonly MachineRecord[];
  machines: readonly CodexMachine[];
  physicalMachines?: readonly PhysicalMachineRecord[];
  projects: readonly ProjectSpaceRecord[];
  sessions: readonly CodexSession[];
}

function entryStatus(session: CodexSession): ProjectCodexTaskStatus {
  if (session.attention === 'approval') return 'waiting-approval';
  if (session.attention === 'input') return 'waiting-input';
  return session.status;
}

function activityTimestamp(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function machineRank(status: CodexMachineStatus) {
  return status === 'connected' ? 0 : status === 'offline' ? 1 : 2;
}

/**
 * Every Codex thread the controller has loaded, on every machine, grouped by the
 * physical machine that owns the connector. Unlike `projectCodexTasks` this keeps
 * threads that no project owns, because the directory is the place to find them.
 */
export function codexThreadDirectory({
  machines,
  physicalMachines = [],
  projects,
  sessions
}: CodexThreadDirectoryInput): CodexThreadDirectoryMachine[] {
  const machineById = new Map(machines.map((machine) => [machine.id, machine]));
  const physicalMachineByConnectorId = new Map<string, PhysicalMachineRecord>();
  for (const physicalMachine of physicalMachines) {
    for (const connectorId of physicalMachine.connectorIds) {
      if (!physicalMachineByConnectorId.has(connectorId)) {
        physicalMachineByConnectorId.set(connectorId, physicalMachine);
      }
    }
  }
  const groupIdFor = (connectorId: string) =>
    physicalMachineByConnectorId.get(connectorId)?.id ?? connectorId;

  const groups = new Map<string, { connectorIds: Set<string>; entries: CodexThreadDirectoryEntry[] }>();
  const ensureGroup = (groupId: string) => {
    const group = groups.get(groupId) ?? { connectorIds: new Set<string>(), entries: [] };
    groups.set(groupId, group);
    return group;
  };

  for (const machine of machines) {
    ensureGroup(groupIdFor(machine.id)).connectorIds.add(machine.id);
  }

  const seen = new Set<string>();
  for (const session of sessions) {
    const id = projectCodexTaskId(session.machineId, session.threadId);
    if (seen.has(id)) continue;
    seen.add(id);
    const project = projectForCodexSession(session, projects);
    const title = parseProjectCodexTaskTitle(session.title);
    const status = entryStatus(session);
    const group = ensureGroup(groupIdFor(session.machineId));
    group.connectorIds.add(session.machineId);
    group.entries.push({
      active: status === 'active' || status === 'waiting-approval' || status === 'waiting-input',
      connectorId: session.machineId,
      cwd: session.cwd,
      id,
      ...(title.issueNumber ? { issueNumber: title.issueNumber } : {}),
      lastActivityAt: session.lastActivityAt,
      ...(project ? { projectId: project.id } : {}),
      ...(project?.name || session.projectName
        ? { projectName: project?.github?.name ?? project?.name ?? session.projectName }
        : {}),
      ...(title.pullRequestNumber ? { pullRequestNumber: title.pullRequestNumber } : {}),
      searchTerms: [
        title.title,
        session.title,
        session.threadId,
        session.cwd,
        session.projectName,
        project?.name,
        project?.github?.fullName
      ].flatMap((term) => (term ? [term] : [])),
      status,
      threadId: session.threadId,
      title: title.title
    });
  }

  return [...groups.entries()].flatMap<CodexThreadDirectoryMachine>(([groupId, group]) => {
    const connectorIds = [...group.connectorIds];
    const connectorMachines = connectorIds.flatMap((connectorId) => {
      const machine = machineById.get(connectorId);
      return machine ? [machine] : [];
    });
    const physicalMachine = physicalMachines.find((machine) => machine.id === groupId);
    const status: CodexMachineStatus = connectorMachines.some((machine) => machine.status === 'connected')
      ? 'connected'
      : connectorMachines.length > 0 && connectorMachines.every((machine) => machine.status === 'offline')
        ? 'offline'
        : 'unavailable';
    if (group.entries.length === 0 && status === 'unavailable') return [];

    return [{
      entries: group.entries.sort((left, right) =>
        activityTimestamp(right.lastActivityAt) - activityTimestamp(left.lastActivityAt) ||
        left.title.localeCompare(right.title)
      ),
      id: groupId,
      name: physicalMachine?.name ?? connectorMachines[0]?.name ?? groupId,
      status,
      statusDetail: connectorMachines.map((machine) => machine.statusDetail).find(Boolean)
    }];
  }).sort((left, right) =>
    machineRank(left.status) - machineRank(right.status) || left.name.localeCompare(right.name)
  );
}

export function filterCodexThreadDirectory(
  machines: readonly CodexThreadDirectoryMachine[],
  query: string,
  { activeOnly = false }: { activeOnly?: boolean } = {}
): CodexThreadDirectoryMachine[] {
  return machines.flatMap((machine) => {
    const entries = machine.entries.filter((entry) => (
      (!activeOnly || entry.active) &&
      matchesFuzzyQuery([...entry.searchTerms, machine.name], query)
    ));
    return entries.length > 0 ? [{ ...machine, entries }] : [];
  });
}

export function countCodexThreadDirectory(machines: readonly CodexThreadDirectoryMachine[]) {
  return machines.reduce((total, machine) => total + machine.entries.length, 0);
}
