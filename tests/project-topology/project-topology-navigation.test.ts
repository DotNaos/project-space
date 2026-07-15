import { describe, expect, test } from 'bun:test';
import {
  initialTopologyNavigationState,
  reconcileTopologyWorkspace,
  reduceTopologyNavigation,
  resolveTopologyTarget,
  topologyNavigationBindings
} from '../../src/features/project-topology/project-topology-navigation';
import { buildProjectTopology } from '../../src/features/project-topology/project-topology-model';
import type { TopologyNavigationEvent } from '../../src/features/project-topology/project-topology-navigation';
import {
  checkedAt,
  codex,
  inventory,
  session,
  snapshot
} from './project-topology-test-fixtures';

describe('project topology navigation compositor', () => {
  test('resolves exact project, machine, and task identities from the current snapshot', () => {
    const topology = topologyWithTask();
    const project = topology.projects[0]!;
    const machine = project.machines[0]!;
    const task = machine.tasks[0]!;

    expect(resolveTopologyTarget(topology, {
      kind: 'project', projectId: project.id
    })).toEqual({ project });
    expect(resolveTopologyTarget(topology, {
      kind: 'machine', machineId: machine.id, projectId: project.id
    })).toEqual({ machine, project });
    expect(resolveTopologyTarget(topology, {
      kind: 'task', taskId: task.id
    })).toEqual({ machine, project, task });
    expect(resolveTopologyTarget(topology, {
      kind: 'task', taskId: 'missing-task'
    })).toEqual({});
  });

  test('returns a task to the exact focused machine after ordered settlements', () => {
    const topology = topologyWithTask();
    const project = topology.projects[0]!;
    const machine = project.machines[0]!;
    const task = machine.tasks[0]!;
    let state = initialTopologyNavigationState();

    state = reduceTopologyNavigation(state, {
      target: { kind: 'machine', machineId: machine.id, projectId: project.id },
      type: 'focus'
    });
    state = settleViewport(state);
    state = reduceTopologyNavigation(state, { taskId: task.id, type: 'open-task' });
    state = settleViewport(state);
    state = reduceTopologyNavigation(state, {
      taskId: task.id,
      transition: state.transition,
      type: 'workspace-opened'
    });
    expect(state).toMatchObject({
      phase: 'open',
      returnTarget: { kind: 'machine', machineId: machine.id, projectId: project.id }
    });

    state = reduceTopologyNavigation(state, { type: 'close-task' });
    state = reduceTopologyNavigation(state, {
      taskId: task.id,
      transition: state.transition,
      type: 'workspace-closed'
    });
    expect(state).toMatchObject({
      phase: 'focusing',
      target: { kind: 'machine', machineId: machine.id, projectId: project.id }
    });
  });

  test('fails closed to the last valid canvas target when a selected task disappears', () => {
    const topology = topologyWithTask();
    const project = topology.projects[0]!;
    const task = project.machines[0]!.tasks[0]!;
    const open = {
      phase: 'open' as const,
      returnTarget: { kind: 'project' as const, projectId: project.id },
      target: { kind: 'task' as const, taskId: task.id },
      transition: 8
    };
    const withoutTask = snapshot(buildProjectTopology(inventory()));

    const reconciled = reconcileTopologyWorkspace(open, withoutTask);

    expect(reconciled).toEqual({
      phase: 'focusing',
      returnTarget: { kind: 'project', projectId: project.id },
      target: { kind: 'project', projectId: project.id },
      transition: 9
    });
    expect(reduceTopologyNavigation(reconciled, {
      taskId: task.id,
      transition: 8,
      type: 'workspace-closed'
    })).toEqual(reconciled);
  });

  test('drops missing queued targets and resets removed canvas focus to overview', () => {
    const topology = topologyWithTask();
    const project = topology.projects[0]!;
    const task = project.machines[0]!.tasks[0]!;
    const anotherTopology = snapshot(buildProjectTopology(inventory({
      projects: []
    })));
    const closing = {
      pendingTarget: { kind: 'task' as const, taskId: 'missing-task' },
      phase: 'closing' as const,
      returnTarget: { kind: 'project' as const, projectId: project.id },
      target: { kind: 'task' as const, taskId: task.id },
      transition: 3
    };

    expect(reconcileTopologyWorkspace(closing, anotherTopology)).toEqual({
      phase: 'focusing',
      returnTarget: { kind: 'overview' },
      target: { kind: 'overview' },
      transition: 4
    });
  });

  test('emits token-preserving focus and settlement events through one binding', () => {
    const events: TopologyNavigationEvent[] = [];
    const bindings = topologyNavigationBindings((event) => events.push(event));

    bindings.focusProject('project-a');
    bindings.focusMachine('project-a', 'machine-a');
    bindings.openTask('task-a');
    bindings.viewportSettled({ kind: 'task', taskId: 'task-a' }, 7);
    bindings.workspaceSettled({ phase: 'opening', taskId: 'task-a', transition: 8 });
    bindings.workspaceSettled({ phase: 'closing', taskId: 'task-a', transition: 9 });
    bindings.closeTask();
    bindings.focusOverview();

    expect(events).toEqual([
      { target: { kind: 'project', projectId: 'project-a' }, type: 'focus' },
      {
        target: { kind: 'machine', machineId: 'machine-a', projectId: 'project-a' },
        type: 'focus'
      },
      { taskId: 'task-a', type: 'open-task' },
      {
        target: { kind: 'task', taskId: 'task-a' },
        transition: 7,
        type: 'viewport-settled'
      },
      { taskId: 'task-a', transition: 8, type: 'workspace-opened' },
      { taskId: 'task-a', transition: 9, type: 'workspace-closed' },
      { type: 'close-task' },
      { target: { kind: 'overview' }, type: 'focus' }
    ]);
  });
});

function topologyWithTask() {
  const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'active');
  return snapshot(buildProjectTopology(inventory({
    codexByMachine: {
      'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
    }
  })));
}

function settleViewport(state: ReturnType<typeof initialTopologyNavigationState>) {
  return reduceTopologyNavigation(state, {
    target: state.target,
    transition: state.transition,
    type: 'viewport-settled'
  });
}
