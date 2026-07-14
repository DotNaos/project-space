import { describe, expect, test } from 'bun:test';
import type {
  ConnectorOverviewResult,
  ProjectDiscoveryResult,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import type { CodexSessionRecord } from '@/shared/codex-sessions-api';
import {
  loadProjectTopologyInventory,
  type ProjectTopologySource
} from '../../src/features/project-topology/project-topology-loader';
import { buildProjectTopology } from '../../src/features/project-topology/project-topology-model';
import {
  checkedAt,
  codex,
  conversation,
  inventory,
  machine,
  project,
  repositoryDetails,
  session,
  snapshot,
  writable,
  worktrees
} from './project-topology-test-fixtures';
import { topologyTaskId } from '../../src/features/project-topology/project-topology-types';

const staleLastSafeAt = '2026-07-13T23:45:00.000Z';

interface SourceSetup {
  machines?: ConnectorOverviewResult['machines'];
  projects?: ProjectSpaceRecord[];
  sessions?: CodexSessionRecord[];
}

describe('project topology source truth', () => {
  test('preserves an explicit stale Codex last-safe time without claiming zero sessions is empty', async () => {
    const source = createSource({}, {
      async listCodexSessions(machineId) {
        return {
          data: { ...codex(machineId, []), checkedAt: staleLastSafeAt },
          lastSafeAt: staleLastSafeAt,
          reason: 'Connector inventory is offline.',
          state: 'stale'
        };
      }
    });

    const loaded = await loadProjectTopologyInventory(source, {
      clock: () => checkedAt,
      includeTranscripts: false
    });
    const result = snapshot(buildProjectTopology(loaded));
    const taskInventory = result.projects[0]!.machines[0]!.taskInventory;

    expect(loaded.codexByMachineId['machine-a']).toEqual({
      data: { ...codex('machine-a', []), checkedAt: staleLastSafeAt },
      lastSafeAt: staleLastSafeAt,
      reason: 'Connector inventory is offline.',
      state: 'stale'
    });
    expect(taskInventory).toEqual({
      lastSafeAt: staleLastSafeAt,
      reason: 'Connector inventory is offline.',
      state: 'stale'
    });
    expect(result.projects[0]!.machines[0]!.tasks).toEqual([]);
    expect(result.summary.tasks).toEqual({
      completeness: 'partial',
      observedCount: 0
    });
  });

  test('keeps tasks from stale Codex evidence visibly stale at the exact source time', async () => {
    const taskSession = {
      ...session('machine-a', 'thread-a', '/projects/project-space/src', 'idle'),
      lastActivityAt: staleLastSafeAt
    };
    const source = createSource({ sessions: [taskSession] }, {
      async listCodexSessions(machineId) {
        return {
          data: {
            ...codex(machineId, [taskSession]),
            checkedAt: staleLastSafeAt
          },
          lastSafeAt: staleLastSafeAt,
          reason: 'Connector inventory is offline.',
          state: 'stale'
        };
      }
    });

    const loaded = await loadProjectTopologyInventory(source, { clock: () => checkedAt });
    const result = snapshot(buildProjectTopology(loaded));
    const topologyMachine = result.projects[0]!.machines[0]!;
    const task = topologyMachine.tasks[0]!;

    expect(topologyMachine.taskInventory).toMatchObject({
      lastSafeAt: staleLastSafeAt,
      state: 'stale'
    });
    expect(task.activity).toBe('stale');
    expect(task.lastSafeAt).toBe(staleLastSafeAt);
    expect(task.interaction.composerVisible).toBe(false);
    expect(result.summary.tasks).toEqual({
      completeness: 'partial',
      observedCount: 1
    });
  });

  test('does not retain write authority on a task from stale Codex inventory', () => {
    const candidate = {
      ...session('machine-a', 'thread-stale-codex', '/projects/project-space', 'idle'),
      lastActivityAt: staleLastSafeAt
    };
    const taskId = topologyTaskId(candidate.machineId, candidate.id);
    const task = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': {
          data: { ...codex('machine-a', [candidate]), checkedAt: staleLastSafeAt },
          lastSafeAt: staleLastSafeAt,
          reason: 'Codex inventory is offline.',
          state: 'stale'
        }
      },
      conversations: {
        [taskId]: { checkedAt, data: conversation(candidate), state: 'ready' }
      },
      writeCapabilities: { [taskId]: writable(candidate) }
    }))).projects[0]!.machines[0]!.tasks[0]!;

    expect(task.activity).toBe('stale');
    expect(task.interaction.composerVisible).toBe(false);
    expect(task.interaction.authority).toBeUndefined();
  });

  test('blocks future-dated and malformed ready source timestamps', async () => {
    for (const evidenceCheckedAt of [
      '2026-07-15T00:00:00.000Z',
      'not-a-timestamp'
    ]) {
      const source = createSource({}, {
        async loadProjectDiscovery() {
          return ready(projectDiscovery([
            project('project-a', 'machine-a', '/projects/project-space')
          ]), evidenceCheckedAt);
        }
      });

      const loaded = await loadProjectTopologyInventory(source, {
        clock: () => checkedAt,
        includeTranscripts: false
      });

      expect(loaded.projects).toEqual({
        checkedAt,
        reason: 'Source evidence timestamp was malformed, future-dated, or internally inconsistent.',
        state: 'blocked'
      });
      expect(loaded.codexByMachineId).toEqual({});
      expect(buildProjectTopology(loaded).state).toBe('blocked');
    }
  });

  test('retains valid ready evidence as stale when a slower sibling source ages it out', async () => {
    const source = createSource({}, {
      async getConnectorOverview() {
        return ready({
          machines: [machine('machine-a')],
          machinesRepo: { exists: true, path: '/machines' },
          tailscale: {
            connected: true,
            installed: true,
            ips: [],
            peersOnline: 0,
            serveOrigins: []
          }
        }, checkedAt);
      }
    });
    const times = [
      '2026-07-14T00:00:31.000Z',
      '2026-07-14T00:00:31.000Z'
    ];

    const loaded = await loadProjectTopologyInventory(source, {
      clock: () => times.shift() ?? '2026-07-14T00:00:31.000Z',
      includeTranscripts: false
    });

    expect(loaded.machines).toMatchObject({
      lastSafeAt: checkedAt,
      reason: 'Source evidence expired before the topology snapshot was published.',
      state: 'stale'
    });
    expect(buildProjectTopology(loaded).state).toBe('ready');
  });

  test('blocks ready or stale evidence whose nested timestamp differs from its envelope', async () => {
    for (const nestedCheckedAt of [
      '2026-07-15T00:00:00.000Z',
      '2020-01-01T00:00:00.000Z'
    ]) for (const stale of [false, true]) {
      const source = createSource({}, {
        async listCodexSessions(machineId) {
          const data = {
            ...codex(machineId, []),
            checkedAt: nestedCheckedAt
          };
          return stale
            ? { data, lastSafeAt: checkedAt, reason: 'Offline.', state: 'stale' }
            : ready(data);
        }
      });

      const loaded = await loadProjectTopologyInventory(source, {
        clock: () => checkedAt,
        includeTranscripts: false
      });
      const result = snapshot(buildProjectTopology(loaded));

      expect(loaded.codexByMachineId['machine-a']).toEqual({
        checkedAt,
        reason: 'Source evidence timestamp was malformed, future-dated, or internally inconsistent.',
        state: 'blocked'
      });
      expect(result.projects[0]!.machines[0]!.taskInventory.state).toBe('blocked');
      expect(result.summary.tasks).toEqual({
        completeness: 'unknown',
        observedCount: 0
      });
    }
  });

  test('blocks a present non-string nested timestamp instead of treating it as absent', async () => {
    const source = createSource({}, {
      async listCodexSessions(machineId) {
        return ready({
          ...codex(machineId, []),
          checkedAt: 42 as unknown as string
        });
      }
    });

    const loaded = await loadProjectTopologyInventory(source, {
      clock: () => checkedAt,
      includeTranscripts: false
    });

    expect(loaded.codexByMachineId['machine-a']).toMatchObject({
      reason: 'Source evidence timestamp was malformed, future-dated, or internally inconsistent.',
      state: 'blocked'
    });
    expect(snapshot(buildProjectTopology(loaded)).summary.tasks.completeness).toBe('unknown');
  });

  test('turns a completed worktree checking response into a blocked result', async () => {
    const taskSession = session('machine-a', 'thread-a', '/projects/project-space');
    const source = createSource({ sessions: [taskSession] }, {
      async discoverProjectWorktrees() {
        return { state: 'checking' } as never;
      }
    });

    const loaded = await loadProjectTopologyInventory(source, {
      clock: () => checkedAt,
      includeTranscripts: false
    });
    const worktreeResult = Object.values(loaded.worktreesByProjectScope)[0]!;
    const topologyMachine = snapshot(buildProjectTopology(loaded)).projects[0]!.machines[0]!;

    expect(worktreeResult).toMatchObject({
      message: 'Worktree source completed without a final evidence state.',
      state: 'blocked'
    });
    expect(topologyMachine.taskInventory.state).toBe('blocked');
    expect(topologyMachine.tasks).toEqual([]);
  });

  test('does not map a task from an old cached canonical path response', async () => {
    const oldAt = '2020-01-01T00:00:00.000Z';
    const taskSession = {
      ...session('machine-a', 'thread-old-location', '/projects/project-space'),
      lastActivityAt: oldAt
    };
    const source = createSource({ sessions: [taskSession] }, {
      async resolveCodexSessionLocation(machineId, threadId) {
        const data = {
          canonicalCwd: '/projects/project-space',
          checkedAt: oldAt,
          machineId,
          sessionRevision: 'a'.repeat(64),
          source: 'connector-realpath' as const,
          threadId,
          worktreeRoot: '/projects/project-space'
        };
        return { checkedAt: oldAt, data, state: 'ready' };
      }
    });

    const loaded = await loadProjectTopologyInventory(source, { clock: () => checkedAt });
    const topologyMachine = snapshot(buildProjectTopology(loaded)).projects[0]!.machines[0]!;

    expect(topologyMachine.tasks).toEqual([]);
    expect(topologyMachine.taskInventory.state).toBe('blocked');
  });

  test('keeps an old valid worktree response stale without mapping a task', async () => {
    const oldAt = '2020-01-01T00:00:00.000Z';
    const taskSession = {
      ...session('machine-a', 'thread-old-worktree', '/projects/project-space'),
      lastActivityAt: oldAt
    };
    const source = createSource({ sessions: [taskSession] }, {
      async discoverProjectWorktrees() {
        const result = worktrees('/projects/project-space', []);
        return { ...result, evidence: { ...result.evidence, checkedAt: oldAt } };
      }
    });

    const loaded = await loadProjectTopologyInventory(source, { clock: () => checkedAt });
    const topologyMachine = snapshot(buildProjectTopology(loaded)).projects[0]!.machines[0]!;

    expect(topologyMachine.worktreeInventory.state).toBe('stale');
    expect(topologyMachine.taskInventory.state).toBe('stale');
    expect(topologyMachine.tasks).toEqual([]);
  });

  test('does not expose malformed or future connector last-seen values as stale truth', () => {
    for (const lastSeen of ['not-a-timestamp', '2099-01-01T00:00:00.000Z']) {
      const machineRecord = {
        ...machine('machine-a', 'offline'),
        connector: { ...machine('machine-a', 'offline').connector, lastSeen }
      };
      const topologyMachine = snapshot(buildProjectTopology(inventory({
        machines: [machineRecord]
      }))).projects[0]!.machines[0]!;

      expect(topologyMachine.inventory).toMatchObject({
        reason: 'The machine connector is offline and its last-seen evidence is invalid.',
        state: 'limited'
      });
      expect(topologyMachine.inventory).not.toHaveProperty('lastSafeAt');
    }
  });

  test('does not call an empty stale project cache a complete task inventory', () => {
    const result = snapshot(buildProjectTopology(inventory({
      projectsInventory: {
        data: [],
        lastSafeAt: staleLastSafeAt,
        reason: 'Project discovery is offline.',
        state: 'stale'
      }
    })));

    expect(result.summary.projectCount).toBe(0);
    expect(result.summary.tasks).toEqual({ completeness: 'unknown', observedCount: 0 });
  });

  test('caps Codex list source fanout at six concurrent calls', async () => {
    const machines = Array.from({ length: 12 }, (_, index) => machine(`machine-${index}`));
    const projects = machines.map((entry, index) => project(
      `project-${index}`,
      entry.id,
      `/projects/project-${index}`
    ));
    let active = 0;
    let calls = 0;
    let peak = 0;
    const source = createSource({ machines, projects }, {
      async listCodexSessions(machineId) {
        calls += 1;
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return ready(codex(machineId, []));
      }
    });

    await loadProjectTopologyInventory(source, {
      clock: () => checkedAt,
      includeTranscripts: false
    });

    expect(calls).toBe(12);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(6);
  });
});

function createSource(
  setup: SourceSetup = {},
  overrides: Partial<ProjectTopologySource> = {}
): ProjectTopologySource {
  const projects = setup.projects ?? [
    project('project-a', 'machine-a', '/projects/project-space')
  ];
  const machines = setup.machines ?? [machine('machine-a')];
  const sessions = setup.sessions ?? [];
  const defaults: ProjectTopologySource = {
    async discoverProjectWorktrees(projectId, machineId) {
      const record = projects.find((candidate) => (
        candidate.id === projectId && candidate.machineId === machineId
      ));
      return worktrees(record?.rootPath ?? '/unknown', []);
    },
    async getConnectorOverview() {
      return ready(connectorOverview(machines));
    },
    async getDeployedEnvironmentStatus(repositoryFullName) {
      return ready({
        checkedAt,
        environments: [],
        repositoryFullName,
        status: 'available'
      });
    },
    async getGitHubRepositoryDetails() {
      return ready(repositoryDetails('main'));
    },
    async listCodexSessions(machineId) {
      return ready(codex(
        machineId,
        sessions.filter((candidate) => candidate.machineId === machineId)
      ));
    },
    async loadProjectDiscovery() {
      return ready(projectDiscovery(projects));
    },
    async readCodexSession(machineId, threadId) {
      const record = sessions.find((candidate) => (
        candidate.machineId === machineId && candidate.id === threadId
      ));
      if (!record) throw new Error('Session not found.');
      return ready(conversation(record));
    },
    async resolveCodexSessionLocation(machineId, threadId) {
      const record = sessions.find((candidate) => (
        candidate.machineId === machineId && candidate.id === threadId
      ));
      if (!record?.cwd) throw new Error('Canonical location unavailable.');
      return ready({
        canonicalCwd: record.cwd,
        checkedAt,
        machineId,
        sessionRevision: 'a'.repeat(64),
        source: 'connector-realpath',
        threadId,
        worktreeRoot: projects.find((projectRecord) => (
          projectRecord.machineId === machineId
          && record.cwd?.startsWith(projectRecord.rootPath)
        ))?.rootPath ?? record.cwd
      });
    }
  };
  return { ...defaults, ...overrides };
}

function projectDiscovery(projects: ProjectSpaceRecord[]): ProjectDiscoveryResult {
  return {
    groups: [],
    projects,
    rootItems: [],
    rootPath: '/projects',
    structureViolations: []
  };
}

function connectorOverview(
  machines: ConnectorOverviewResult['machines']
): ConnectorOverviewResult {
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

function ready<T>(data: T, evidenceCheckedAt = checkedAt) {
  return { checkedAt: evidenceCheckedAt, data, state: 'ready' as const };
}
