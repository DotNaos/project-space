import { describe, expect, test } from 'bun:test';
import { buildProjectTopology } from '../../src/features/project-topology/project-topology-model';
import {
  loadProjectTopologyInventory,
  loadProjectTopologyTaskDetails
} from '../../src/features/project-topology/project-topology-loader';
import { loadProjectTopologySelectedTask } from '../../src/features/project-topology/project-topology-selected-task-loader';
import {
  topologyTaskId,
  type TopologyTaskWriteCapability
} from '../../src/features/project-topology/project-topology-types';
import {
  checkedAt,
  codex,
  conversation,
  machine,
  project,
  session,
  snapshot
} from './project-topology-test-fixtures';
import { readyEvidence, sourceHarness } from './project-topology-loader-harness';

describe('selected topology task loader', () => {
  test('never requests write authority while loading the portfolio overview', async () => {
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
    expect(withInventory.writeCapabilitiesByTaskId?.[id]).toBeUndefined();
    expect(withWrite.calls.writes).toEqual([]);
  });

  test('strips selected authority when returning to portfolio detail loading', async () => {
    const { calls, source } = sourceHarness();
    const overview = await loadProjectTopologyInventory(source, {
      clock: () => checkedAt,
      includeTranscripts: false
    });
    const task = snapshot(buildProjectTopology(overview))
      .projects[0]!.machines[0]!.tasks[0]!;
    const selected = await loadProjectTopologySelectedTask(
      source,
      overview,
      task.id,
      { clock: () => checkedAt }
    );
    expect(selected.writeCapabilitiesByTaskId?.[task.id]?.state).toBe('ready');

    const readOnly = await loadProjectTopologyTaskDetails(source, selected, {
      clock: () => checkedAt
    });

    expect(readOnly.writeCapabilitiesByTaskId).toBeUndefined();
    expect(calls.writes).toEqual([['machine-a', 'thread-a']]);
  });

  test('does not request selected-task authority from stale membership evidence', async () => {
    for (const staleSource of ['projects', 'codex'] as const) {
      const { calls, source } = sourceHarness();
      const overview = await loadProjectTopologyInventory(source, {
        clock: () => checkedAt,
        includeTranscripts: false
      });
      const task = snapshot(buildProjectTopology(overview))
        .projects[0]!.machines[0]!.tasks[0]!;
      const stale = staleSource === 'projects'
        ? {
            ...overview,
            projects: {
              data: overview.projects.state === 'ready' ? overview.projects.data : [],
              lastSafeAt: checkedAt,
              reason: 'Project discovery is stale.',
              state: 'stale' as const
            }
          }
        : {
            ...overview,
            codexByMachineId: {
              ...overview.codexByMachineId,
              'machine-a': {
                data: overview.codexByMachineId['machine-a']!.state === 'ready'
                  ? overview.codexByMachineId['machine-a']!.data
                  : codex('machine-a', []),
                lastSafeAt: checkedAt,
                reason: 'Codex inventory is stale.',
                state: 'stale' as const
              }
            }
          };

      const selected = await loadProjectTopologySelectedTask(
        source,
        stale,
        task.id,
        { clock: () => checkedAt }
      );

      expect(selected.writeCapabilitiesByTaskId).toBeUndefined();
      expect(calls.writes).toEqual([]);
      expect(calls.reads).toEqual([]);
    }
  });

  test('does not request authority when the selected transcript generation changed', async () => {
    const { calls, source } = sourceHarness();
    const overview = await loadProjectTopologyInventory(source, {
      clock: () => checkedAt,
      includeTranscripts: false
    });
    const task = snapshot(buildProjectTopology(overview))
      .projects[0]!.machines[0]!.tasks[0]!;
    source.readCodexSession = async (machineId, threadId) => {
      calls.reads.push([machineId, threadId]);
      return readyEvidence(conversation({
        ...task.session,
        lastActivityAt: '2026-07-14T00:00:01.000Z'
      }));
    };

    const selected = await loadProjectTopologySelectedTask(
      source,
      overview,
      task.id,
      { clock: () => checkedAt }
    );

    expect(calls.writes).toEqual([]);
    expect(selected.writeCapabilitiesByTaskId).toBeUndefined();
    expect(snapshot(buildProjectTopology(selected))
      .projects[0]!.machines[0]!.tasks[0]!.interaction.composerVisible).toBe(false);
  });

  test('hides the composer when selected authority belongs to another location revision', async () => {
    const { calls, source } = sourceHarness({
      writeCapability: {
        canContinue: true,
        checkedAt,
        expiresAt: '2026-07-14T00:05:00.000Z',
        machineId: 'machine-a',
        sessionLastActivityAt: checkedAt,
        sessionRevision: 'b'.repeat(64),
        state: 'ready',
        threadId: 'thread-a'
      }
    });
    const overview = await loadProjectTopologyInventory(source, {
      clock: () => checkedAt,
      includeTranscripts: false
    });
    const task = snapshot(buildProjectTopology(overview))
      .projects[0]!.machines[0]!.tasks[0]!;
    const selected = await loadProjectTopologySelectedTask(
      source,
      overview,
      task.id,
      { clock: () => checkedAt }
    );

    expect(calls.writes).toEqual([['machine-a', 'thread-a']]);
    expect(selected.writeCapabilitiesByTaskId?.[task.id]?.state).toBe('blocked');
    expect(snapshot(buildProjectTopology(selected))
      .projects[0]!.machines[0]!.tasks[0]!.interaction.composerVisible).toBe(false);
  });

  test('keeps selected authority isolated by machine when thread IDs match', async () => {
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
    const selectedId = topologyTaskId('machine-b', 'same-thread');
    const selected = await loadProjectTopologySelectedTask(
      source,
      loaded,
      selectedId,
      { clock: () => checkedAt }
    );

    expect(calls.writes).toEqual([['machine-b', 'same-thread']]);
    expect(Object.keys(selected.writeCapabilitiesByTaskId ?? {})).toEqual([selectedId]);
  });

  test('requests short-lived authority only for the explicitly selected current task', async () => {
    let now = Date.parse(checkedAt);
    const iso = () => new Date(now).toISOString();
    const { calls, source } = sourceHarness();
    source.resolveCodexSessionLocation = async (machineId, threadId) => {
      now += 1_000;
      const location = {
        canonicalCwd: '/projects/project-space/src',
        checkedAt: iso(),
        machineId,
        sessionRevision: 'a'.repeat(64),
        source: 'connector-realpath',
        threadId,
        worktreeRoot: '/projects/project-space'
      };
      return { checkedAt: location.checkedAt, data: location, state: 'ready' };
    };
    source.getCodexSessionWriteCapability = async (machineId, threadId) => {
      calls.writes.push([machineId, threadId]);
      now += 1_000;
      return {
        canContinue: true,
        checkedAt: iso(),
        expiresAt: new Date(now + 5 * 60 * 1_000).toISOString(),
        machineId,
        sessionRevision: 'a'.repeat(64),
        sessionLastActivityAt: checkedAt,
        state: 'ready',
        threadId
      };
    };

    const loaded = await loadProjectTopologyInventory(source, { clock: iso });
    const task = snapshot(buildProjectTopology(loaded)).projects[0]!.machines[0]!.tasks[0]!;
    const selected = await loadProjectTopologySelectedTask(source, loaded, task.id, { clock: iso });
    const location = selected.taskLocationsByTaskId?.[task.id];
    const authority = selected.writeCapabilitiesByTaskId?.[task.id];

    expect(calls.writes).toEqual([['machine-a', 'thread-a']]);
    expect(Date.parse(selected.checkedAt)).toBeGreaterThanOrEqual(Date.parse(location!.checkedAt));
    expect(authority?.state).toBe('ready');
    if (authority?.state === 'ready') {
      expect(Date.parse(selected.checkedAt)).toBeGreaterThanOrEqual(Date.parse(authority.checkedAt));
    }
    const selectedTask = snapshot(buildProjectTopology(selected))
      .projects[0]!.machines[0]!.tasks[0]!;
    expect(selectedTask.interaction.composerVisible).toBe(true);
  });
});
