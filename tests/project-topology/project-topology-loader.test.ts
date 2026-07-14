import { describe, expect, test } from 'bun:test';
import { applyTopologyBuild, buildProjectTopology } from '../../src/features/project-topology/project-topology-model';
import { loadProjectTopologyInventory } from '../../src/features/project-topology/project-topology-loader';
import {
  checkedAt,
  machine,
  project,
  session,
  snapshot,
  worktrees
} from './project-topology-test-fixtures';
import {
  topologyTaskId,
  type TopologyTaskEvidence
} from '../../src/features/project-topology/project-topology-types';
import { sourceHarness, type SourceOptions } from './project-topology-loader-harness';
describe('project topology loader', () => {
  test('uses one atomic project/worktree snapshot and skips legacy fanout', async () => {
    const record = project('project-a', 'machine-a', '/projects/project-space');
    const { calls, source } = sourceHarness({ projects: [record], sessions: [] });
    let snapshots = 0;
    source.loadProjectWorktreeSnapshot = async () => {
      snapshots += 1;
      return {
        checkedAt,
        data: {
          authorization: {
            connectorOverviewCheckedAt: checkedAt,
            projectDiscoveryCheckedAt: checkedAt
          },
          checkedAt,
          publishedAt: checkedAt,
          projectDiscovery: {
            groups: [], projects: [record], rootItems: [], rootPath: '/projects',
            structureViolations: []
          },
          worktrees: [{
            machineId: record.machineId,
            projectId: record.id,
            result: worktrees(record.rootPath, [])
          }]
        },
        state: 'ready'
      };
    };

    const inventory = await loadProjectTopologyInventory(source, {
      clock: () => checkedAt,
      includeTranscripts: false
    });

    expect(snapshots).toBe(1);
    expect(calls.projects).toBe(0);
    expect(calls.worktrees).toEqual([]);
    expect(inventory.worktreesByProjectScope['machine-a:project-a']).toMatchObject({
      state: 'proven-empty'
    });
  });

  test('keeps valid early worktree evidence stale when a slow sibling ages it', async () => {
    const record = project('project-a', 'machine-a', '/projects/project-space');
    const { source } = sourceHarness({ projects: [record], sessions: [] });
    const publishedAt = '2026-07-14T00:00:31.000Z';
    source.loadProjectWorktreeSnapshot = async () => ({
      checkedAt: publishedAt,
      data: {
        authorization: {
          connectorOverviewCheckedAt: publishedAt,
          projectDiscoveryCheckedAt: publishedAt
        },
        checkedAt: publishedAt,
        publishedAt,
        projectDiscovery: {
          groups: [], projects: [record], rootItems: [], rootPath: '/projects',
          structureViolations: []
        },
        worktrees: [{
          machineId: record.machineId,
          projectId: record.id,
          result: worktrees(record.rootPath, [])
        }]
      },
      state: 'ready'
    });

    const inventory = await loadProjectTopologyInventory(source, {
      clock: () => publishedAt,
      includeTranscripts: false
    });

    expect(inventory.worktreesByProjectScope['machine-a:project-a']).toMatchObject({
      lastSafeAt: checkedAt,
      state: 'stale'
    });
  });

  test('joins a real task read-only through canonical location and stable machine/thread calls', async () => {
    const { calls, source } = sourceHarness();
    const inventory = await loadProjectTopologyInventory(source, { clock: () => checkedAt });
    const id = topologyTaskId('machine-a', 'thread-a');
    const result = snapshot(buildProjectTopology(inventory));
    const task = result.projects[0]!.machines[0]!.tasks[0]!;

    expect(calls.sessions).toEqual(['machine-a']);
    expect(calls.locations).toEqual([['machine-a', 'thread-a']]);
    expect(calls.reads).toEqual([['machine-a', 'thread-a']]);
    expect(calls.writes).toEqual([]);
    expect(inventory.taskLocationsByTaskId?.[id]).toMatchObject({
      canonicalCwd: '/projects/project-space/src',
      machineId: 'machine-a',
      threadId: 'thread-a'
    });
    expect(inventory.conversationsByTaskId?.[id]?.state).toBe('ready');
    expect(inventory.writeCapabilitiesByTaskId).toBeUndefined();
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
        sessionRevision: 'a'.repeat(64),
        source: 'connector-realpath',
        threadId: 'thread-a',
        worktreeRoot: 'relative/untrusted/path'
      },
      state: 'blocked'
    }, {
      canonicalLocation: {
        canonicalCwd: '/projects/project-space',
        checkedAt,
        machineId: 'machine-b',
        sessionRevision: 'a'.repeat(64),
        source: 'connector-realpath',
        threadId: 'thread-a',
        worktreeRoot: '/projects/project-space'
      },
      state: 'blocked'
    }, {
      canonicalLocation: {
        canonicalCwd: '/somewhere/outside-the-project',
        checkedAt,
        machineId: 'machine-a',
        sessionRevision: 'a'.repeat(64),
        source: 'connector-realpath',
        threadId: 'thread-a',
        worktreeRoot: '/somewhere/outside-the-project'
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
        sessionRevision: 'a'.repeat(64),
        source: 'connector-realpath',
        threadId: 'thread-a',
        worktreeRoot: '/projects/a-different-project'
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
    expect(calls.writes).toEqual([]);
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
