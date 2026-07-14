import type {
  ProjectTopologyBuildResult,
  ProjectTopologyReadState,
  ProjectTopologySnapshot,
  TopologyMachine,
  TopologyProject,
  TopologyTask,
  TopologyTruthState
} from './project-topology-types';
import { aggregateProjectTruth, multiMachineWarning } from './project-topology-inventory-evidence';

const refreshingReason = 'Topology evidence is refreshing.';

export function beginTopologyRefresh(
  current?: ProjectTopologyReadState
): ProjectTopologyReadState {
  if (current?.state === 'ready' || current?.state === 'stale') {
    return {
      previous: staleSnapshot(current.snapshot, refreshingReason),
      state: 'checking'
    };
  }
  if (current?.state === 'checking' && current.previous) {
    return {
      previous: staleSnapshot(current.previous, refreshingReason),
      state: 'checking'
    };
  }
  return { state: 'checking' };
}

export function applyTopologyBuild(
  current: ProjectTopologyReadState | undefined,
  result: ProjectTopologyBuildResult,
  failedAt = new Date().toISOString()
): ProjectTopologyReadState {
  if (result.state === 'ready') {
    const previous = current?.state === 'ready' || current?.state === 'stale'
      ? current.snapshot
      : current?.state === 'checking'
        ? current.previous
        : undefined;
    return previous
      ? { snapshot: reconcileSnapshot(previous, result.snapshot), state: 'ready' }
      : result;
  }
  if (result.state === 'checking') return beginTopologyRefresh(current);
  const previous = current?.state === 'ready' || current?.state === 'stale'
    ? current.snapshot
    : current?.state === 'checking'
      ? current.previous
      : undefined;
  return previous
    ? {
        failedAt,
        reason: result.reason,
        snapshot: staleSnapshot(previous, result.reason),
        state: 'stale'
      }
    : { checkedAt: result.checkedAt, reason: result.reason, state: 'blocked' };
}

export function topologyTaskCountEvidence(
  projects: TopologyProject[],
  observedCount: number,
  portfolioInventory: ProjectTopologySnapshot['inventory']
): ProjectTopologySnapshot['summary']['tasks'] {
  const inventories = projects.flatMap((project) => (
    project.machines.map((machine) => machine.taskInventory)
  ));
  if (
    portfolioInventory.projects.state === 'ready'
    && portfolioInventory.machines.state === 'ready'
    && inventories.every((inventory) => inventory.state === 'ready')
  ) {
    return { completeness: 'complete', observedCount };
  }
  if (inventories.some((inventory) => (
    inventory.state === 'ready' || inventory.state === 'stale'
  ))) return { completeness: 'partial', observedCount };
  return { completeness: 'unknown', observedCount };
}

function reconcileSnapshot(
  previous: ProjectTopologySnapshot,
  current: ProjectTopologySnapshot
): ProjectTopologySnapshot {
  const previousProjects = new Map(previous.projects.map((project) => [project.id, project]));
  const previousProjectsWin = shouldRetainNewer(
    previous.inventory.projects,
    current.inventory.projects
  );
  const projects = previousProjectsWin
    ? previous.projects.map((project) => staleProjectSnapshot(
        project,
        current.inventory.projects.state === 'stale'
          ? current.inventory.projects.reason
          : 'Project inventory is stale.',
        previous.checkedAt
      ))
    : current.projects.map((project) => {
        const previousProject = previousProjects.get(project.id);
        if (!previousProject) return project;
        const previousMachines = new Map(
          previousProject.machines.map((machine) => [machine.id, machine])
        );
        const machines = project.machines.map((machine) => reconcileMachine(
          previousMachines.get(machine.id),
          machine,
          previous.checkedAt
        ));
        return {
          ...project,
          branches: reconcileInventory(previousProject.branches, project.branches),
          inventory: aggregateProjectTruth(project.inventory, machines),
          issues: reconcileInventory(previousProject.issues, project.issues),
          machines,
          multiMachineState: reconciledMultiMachineState(project, machines),
          pullRequests: reconcileInventory(previousProject.pullRequests, project.pullRequests)
        };
      });
  const observedTaskCount = new Set(projects.flatMap((project) => (
    project.machines.flatMap((machine) => machine.tasks.map((task) => task.id))
  ))).size;
  const portfolioInventory = {
    machines: reconcileTruth(previous.inventory.machines, current.inventory.machines),
    projects: reconcileTruth(previous.inventory.projects, current.inventory.projects)
  };
  const machineCount = new Set(projects.flatMap((project) => (
    project.machines.map((machine) => machine.id)
  ))).size;
  return {
    ...current,
    inventory: portfolioInventory,
    projects,
    warnings: occupancyWarnings(projects),
    summary: {
      ...current.summary,
      machineCount,
      projectCount: projects.length,
      tasks: topologyTaskCountEvidence(projects, observedTaskCount, portfolioInventory)
    }
  };
}

function reconcileMachine(
  previous: TopologyMachine | undefined,
  current: TopologyMachine,
  fallbackLastSafeAt: string
): TopologyMachine {
  if (!previous) return current;
  if (shouldRetainNewer(previous.inventory, current.inventory)) {
    return staleMachineSnapshot(
      previous,
      current.inventory.state === 'stale'
        ? current.inventory.reason
        : 'Machine inventory is stale.',
      truthSafeAt(previous.inventory) ?? fallbackLastSafeAt
    );
  }
  if (shouldRetainNewer(previous.taskInventory, current.taskInventory)) {
    return staleMachineSnapshot(
      previous,
      current.taskInventory.state === 'stale'
        ? current.taskInventory.reason
        : 'Task inventory is stale.',
      truthSafeAt(previous.taskInventory) ?? fallbackLastSafeAt
    );
  }
  const unavailable = current.taskInventory.state === 'checking'
    || current.taskInventory.state === 'blocked';
  const previousWasSafe = previous.taskInventory.state === 'ready'
    || previous.taskInventory.state === 'stale';
  if (unavailable && previousWasSafe) {
    const reason = current.taskInventory.state === 'blocked'
      ? current.taskInventory.reason
      : 'Codex task inventory is still checking.';
    const lastSafeAt = previous.taskInventory.state === 'ready'
      ? previous.taskInventory.checkedAt
      : previous.taskInventory.state === 'stale'
        ? previous.taskInventory.lastSafeAt
        : fallbackLastSafeAt;
    const worktreeInventory = reconcileWorktreeInventory(
      previous.worktreeInventory,
      current.worktreeInventory
    );
    return {
      ...current,
      taskInventory: { lastSafeAt: lastSafeAt ?? fallbackLastSafeAt, reason, state: 'stale' },
      tasks: previous.tasks.map((task) => staleTask(
        task,
        'The owning task inventory is stale.',
        lastSafeAt ?? fallbackLastSafeAt
      )),
      worktreeInventory,
      worktrees: worktreeInventory === current.worktreeInventory
        ? current.worktrees
        : previous.worktrees
    };
  }
  const previousTasks = new Map(previous.tasks.map((task) => [task.id, task]));
  const tasks = current.tasks.map((task) => {
    const oldTask = previousTasks.get(task.id);
    if (!oldTask || (task.transcript.state !== 'checking' && task.transcript.state !== 'blocked')) {
      return task;
    }
    if (oldTask.transcript.state !== 'ready' && oldTask.transcript.state !== 'stale') {
      return task;
    }
    const reason = task.transcript.state === 'blocked'
      ? task.transcript.reason
      : 'The transcript is reconnecting.';
    const lastSafeAt = oldTask.transcript.state === 'ready'
      ? oldTask.transcript.checkedAt
      : oldTask.transcript.lastSafeAt;
    return {
      ...task,
      browser: unavailableStaleBrowser(reason),
      interaction: {
        canContinue: false,
        canInterrupt: false,
        composerVisible: false,
        reason
      },
      transcript: { data: oldTask.transcript.data, lastSafeAt, reason, state: 'stale' as const }
    };
  });
  const worktreeInventory = reconcileWorktreeInventory(
    previous.worktreeInventory,
    current.worktreeInventory
  );
  return {
    ...current,
    tasks,
    worktreeInventory,
    worktrees: worktreeInventory === current.worktreeInventory
      ? current.worktrees
      : previous.worktrees
  };
}

function staleSnapshot(snapshot: ProjectTopologySnapshot, reason: string) {
  const projects = snapshot.projects.map((project) => (
    staleProjectSnapshot(project, reason, snapshot.checkedAt)
  ));
  const observedCount = new Set(projects.flatMap((project) => (
    project.machines.flatMap((machine) => machine.tasks.map((task) => task.id))
  ))).size;
  const portfolioInventory = {
    machines: staleTruth(snapshot.inventory.machines, reason),
    projects: staleTruth(snapshot.inventory.projects, reason)
  };
  return {
    ...snapshot,
    inventory: portfolioInventory,
    projects,
    warnings: occupancyWarnings(projects),
    summary: {
      ...snapshot.summary,
      tasks: topologyTaskCountEvidence(projects, observedCount, portfolioInventory)
    }
  };
}

function staleProjectSnapshot(
  project: TopologyProject,
  reason: string,
  fallbackLastSafeAt: string
): TopologyProject {
  return {
    ...project,
    branches: staleInventory(project.branches, reason),
    inventory: staleTruth(project.inventory, reason),
    issues: staleInventory(project.issues, reason),
    machines: project.machines.map((machine) => (
      staleMachineSnapshot(machine, reason, fallbackLastSafeAt)
    )),
    multiMachineState: project.machines.length > 1 ? 'stale' : 'single',
    pullRequests: staleInventory(project.pullRequests, reason)
  };
}

function staleMachineSnapshot(
  machine: TopologyMachine,
  reason: string,
  fallbackLastSafeAt: string
): TopologyMachine {
  return {
    ...machine,
    inventory: staleTruth(machine.inventory, reason),
    taskInventory: staleTruth(machine.taskInventory, reason),
    tasks: machine.tasks.map((task) => staleTask(
      task,
      reason,
      task.lastSafeAt ?? fallbackLastSafeAt
    )),
    worktreeInventory: staleWorktreeInventory(machine.worktreeInventory, reason)
  };
}

function reconciledMultiMachineState(
  project: TopologyProject,
  machines: TopologyMachine[]
): TopologyProject['multiMachineState'] {
  if (machines.length <= 1) return 'single';
  return machines.some((machine) => (
    machine.inventory.state === 'stale'
    || machine.taskInventory.state === 'stale'
    || machine.worktreeInventory.state === 'stale'
  )) ? 'stale' : project.multiMachineState;
}

function occupancyWarnings(projects: TopologyProject[]) {
  return projects.flatMap((project) => {
    const message = project.machines.length > 1 ? multiMachineWarning(project) : undefined;
    return message
      ? [{ id: `occupancy:${project.id}`, message, projectId: project.id }]
      : [];
  });
}

function reconcileInventory<T>(
  previous: import('./project-topology-types').TopologyInventoryResult<T>,
  current: import('./project-topology-types').TopologyInventoryResult<T>
): import('./project-topology-types').TopologyInventoryResult<T> {
  if (!shouldRetainNewer(previous, current)) return current;
  const previousSafeAt = inventorySafeAt(previous);
  const data = previous.state === 'ready' || previous.state === 'stale'
    ? previous.data
    : undefined;
  return data !== undefined && previousSafeAt
    ? {
        data,
        lastSafeAt: previousSafeAt,
        reason: current.state === 'stale'
          ? current.reason
          : 'A newer inventory snapshot was retained while this source caught up.',
        state: 'stale'
      }
    : current;
}

function reconcileTruth(
  previous: TopologyTruthState,
  current: TopologyTruthState
): TopologyTruthState {
  if (!shouldRetainNewer(previous, current)) return current;
  const lastSafeAt = truthSafeAt(previous);
  return lastSafeAt
    ? {
        lastSafeAt,
        reason: current.state === 'stale'
          ? current.reason
          : 'A newer inventory snapshot was retained while this source caught up.',
        state: 'stale'
      }
    : current;
}

function reconcileWorktreeInventory(
  previous: TopologyMachine['worktreeInventory'],
  current: TopologyMachine['worktreeInventory']
): TopologyMachine['worktreeInventory'] {
  if (
    current.state !== 'ready'
    && current.state !== 'proven-empty'
    && current.state !== 'stale'
  ) return current;
  const previousSafeAt = worktreeSafeAt(previous);
  const currentSafeAt = worktreeSafeAt(current);
  const previousTime = Date.parse(previousSafeAt ?? '');
  const currentTime = Date.parse(currentSafeAt ?? '');
  if (!previousSafeAt || !Number.isFinite(previousTime) || (
    Number.isFinite(currentTime) && (
      previousTime < currentTime
      || (previousTime === currentTime && current.state !== 'stale')
    )
  )) return current;
  const data = previous.state === 'stale'
    ? previous.data
    : previous.state === 'ready' || previous.state === 'proven-empty'
      ? previous
      : undefined;
  return data
    ? {
        data,
        lastSafeAt: previousSafeAt,
        reason: current.state === 'stale'
          ? current.reason
          : 'A newer worktree snapshot was retained while discovery caught up.',
        state: 'stale'
      }
    : current;
}

function shouldRetainNewer(
  previous: TopologyTruthState | import('./project-topology-types').TopologyInventoryResult<unknown>,
  current: TopologyTruthState | import('./project-topology-types').TopologyInventoryResult<unknown>
) {
  const previousSafeAt = 'data' in previous ? inventorySafeAt(previous) : truthSafeAt(previous);
  const currentSafeAt = 'data' in current ? inventorySafeAt(current) : truthSafeAt(current);
  if (!previousSafeAt || !currentSafeAt) return false;
  const previousTime = Date.parse(previousSafeAt);
  const currentTime = Date.parse(currentSafeAt);
  return Number.isFinite(previousTime)
    && (!Number.isFinite(currentTime) || previousTime > currentTime || (
      previousTime === currentTime && current.state === 'stale'
    ));
}

function inventorySafeAt(
  inventory: import('./project-topology-types').TopologyInventoryResult<unknown>
) {
  return inventory.state === 'ready'
    ? inventory.checkedAt
    : inventory.state === 'stale'
      ? inventory.lastSafeAt
      : undefined;
}

function truthSafeAt(truth: TopologyTruthState) {
  return truth.state === 'ready'
    ? truth.checkedAt
    : truth.state === 'stale'
      ? truth.lastSafeAt
      : undefined;
}

function worktreeSafeAt(inventory: TopologyMachine['worktreeInventory']) {
  return inventory.state === 'ready' || inventory.state === 'proven-empty'
    ? inventory.evidence.checkedAt
    : inventory.state === 'stale'
      ? inventory.lastSafeAt
      : undefined;
}

function staleInventory<T>(
  inventory: import('./project-topology-types').TopologyInventoryResult<T>,
  reason: string
): import('./project-topology-types').TopologyInventoryResult<T> {
  if (inventory.state === 'ready') {
    return { data: inventory.data, lastSafeAt: inventory.checkedAt, reason, state: 'stale' };
  }
  return inventory.state === 'stale' ? { ...inventory, reason } : inventory;
}

function staleWorktreeInventory(
  inventory: TopologyMachine['worktreeInventory'],
  reason: string
): TopologyMachine['worktreeInventory'] {
  if (inventory.state === 'ready' || inventory.state === 'proven-empty') {
    return {
      data: inventory,
      lastSafeAt: inventory.evidence.checkedAt,
      reason,
      state: 'stale'
    };
  }
  return inventory.state === 'stale' ? { ...inventory, reason } : inventory;
}

function staleTask(task: TopologyTask, reason: string, lastSafeAt: string): TopologyTask {
  return {
    ...task,
    activity: 'stale',
    browser: unavailableStaleBrowser(reason),
    evidence: { ...task.evidence, current: false, lastSafeAt },
    interaction: {
      canContinue: false,
      canInterrupt: false,
      composerVisible: false,
      reason
    },
    lastSafeAt,
    transcript: task.transcript.state === 'ready'
      ? {
          data: task.transcript.data,
          lastSafeAt: task.transcript.checkedAt,
          reason,
          state: 'stale'
        }
      : task.transcript
  };
}

function staleTruth(truth: TopologyTruthState, reason: string): TopologyTruthState {
  if (truth.state === 'ready') {
    return { lastSafeAt: truth.checkedAt, reason, state: 'stale' };
  }
  return truth.state === 'stale' ? { ...truth, reason } : truth;
}

function unavailableStaleBrowser(reason: string) {
  return {
    reason: `Browser capability is unavailable: ${reason}`,
    state: 'unavailable' as const
  };
}
