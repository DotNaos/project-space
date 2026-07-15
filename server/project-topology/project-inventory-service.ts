import type {
  ProjectSpaceBackend,
  ProjectSpaceRecord,
  ProjectWorktreeDiscoveryResult,
  ProjectWorktreeRecord
} from '../../src/shared/project-space-api';
import {
  projectTopologyProjectScope,
  type ProjectTopologyProjectWorktreeEntry,
  type ProjectTopologyWorktreeSnapshot
} from '../../src/shared/project-topology-api';
import {
  discoverProjectWorktrees,
  reconcileProjectWorktreeDiscovery
} from '../project-worktree-discovery';

interface ProjectTopologyInventoryServiceOptions {
  authorizedBackend: Pick<
    ProjectSpaceBackend,
    'getConnectorOverview' | 'loadProjectDiscovery'
  >;
  clock?: () => string;
  concurrency?: number;
  deadlineMs?: number;
  worktreeBackend: {
    loadProjectWorktrees(
      projectPath: string,
      machineId?: string,
      options?: { signal?: AbortSignal; timeoutMs?: number }
    ): Promise<ProjectWorktreeRecord[]>;
  };
}

export interface ProjectTopologyInventoryLoadOptions {
  scopeKey?: string;
  signal?: AbortSignal;
}

interface SharedInventoryLoad {
  consumers: number;
  controller: AbortController;
  promise: Promise<ProjectTopologyWorktreeSnapshot>;
  settled: boolean;
}

const defaultDeadlineMs = 28_000;

export function createProjectTopologyInventoryService(
  options: ProjectTopologyInventoryServiceOptions
) {
  const concurrency = options.concurrency ?? 6;
  const deadlineMs = options.deadlineMs ?? defaultDeadlineMs;
  const clock = options.clock ?? (() => new Date().toISOString());
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error('Topology worktree concurrency must be between 1 and 32.');
  }
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs >= 30_000) {
    throw new Error('Topology inventory deadline must be between 1 and 29999 milliseconds.');
  }
  const activeLoads = new Map<string, SharedInventoryLoad>();

  return {
    async load(
      request: ProjectTopologyInventoryLoadOptions = {}
    ): Promise<ProjectTopologyWorktreeSnapshot> {
      const scopeKey = request.scopeKey ?? 'local-development-user';
      if (!scopeKey || scopeKey.length > 256) {
        throw new Error('Topology inventory scope identity is invalid.');
      }
      let shared = activeLoads.get(scopeKey);
      if (!shared) {
        shared = startSharedLoad(scopeKey, activeLoads, deadlineMs, (signal) => (
          loadSnapshot(options, concurrency, deadlineMs, clock, signal)
        ));
      }
      shared.consumers += 1;
      try {
        return await waitForSharedLoad(shared.promise, request.signal);
      } finally {
        shared.consumers -= 1;
        if (shared.consumers === 0 && !shared.settled) {
          shared.controller.abort(new Error('Topology inventory request was cancelled.'));
        }
      }
    }
  };
}

async function loadSnapshot(
  options: ProjectTopologyInventoryServiceOptions,
  concurrency: number,
  deadlineMs: number,
  clock: () => string,
  signal: AbortSignal
): Promise<ProjectTopologyWorktreeSnapshot> {
  const [projectCapture, connectorCapture] = await Promise.all([
    captureAuthorized(options.authorizedBackend.loadProjectDiscovery(), signal, clock),
    captureAuthorized(options.authorizedBackend.getConnectorOverview(), signal, clock)
  ]);
  const projectDiscovery = projectCapture.value;
  const connectorOverview = connectorCapture.value;
  const machines = new Map(connectorOverview.machines.map((machine) => [machine.id, machine]));
  const projectsByScope = groupProjects(projectDiscovery.projects);
  const worktrees = await mapWithConcurrency(
    [...projectsByScope.values()],
    concurrency,
    async (projects): Promise<ProjectTopologyProjectWorktreeEntry> => {
      const project = projects[0]!;
      const result = signal.aborted
        ? blocked(signalMessage(signal), 'request-failed', clock)
        : projects.some((candidate) => candidate.rootPath !== project.rootPath)
          ? blocked(
              'Project discovery returned conflicting trusted roots for one project scope.',
              'source-disagreement',
              clock
            )
          : await loadProjectWorktrees(
              project,
              machines,
              options.worktreeBackend,
              signal,
              deadlineMs
            );
      return {
        ...(project.machineId ? { machineId: project.machineId } : {}),
        projectId: project.id,
        result
      };
    }
  );
  const checkedAt = earlierTimestamp(
    projectCapture.checkedAt,
    connectorCapture.checkedAt
  );
  return {
    authorization: {
      connectorOverviewCheckedAt: connectorCapture.checkedAt,
      projectDiscoveryCheckedAt: projectCapture.checkedAt
    },
    checkedAt,
    projectDiscovery,
    publishedAt: clock(),
    worktrees
  };
}

async function loadProjectWorktrees(
  project: ProjectSpaceRecord,
  machines: ReadonlyMap<string, Awaited<ReturnType<ProjectSpaceBackend['getConnectorOverview']>>['machines'][number]>,
  backend: ProjectTopologyInventoryServiceOptions['worktreeBackend'],
  signal: AbortSignal,
  timeoutMs: number
): Promise<ProjectWorktreeDiscoveryResult> {
  const machine = project.machineId ? machines.get(project.machineId) : undefined;
  if (!project.machineId || !machine) {
    return blocked(
      'Project discovery did not have matching authorized machine evidence.',
      'project-mismatch'
    );
  }
  if (machine.connector.status !== 'local' && machine.connector.status !== 'online') {
    return blocked(
      `${machine.name} cannot provide current worktree inventory because its connector is ${machine.connector.status}.`,
      'request-failed'
    );
  }
  const discovery = await discoverProjectWorktrees({
    projectPath: project.rootPath,
    scan: () => waitForSharedLoad(
      machine.connector.status === 'local'
        ? backend.loadProjectWorktrees(project.rootPath, undefined, { signal, timeoutMs })
        : backend.loadProjectWorktrees(project.rootPath, machine.id, { signal, timeoutMs }),
      signal
    )
  });
  return reconcileProjectWorktreeDiscovery(discovery, Boolean(project.gitStatus));
}

function groupProjects(projects: ProjectSpaceRecord[]) {
  const grouped = new Map<string, ProjectSpaceRecord[]>();
  for (const project of projects) {
    const scope = projectTopologyProjectScope(project);
    grouped.set(scope, [...(grouped.get(scope) ?? []), project]);
  }
  return grouped;
}

function blocked(
  message: string,
  reason: 'project-mismatch' | 'request-failed' | 'source-disagreement',
  clock: () => string = () => new Date().toISOString()
): ProjectWorktreeDiscoveryResult {
  return { checkedAt: clock(), message, reason, state: 'blocked' };
}

function startSharedLoad(
  scopeKey: string,
  activeLoads: Map<string, SharedInventoryLoad>,
  deadlineMs: number,
  load: (signal: AbortSignal) => Promise<ProjectTopologyWorktreeSnapshot>
) {
  const controller = new AbortController();
  const deadline = setTimeout(() => {
    controller.abort(new Error('Topology inventory exceeded its safe evidence deadline.'));
  }, deadlineMs);
  let shared!: SharedInventoryLoad;
  const promise = load(controller.signal).finally(() => {
    clearTimeout(deadline);
    shared.settled = true;
    if (activeLoads.get(scopeKey) === shared) activeLoads.delete(scopeKey);
  });
  shared = { consumers: 0, controller, promise, settled: false };
  activeLoads.set(scopeKey, shared);
  return shared;
}

async function captureAuthorized<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  clock: () => string
) {
  const value = await waitForSharedLoad(promise, signal);
  return { checkedAt: clock(), value };
}

function waitForSharedLoad<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signalError(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signalError(signal));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function signalError(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Topology inventory request was cancelled.');
}

function signalMessage(signal: AbortSignal) {
  return signalError(signal).message;
}

function earlierTimestamp(left: string, right: string) {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  transform: (value: T) => Promise<R>
) {
  const results = new Array<R>(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await transform(values[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}
