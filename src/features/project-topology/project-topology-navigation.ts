import {
  initialTopologyWorkspaceState,
  reduceTopologyWorkspace,
  type TopologyWorkspaceEvent,
  type TopologyWorkspaceState
} from './project-topology-motion';
import type {
  ProjectTopologySnapshot,
  TopologyMachine,
  TopologyProject,
  TopologyTask
} from './project-topology-types';

export type TopologyNavigationEvent =
  | TopologyWorkspaceEvent
  | { snapshot?: ProjectTopologySnapshot; type: 'snapshot-changed' };

export interface TopologyResolvedTarget {
  machine?: TopologyMachine;
  project?: TopologyProject;
  task?: TopologyTask;
}

export function reduceTopologyNavigation(
  state: TopologyWorkspaceState,
  event: TopologyNavigationEvent
) {
  return event.type === 'snapshot-changed'
    ? reconcileTopologyWorkspace(state, event.snapshot)
    : reduceTopologyWorkspace(state, event);
}

export function reconcileTopologyWorkspace(
  state: TopologyWorkspaceState,
  snapshot?: ProjectTopologySnapshot
): TopologyWorkspaceState {
  const overview = { kind: 'overview' as const };
  const targetExists = topologyTargetExists(snapshot, state.target);
  const returnTarget = topologyTargetExists(snapshot, state.returnTarget)
    ? state.returnTarget
    : overview;
  const pendingTarget = state.pendingTarget
    && topologyTargetExists(snapshot, state.pendingTarget)
      ? state.pendingTarget
      : undefined;

  if (!targetExists) {
    const target = pendingTarget ?? returnTarget;
    return {
      phase: 'focusing',
      returnTarget: target.kind === 'task' ? returnTarget : target,
      target,
      transition: state.transition + 1
    };
  }

  if (
    returnTarget === state.returnTarget
    && pendingTarget === state.pendingTarget
  ) return state;

  return {
    ...state,
    pendingTarget,
    returnTarget
  };
}

export function topologyTargetExists(
  snapshot: ProjectTopologySnapshot | undefined,
  target: TopologyWorkspaceState['target']
) {
  if (target.kind === 'overview') return true;
  if (!snapshot) return false;
  const resolved = resolveTopologyTarget(snapshot, target);
  if (target.kind === 'project') return Boolean(resolved.project);
  if (target.kind === 'machine') return Boolean(resolved.machine);
  return Boolean(resolved.task);
}

export function resolveTopologyTarget(
  snapshot: ProjectTopologySnapshot,
  target: TopologyWorkspaceState['target']
): TopologyResolvedTarget {
  if (target.kind === 'overview') return {};
  if (target.kind === 'project') {
    return { project: snapshot.projects.find((project) => project.id === target.projectId) };
  }
  if (target.kind === 'machine') {
    const project = snapshot.projects.find((candidate) => candidate.id === target.projectId);
    return {
      machine: project?.machines.find((machine) => machine.id === target.machineId),
      project
    };
  }
  for (const project of snapshot.projects) {
    for (const machine of project.machines) {
      const task = machine.tasks.find((candidate) => candidate.id === target.taskId);
      if (task) return { machine, project, task };
    }
  }
  return {};
}

export function topologyNavigationBindings(
  dispatch: (event: TopologyNavigationEvent) => void
) {
  return {
    closeTask() {
      dispatch({ type: 'close-task' });
    },
    focusMachine(projectId: string, machineId: string) {
      dispatch({ target: { kind: 'machine', machineId, projectId }, type: 'focus' });
    },
    focusOverview() {
      dispatch({ target: { kind: 'overview' }, type: 'focus' });
    },
    focusProject(projectId: string) {
      dispatch({ target: { kind: 'project', projectId }, type: 'focus' });
    },
    openTask(taskId: string) {
      dispatch({ taskId, type: 'open-task' });
    },
    viewportSettled(target: TopologyWorkspaceState['target'], transition: number) {
      dispatch({ target, transition, type: 'viewport-settled' });
    },
    workspaceSettled(result: {
      phase: 'closing' | 'opening';
      taskId: string;
      transition: number;
    }) {
      dispatch(result.phase === 'opening'
        ? {
            taskId: result.taskId,
            transition: result.transition,
            type: 'workspace-opened'
          }
        : {
            taskId: result.taskId,
            transition: result.transition,
            type: 'workspace-closed'
          });
    }
  };
}

export function initialTopologyNavigationState() {
  return initialTopologyWorkspaceState();
}
