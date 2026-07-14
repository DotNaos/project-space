import type { CodexSessionRecord } from '@/shared/codex-sessions-api';
import type {
  ConnectorOverviewResult,
  DeployedEnvironmentStatusResult,
  GitHubRepositoryDetailsResult,
  ProjectDiscoveryResult,
  ProjectSpaceRecord,
  ProjectWorktreeDiscoveryResult
} from '@/shared/project-space-api';
import type { ProjectTopologySource } from '../../src/features/project-topology/project-topology-loader';
import {
  comparablePath,
  containsPath
} from '../../src/features/project-topology/project-topology-inventory-evidence';
import {
  topologyTaskId,
  type TopologyTaskLocationEvidence,
  type TopologyTaskWriteCapability
} from '../../src/features/project-topology/project-topology-types';
import {
  checkedAt,
  codex,
  conversation,
  machine,
  project,
  repositoryDetails,
  session,
  worktrees
} from './project-topology-test-fixtures';

export interface SourceCalls {
  deployments: string[];
  locations: Array<[string, string]>;
  machines: number;
  projects: number;
  reads: Array<[string, string]>;
  repositories: string[];
  sessions: string[];
  worktrees: Array<[string, string | undefined]>;
  writes: Array<[string, string]>;
}

export interface SourceOptions {
  canonicalLocation?: 'missing' | TopologyTaskLocationEvidence;
  canonicalLocations?: Record<string, string>;
  foreignCodex?: boolean;
  machineFailure?: string;
  machines?: ConnectorOverviewResult['machines'];
  projectFailure?: string;
  projects?: ProjectSpaceRecord[];
  repositoryStatus?: GitHubRepositoryDetailsResult['status'];
  sessionFailure?: string;
  sessions?: CodexSessionRecord[];
  writeCapability?: 'missing' | TopologyTaskWriteCapability;
}

export function sourceHarness(options: SourceOptions = {}) {
  const projects = options.projects ?? [
    project('project-a', 'machine-a', '/projects/project-space')
  ];
  const machines = options.machines ?? [machine('machine-a')];
  const sessions = options.sessions ?? [
    session('machine-a', 'thread-a', '/untrusted/session-cwd', 'idle')
  ];
  const calls: SourceCalls = {
    deployments: [], locations: [], machines: 0, projects: 0, reads: [],
    repositories: [], sessions: [], worktrees: [], writes: []
  };
  const source: ProjectTopologySource = {
    async discoverProjectWorktrees(projectId, machineId) {
      calls.worktrees.push([projectId, machineId]);
      const record = projects.find((candidate) => candidate.id === projectId);
      return provenEmptyWorktrees(record?.rootPath ?? '/unknown');
    },
    async getConnectorOverview() {
      calls.machines += 1;
      if (options.machineFailure) throw new Error(options.machineFailure);
      return readyEvidence(connectorOverview(machines));
    },
    async getDeployedEnvironmentStatus(repositoryFullName) {
      calls.deployments.push(repositoryFullName);
      return readyEvidence(deploymentStatus(repositoryFullName));
    },
    async getGitHubRepositoryDetails(repositoryFullName) {
      calls.repositories.push(repositoryFullName);
      return readyEvidence({
        ...repositoryDetails('main'),
        message: options.repositoryStatus && options.repositoryStatus !== 'connected'
          ? 'GitHub authentication is required.'
          : undefined,
        status: options.repositoryStatus ?? 'connected'
      });
    },
    async listCodexSessions(machineId) {
      calls.sessions.push(machineId);
      if (options.sessionFailure) throw new Error(options.sessionFailure);
      if (options.foreignCodex) {
        return readyEvidence(codex('machine-b', [
          session('machine-b', 'foreign-thread', '/projects/foreign', 'idle')
        ]));
      }
      return readyEvidence(codex(
        machineId,
        sessions.filter((candidate) => candidate.machineId === machineId)
      ));
    },
    async loadProjectDiscovery() {
      calls.projects += 1;
      if (options.projectFailure) throw new Error(options.projectFailure);
      return readyEvidence(projectDiscovery(projects));
    },
    async readCodexSession(machineId, threadId) {
      calls.reads.push([machineId, threadId]);
      const record = sessions.find((candidate) => (
        candidate.machineId === machineId && candidate.id === threadId
      ));
      if (!record) throw new Error('Session not found.');
      return readyEvidence(conversation(record));
    },
    async resolveCodexSessionLocation(machineId, threadId) {
      calls.locations.push([machineId, threadId]);
      if (options.canonicalLocation === 'missing') {
        throw new Error('Canonical location unavailable.');
      }
      const canonicalCwd = options.canonicalLocations?.[
        topologyTaskId(machineId, threadId)
      ];
      const resolvedCwd = canonicalCwd ?? '/projects/project-space/src';
      const worktreeRoot = projects
        .filter((record) => record.machineId === machineId)
        .map((record) => comparablePath(record.rootPath))
        .filter((root) => containsPath(root, comparablePath(resolvedCwd)))
        .sort((left, right) => right.length - left.length)[0] ?? resolvedCwd;
      const location = options.canonicalLocation ?? {
        canonicalCwd: resolvedCwd,
        checkedAt,
        machineId,
        sessionRevision: 'a'.repeat(64),
        source: 'connector-realpath',
        threadId,
        worktreeRoot
      };
      return readyEvidence(location, location.checkedAt);
    },
    ...(options.writeCapability === 'missing' ? {} : {
      async getCodexSessionWriteCapability(machineId: string, threadId: string) {
        calls.writes.push([machineId, threadId]);
        return options.writeCapability ?? defaultWriteCapability(machineId, threadId);
      }
    })
  };
  return { calls, source };
}

export function readyEvidence<T>(data: T, evidenceCheckedAt = checkedAt) {
  return { checkedAt: evidenceCheckedAt, data, state: 'ready' as const };
}

function projectDiscovery(projects: ProjectSpaceRecord[]): ProjectDiscoveryResult {
  return { groups: [], projects, rootItems: [], rootPath: '/projects', structureViolations: [] };
}

function connectorOverview(machines: ConnectorOverviewResult['machines']): ConnectorOverviewResult {
  return {
    machines,
    machinesRepo: { exists: true, path: '/machines' },
    tailscale: {
      connected: true,
      installed: true,
      ips: [],
      peersOnline: 0,
      serveOrigins: []
    }
  };
}

function provenEmptyWorktrees(projectPath: string): ProjectWorktreeDiscoveryResult {
  const result = worktrees(projectPath, []);
  if (result.state !== 'proven-empty') throw new Error('Expected proven-empty worktrees.');
  return result;
}

function deploymentStatus(repositoryFullName: string): DeployedEnvironmentStatusResult {
  return { checkedAt, environments: [], repositoryFullName, status: 'available' };
}

function defaultWriteCapability(
  machineId: string,
  threadId: string
): TopologyTaskWriteCapability {
  return {
    canContinue: true,
    checkedAt,
    expiresAt: '2026-07-14T00:05:00.000Z',
    machineId,
    sessionRevision: 'a'.repeat(64),
    sessionLastActivityAt: checkedAt,
    state: 'ready',
    threadId
  };
}
