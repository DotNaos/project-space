import { describe, expect, test } from 'bun:test';
import type {
  ConnectorOverviewResult,
  DeployedEnvironmentStatusResult,
  GitHubRepositoryDetailsResult,
  ProjectDiscoveryResult
} from '@/shared/project-space-api';
import type {
  CodexSessionListResult,
  CodexSessionReadResult
} from '@/shared/codex-sessions-api';
import { ProjectTopologyController } from '../../src/features/project-topology/project-topology-controller';
import type { ProjectTopologySource } from '../../src/features/project-topology/project-topology-loader';
import {
  checkedAt,
  codex,
  conversation,
  machine,
  project,
  repositoryDetails,
  session,
  writable,
  worktrees
} from './project-topology-test-fixtures';
import { topologyTaskId } from '../../src/features/project-topology/project-topology-types';

describe('project topology controller', () => {
  test('loads a ready snapshot and notifies subscribers', async () => {
    const source = readySource();
    const controller = new ProjectTopologyController(source, {
      clock: () => checkedAt,
      includeTranscripts: false
    });
    const states: string[] = [];
    controller.subscribe(() => states.push(controller.getState().state));

    const result = await controller.refresh();

    expect(result.state).toBe('ready');
    expect(states).toEqual(['checking', 'ready']);
    if (result.state === 'ready') {
      expect(result.snapshot.summary).toMatchObject({
        machineCount: 1,
        projectCount: 1
      });
    }
  });

  test('retains a sanitized stale snapshot after a later refresh fails', async () => {
    let fails = false;
    const source = readySource(() => fails);
    const controller = new ProjectTopologyController(source, {
      clock: () => checkedAt,
      includeTranscripts: false
    });
    await controller.refresh();
    fails = true;

    const result = await controller.refresh();

    expect(result.state).toBe('stale');
    if (result.state === 'stale') {
      expect(result.reason).toBe('Project discovery failed.');
      expect(result.snapshot.inventory.projects.state).toBe('stale');
      if (result.snapshot.inventory.projects.state === 'stale') {
        expect(result.snapshot.inventory.projects.reason).toBe('Project discovery failed.');
      }
    }
  });

  test('ignores an older refresh that resolves after a newer refresh', async () => {
    const first = deferred<ProjectDiscoveryResult>();
    let firstSignal: AbortSignal | undefined;
    let loadCount = 0;
    const source = readySource(undefined, async (signal) => {
      loadCount += 1;
      if (loadCount === 1) firstSignal = signal;
      return loadCount === 1
        ? first.promise
        : discovery('new-project');
    });
    const controller = new ProjectTopologyController(source, {
      clock: () => checkedAt,
      includeTranscripts: false
    });

    const oldRefresh = controller.refresh();
    const newRefresh = controller.refresh();
    expect(firstSignal?.aborted).toBe(true);
    await newRefresh;
    first.resolve(discovery('old-project'));
    await oldRefresh;

    const state = controller.getState();
    expect(state.state).toBe('ready');
    if (state.state === 'ready') {
      expect(state.snapshot.projects[0]!.projectRecords[0]!.id).toBe('new-project');
    }
  });

  test('dispose prevents late refreshes and notifications', async () => {
    const pending = deferred<ProjectDiscoveryResult>();
    const source = readySource(undefined, () => pending.promise);
    const controller = new ProjectTopologyController(source, {
      clock: () => checkedAt,
      includeTranscripts: false
    });
    let notifications = 0;
    controller.subscribe(() => { notifications += 1; });
    const refresh = controller.refresh();
    controller.dispose();
    pending.resolve(discovery('late-project'));
    await refresh;

    expect(controller.getState().state).toBe('checking');
    expect(notifications).toBe(1);
  });

  test('publishes the portfolio before a slow transcript finishes', async () => {
    const transcript = deferred<CodexSessionReadResult>();
    let writeCalls = 0;
    const candidate = session(
      'machine-a',
      'thread-a',
      '/projects/project-a',
      'idle'
    );
    const source: ProjectTopologySource = {
      ...readySource(),
      async getCodexSessionWriteCapability() {
        writeCalls += 1;
        return writable(candidate);
      },
      async listCodexSessions(machineId) {
        return readyEvidence(codex(machineId, [candidate]));
      },
      async readCodexSession() {
        return readyEvidence(await transcript.promise);
      },
      async resolveCodexSessionLocation(machineId, threadId) {
        return readyEvidence({
          canonicalCwd: '/projects/project-a',
          checkedAt,
          machineId,
          source: 'connector-realpath',
          threadId
        });
      }
    };
    const controller = new ProjectTopologyController(source, { clock: () => checkedAt });
    const baseReady = deferred<void>();
    controller.subscribe(() => {
      if (controller.getState().state === 'ready') baseReady.resolve();
    });
    let settled = false;
    const refresh = controller.refresh().then((result) => {
      settled = true;
      return result;
    });

    await baseReady.promise;
    expect(controller.getState().state).toBe('ready');
    expect(settled).toBe(false);
    await controller.selectTask(topologyTaskId(candidate.machineId, candidate.id));
    expect(writeCalls).toBe(0);

    transcript.resolve(conversation(candidate));
    const result = await refresh;
    expect(result.state).toBe('ready');
    if (result.state === 'ready') {
      expect(result.snapshot.projects[0]!.machines[0]!.tasks[0]!.transcript.state).toBe('ready');
      expect(result.snapshot.projects[0]!.machines[0]!.tasks[0]!.interaction.composerVisible)
        .toBe(true);
    }
    expect(writeCalls).toBe(1);
  });

  test('keeps the overview read-only and grants authority only to the selected task', async () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-a', 'idle');
    const calls: Array<[string, string]> = [];
    const source: ProjectTopologySource = {
      ...readySource(),
      async getCodexSessionWriteCapability(machineId, threadId) {
        calls.push([machineId, threadId]);
        return writable(candidate);
      },
      async listCodexSessions(machineId) {
        return readyEvidence(codex(machineId, [candidate]));
      },
      async readCodexSession() {
        return readyEvidence(conversation(candidate));
      },
      async resolveCodexSessionLocation(machineId, threadId) {
        return readyEvidence({
          canonicalCwd: '/projects/project-a',
          checkedAt,
          machineId,
          source: 'connector-realpath',
          threadId
        });
      }
    };
    const controller = new ProjectTopologyController(source, {
      clock: () => checkedAt,
      includeTranscripts: false
    });

    const overview = await controller.refresh();
    expect(calls).toEqual([]);
    expect(taskFrom(overview, candidate).interaction.composerVisible).toBe(false);

    const taskId = topologyTaskId(candidate.machineId, candidate.id);
    const focused = await controller.selectTask(taskId);
    expect(calls).toEqual([['machine-a', 'thread-a']]);
    expect(taskFrom(focused, candidate).interaction.composerVisible).toBe(true);
    expect(controller.getSelectedTask(taskId)?.id).toBe(taskId);

    const closed = await controller.selectTask();
    expect(taskFrom(closed, candidate).interaction.composerVisible).toBe(false);
    expect(controller.getSelectedTask(taskId)).toBeUndefined();

    await controller.selectTask(taskId);
    controller.dispose();
    expect(controller.getSelectedTask(taskId)).toBeUndefined();
    const disposed = controller.getState();
    expect(disposed.state).toBe('checking');
    if (disposed.state === 'checking' && disposed.previous) {
      expect(taskFromSnapshot(disposed.previous, candidate).interaction.composerVisible)
        .toBe(false);
    }
  });

  test('drops a late authority response after selection changes', async () => {
    const first = session('machine-a', 'thread-a', '/projects/project-a', 'idle');
    const second = session('machine-a', 'thread-b', '/projects/project-a', 'idle');
    const firstCapability = deferred<ReturnType<typeof writable>>();
    const source: ProjectTopologySource = {
      ...readySource(),
      async getCodexSessionWriteCapability(_machineId, threadId) {
        return threadId === first.id ? firstCapability.promise : writable(second);
      },
      async listCodexSessions(machineId) {
        return readyEvidence(codex(machineId, [first, second]));
      },
      async readCodexSession(_machineId, threadId) {
        return readyEvidence(conversation(threadId === first.id ? first : second));
      },
      async resolveCodexSessionLocation(machineId, threadId) {
        return readyEvidence({
          canonicalCwd: '/projects/project-a',
          checkedAt,
          machineId,
          source: 'connector-realpath',
          threadId
        });
      }
    };
    const controller = new ProjectTopologyController(source, {
      clock: () => checkedAt,
      includeTranscripts: false
    });
    await controller.refresh();

    const oldSelection = controller.selectTask(topologyTaskId(first.machineId, first.id));
    const current = await controller.selectTask(topologyTaskId(second.machineId, second.id));
    firstCapability.resolve(writable(first));
    await oldSelection;

    expect(taskFrom(current, first).interaction.composerVisible).toBe(false);
    expect(taskFrom(controller.getState(), second).interaction.composerVisible).toBe(true);
  });

  test('does not restore a late authority response after the task closes', async () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-a', 'idle');
    const capability = deferred<ReturnType<typeof writable>>();
    const source: ProjectTopologySource = {
      ...readySource(),
      async getCodexSessionWriteCapability() {
        return capability.promise;
      },
      async listCodexSessions(machineId) {
        return readyEvidence(codex(machineId, [candidate]));
      },
      async readCodexSession() {
        return readyEvidence(conversation(candidate));
      },
      async resolveCodexSessionLocation(machineId, threadId) {
        return readyEvidence({
          canonicalCwd: '/projects/project-a',
          checkedAt,
          machineId,
          source: 'connector-realpath',
          threadId
        });
      }
    };
    const controller = new ProjectTopologyController(source, {
      clock: () => checkedAt,
      includeTranscripts: false
    });
    const taskId = topologyTaskId(candidate.machineId, candidate.id);
    await controller.refresh();

    const selecting = controller.selectTask(taskId);
    await controller.selectTask();
    capability.resolve(writable(candidate));
    await selecting;

    expect(controller.getSelectedTask(taskId)).toBeUndefined();
    expect(taskFrom(controller.getState(), candidate).interaction.composerVisible).toBe(false);
  });

  test('revokes expired authority and reacquires it for the preserved selection', async () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-a', 'idle');
    let expire = () => undefined;
    let scheduledDelay = -1;
    let writeCalls = 0;
    const source: ProjectTopologySource = {
      ...readySource(),
      async getCodexSessionWriteCapability() {
        writeCalls += 1;
        return writable(candidate, { expiresAt: '2026-07-14T00:02:00.000Z' });
      },
      async listCodexSessions(machineId) {
        return readyEvidence(codex(machineId, [candidate]));
      },
      async readCodexSession() {
        return readyEvidence(conversation(candidate));
      },
      async resolveCodexSessionLocation(machineId, threadId) {
        return readyEvidence({
          canonicalCwd: '/projects/project-a',
          checkedAt,
          machineId,
          source: 'connector-realpath',
          threadId
        });
      }
    };
    const controller = new ProjectTopologyController(source, {
      clock: () => checkedAt,
      includeTranscripts: false,
      schedule(callback, delayMs) {
        expire = callback;
        scheduledDelay = delayMs;
        return () => { expire = () => undefined; };
      }
    });
    const taskId = topologyTaskId(candidate.machineId, candidate.id);
    await controller.refresh();
    await controller.selectTask(taskId);
    expect(controller.getSelectedTask(taskId)?.interaction.composerVisible).toBe(true);
    expect(scheduledDelay).toBe(120_000);

    expire();

    expect(controller.getSelectedTask(taskId)).toBeUndefined();
    expect(taskFrom(controller.getState(), candidate).interaction.composerVisible).toBe(false);

    await controller.refresh();
    expect(writeCalls).toBe(2);
    expect(controller.getSelectedTask(taskId)?.interaction.composerVisible).toBe(true);
  });

  test('does not renew authority from a stale snapshot after refresh failure', async () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-a', 'idle');
    let discoveryFails = false;
    let writeCalls = 0;
    const source: ProjectTopologySource = {
      ...readySource(() => discoveryFails),
      async getCodexSessionWriteCapability() {
        writeCalls += 1;
        return writable(candidate);
      },
      async listCodexSessions(machineId) {
        return readyEvidence(codex(machineId, [candidate]));
      },
      async readCodexSession() {
        return readyEvidence(conversation(candidate));
      },
      async resolveCodexSessionLocation(machineId, threadId) {
        return readyEvidence({
          canonicalCwd: '/projects/project-a',
          checkedAt,
          machineId,
          source: 'connector-realpath',
          threadId
        });
      }
    };
    const controller = new ProjectTopologyController(source, {
      clock: () => checkedAt,
      includeTranscripts: false
    });
    await controller.refresh();
    await controller.selectTask(topologyTaskId(candidate.machineId, candidate.id));
    expect(writeCalls).toBe(1);

    discoveryFails = true;
    const stale = await controller.refresh();

    expect(stale.state).toBe('stale');
    expect(writeCalls).toBe(1);
    expect(controller.getSelectedTask(topologyTaskId(candidate.machineId, candidate.id)))
      .toBeUndefined();
    if (stale.state === 'stale') {
      expect(taskFromSnapshot(stale.snapshot, candidate).interaction.composerVisible).toBe(false);
    }
  });
});

function taskFrom(
  state: ReturnType<ProjectTopologyController['getState']>,
  candidate: ReturnType<typeof session>
) {
  if (state.state !== 'ready') throw new Error('Expected a ready topology state.');
  return taskFromSnapshot(state.snapshot, candidate);
}

function taskFromSnapshot(
  snapshot: Extract<ReturnType<ProjectTopologyController['getState']>, {
    state: 'ready' | 'stale';
  }>['snapshot'],
  candidate: ReturnType<typeof session>
) {
  const id = topologyTaskId(candidate.machineId, candidate.id);
  const task = snapshot.projects.flatMap((entry) => (
    entry.machines.flatMap((machineEntry) => machineEntry.tasks)
  )).find((entry) => entry.id === id);
  if (!task) throw new Error(`Expected topology task ${id}.`);
  return task;
}

function readySource(
  shouldFail?: () => boolean,
  loadDiscovery?: (signal?: AbortSignal) => Promise<ProjectDiscoveryResult>
): ProjectTopologySource {
  return {
    async discoverProjectWorktrees(projectId) {
      return worktrees(`/projects/${projectId}`, []);
    },
    async getConnectorOverview() {
      return readyEvidence({
        machines: [machine('machine-a')],
        machinesRepo: { exists: true, path: '/machines' },
        tailscale: {
          connected: true,
          installed: true,
          ips: [],
          peersOnline: 0,
          serveOrigins: []
        }
      });
    },
    async getDeployedEnvironmentStatus(
      repositoryFullName
    ) {
      return readyEvidence({
        checkedAt, environments: [], repositoryFullName, status: 'available'
      } satisfies DeployedEnvironmentStatusResult);
    },
    async getGitHubRepositoryDetails() {
      return readyEvidence(repositoryDetails('main'));
    },
    async listCodexSessions(machineId) {
      return readyEvidence(codex(machineId, []));
    },
    async loadProjectDiscovery(signal) {
      if (shouldFail?.()) throw new Error('Project discovery failed.');
      return readyEvidence(await (loadDiscovery?.(signal) ?? discovery('project-a')));
    },
    async readCodexSession() {
      throw new Error('No task transcript should be read.');
    },
    async resolveCodexSessionLocation() {
      throw new Error('No task location should be resolved.');
    }
  };
}

function discovery(projectId: string): ProjectDiscoveryResult {
  return {
    groups: [],
    projects: [project(projectId, 'machine-a', `/projects/${projectId}`)],
    rootItems: [],
    rootPath: '/projects',
    structureViolations: []
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function readyEvidence<T>(data: T) {
  return { checkedAt, data, state: 'ready' as const };
}
