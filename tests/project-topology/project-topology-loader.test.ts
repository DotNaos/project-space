import { describe, expect, test } from 'bun:test';
import type {
  ConnectorOverviewResult,
  DeployedEnvironmentStatusResult,
  GitHubRepositoryDetailsResult,
  ProjectDiscoveryResult,
  ProjectSpaceRecord,
  ProjectWorktreeDiscoveryResult
} from '@/shared/project-space-api';
import type { CodexSessionRecord } from '@/shared/codex-sessions-api';
import { applyTopologyBuild, buildProjectTopology } from '../../src/features/project-topology/project-topology-model';
import {
  loadProjectTopologyInventory,
  type ProjectTopologySource
} from '../../src/features/project-topology/project-topology-loader';
import {
  checkedAt,
  codex,
  conversation,
  machine,
  project,
  repositoryDetails,
  session,
  snapshot,
  worktrees
} from './project-topology-test-fixtures';
import {
  topologyTaskId,
  type TopologyTaskEvidence,
  type TopologyTaskLocationEvidence,
  type TopologyTaskWriteCapability
} from '../../src/features/project-topology/project-topology-types';
interface SourceCalls {
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

interface SourceOptions {
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

function sourceHarness(options: SourceOptions = {}) {
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
      const location = options.canonicalLocation ?? {
        canonicalCwd: canonicalCwd ?? '/projects/project-space/src',
        checkedAt,
        machineId,
        source: 'connector-realpath',
        threadId
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
describe('project topology loader', () => {
  test('joins a real task through canonical location and stable machine/thread calls', async () => {
    const { calls, source } = sourceHarness();
    const inventory = await loadProjectTopologyInventory(source, { clock: () => checkedAt });
    const id = topologyTaskId('machine-a', 'thread-a');
    const result = snapshot(buildProjectTopology(inventory));
    const task = result.projects[0]!.machines[0]!.tasks[0]!;

    expect(calls.sessions).toEqual(['machine-a']);
    expect(calls.locations).toEqual([['machine-a', 'thread-a']]);
    expect(calls.reads).toEqual([['machine-a', 'thread-a']]);
    expect(calls.writes).toEqual([['machine-a', 'thread-a']]);
    expect(inventory.taskLocationsByTaskId?.[id]).toMatchObject({
      canonicalCwd: '/projects/project-space/src',
      machineId: 'machine-a',
      threadId: 'thread-a'
    });
    expect(inventory.conversationsByTaskId?.[id]?.state).toBe('ready');
    expect(inventory.writeCapabilitiesByTaskId?.[id]?.state).toBe('ready');
    expect(task.cwd).toBe('/projects/project-space/src');
    expect(task.evidence.source).toBe('connector-canonical-cwd');
  });

  test('stops location and transcript reads after Codex list failure', async () => {
    const { calls, source } = sourceHarness({ sessionFailure: 'Connector timed out.' });
    const inventory = await loadProjectTopologyInventory(source, { clock: () => checkedAt });
    const result = snapshot(buildProjectTopology(inventory));

    expect(inventory.codexByMachineId['machine-a']).toMatchObject({
      reason: 'Connector timed out.', state: 'blocked'
    });
    expect(calls.locations).toEqual([]);
    expect(calls.reads).toEqual([]);
    expect(calls.writes).toEqual([]);
    expect(result.summary.tasks).toEqual({ completeness: 'unknown', observedCount: 0 });
  });

  test('distinguishes unavailable from successfully unmatched canonical evidence', async () => {
    const variants: Array<{
      canonicalLocation: SourceOptions['canonicalLocation'];
      state: 'blocked' | 'limited';
    }> = [{ canonicalLocation: 'missing', state: 'blocked' }, {
      canonicalLocation: {
        canonicalCwd: 'relative/untrusted/path',
        checkedAt,
        machineId: 'machine-a',
        source: 'connector-realpath',
        threadId: 'thread-a'
      },
      state: 'blocked'
    }, {
      canonicalLocation: {
        canonicalCwd: '/projects/project-space',
        checkedAt,
        machineId: 'machine-b',
        source: 'connector-realpath',
        threadId: 'thread-a'
      },
      state: 'blocked'
    }, {
      canonicalLocation: {
        canonicalCwd: '/somewhere/outside-the-project',
        checkedAt,
        machineId: 'machine-a',
        source: 'connector-realpath',
        threadId: 'thread-a'
      },
      state: 'limited'
    }];

    for (const { canonicalLocation, state } of variants) {
      const { calls, source } = sourceHarness({ canonicalLocation });
      const inventory = await loadProjectTopologyInventory(source, { clock: () => checkedAt });
      const result = snapshot(buildProjectTopology(inventory));
      const machineResult = result.projects[0]!.machines[0]!;

      expect(machineResult.taskInventory.state).toBe(state);
      expect(machineResult.tasks).toEqual([]);
      expect(calls.locations).toEqual([['machine-a', 'thread-a']]);
      expect(calls.reads).toEqual([]);
      expect(calls.writes).toEqual([]);
    }
  });

  test('retains resolver failure as stale but accepts a proven task move', async () => {
    const readyInventory = await loadProjectTopologyInventory(sourceHarness().source, {
      clock: () => checkedAt
    });
    const ready = applyTopologyBuild(undefined, buildProjectTopology(readyInventory));
    const failedInventory = await loadProjectTopologyInventory(sourceHarness({
      canonicalLocation: 'missing'
    }).source, { clock: () => checkedAt });
    const stale = applyTopologyBuild(ready, buildProjectTopology(failedInventory));
    const movedInventory = await loadProjectTopologyInventory(sourceHarness({
      canonicalLocation: {
        canonicalCwd: '/projects/a-different-project',
        checkedAt,
        machineId: 'machine-a',
        source: 'connector-realpath',
        threadId: 'thread-a'
      }
    }).source, { clock: () => checkedAt });
    const moved = applyTopologyBuild(ready, buildProjectTopology(movedInventory));

    expect(stale.state).toBe('ready');
    if (stale.state === 'ready') {
      const task = stale.snapshot.projects[0]!.machines[0]!.tasks[0]!;
      expect(task.activity).toBe('stale');
      expect(task.interaction.composerVisible).toBe(false);
    }
    expect(moved.state).toBe('ready');
    if (moved.state === 'ready') {
      expect(moved.snapshot.projects[0]!.machines[0]!.tasks).toEqual([]);
      expect(moved.snapshot.projects[0]!.machines[0]!.taskInventory.state).toBe('limited');
    }
  });

  test('loads repository and deployment evidence once for duplicate repository records', async () => {
    const projects = [
      project('project-a', 'machine-a', '/projects/project-space'),
      project('project-b', 'machine-a', '/projects/project-space-mirror')
    ];
    const { calls, source } = sourceHarness({ projects, sessions: [] });

    await loadProjectTopologyInventory(source, {
      clock: () => checkedAt,
      includeTranscripts: false
    });

    expect(calls.repositories).toEqual(['DotNaos/project-space']);
    expect(calls.deployments).toEqual(['DotNaos/project-space']);
    expect(calls.sessions).toEqual(['machine-a']);
  });

  test('stops all downstream inventory when projects or machines fail', async () => {
    for (const options of [
      { projectFailure: 'Project discovery failed.' },
      { machineFailure: 'Machine inventory failed.' }
    ]) {
      const { calls, source } = sourceHarness(options);
      const inventory = await loadProjectTopologyInventory(source, { clock: () => checkedAt });

      expect(calls.projects).toBe(1);
      expect(calls.machines).toBe(1);
      expect(calls.worktrees).toEqual([]);
      expect(calls.repositories).toEqual([]);
      expect(calls.deployments).toEqual([]);
      expect(calls.sessions).toEqual([]);
      expect(calls.locations).toEqual([]);
      expect(calls.reads).toEqual([]);
      expect(calls.writes).toEqual([]);
      expect(
        inventory.projects.state === 'blocked' || inventory.machines.state === 'blocked'
      ).toBe(true);
    }
  });

  test('includes write authority only when the source explicitly provides it', async () => {
    const withoutWrite = sourceHarness({ writeCapability: 'missing' });
    const unavailableCapability: TopologyTaskWriteCapability = {
      checkedAt,
      reason: 'Writes are not supported by this connector.',
      state: 'unavailable'
    };
    const withWrite = sourceHarness({ writeCapability: unavailableCapability });
    const [withoutInventory, withInventory] = await Promise.all([
      loadProjectTopologyInventory(withoutWrite.source, { clock: () => checkedAt }),
      loadProjectTopologyInventory(withWrite.source, { clock: () => checkedAt })
    ]);
    const id = topologyTaskId('machine-a', 'thread-a');

    expect(withoutInventory.writeCapabilitiesByTaskId).toBeUndefined();
    expect(withoutWrite.calls.writes).toEqual([]);
    expect(withInventory.writeCapabilitiesByTaskId?.[id]).toEqual(unavailableCapability);
    expect(withWrite.calls.writes).toEqual([['machine-a', 'thread-a']]);
  });

  test('does not call unsuccessful GitHub inventory ready', async () => {
    const { source } = sourceHarness({ repositoryStatus: 'auth-required', sessions: [] });
    const inventory = await loadProjectTopologyInventory(source, {
      clock: () => checkedAt,
      includeTranscripts: false
    });
    const result = snapshot(buildProjectTopology(inventory));

    expect(inventory.repositoriesByFullName['DotNaos/project-space']).toMatchObject({
      reason: 'GitHub authentication is required.',
      state: 'blocked'
    });
    expect(result.projects[0]!.issues.state).toBe('blocked');
  });

  test('keeps same thread IDs isolated across two machines', async () => {
    const projects = [
      project('project-a', 'machine-a', '/a/project-space'),
      project('project-b', 'machine-b', '/b/project-space')
    ];
    const sessions = [
      session('machine-a', 'same-thread', '/ignored/a', 'idle'),
      session('machine-b', 'same-thread', '/ignored/b', 'idle')
    ];
    const { calls, source } = sourceHarness({
      canonicalLocations: {
        [topologyTaskId('machine-a', 'same-thread')]: '/a/project-space/src',
        [topologyTaskId('machine-b', 'same-thread')]: '/b/project-space/src'
      },
      machines: [machine('machine-a'), machine('machine-b')],
      projects,
      sessions
    });
    const loaded = await loadProjectTopologyInventory(source, { clock: () => checkedAt });
    const result = snapshot(buildProjectTopology(loaded));

    expect(calls.locations).toEqual([
      ['machine-a', 'same-thread'],
      ['machine-b', 'same-thread']
    ]);
    expect(calls.reads).toEqual([
      ['machine-a', 'same-thread'],
      ['machine-b', 'same-thread']
    ]);
    expect(calls.writes).toEqual(calls.reads);
    expect(new Set(result.projects[0]!.machines.flatMap((entry) => (
      entry.tasks.map((task) => task.id)
    )))).toEqual(new Set([
      topologyTaskId('machine-a', 'same-thread'),
      topologyTaskId('machine-b', 'same-thread')
    ]));
  });

  test('does not use foreign machine identities returned by Codex inventory', async () => {
    const { calls, source } = sourceHarness({ foreignCodex: true });
    const loaded = await loadProjectTopologyInventory(source, { clock: () => checkedAt });
    const result = snapshot(buildProjectTopology(loaded));

    expect(calls.locations).toEqual([]);
    expect(calls.reads).toEqual([]);
    expect(calls.writes).toEqual([]);
    expect(result.projects[0]!.machines[0]!.taskInventory.state).toBe('blocked');
  });

  test('captures the snapshot after delayed location and write evidence', async () => {
    let now = Date.parse(checkedAt);
    const iso = () => new Date(now).toISOString();
    const { source } = sourceHarness();
    source.resolveCodexSessionLocation = async (machineId, threadId) => {
      now += 1_000;
      const location = {
        canonicalCwd: '/projects/project-space/src',
        checkedAt: iso(),
        machineId,
        source: 'connector-realpath',
        threadId
      };
      return { checkedAt: location.checkedAt, data: location, state: 'ready' };
    };
    source.getCodexSessionWriteCapability = async (machineId, threadId) => {
      now += 1_000;
      return {
        canContinue: true,
        checkedAt: iso(),
        expiresAt: new Date(now + 5 * 60 * 1_000).toISOString(),
        machineId,
        sessionLastActivityAt: checkedAt,
        state: 'ready',
        threadId
      };
    };

    const loaded = await loadProjectTopologyInventory(source, { clock: iso });
    const task = snapshot(buildProjectTopology(loaded)).projects[0]!.machines[0]!.tasks[0]!;
    const location = loaded.taskLocationsByTaskId?.[task.id];
    const authority = loaded.writeCapabilitiesByTaskId?.[task.id];

    expect(Date.parse(loaded.checkedAt)).toBeGreaterThanOrEqual(Date.parse(location!.checkedAt));
    expect(authority?.state).toBe('ready');
    if (authority?.state === 'ready') {
      expect(Date.parse(loaded.checkedAt)).toBeGreaterThanOrEqual(Date.parse(authority.checkedAt));
    }
    expect(task.interaction.composerVisible).toBe(true);
  });

  test('loads decision and verification evidence through the real source boundary', async () => {
    const { source } = sourceHarness();
    let evidenceCalls = 0;
    source.getCodexSessionTaskEvidence = async (machineId, threadId) => {
      evidenceCalls += 1;
      return {
        awaitingDecision: {
          expiresAt: '2026-07-14T00:10:00.000Z',
          observedAt: checkedAt,
          sessionLastActivityAt: checkedAt
        },
        machineId,
        threadId
      } satisfies TopologyTaskEvidence;
    };

    const loaded = await loadProjectTopologyInventory(source, { clock: () => checkedAt });
    const task = snapshot(buildProjectTopology(loaded)).projects[0]!.machines[0]!.tasks[0]!;

    expect(evidenceCalls).toBe(1);
    expect(loaded.taskEvidenceByTaskId?.[task.id]).toBeDefined();
    expect(task.activity).toBe('awaiting-decision');
  });
});

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
    sessionLastActivityAt: checkedAt,
    state: 'ready',
    threadId
  };
}

function readyEvidence<T>(data: T, evidenceCheckedAt = checkedAt) {
  return { checkedAt: evidenceCheckedAt, data, state: 'ready' as const };
}
