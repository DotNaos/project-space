import { describe, expect, test } from 'bun:test';
import {
  initialTopologyWorkspaceState,
  interpolateTopologyBounds,
  reduceTopologyWorkspace,
  topologySpringKeyframes,
  topologySprings,
  topologyTransitionDuration,
  type TopologyWorkspaceState
} from '../../src/features/project-topology/project-topology-motion';

describe('project topology physical transitions', () => {
  test('uses a settled focus spring and a physical overshoot for workspace expansion', () => {
    const focus = topologySpringKeyframes(topologySprings.focus, { samples: 40 });
    const workspace = topologySpringKeyframes(topologySprings.workspace, { samples: 40 });

    expect(focus[0]).toEqual({ offset: 0, progress: 0 });
    expect(focus.at(-1)).toEqual({ offset: 1, progress: 1 });
    expect(focus.every((frame, index) => (
      index === 0 || frame.progress >= focus[index - 1]!.progress
    ))).toBe(true);
    expect(workspace.some((frame) => frame.progress > 1)).toBe(true);
    expect(workspace.at(-1)).toEqual({ offset: 1, progress: 1 });
  });

  test('collapses motion to one final frame when reduced motion is requested', () => {
    expect(topologySpringKeyframes(topologySprings.workspace, { reducedMotion: true })).toEqual([
      { offset: 0, progress: 1 }
    ]);
    expect(topologyTransitionDuration(topologySprings.workspace, true)).toBe(0);
    expect(topologySpringKeyframes(topologySprings.workspace, { samples: Infinity })).toHaveLength(24);
    expect(topologySpringKeyframes(topologySprings.workspace, { samples: 1_000_000 })).toHaveLength(120);
  });

  test('interpolates a task cell rectangle into the focused workspace', () => {
    const halfway = interpolateTopologyBounds(
      { height: 170, width: 404, x: 20, y: 30 },
      { height: 700, width: 1100, x: 12, y: 12 },
      0.5
    );
    expect(halfway).toEqual({ height: 435, width: 752, x: 16, y: 21 });
  });

  test('opens a task only after viewport and workspace transition evidence', () => {
    const initial = initialTopologyWorkspaceState();
    const projectFocused = reduceTopologyWorkspace(initial, {
      target: { kind: 'project', projectId: 'project-a' },
      type: 'focus'
    });
    const canvas = settleViewport(projectFocused);
    const focusingTask = reduceTopologyWorkspace(canvas, {
      taskId: 'task-a',
      type: 'open-task'
    });

    expect(focusingTask.phase).toBe('focusing');
    const opening = settleViewport(focusingTask);
    expect(opening.phase).toBe('opening');
    const open = settleWorkspaceOpen(opening);
    expect(open.phase).toBe('open');
    expect(open.returnTarget).toEqual({ kind: 'project', projectId: 'project-a' });

    const closing = reduceTopologyWorkspace(open, { type: 'close-task' });
    const returning = settleWorkspaceClosed(closing);
    expect(returning).toMatchObject({
      phase: 'focusing',
      target: { kind: 'project', projectId: 'project-a' }
    });
    expect(settleViewport(returning).phase).toBe('canvas');
  });

  test('cancels a task while its viewport is still focusing', () => {
    const projectTarget = { kind: 'project' as const, projectId: 'project-a' };
    const projectFocused = reduceTopologyWorkspace(initialTopologyWorkspaceState(), {
      target: projectTarget,
      type: 'focus'
    });
    const canvas = settleViewport(projectFocused);
    const focusingTask = reduceTopologyWorkspace(canvas, {
      taskId: 'task-a',
      type: 'open-task'
    });
    const cancelled = reduceTopologyWorkspace(focusingTask, { type: 'close-task' });

    expect(cancelled).toMatchObject({ phase: 'focusing', target: projectTarget });
    expect(settleWorkspaceOpen(cancelled, 'task-a')).toEqual(cancelled);
    expect(settleViewport(cancelled)).toMatchObject({
      phase: 'canvas',
      target: projectTarget
    });
  });

  test('closes the open workspace before focusing another canvas area', () => {
    const projectTarget = { kind: 'project' as const, projectId: 'project-a' };
    const machineTarget = {
      kind: 'machine' as const,
      machineId: 'machine-b',
      projectId: 'project-a'
    };
    const focusingTask = reduceTopologyWorkspace(
      {
        phase: 'canvas',
        returnTarget: projectTarget,
        target: projectTarget,
        transition: 0
      },
      { taskId: 'task-a', type: 'open-task' }
    );
    const opening = settleViewport(focusingTask);
    const open = settleWorkspaceOpen(opening);
    const closing = reduceTopologyWorkspace(open, {
      target: machineTarget,
      type: 'focus'
    });

    expect(closing).toMatchObject({
      pendingTarget: machineTarget,
      phase: 'closing',
      returnTarget: projectTarget,
      target: { kind: 'task', taskId: 'task-a' }
    });
    expect(settleViewport(closing, machineTarget)).toEqual(closing);
    expect(settleWorkspaceOpen(closing, 'task-a')).toEqual(closing);
    expect(settleWorkspaceClosed(closing)).toMatchObject({
      phase: 'focusing',
      returnTarget: machineTarget,
      target: machineTarget
    });
  });

  test('queues another task while opening and preserves the canvas return target', () => {
    const projectTarget = { kind: 'project' as const, projectId: 'project-a' };
    const taskA = reduceTopologyWorkspace(
      {
        phase: 'canvas',
        returnTarget: projectTarget,
        target: projectTarget,
        transition: 0
      },
      { taskId: 'task-a', type: 'open-task' }
    );
    const opening = settleViewport(taskA);
    const closing = reduceTopologyWorkspace(opening, {
      taskId: 'task-b',
      type: 'open-task'
    });

    expect(closing).toMatchObject({
      pendingTarget: { kind: 'task', taskId: 'task-b' },
      phase: 'closing',
      target: { kind: 'task', taskId: 'task-a' }
    });
    const focusingTaskB = settleWorkspaceClosed(closing);
    expect(focusingTaskB).toMatchObject({
      phase: 'focusing',
      returnTarget: projectTarget,
      target: { kind: 'task', taskId: 'task-b' }
    });
    expect(settleViewport(focusingTaskB)).toMatchObject({
      phase: 'opening',
      returnTarget: projectTarget,
      target: { kind: 'task', taskId: 'task-b' }
    });
  });

  test('keeps closing while conflicting navigation events update the latest intent', () => {
    const projectTarget = { kind: 'project' as const, projectId: 'project-a' };
    const closing = {
      phase: 'closing' as const,
      returnTarget: projectTarget,
      target: { kind: 'task' as const, taskId: 'task-a' },
      transition: 7
    };
    const machineQueued = reduceTopologyWorkspace(closing, {
      target: {
        kind: 'machine',
        machineId: 'machine-a',
        projectId: 'project-a'
      },
      type: 'focus'
    });
    const taskQueued = reduceTopologyWorkspace(machineQueued, {
      taskId: 'task-b',
      type: 'open-task'
    });
    const finalTarget = { kind: 'project' as const, projectId: 'project-c' };
    const projectQueued = reduceTopologyWorkspace(taskQueued, {
      target: finalTarget,
      type: 'focus'
    });

    expect(machineQueued.phase).toBe('closing');
    expect(taskQueued).toMatchObject({
      pendingTarget: { kind: 'task', taskId: 'task-b' },
      phase: 'closing',
      target: closing.target
    });
    expect(projectQueued).toMatchObject({
      pendingTarget: finalTarget,
      phase: 'closing',
      target: closing.target
    });
    expect(settleWorkspaceClosed(projectQueued)).toMatchObject({
      phase: 'focusing',
      returnTarget: finalTarget,
      target: finalTarget
    });
  });

  test('ignores stale settlement callbacks across an A-B-A focus race', () => {
    const initial = initialTopologyWorkspaceState();
    const projectA = { kind: 'project' as const, projectId: 'project-a' };
    const projectB = { kind: 'project' as const, projectId: 'project-b' };
    const focusingA = reduceTopologyWorkspace(initial, { target: projectA, type: 'focus' });
    const focusingB = reduceTopologyWorkspace(focusingA, { target: projectB, type: 'focus' });
    const focusingAAgain = reduceTopologyWorkspace(focusingB, {
      target: projectA,
      type: 'focus'
    });

    expect(reduceTopologyWorkspace(focusingAAgain, {
      target: projectA,
      transition: focusingA.transition,
      type: 'viewport-settled'
    })).toEqual(focusingAAgain);
    expect(reduceTopologyWorkspace(focusingAAgain, {
      target: projectA,
      transition: focusingAAgain.transition,
      type: 'viewport-settled'
    }).phase).toBe('canvas');
  });
});

function settleViewport(
  state: TopologyWorkspaceState,
  target = state.target
) {
  return reduceTopologyWorkspace(state, {
    target,
    transition: state.transition,
    type: 'viewport-settled'
  });
}

function settleWorkspaceOpen(state: TopologyWorkspaceState, taskId?: string) {
  return reduceTopologyWorkspace(state, {
    taskId: taskId ?? (state.target.kind === 'task' ? state.target.taskId : 'not-current'),
    transition: state.transition,
    type: 'workspace-opened'
  });
}

function settleWorkspaceClosed(state: TopologyWorkspaceState) {
  return reduceTopologyWorkspace(state, {
    taskId: state.target.kind === 'task' ? state.target.taskId : 'not-current',
    transition: state.transition,
    type: 'workspace-closed'
  });
}
