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
  worktrees
} from './project-topology-test-fixtures';

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
    const candidate = session(
      'machine-a',
      'thread-a',
      '/projects/project-a',
      'idle'
    );
    const source: ProjectTopologySource = {
      ...readySource(),
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

    transcript.resolve(conversation(candidate));
    const result = await refresh;
    expect(result.state).toBe('ready');
    if (result.state === 'ready') {
      expect(result.snapshot.projects[0]!.machines[0]!.tasks[0]!.transcript.state).toBe('ready');
    }
  });
});

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
