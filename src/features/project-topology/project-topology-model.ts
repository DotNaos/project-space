import type {
  MachineRecord,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import type {
  CodexSessionListResult,
  CodexSessionRecord
} from '@/shared/codex-sessions-api';
import { projectChatProjectId } from '../../shared/project-chat-project';
import {
  agentLabel,
  connectorReachable,
  flattenTranscript,
  resolveActivity,
  resolveDelivery,
  resolveInteraction,
  resolveIssue,
  safeBrowser,
  validateCodexInventory,
  validateConversation
} from './project-topology-evidence';
import {
  codexTruth,
  dedupeSessions,
  inventoryTruth,
  machineTruth,
  mapInventory,
  mergeWorktreeInventories,
  multiMachineWarning,
  projectTruth,
  resolveMultiMachineState
} from './project-topology-inventory-evidence';
import {
  topologyTaskId,
  type ProjectTopologyBuildResult,
  type ProjectTopologyInventory,
  type ProjectTopologySnapshot,
  type TopologyInventoryResult,
  type TopologyMachine,
  type TopologyProject,
  type TopologyTask
} from './project-topology-types';
import { topologyTaskCountEvidence } from './project-topology-refresh';
import {
  normalizeTopologyMachineInventory,
  normalizeTopologyProjectInventory
} from './project-topology-list-truth';
import {
  matchCodexTasks,
  type ProjectTopologyTaskMatch
} from './project-topology-task-matching';

export { applyTopologyBuild, beginTopologyRefresh } from './project-topology-refresh';

interface ProjectGroup {
  id: string;
  records: ProjectSpaceRecord[];
  repositoryFullName?: string;
}

export function buildProjectTopology(
  inventory: ProjectTopologyInventory
): ProjectTopologyBuildResult {
  const projectsSource = normalizeTopologyProjectInventory(inventory.projects);
  const machinesSource = normalizeTopologyMachineInventory(inventory.machines);
  const trustedInventory = {
    ...inventory,
    machines: machinesSource,
    projects: projectsSource
  };
  if (projectsSource.state === 'checking' || machinesSource.state === 'checking') {
    return { state: 'checking' };
  }
  if (projectsSource.state === 'blocked') {
    return {
      checkedAt: projectsSource.checkedAt,
      reason: projectsSource.reason,
      state: 'blocked'
    };
  }
  if (machinesSource.state === 'blocked') {
    return {
      checkedAt: machinesSource.checkedAt,
      reason: machinesSource.reason,
      state: 'blocked'
    };
  }

  const groups = groupProjects(projectsSource.data);
  const machineById = new Map(machinesSource.data.map((machine) => [machine.id, machine]));
  const matches = matchCodexTasks(groups, trustedInventory);
  const warnings: ProjectTopologySnapshot['warnings'] = [];
  const projects = groups.map((group) => {
    const project = buildProject(group, machineById, matches, trustedInventory);
    if (project.machines.length > 1) {
      const message = multiMachineWarning(project);
      if (message) warnings.push({ id: `occupancy:${project.id}`, message, projectId: project.id });
    }
    return project;
  }).sort((left, right) => left.name.localeCompare(right.name));
  const machineIds = new Set(projects.flatMap((project) => project.machines.map(({ id }) => id)));
  const taskIds = new Set(
    projects.flatMap((project) => project.machines.flatMap((machine) => (
      machine.tasks.map((task) => task.id)
    )))
  );
  const portfolioInventory = {
    machines: inventoryTruth(machinesSource),
    projects: inventoryTruth(projectsSource)
  };

  return {
    state: 'ready',
    snapshot: {
      checkedAt: inventory.checkedAt,
      inventory: portfolioInventory,
      lead: { conversationTarget: 'portfolio', id: 'lead', label: 'Lead' },
      projects,
      summary: {
        machineCount: machineIds.size,
        projectCount: projects.length,
        tasks: topologyTaskCountEvidence(projects, taskIds.size, portfolioInventory)
      },
      warnings
    }
  };
}

function groupProjects(projects: ProjectSpaceRecord[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const project of projects) {
    const repositoryFullName = project.github?.fullName;
    const id = repositoryFullName
      ? `github:${repositoryFullName.toLowerCase()}`
      : `machine:${project.machineId ?? 'unknown'}:project:${project.id}`;
    const group = groups.get(id) ?? { id, records: [], repositoryFullName };
    group.records.push(project);
    groups.set(id, group);
  }
  return [...groups.values()];
}

function buildProject(
  group: ProjectGroup,
  machineById: Map<string, MachineRecord>,
  matches: Map<string, ProjectTopologyTaskMatch>,
  inventory: ProjectTopologyInventory
): TopologyProject {
  const repository = group.records.find((record) => record.github)?.github;
  const repositoryResult = group.repositoryFullName
    ? inventory.repositoriesByFullName[group.repositoryFullName] ?? { state: 'checking' as const }
    : undefined;
  const machineGroups = new Map<string, ProjectSpaceRecord[]>();
  for (const record of group.records) {
    const machineId = record.machineId ?? 'unknown';
    machineGroups.set(machineId, [...(machineGroups.get(machineId) ?? []), record]);
  }
  const claimedPrimary = inventory.primaryMachineByProject?.[group.id]
    ?? (group.repositoryFullName
      ? inventory.primaryMachineByProject?.[group.repositoryFullName]
      : undefined);
  const claimedPrimaryMachineId = claimedPrimary?.source === 'project-configuration'
    ? claimedPrimary.machineId
    : undefined;
  const primaryMachineId = claimedPrimaryMachineId && machineGroups.has(claimedPrimaryMachineId)
    ? claimedPrimaryMachineId
    : undefined;
  const machines = [...machineGroups.entries()].map(([machineId, records]) => buildMachine(
    group,
    machineId,
    records,
    machineById.get(machineId),
    matches,
    machineGroups.size,
    primaryMachineId,
    inventory
  )).sort((left, right) => left.name.localeCompare(right.name));
  const multiMachineState = inventory.projects.state === 'stale' && machines.length > 1
    ? 'stale'
    : resolveMultiMachineState(
        group.id,
        group.repositoryFullName,
        machines,
        inventory.intentionalMultiMachineProjects ?? []
      );
  const unavailableRepository = {
    reason: 'No connected GitHub repository evidence is available for this project.',
    state: 'blocked' as const
  };

  return {
    branches: repositoryResult
      ? mapInventory(repositoryResult, (data) => data.branches)
      : unavailableRepository,
    chatProjectId: projectChatProjectId(group.records[0]!, repository),
    id: group.id,
    inventory: projectTruth(inventory.projects, machines),
    issues: repositoryResult
      ? mapInventory(repositoryResult, (data) => data.issues)
      : unavailableRepository,
    machines,
    multiMachineState,
    name: group.records[0]?.name ?? group.id,
    projectRecords: group.records,
    pullRequests: repositoryResult
      ? mapInventory(repositoryResult, (data) => data.pullRequests)
      : unavailableRepository,
    repositoryFullName: group.repositoryFullName,
    repositoryUrl: repository?.url
  };
}

function buildMachine(
  group: ProjectGroup,
  machineId: string,
  records: ProjectSpaceRecord[],
  machine: MachineRecord | undefined,
  matches: Map<string, ProjectTopologyTaskMatch>,
  machineCount: number,
  primaryMachineId: string | undefined,
  inventory: ProjectTopologyInventory
): TopologyMachine {
  const codex = validateCodexInventory(
    machineId,
    inventory.codexByMachineId[machineId] ?? { state: 'checking' as const }
  );
  const machineInventory = machineTruth(machine, inventory.machines);
  const worktreeInventory = mergeWorktreeInventories(records, inventory);
  const sessions = codex.state === 'ready' || codex.state === 'stale'
    ? dedupeSessions(codex.data.sessions)
    : [];
  const unmatchedSessionCount = sessions.filter((session) => (
    !matches.has(topologyTaskId(machineId, session.id))
  )).length;
  const locationFailures = sessions.flatMap((session) => {
    const failure = inventory.taskLocationFailuresByTaskId?.[
      topologyTaskId(machineId, session.id)
    ];
    return failure ? [failure] : [];
  });
  const taskInventory = codex.state === 'checking' || codex.state === 'blocked'
    ? codex
    : machineInventory.state !== 'ready'
    ? machineInventory
    : sessions.length > 0 && worktreeInventory.state === 'checking'
      ? worktreeInventory
    : sessions.length > 0 && worktreeInventory.state === 'blocked'
      ? {
          checkedAt: worktreeInventory.checkedAt,
          reason: worktreeInventory.message,
          state: 'blocked' as const
        }
    : sessions.length > 0 && worktreeInventory.state === 'stale'
      ? {
          lastSafeAt: worktreeInventory.lastSafeAt,
          reason: worktreeInventory.reason,
          state: 'stale' as const
        }
    : codex.state === 'ready' && locationFailures.length > 0
    ? {
        checkedAt: codex.checkedAt,
        reason: locationFailures[0]!.reason,
        state: 'blocked' as const
      }
    : codex.state === 'ready' && unmatchedSessionCount > 0
    ? {
        checkedAt: codex.checkedAt,
        reason: `${unmatchedSessionCount} Codex ${unmatchedSessionCount === 1 ? 'task could' : 'tasks could'} not be mapped from canonical host/worktree evidence.`,
        state: 'limited' as const
      }
    : codexTruth(codex);
  const tasks = (codex.state === 'ready' || codex.state === 'stale')
    ? sessions.flatMap((session) => {
        const id = topologyTaskId(machineId, session.id);
        const match = matches.get(id);
        return match?.projectId === group.id
          ? [buildTask(session, match, machine, codex, inventory)]
          : [];
      }).sort((left, right) => (
        Date.parse(right.session.lastActivityAt) - Date.parse(left.session.lastActivityAt)
      ))
    : [];
  const worktrees = worktreeInventory.state === 'ready'
    ? worktreeInventory.worktrees
    : worktreeInventory.state === 'stale' && worktreeInventory.data.state === 'ready'
      ? worktreeInventory.data.worktrees
      : [];

  return {
    id: machineId,
    inventory: machineInventory,
    machine,
    name: machine?.name ?? machineId,
    occupancy: machineCount === 1
      ? 'single'
      : primaryMachineId === machineId
        ? 'primary'
        : primaryMachineId
          ? 'secondary'
          : 'unknown',
    projectRecords: records,
    tasks,
    taskInventory,
    worktreeInventory,
    worktrees
  };
}

function buildTask(
  session: CodexSessionRecord,
  match: ProjectTopologyTaskMatch,
  machine: MachineRecord | undefined,
  codex: Extract<
    TopologyInventoryResult<CodexSessionListResult>,
    { state: 'ready' } | { state: 'stale' }
  >,
  inventory: ProjectTopologyInventory
): TopologyTask {
  const id = topologyTaskId(session.machineId, session.id);
  const repository = match.projectRecord.github?.fullName;
  const repositoryResult = repository ? inventory.repositoriesByFullName[repository] : undefined;
  const details = repositoryResult?.state === 'ready' || repositoryResult?.state === 'stale'
    ? repositoryResult.data
    : undefined;
  const currentDetails = repositoryResult?.state === 'ready' ? repositoryResult.data : undefined;
  const branchName = match.worktree?.branchName ?? match.projectRecord.gitStatus?.branchName;
  const issue = resolveIssue(details?.branches ?? [], details?.issues ?? [], branchName, session.title);
  const delivery = resolveDelivery(
    currentDetails?.pullRequests ?? [],
    inventory.deploymentsByRepository[repository ?? ''],
    repository,
    branchName,
    match.worktree?.headSha,
    session,
    inventory.taskEvidenceByTaskId?.[id],
    inventory.checkedAt
  );
  const online = codex.state === 'ready'
    && codex.data.machine.online
    && connectorReachable(machine);
  const activity = codex.state === 'stale' || !match.current
    ? 'stale'
    : resolveActivity(
        session,
        online,
        inventory.taskEvidenceByTaskId?.[id],
        inventory.checkedAt
      );
  const transcriptResult = validateConversation(
    inventory.conversationsByTaskId?.[id] ?? { state: 'checking' as const },
    session
  );
  const interaction = match.current
    ? resolveInteraction(
        session,
        online,
        transcriptResult,
        inventory.writeCapabilitiesByTaskId?.[id],
        inventory.checkedAt
      )
    : {
        canContinue: false,
        canInterrupt: false,
        composerVisible: false,
        reason: 'Task attribution relies on stale worktree evidence.'
      };

  return {
    activity,
    agentLabel: agentLabel(session.title),
    branchName,
    browser: safeBrowser(inventory.browsersByTaskId?.[id], session.machineId, session.id),
    cwd: match.canonicalCwd,
    delivery,
    evidence: {
      current: match.current,
      ...(match.lastSafeAt ? { lastSafeAt: match.lastSafeAt } : {}),
      match: match.type,
      matchedPath: match.matchedPath,
      source: 'connector-canonical-cwd'
    },
    id,
    interaction,
    issue,
    lastSafeAt: oldestEvidenceAt(
      codex.state === 'stale' ? codex.lastSafeAt : undefined,
      match.lastSafeAt
    ),
    machineId: session.machineId,
    model: session.model,
    session,
    threadId: session.id,
    title: issue?.title ?? session.title,
    transcript: mapInventory(transcriptResult, flattenTranscript),
    worktree: match.worktree
  };
}

function oldestEvidenceAt(...values: Array<string | undefined>) {
  return values.filter((value): value is string => Boolean(value)).sort((left, right) => (
    Date.parse(left) - Date.parse(right)
  ))[0];
}
