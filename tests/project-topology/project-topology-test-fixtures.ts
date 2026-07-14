import { expect } from 'bun:test';
import type {
  GitHubRepositoryDetailsResult,
  MachineRecord,
  ProjectSpaceRecord,
  ProjectWorktreeDiscoveryState
} from '@/shared/project-space-api';
import type {
  CodexSessionListResult,
  CodexSessionReadResult,
  CodexSessionRecord
} from '@/shared/codex-sessions-api';
import {
  comparablePath,
  containsPath,
  topologyProjectScope
} from '../../src/features/project-topology/project-topology-inventory-evidence';
import {
  topologyTaskId,
  type ProjectTopologyInventory,
  type ProjectTopologySnapshot,
  type TopologyBrowserCapability,
  type TopologyTaskLocationEvidence,
  type TopologyTaskWriteCapability
} from '../../src/features/project-topology/project-topology-types';
import { buildProjectTopology } from '../../src/features/project-topology/project-topology-model';

export const checkedAt = '2026-07-14T00:00:00.000Z';

export function machine(
  id: string,
  status: MachineRecord['connector']['status'] = 'online'
): MachineRecord {
  return {
    connector: { installCommand: 'project-space-connector', lastSeen: checkedAt, status },
    id,
    kind: 'connector',
    name: id,
    network: {},
    roles: ['connector'],
    sourcePath: 'connector-hub'
  };
}

export function project(
  id: string,
  machineId: string,
  rootPath: string,
  fullName = 'DotNaos/project-space'
): ProjectSpaceRecord {
  return {
    github: {
      fullName,
      id: 177,
      isPrivate: true,
      name: fullName.split('/')[1]!,
      owner: fullName.split('/')[0]!,
      projectConfig: { projectYaml: true, status: 'complete', templateLock: true },
      url: `https://github.com/${fullName}`
    },
    id,
    kind: 'workspace',
    machineId,
    name: fullName.split('/')[1]!,
    rootPath
  };
}

export function worktrees(
  projectPath: string,
  values: Array<{
    branchName: string;
    headSha?: string;
    id: string;
    isBase?: boolean;
    path: string;
  }>
): Extract<ProjectWorktreeDiscoveryState, { state: 'ready' | 'proven-empty' }> {
  if (values.length === 0) {
    return {
      evidence: { checkedAt, projectPath, source: 'git-worktree-list' },
      state: 'proven-empty',
      worktrees: []
    };
  }
  return {
    evidence: { checkedAt, projectPath, source: 'git-worktree-list' },
    state: 'ready',
    worktrees: values.map((value) => ({
      branchName: value.branchName,
      detached: false,
      headSha: value.headSha,
      id: value.id,
      isBase: value.isBase ?? false,
      kind: 'project-managed' as const,
      locked: false,
      name: value.branchName,
      path: value.path,
      prunable: false,
      status: 'ready' as const
    })) as Extract<ProjectWorktreeDiscoveryState, { state: 'ready' }>['worktrees']
  };
}

export function session(
  machineId: string,
  id: string,
  cwd: string | undefined,
  status: CodexSessionRecord['status'] = 'idle'
): CodexSessionRecord {
  return {
    archived: status === 'archived',
    cwd,
    id,
    lastActivityAt: checkedAt,
    loadedByProjectSpace: false,
    machineId,
    machineName: machineId,
    status,
    title: '#177 · Fayn-EVT6AF · Implement topology command center · project-space'
  };
}

export function codex(
  machineId: string,
  sessions: CodexSessionRecord[],
  online = true
): CodexSessionListResult {
  return {
    checkedAt,
    machine: { id: machineId, name: machineId, online },
    sessions
  };
}

export function conversation(sessionRecord: CodexSessionRecord): CodexSessionReadResult {
  return { openedReadOnly: true, session: sessionRecord, turns: [] };
}

export function location(
  sessionRecord: CodexSessionRecord,
  canonicalCwd = sessionRecord.cwd ?? '',
  worktreeRoot = canonicalCwd
): TopologyTaskLocationEvidence {
  return {
    canonicalCwd,
    checkedAt,
    machineId: sessionRecord.machineId,
    sessionRevision: 'a'.repeat(64),
    source: 'connector-realpath',
    threadId: sessionRecord.id,
    worktreeRoot
  };
}

export function writable(
  sessionRecord: CodexSessionRecord,
  overrides: Partial<Extract<TopologyTaskWriteCapability, { state: 'ready' }>> = {}
): Extract<TopologyTaskWriteCapability, { state: 'ready' }> {
  return {
    canContinue: true,
    checkedAt,
    expiresAt: '2026-07-14T00:05:00.000Z',
    machineId: sessionRecord.machineId,
    sessionRevision: 'a'.repeat(64),
    sessionLastActivityAt: sessionRecord.lastActivityAt,
    state: 'ready',
    threadId: sessionRecord.id,
    ...overrides
  };
}

export function repositoryDetails(
  branchName = 'issue-177-topology'
): GitHubRepositoryDetailsResult {
  return {
    branches: [{ isDefault: false, linkedIssueNumbers: [177], name: branchName }],
    checkedAt,
    issues: [{
      labels: [],
      number: 177,
      state: 'open',
      title: 'Introduce Lead and Project Lead coordination workflow',
      url: 'https://github.com/DotNaos/project-space/issues/177'
    }],
    pullRequests: [],
    status: 'connected'
  };
}

interface InventoryInput {
  browsers?: Record<string, TopologyBrowserCapability>;
  codexByMachine?: ProjectTopologyInventory['codexByMachineId'];
  conversations?: ProjectTopologyInventory['conversationsByTaskId'];
  deployments?: ProjectTopologyInventory['deploymentsByRepository'];
  machines?: MachineRecord[];
  machinesInventory?: ProjectTopologyInventory['machines'];
  primaryMachineByProject?: ProjectTopologyInventory['primaryMachineByProject'];
  projects?: ProjectSpaceRecord[];
  projectsInventory?: ProjectTopologyInventory['projects'];
  repositories?: ProjectTopologyInventory['repositoriesByFullName'];
  taskLocationFailures?: ProjectTopologyInventory['taskLocationFailuresByTaskId'];
  taskLocations?: Record<string, TopologyTaskLocationEvidence>;
  taskEvidence?: ProjectTopologyInventory['taskEvidenceByTaskId'];
  writeCapabilities?: Record<string, TopologyTaskWriteCapability>;
  worktreesByProject?: Record<
    string,
    ProjectTopologyInventory['worktreesByProjectScope'][string]
  >;
  worktreesByScope?: ProjectTopologyInventory['worktreesByProjectScope'];
}

export function inventory(input: InventoryInput = {}): ProjectTopologyInventory {
  const projects = input.projects ?? (
    input.projectsInventory?.state === 'ready' || input.projectsInventory?.state === 'stale'
      ? input.projectsInventory.data
      : [project('project-a', 'machine-a', '/projects/project-space')]
  );
  const machines = input.machines ?? (
    input.machinesInventory?.state === 'ready' || input.machinesInventory?.state === 'stale'
      ? input.machinesInventory.data
      : [machine('machine-a')]
  );
  const codexByMachineId = input.codexByMachine ?? Object.fromEntries(machines.map((entry) => [
    entry.id,
    { checkedAt, data: codex(entry.id, []), state: 'ready' as const }
  ]));
  const codexSessions = Object.values(codexByMachineId).flatMap((result) => (
    result.state === 'ready' || result.state === 'stale' ? result.data.sessions : []
  ));
  const worktreesByProjectScope = input.worktreesByScope ?? Object.fromEntries(projects.map((entry) => [
    topologyProjectScope(entry),
    input.worktreesByProject?.[entry.id] ?? worktrees(entry.rootPath, [])
  ]));
  const defaultLocations = Object.fromEntries(codexSessions.flatMap((entry) => (
    entry.cwd ? [[
      topologyTaskId(entry.machineId, entry.id),
      location(entry, entry.cwd, fixtureGitRoot(entry, projects, worktreesByProjectScope))
    ]] : []
  )));
  return {
    browsersByTaskId: input.browsers,
    checkedAt,
    codexByMachineId,
    conversationsByTaskId: input.conversations,
    deploymentsByRepository: input.deployments ?? {},
    machines: input.machinesInventory ?? { checkedAt, data: machines, state: 'ready' },
    primaryMachineByProject: input.primaryMachineByProject,
    projects: input.projectsInventory ?? { checkedAt, data: projects, state: 'ready' },
    repositoriesByFullName: input.repositories ?? {
      'DotNaos/project-space': { checkedAt, data: repositoryDetails(), state: 'ready' }
    },
    taskLocationFailuresByTaskId: input.taskLocationFailures,
    taskLocationsByTaskId: input.taskLocations ?? defaultLocations,
    taskEvidenceByTaskId: input.taskEvidence,
    writeCapabilitiesByTaskId: input.writeCapabilities,
    worktreesByProjectScope
  };
}

function fixtureGitRoot(
  entry: CodexSessionRecord,
  projects: ProjectSpaceRecord[],
  inventories: ProjectTopologyInventory['worktreesByProjectScope']
) {
  const cwd = comparablePath(entry.cwd);
  const paths = projects
    .filter((projectRecord) => projectRecord.machineId === entry.machineId)
    .flatMap((projectRecord) => {
      const discovered = inventories[topologyProjectScope(projectRecord)];
      const worktreeRecords = discovered?.state === 'ready'
        ? discovered.worktrees
        : discovered?.state === 'stale' && discovered.data.state === 'ready'
          ? discovered.data.worktrees
          : [];
      return [projectRecord.rootPath, ...worktreeRecords.map((worktree) => worktree.path)];
    })
    .map(comparablePath)
    .filter((path) => containsPath(path, cwd))
    .sort((left, right) => right.length - left.length);
  return paths[0] ?? entry.cwd ?? '';
}

export function snapshot(
  result: ReturnType<typeof buildProjectTopology>
): ProjectTopologySnapshot {
  expect(result.state).toBe('ready');
  if (result.state !== 'ready') throw new Error('Expected a ready topology snapshot.');
  return result.snapshot;
}
