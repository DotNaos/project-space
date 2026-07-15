import type { TopologyBounds, TopologyFocusTarget } from './project-topology-layout';

export interface TopologySpring {
  damping: number;
  durationMs: number;
  mass: number;
  stiffness: number;
}

export const topologySprings = {
  focus: { damping: 27, durationMs: 560, mass: 1, stiffness: 180 },
  workspace: { damping: 24, durationMs: 620, mass: 1, stiffness: 260 }
} satisfies Record<string, TopologySpring>;

export interface TopologySpringKeyframe {
  offset: number;
  progress: number;
}

export function topologySpringProgress(
  elapsedFraction: number,
  spring: TopologySpring
) {
  const fraction = Math.min(1, Math.max(0, elapsedFraction));
  if (fraction === 0) return 0;
  if (fraction === 1) return 1;
  const time = fraction * spring.durationMs / 1000;
  const omega = Math.sqrt(spring.stiffness / spring.mass);
  const ratio = spring.damping / (2 * Math.sqrt(spring.stiffness * spring.mass));
  if (ratio < 1) {
    const damped = omega * Math.sqrt(1 - ratio * ratio);
    const phase = ratio / Math.sqrt(1 - ratio * ratio);
    return 1 - Math.exp(-ratio * omega * time) * (
      Math.cos(damped * time) + phase * Math.sin(damped * time)
    );
  }
  if (Math.abs(ratio - 1) < 0.0001) {
    return 1 - Math.exp(-omega * time) * (1 + omega * time);
  }
  const root = Math.sqrt(ratio * ratio - 1);
  const first = -omega * (ratio - root);
  const second = -omega * (ratio + root);
  const firstWeight = second / (first - second);
  const secondWeight = -first / (first - second);
  return 1 + firstWeight * Math.exp(first * time) + secondWeight * Math.exp(second * time);
}

export function topologySpringKeyframes(
  spring: TopologySpring,
  options: { reducedMotion?: boolean; samples?: number } = {}
): TopologySpringKeyframe[] {
  if (options.reducedMotion) return [{ offset: 0, progress: 1 }];
  const requestedSamples = Number.isFinite(options.samples)
    ? Math.floor(options.samples!)
    : 24;
  const samples = Math.min(120, Math.max(2, requestedSamples));
  return Array.from({ length: samples }, (_, index) => {
    const offset = index / (samples - 1);
    return { offset, progress: topologySpringProgress(offset, spring) };
  });
}

export function topologyTransitionDuration(
  spring: TopologySpring,
  reducedMotion: boolean
) {
  return reducedMotion ? 0 : spring.durationMs;
}

export function interpolateTopologyBounds(
  from: TopologyBounds,
  to: TopologyBounds,
  progress: number
): TopologyBounds {
  return {
    height: interpolate(from.height, to.height, progress),
    width: interpolate(from.width, to.width, progress),
    x: interpolate(from.x, to.x, progress),
    y: interpolate(from.y, to.y, progress)
  };
}

function interpolate(from: number, to: number, progress: number) {
  return from + (to - from) * progress;
}

export type TopologyWorkspacePhase =
  | 'canvas'
  | 'closing'
  | 'focusing'
  | 'open'
  | 'opening';

export interface TopologyWorkspaceState {
  pendingTarget?: TopologyFocusTarget;
  phase: TopologyWorkspacePhase;
  returnTarget: Exclude<TopologyFocusTarget, { kind: 'task' }>;
  target: TopologyFocusTarget;
  transition: number;
}

export type TopologyWorkspaceEvent =
  | { target: Exclude<TopologyFocusTarget, { kind: 'task' }>; type: 'focus' }
  | { taskId: string; type: 'open-task' }
  | { target: TopologyFocusTarget; transition: number; type: 'viewport-settled' }
  | { taskId: string; transition: number; type: 'workspace-opened' }
  | { type: 'close-task' }
  | { taskId: string; transition: number; type: 'workspace-closed' };

export function initialTopologyWorkspaceState(): TopologyWorkspaceState {
  const overview = { kind: 'overview' as const };
  return { phase: 'canvas', returnTarget: overview, target: overview, transition: 0 };
}

export function reduceTopologyWorkspace(
  state: TopologyWorkspaceState,
  event: TopologyWorkspaceEvent
): TopologyWorkspaceState {
  if (event.type === 'focus') {
    return navigateTopologyWorkspace(state, event.target);
  }
  if (event.type === 'open-task') {
    return navigateTopologyWorkspace(state, { kind: 'task', taskId: event.taskId });
  }
  if (
    event.type === 'viewport-settled'
    && state.phase === 'focusing'
    && event.transition === state.transition
    && sameFocusTarget(event.target, state.target)
  ) {
    return state.target.kind === 'task'
      ? { ...state, phase: 'opening', transition: state.transition + 1 }
      : { ...state, phase: 'canvas' };
  }
  if (
    event.type === 'workspace-opened'
    && state.phase === 'opening'
    && event.transition === state.transition
    && state.target.kind === 'task'
    && event.taskId === state.target.taskId
  ) {
    return { ...state, phase: 'open' };
  }
  if (
    event.type === 'close-task'
    && state.phase === 'focusing'
    && state.target.kind === 'task'
  ) {
    return { ...state, target: state.returnTarget, transition: state.transition + 1 };
  }
  if (event.type === 'close-task' && (state.phase === 'open' || state.phase === 'opening')) {
    return { ...state, phase: 'closing', transition: state.transition + 1 };
  }
  if (
    event.type === 'workspace-closed'
    && state.phase === 'closing'
    && event.transition === state.transition
    && state.target.kind === 'task'
    && event.taskId === state.target.taskId
  ) {
    const target = state.pendingTarget ?? state.returnTarget;
    return {
      phase: 'focusing',
      returnTarget: target.kind === 'task' ? state.returnTarget : target,
      target,
      transition: state.transition + 1
    };
  }
  return state;
}

function sameFocusTarget(left: TopologyFocusTarget, right: TopologyFocusTarget) {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'overview' && right.kind === 'overview') return true;
  if (left.kind === 'project' && right.kind === 'project') {
    return left.projectId === right.projectId;
  }
  if (left.kind === 'machine' && right.kind === 'machine') {
    return left.projectId === right.projectId && left.machineId === right.machineId;
  }
  return left.kind === 'task'
    && right.kind === 'task'
    && left.taskId === right.taskId;
}

function navigateTopologyWorkspace(
  state: TopologyWorkspaceState,
  target: TopologyFocusTarget
): TopologyWorkspaceState {
  if (state.phase === 'closing') {
    return { ...state, pendingTarget: target };
  }
  if (state.phase === 'open' || state.phase === 'opening') {
    if (
      target.kind === 'task'
      && state.target.kind === 'task'
      && target.taskId === state.target.taskId
    ) {
      return state;
    }
    return {
      ...state,
      pendingTarget: target,
      phase: 'closing',
      transition: state.transition + 1
    };
  }
  return {
    phase: 'focusing',
    returnTarget: target.kind === 'task'
      ? state.target.kind === 'task' ? state.returnTarget : state.target
      : target,
    target,
    transition: state.transition + 1
  };
}
