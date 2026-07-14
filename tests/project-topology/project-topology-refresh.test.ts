import { describe, expect, test } from 'bun:test';
import {
  applyTopologyBuild,
  beginTopologyRefresh
} from '../../src/features/project-topology/project-topology-refresh';
import { buildProjectTopology } from '../../src/features/project-topology/project-topology-model';
import {
  checkedAt,
  codex,
  conversation,
  inventory,
  machine,
  project,
  session,
  worktrees,
  writable
} from './project-topology-test-fixtures';
import {
  topologyTaskId,
  type ProjectTopologyBuildResult,
  type ProjectTopologyReadState,
  type TopologyTask
} from '../../src/features/project-topology/project-topology-types';

describe('project topology stale snapshot safety', () => {
  test('sanitizes every retained task while checking and after a blocked refresh', () => {
    const ready = readyStateWithLiveTask();
    const originalTask = onlyTask(ready);
    expect(originalTask.interaction.canContinue).toBe(true);
    expect(originalTask.transcript.state).toBe('ready');

    const checking = beginTopologyRefresh(ready);
    expect(checking.state).toBe('checking');
    if (checking.state !== 'checking' || !checking.previous) {
      throw new Error('Expected a last-safe checking snapshot.');
    }
    expectStaleTask(onlySnapshotTask(checking.previous));
    expect(checking.previous.inventory.projects.state).toBe('stale');
    expect(checking.previous.inventory.machines.state).toBe('stale');
    expect(checking.previous.projects[0]!.inventory.state).toBe('stale');
    expect(checking.previous.projects[0]!.branches.state).toBe('stale');
    expect(checking.previous.projects[0]!.issues.state).toBe('stale');
    expect(checking.previous.projects[0]!.pullRequests.state).toBe('stale');
    expect(checking.previous.projects[0]!.machines[0]!.taskInventory.state).toBe('stale');
    expect(checking.previous.projects[0]!.machines[0]!.worktreeInventory.state).toBe('stale');
    expect(checking.previous.summary.tasks.completeness).toBe('partial');
    const stillChecking = beginTopologyRefresh(checking);
    expect(stillChecking.state).toBe('checking');
    if (stillChecking.state !== 'checking' || !stillChecking.previous) {
      throw new Error('Expected the repeated check to retain its safe snapshot.');
    }
    expectStaleTask(onlySnapshotTask(stillChecking.previous));

    const blocked = applyTopologyBuild(ready, {
      checkedAt: '2026-07-14T00:02:00.000Z',
      reason: 'Machine inventory timed out.',
      state: 'blocked'
    }, '2026-07-14T00:03:00.000Z');
    expect(blocked.state).toBe('stale');
    if (blocked.state !== 'stale') throw new Error('Expected a stale snapshot.');
    expectStaleTask(onlySnapshotTask(blocked.snapshot));

    expect(originalTask.interaction.canContinue).toBe(true);
    expect(originalTask.transcript.state).toBe('ready');
  });

  test('strips browser and write authority from tasks retained during reconciliation', () => {
    const ready = readyStateWithLiveTask();
    const current = buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { reason: 'Connector timed out.', state: 'blocked' }
      }
    }));
    const reconciled = applyTopologyBuild(ready, current);

    expect(reconciled.state).toBe('ready');
    if (reconciled.state !== 'ready') throw new Error('Expected a reconciled snapshot.');
    expectStaleTask(onlySnapshotTask(reconciled.snapshot));
  });

  test('retains the last safe task when an offline machine cannot list Codex sessions', () => {
    const ready = readyStateWithLiveTask();
    const current = buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { reason: 'Offline connector could not list tasks.', state: 'blocked' }
      },
      machines: [machine('machine-a', 'offline')]
    }));
    const reconciled = applyTopologyBuild(ready, current);

    expect(reconciled.state).toBe('ready');
    if (reconciled.state !== 'ready') throw new Error('Expected a reconciled snapshot.');
    const topologyMachine = reconciled.snapshot.projects[0]!.machines[0]!;
    expect(topologyMachine.inventory.state).toBe('stale');
    expect(topologyMachine.taskInventory.state).toBe('stale');
    expectStaleTask(topologyMachine.tasks[0]!);
  });

  test('does not let older stale task sources erase a newer known task', () => {
    const ready = readyStateWithLiveTask();
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'idle');
    const staleAt = '2026-07-13T23:59:00.000Z';
    const variants = [{
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' as const }
      },
      worktreesByProject: {
        'project-a': {
          data: worktrees('/projects/project-space', []),
          lastSafeAt: checkedAt,
          reason: 'Worktree discovery is offline.',
          state: 'stale' as const
        }
      }
    }, {
      codexByMachine: {
        'machine-a': {
          data: { ...codex('machine-a', []), checkedAt: staleAt },
          lastSafeAt: staleAt,
          reason: 'Codex inventory is offline.',
          state: 'stale' as const
        }
      }
    }];

    for (const variant of variants) {
      const reconciled = applyTopologyBuild(
        ready,
        buildProjectTopology(inventory(variant))
      );
      expect(reconciled.state).toBe('ready');
      if (reconciled.state !== 'ready') throw new Error('Expected a reconciled snapshot.');
      const topologyMachine = reconciled.snapshot.projects[0]!.machines[0]!;
      expect(topologyMachine.taskInventory.state).toBe('stale');
      expectStaleTask(topologyMachine.tasks[0]!);
    }
  });

  test('does not let an older nominally ready task list erase newer truth', () => {
    const ready = readyStateWithLiveTask();
    const olderAt = '2026-07-13T23:59:00.000Z';
    const current = buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': {
          checkedAt: olderAt,
          data: { ...codex('machine-a', []), checkedAt: olderAt },
          state: 'ready'
        }
      }
    }));
    const reconciled = applyTopologyBuild(ready, current);

    expect(reconciled.state).toBe('ready');
    if (reconciled.state !== 'ready') throw new Error('Expected a reconciled snapshot.');
    const topologyMachine = reconciled.snapshot.projects[0]!.machines[0]!;
    expect(topologyMachine.taskInventory.state).toBe('stale');
    expectStaleTask(topologyMachine.tasks[0]!);
    expect(reconciled.snapshot.summary.tasks).toEqual({
      completeness: 'partial',
      observedCount: 1
    });
  });

  test('retains a newer project when an older stale cache omits the portfolio', () => {
    const ready = readyStateWithLiveTask();
    const current = buildProjectTopology(inventory({
      projectsInventory: {
        data: [],
        lastSafeAt: '2026-07-13T23:59:00.000Z',
        reason: 'Project discovery is offline.',
        state: 'stale'
      }
    }));
    const reconciled = applyTopologyBuild(ready, current);

    expect(reconciled.state).toBe('ready');
    if (reconciled.state !== 'ready') throw new Error('Expected a reconciled snapshot.');
    expect(reconciled.snapshot.projects).toHaveLength(1);
    expect(reconciled.snapshot.projects[0]!.inventory.state).toBe('stale');
    expectStaleTask(reconciled.snapshot.projects[0]!.machines[0]!.tasks[0]!);
    expect(reconciled.snapshot.summary).toMatchObject({
      machineCount: 1,
      projectCount: 1,
      tasks: { completeness: 'partial', observedCount: 1 }
    });
  });

  test('retains the complete newer project generation over contradictory stale records', () => {
    const ready = readyStateWithLiveTask();
    const oldProject = {
      ...project('project-a', 'machine-a', '/projects/old-project-space'),
      name: 'old-project-space'
    };
    const removedProject = project(
      'project-removed',
      'machine-a',
      '/projects/removed',
      'DotNaos/removed'
    );
    const current = buildProjectTopology(inventory({
      projectsInventory: {
        data: [oldProject, removedProject],
        lastSafeAt: '2026-07-13T23:59:00.000Z',
        reason: 'Project discovery is offline.',
        state: 'stale'
      }
    }));
    const reconciled = applyTopologyBuild(ready, current);

    expect(reconciled.state).toBe('ready');
    if (reconciled.state !== 'ready') throw new Error('Expected a reconciled snapshot.');
    expect(reconciled.snapshot.projects).toHaveLength(1);
    const topologyProject = reconciled.snapshot.projects[0]!;
    expect(topologyProject.name).toBe('project-space');
    expect(topologyProject.repositoryFullName).toBe('DotNaos/project-space');
    expect(topologyProject.projectRecords[0]!.rootPath).toBe('/projects/project-space');
    expect(topologyProject.inventory.state).toBe('stale');
    expectStaleTask(topologyProject.machines[0]!.tasks[0]!);
  });

  test('retains the complete newer machine generation over older stale metadata', () => {
    const newerMachine = {
      ...machine('machine-a'),
      name: 'New machine identity',
      sourcePath: 'new-connector-source'
    };
    const ready = readyStateWithLiveTask(newerMachine);
    const olderMachine = {
      ...machine('machine-a'),
      name: 'Old machine identity',
      sourcePath: 'old-connector-source'
    };
    const current = buildProjectTopology(inventory({
      machinesInventory: {
        data: [olderMachine],
        lastSafeAt: '2026-07-13T23:59:00.000Z',
        reason: 'Machine discovery is offline.',
        state: 'stale'
      }
    }));
    const reconciled = applyTopologyBuild(ready, current);

    expect(reconciled.state).toBe('ready');
    if (reconciled.state !== 'ready') throw new Error('Expected a reconciled snapshot.');
    const topologyMachine = reconciled.snapshot.projects[0]!.machines[0]!;
    expect(topologyMachine.name).toBe('New machine identity');
    expect(topologyMachine.machine?.sourcePath).toBe('new-connector-source');
    expect(topologyMachine.inventory.state).toBe('stale');
    expectStaleTask(topologyMachine.tasks[0]!);
  });

  test('never leaves a reconciled project ready above a retained stale machine', () => {
    const base = readyStateWithLiveTask();
    const previousProject = base.snapshot.projects[0]!;
    const previousMachine = previousProject.machines[0]!;
    const previous: Extract<ProjectTopologyReadState, { state: 'ready' }> = {
      snapshot: {
        ...base.snapshot,
        checkedAt: '2026-07-14T00:02:00.000Z',
        projects: [{
          ...previousProject,
          inventory: { checkedAt: '2026-07-14T00:01:00.000Z', state: 'ready' },
          machines: [{
            ...previousMachine,
            inventory: { checkedAt: '2026-07-14T00:02:00.000Z', state: 'ready' }
          }]
        }]
      },
      state: 'ready'
    };
    const currentProject = previous.snapshot.projects[0]!;
    const currentMachine = currentProject.machines[0]!;
    const current: ProjectTopologyBuildResult = {
      snapshot: {
        ...previous.snapshot,
        checkedAt: '2026-07-14T00:03:00.000Z',
        projects: [{
          ...currentProject,
          inventory: { checkedAt: '2026-07-14T00:03:00.000Z', state: 'ready' },
          machines: [{
            ...currentMachine,
            inventory: { checkedAt: '2026-07-14T00:01:00.000Z', state: 'ready' }
          }]
        }]
      },
      state: 'ready'
    };

    const reconciled = applyTopologyBuild(previous, current);
    expect(reconciled.state).toBe('ready');
    if (reconciled.state !== 'ready') throw new Error('Expected a reconciled topology.');
    expect(reconciled.snapshot.projects[0]!.machines[0]!.inventory).toMatchObject({
      lastSafeAt: '2026-07-14T00:02:00.000Z',
      state: 'stale'
    });
    expect(reconciled.snapshot.projects[0]!.inventory).toMatchObject({
      lastSafeAt: '2026-07-14T00:02:00.000Z',
      state: 'stale'
    });
  });

  test('recomputes multi-machine truth when one task inventory becomes stale', () => {
    const machines = [machine('machine-a'), machine('machine-b')];
    const projects = [
      project('project-a', 'machine-a', '/projects/a'),
      project('project-b', 'machine-b', '/projects/b')
    ];
    const sessions = {
      'machine-a': session('machine-a', 'thread-a', '/projects/a'),
      'machine-b': session('machine-b', 'thread-b', '/projects/b')
    };
    const baseWorktrees = {
      'project-a': worktrees('/projects/a', [{
        branchName: 'main',
        headSha: 'a'.repeat(40),
        id: 'wt_aaaaaaaaaaaaaaaaaaaaaaaa',
        isBase: true,
        path: '/projects/a'
      }]),
      'project-b': worktrees('/projects/b', [{
        branchName: 'main',
        headSha: 'a'.repeat(40),
        id: 'wt_bbbbbbbbbbbbbbbbbbbbbbbb',
        isBase: true,
        path: '/projects/b'
      }])
    };
    const previous = applyTopologyBuild(undefined, buildProjectTopology(inventory({
      codexByMachine: Object.fromEntries(machines.map((entry) => [entry.id, {
        checkedAt,
        data: codex(entry.id, [sessions[entry.id as keyof typeof sessions]]),
        state: 'ready' as const
      }])),
      machines,
      projects,
      worktreesByProject: baseWorktrees
    })));
    expect(previous.state).toBe('ready');
    if (previous.state !== 'ready') throw new Error('Expected a ready topology.');
    expect(previous.snapshot.projects[0]!.multiMachineState).toBe('synchronized');

    const current = buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': {
          checkedAt,
          data: codex('machine-a', [sessions['machine-a']]),
          state: 'ready'
        },
        'machine-b': { reason: 'Connector timed out.', state: 'blocked' }
      },
      machines,
      projects,
      worktreesByProject: baseWorktrees
    }));
    const reconciled = applyTopologyBuild(previous, current);
    expect(reconciled.state).toBe('ready');
    if (reconciled.state !== 'ready') throw new Error('Expected a reconciled topology.');
    const topologyProject = reconciled.snapshot.projects[0]!;
    expect(topologyProject.multiMachineState).toBe('stale');
    expect(reconciled.snapshot.warnings[0]?.message).toContain('stale machine snapshot');
    const staleMachine = topologyProject.machines.find((entry) => entry.id === 'machine-b')!;
    expect(staleMachine.taskInventory.state).toBe('stale');
    expect(staleMachine.tasks[0]!.activity).toBe('stale');
  });
});

function readyStateWithLiveTask(
  machineRecord = machine('machine-a')
): Extract<ProjectTopologyReadState, { state: 'ready' }> {
  const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'idle');
  const taskId = topologyTaskId(candidate.machineId, candidate.id);
  const read = {
    ...conversation(candidate),
    turns: [{
      id: 'turn-a',
      items: [{ id: 'message-a', kind: 'agent-message' as const, text: 'Still here' }],
      status: 'completed' as const
    }]
  };
  const result = applyTopologyBuild(undefined, buildProjectTopology(inventory({
    codexByMachine: {
      'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
    },
    conversations: {
      [taskId]: { checkedAt, data: read, state: 'ready' }
    },
    machines: [machineRecord],
    writeCapabilities: {
      [taskId]: writable(candidate)
    }
  })));
  if (result.state !== 'ready') throw new Error('Expected a ready topology snapshot.');
  onlySnapshotTask(result.snapshot).browser = {
    checkedAt,
    frameUrl: '/api/browser-sessions/browser-a/frame',
    interaction: 'read-only',
    machineId: candidate.machineId,
    sessionId: 'browser-a',
    state: 'ready',
    threadId: candidate.id,
    tools: {
      logs: { checkedAt, streamUrl: '/api/browser-sessions/browser-a/logs' }
    }
  };
  return result;
}

function onlyTask(state: Extract<ProjectTopologyReadState, { state: 'ready' }>) {
  return onlySnapshotTask(state.snapshot);
}

function onlySnapshotTask(
  snapshot: Extract<ProjectTopologyReadState, { state: 'ready' | 'stale' }>['snapshot']
) {
  const task = snapshot.projects[0]?.machines[0]?.tasks[0];
  if (!task) throw new Error('Expected one topology task.');
  return task;
}

function expectStaleTask(task: TopologyTask) {
  expect(task.activity).toBe('stale');
  expect(task.browser.state).toBe('unavailable');
  expect(task.interaction).toMatchObject({
    canContinue: false,
    canInterrupt: false,
    composerVisible: false
  });
  expect(task.interaction.authority).toBeUndefined();
  expect(task.lastSafeAt).toBe(checkedAt);
  expect(task.transcript.state).toBe('stale');
  if (task.transcript.state === 'stale') {
    expect(task.transcript.data[0]!.id).toBe('message-a');
  }
}
