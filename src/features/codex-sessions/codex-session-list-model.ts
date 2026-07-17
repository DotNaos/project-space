import type {
  ConnectorInstallationRecord,
  PhysicalMachineRecord,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import {
  connectorInstallationLabel,
  groupConnectorInstallations
} from '../project-desktop/components/machine-connector-topology-model';
import {
  projectCodexTaskId,
  projectCodexTasks
} from './project-codex-task-model';
import { sortCodexSessions } from './codex-sessions-model';
import type {
  CodexMachine,
  CodexSession,
  ProjectCodexTaskStatus
} from './codex-sessions-types';

export const ALL_CODEX_MACHINES = 'all-machines';
export const ALL_CODEX_CONNECTORS = 'all-connectors';
export const UNGROUPED_CODEX_CONNECTORS = 'ungrouped-connectors';

export type CodexFilterAvailability = 'checking' | 'connected' | 'offline' | 'unavailable';

export interface CodexMachineFilterOption {
  availability: CodexFilterAvailability;
  connectorIds: string[];
  key: string;
  label: string;
}

export interface CodexConnectorFilterOption {
  availability: CodexFilterAvailability;
  connectorId?: string;
  key: string;
  label: string;
  location?: 'Local' | 'Remote';
  machineLabel?: string;
}

export interface CodexSessionProjectGroup {
  id: string;
  label: string;
  sessions: CodexSession[];
}

export interface CodexSessionListViewModel {
  connectorOptions: CodexConnectorFilterOption[];
  machineOptions: CodexMachineFilterOption[];
  normalizedConnectorKey: string;
  normalizedMachineKey: string;
  projectGroups: CodexSessionProjectGroup[];
  resultCount: number;
}

interface ProjectScopeGroup {
  id: string;
  label: string;
  records: ProjectSpaceRecord[];
}

export function buildCodexSessionListViewModel({
  connectorInstallations,
  loadingMachineIds,
  machines,
  physicalMachines,
  projects,
  query,
  selectedConnectorKey,
  selectedMachineKey,
  sessions
}: {
  connectorInstallations: readonly ConnectorInstallationRecord[];
  loadingMachineIds: readonly string[];
  machines: readonly CodexMachine[];
  physicalMachines: readonly PhysicalMachineRecord[];
  projects: readonly ProjectSpaceRecord[];
  query: string;
  selectedConnectorKey: string;
  selectedMachineKey: string;
  sessions: readonly CodexSession[];
}): CodexSessionListViewModel {
  const topology = groupConnectorInstallations({
    connectors: connectorInstallations,
    physicalMachines
  });
  const connectorRecordById = new Map(
    connectorInstallations.map((connector) => [connector.id, connector])
  );
  const codexMachineById = new Map(machines.map((machine) => [machine.id, machine]));
  const loadingIds = new Set(loadingMachineIds);
  const machineLabelByConnectorId = new Map<string, string>();
  const assignedConnectorIds = new Set<string>();
  const savedMembershipCounts = new Map<string, number>();
  for (const physicalMachine of physicalMachines) {
    for (const connectorId of new Set(physicalMachine.connectorIds)) {
      savedMembershipCounts.set(connectorId, (savedMembershipCounts.get(connectorId) ?? 0) + 1);
    }
  }
  const conflictingConnectorIds = new Set(
    [
      ...topology.conflicts.map((conflict) => conflict.connectorId),
      ...[...savedMembershipCounts].flatMap(([connectorId, count]) => (
        count > 1 ? [connectorId] : []
      ))
    ]
  );

  const physicalOptions = topology.machines.flatMap((machine) => {
    const connectorIds = machine.connectorIds.filter((connectorId) => (
      !conflictingConnectorIds.has(connectorId)
    ));
    if (connectorIds.length === 0) return [];
    for (const connectorId of connectorIds) {
      assignedConnectorIds.add(connectorId);
      machineLabelByConnectorId.set(connectorId, machine.name);
    }
    return [{
      availability: aggregateAvailability(
        connectorIds.map((id) => connectorAvailability(id, codexMachineById, connectorRecordById, loadingIds))
      ),
      connectorIds,
      key: physicalMachineKey(machine.id),
      label: machine.name
    } satisfies CodexMachineFilterOption];
  });

  const knownConnectorIds = new Set([
    ...connectorInstallations.map((connector) => connector.id),
    ...machines.map((machine) => machine.id),
    ...sessions.map((session) => session.machineId)
  ]);
  const ungroupedIds = [...knownConnectorIds].filter((id) => !assignedConnectorIds.has(id));
  const machineOptionsWithoutAll = [
    ...physicalOptions,
    ...(ungroupedIds.length > 0 ? [{
      availability: aggregateAvailability(
        ungroupedIds.map((id) => connectorAvailability(id, codexMachineById, connectorRecordById, loadingIds))
      ),
      connectorIds: ungroupedIds,
      key: UNGROUPED_CODEX_CONNECTORS,
      label: 'Ungrouped connectors'
    } satisfies CodexMachineFilterOption] : [])
  ];
  const allConnectorIds = machineOptionsWithoutAll.flatMap((option) => option.connectorIds);
  const machineOptions: CodexMachineFilterOption[] = [{
    availability: aggregateAvailability(
      allConnectorIds.map((id) => connectorAvailability(id, codexMachineById, connectorRecordById, loadingIds))
    ),
    connectorIds: allConnectorIds,
    key: ALL_CODEX_MACHINES,
    label: 'All'
  }, ...machineOptionsWithoutAll];
  const normalizedMachineKey = machineOptions.some((option) => option.key === selectedMachineKey)
    ? selectedMachineKey
    : ALL_CODEX_MACHINES;
  const selectedMachine = machineOptions.find((option) => option.key === normalizedMachineKey)!;
  const scopedConnectorIds = normalizedMachineKey === ALL_CODEX_MACHINES
    ? allConnectorIds
    : selectedMachine.connectorIds;
  const connectorOptions = buildConnectorOptions({
    codexMachineById,
    connectorRecordById,
    loadingIds,
    machineLabelByConnectorId,
    selectedMachineKey: normalizedMachineKey,
    scopedConnectorIds
  });
  const normalizedConnectorKey = connectorOptions.some((option) => option.key === selectedConnectorKey)
    ? selectedConnectorKey
    : ALL_CODEX_CONNECTORS;
  const selectedConnectorId = connectorIdFromKey(normalizedConnectorKey);
  const visibleConnectorIds = new Set(
    selectedConnectorId ? [selectedConnectorId] : scopedConnectorIds
  );
  const scopedSessions = sortCodexSessions(
    sessions.filter((session) => visibleConnectorIds.has(session.machineId))
  );
  const grouped = assignSessionsToProjects(scopedSessions, projects);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const projectGroups = grouped.flatMap((group) => {
    const filtered = normalizedQuery
      ? group.sessions.filter((session) => normalizedSessionSearchText({
          connector: connectorRecordById.get(session.machineId),
          groupLabel: group.label,
          machine: codexMachineById.get(session.machineId),
          machineLabel: machineLabelByConnectorId.get(session.machineId),
          session
        }).includes(normalizedQuery))
      : group.sessions;
    return filtered.length > 0 ? [{ ...group, sessions: filtered }] : [];
  });

  return {
    connectorOptions,
    machineOptions,
    normalizedConnectorKey,
    normalizedMachineKey,
    projectGroups,
    resultCount: projectGroups.reduce((count, group) => count + group.sessions.length, 0)
  };
}

export function codexSessionStatusPresentation({
  checking,
  machine,
  session
}: {
  checking: boolean;
  machine?: CodexMachine;
  session: CodexSession;
}) {
  const attention: ProjectCodexTaskStatus | undefined = session.attention === 'approval'
    ? 'waiting-approval'
    : session.attention === 'input'
      ? 'waiting-input'
      : undefined;
  if (checking) {
    return { indicator: 'spinner' as const, label: attention ? `${attentionLabel(attention)} · Checking` : 'Checking' };
  }
  const unavailable = machine?.status === 'offline'
    ? 'Offline'
    : machine?.status === 'unavailable'
      ? 'Unavailable'
      : undefined;
  if (unavailable) {
    return { indicator: 'dot' as const, label: attention ? `${attentionLabel(attention)} · ${unavailable}` : unavailable };
  }
  if (attention) return { indicator: 'dot' as const, label: attentionLabel(attention) };
  if (session.status === 'active') return { indicator: 'spinner' as const, label: 'Working' };
  const labels: Record<Exclude<CodexSession['status'], 'active'>, string> = {
    archived: 'Archived',
    idle: 'Idle',
    missing: 'No longer available',
    offline: 'Offline',
    unavailable: 'Unavailable'
  };
  return { indicator: 'dot' as const, label: labels[session.status] };
}

function buildConnectorOptions({
  codexMachineById,
  connectorRecordById,
  loadingIds,
  machineLabelByConnectorId,
  selectedMachineKey,
  scopedConnectorIds
}: {
  codexMachineById: ReadonlyMap<string, CodexMachine>;
  connectorRecordById: ReadonlyMap<string, ConnectorInstallationRecord>;
  loadingIds: ReadonlySet<string>;
  machineLabelByConnectorId: ReadonlyMap<string, string>;
  selectedMachineKey: string;
  scopedConnectorIds: readonly string[];
}) {
  const options = scopedConnectorIds.map((connectorId) => {
    const connector = connectorRecordById.get(connectorId);
    const machineLabel = machineLabelByConnectorId.get(connectorId);
    const location = connector?.connector.status === 'local'
      ? 'Local' as const
      : connector?.connector.status === 'online'
        ? 'Remote' as const
        : undefined;
    return {
      availability: connectorAvailability(connectorId, codexMachineById, connectorRecordById, loadingIds),
      connectorId,
      key: connectorKey(connectorId),
      label: connector ? connectorInstallationLabel(connector) : codexMachineById.get(connectorId)?.name ?? connectorId,
      location,
      machineLabel: selectedMachineKey === ALL_CODEX_MACHINES ? machineLabel ?? 'Ungrouped' : undefined
    } satisfies CodexConnectorFilterOption;
  }).sort((left, right) => (
    (left.machineLabel ?? '').localeCompare(right.machineLabel ?? '')
    || left.label.localeCompare(right.label)
    || left.connectorId.localeCompare(right.connectorId)
  ));
  return [{
    availability: aggregateAvailability(options.map((option) => option.availability)),
    key: ALL_CODEX_CONNECTORS,
    label: 'All connectors'
  } satisfies CodexConnectorFilterOption, ...options];
}

function assignSessionsToProjects(
  sessions: readonly CodexSession[],
  projects: readonly ProjectSpaceRecord[]
): CodexSessionProjectGroup[] {
  const scopes = projectScopeGroups(projects);
  const groupIdByTaskId = new Map<string, string>();
  for (const scope of [...scopes].sort((left, right) => (
    longestRoot(right.records) - longestRoot(left.records) || left.label.localeCompare(right.label)
  ))) {
    for (const task of projectCodexTasks(sessions, scope.records)) {
      if (!groupIdByTaskId.has(task.id)) groupIdByTaskId.set(task.id, scope.id);
    }
  }
  const sessionsByGroupId = new Map<string, CodexSession[]>();
  const other: CodexSession[] = [];
  for (const session of sessions) {
    const groupId = groupIdByTaskId.get(projectCodexTaskId(session.machineId, session.threadId));
    if (!groupId) {
      other.push(session);
      continue;
    }
    const entries = sessionsByGroupId.get(groupId) ?? [];
    entries.push(session);
    sessionsByGroupId.set(groupId, entries);
  }
  const groups = scopes.flatMap((scope) => {
    const entries = sessionsByGroupId.get(scope.id);
    return entries?.length ? [{ id: scope.id, label: scope.label, sessions: sortCodexSessions(entries) }] : [];
  }).sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
  if (other.length > 0) groups.push({ id: 'other', label: 'Other', sessions: sortCodexSessions(other) });
  return groups;
}

function projectScopeGroups(projects: readonly ProjectSpaceRecord[]) {
  const groups = new Map<string, ProjectScopeGroup>();
  for (const project of projects) {
    if (!project.machineId) continue;
    const id = projectScopeId(project);
    const group = groups.get(id) ?? { id, label: projectLabel(project), records: [] };
    group.records.push(project);
    groups.set(id, group);
  }
  return [...groups.values()];
}

function projectScopeId(project: ProjectSpaceRecord) {
  if (project.github?.fullName) return `github:${project.github.fullName.toLocaleLowerCase()}`;
  const scoped = project.id.match(/^connector-project:[A-Za-z0-9_-]+:([A-Za-z0-9_-]+)$/);
  return `project:${scoped?.[1] ?? project.id}`;
}

function projectLabel(project: ProjectSpaceRecord) {
  return project.github?.name || project.name || basenamePath(project.rootPath) || 'Untitled project';
}

function longestRoot(records: readonly ProjectSpaceRecord[]) {
  return Math.max(0, ...records.map((record) => record.rootPath.length));
}

function basenamePath(path: string) {
  return path.replaceAll('\\', '/').split('/').filter(Boolean).pop() ?? '';
}

function normalizedSessionSearchText({
  connector,
  groupLabel,
  machine,
  machineLabel,
  session
}: {
  connector?: ConnectorInstallationRecord;
  groupLabel: string;
  machine?: CodexMachine;
  machineLabel?: string;
  session: CodexSession;
}) {
  return [
    session.title,
    session.projectName,
    session.cwd,
    session.model,
    session.threadId,
    groupLabel,
    machineLabel,
    machine?.name,
    connector ? connectorInstallationLabel(connector) : undefined
  ].filter(Boolean).join(' ').toLocaleLowerCase();
}

function physicalMachineKey(id: string) {
  return `physical-machine:${id}`;
}

function connectorKey(id: string) {
  return `connector:${id}`;
}

function connectorIdFromKey(key: string) {
  return key.startsWith('connector:') ? key.slice('connector:'.length) : undefined;
}

function connectorAvailability(
  connectorId: string,
  codexMachineById: ReadonlyMap<string, CodexMachine>,
  connectorRecordById: ReadonlyMap<string, ConnectorInstallationRecord>,
  loadingIds: ReadonlySet<string>
): CodexFilterAvailability {
  if (loadingIds.has(connectorId)) return 'checking';
  const codexMachine = codexMachineById.get(connectorId);
  if (codexMachine) return codexMachine.status;
  const connector = connectorRecordById.get(connectorId);
  if (connector?.connector.status === 'local' || connector?.connector.status === 'online') return 'connected';
  if (connector?.connector.status === 'offline') return 'offline';
  return 'unavailable';
}

function aggregateAvailability(values: readonly CodexFilterAvailability[]): CodexFilterAvailability {
  if (values.includes('connected')) return 'connected';
  if (values.includes('checking')) return 'checking';
  if (values.length > 0 && values.every((value) => value === 'offline')) return 'offline';
  return 'unavailable';
}

function attentionLabel(status: 'waiting-approval' | 'waiting-input') {
  return status === 'waiting-approval' ? 'Approval' : 'Input';
}
