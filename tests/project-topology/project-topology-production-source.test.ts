import { describe, expect, test } from 'bun:test';
import type {
  CodexSessionRecord,
  CodexSessionsClient
} from '@/shared/codex-sessions-api';
import { loadProjectTopologyInventory } from '../../src/features/project-topology/project-topology-loader';
import { buildProjectTopology } from '../../src/features/project-topology/project-topology-model';
import { loadProjectTopologySelectedTask } from '../../src/features/project-topology/project-topology-selected-task-loader';
import {
  createProjectTopologyProductionSource,
  type ProjectTopologyProductionSourceOptions
} from '../../src/features/project-topology/project-topology-production-source';
import {
  checkedAt,
  codex,
  conversation,
  inventory,
  location,
  machine,
  project,
  repositoryDetails,
  session,
  snapshot,
  writable,
  worktrees
} from './project-topology-test-fixtures';
import { topologyTaskId } from '../../src/features/project-topology/project-topology-types';

describe('project topology production source adapter', () => {
  test('keeps raw Codex cwd blocked without a canonical location capability', async () => {
    const candidate = session(
      'machine-a',
      'thread-without-location-proof',
      '/projects/project-space/src'
    );
    const source = createProjectTopologyProductionSource({
      clock: () => checkedAt,
      codex: codexClient(candidate),
      projectSpace: projectClient()
    });
    const loaded = await loadProjectTopologyInventory(source, { clock: () => checkedAt });
    const taskId = topologyTaskId(candidate.machineId, candidate.id);
    const topologyMachine = snapshot(buildProjectTopology(loaded)).projects[0]!.machines[0]!;

    expect(loaded.taskLocationsByTaskId?.[taskId]).toBeUndefined();
    expect(loaded.taskLocationFailuresByTaskId?.[taskId]?.reason).toBe(
      'Existing-task inspection is not supported by the current server contract.'
    );
    expect(topologyMachine.taskInventory.state).toBe('blocked');
    expect(topologyMachine.tasks).toEqual([]);
  });

  test('joins and authorizes only through explicit production capabilities', async () => {
    const candidate = session(
      'machine-a',
      'thread-proven-capabilities',
      '/untrusted/raw-cwd',
      'idle'
    );
    const source = createProjectTopologyProductionSource({
      capabilities: {
        async getWriteCapability() {
          return writable(candidate);
        },
        async resolveTaskLocation() {
          return {
            checkedAt,
            data: location(
              candidate,
              '/projects/project-space/src',
              '/projects/project-space'
            ),
            state: 'ready'
          };
        }
      },
      clock: () => checkedAt,
      codex: codexClient(candidate),
      projectSpace: projectClient()
    });
    const loaded = await loadProjectTopologyInventory(source, { clock: () => checkedAt });
    const overviewTask = snapshot(buildProjectTopology(loaded))
      .projects[0]!.machines[0]!.tasks[0]!;
    const selected = await loadProjectTopologySelectedTask(
      source,
      loaded,
      overviewTask.id,
      { clock: () => checkedAt }
    );
    const task = snapshot(buildProjectTopology(selected)).projects[0]!.machines[0]!.tasks[0]!;

    expect(task.cwd).toBe('/projects/project-space/src');
    expect(overviewTask.interaction.composerVisible).toBe(false);
    expect(task.interaction).toMatchObject({
      canContinue: true,
      composerVisible: true
    });
  });

  test('uses connector location evidence and a server-issued selected-task capability', async () => {
    const base = session(
      'machine-a',
      'thread-server-proven-capabilities',
      '/untrusted/raw-cwd',
      'idle'
    );
    const candidate: CodexSessionRecord = base;
    const source = createProjectTopologyProductionSource({
      clock: () => checkedAt,
      codex: codexClient(candidate, true, true),
      projectSpace: projectClient()
    });
    const loaded = await loadProjectTopologyInventory(source, { clock: () => checkedAt });
    const overviewTask = snapshot(buildProjectTopology(loaded))
      .projects[0]!.machines[0]!.tasks[0]!;
    const selected = await loadProjectTopologySelectedTask(
      source,
      loaded,
      overviewTask.id,
      { clock: () => checkedAt }
    );
    const task = snapshot(buildProjectTopology(selected)).projects[0]!.machines[0]!.tasks[0]!;

    expect(task.cwd).toBe('/projects/project-space/src');
    expect(overviewTask.interaction.composerVisible).toBe(false);
    expect(task.interaction).toMatchObject({ canContinue: true, composerVisible: true });
  });

  test('does not relabel offline cached Codex inventory as fresh truth', async () => {
    const source = createProjectTopologyProductionSource({
      clock: () => checkedAt,
      codex: codexClient(undefined, false),
      projectSpace: projectClient()
    });

    await expect(source.listCodexSessions('machine-a')).resolves.toEqual({
      checkedAt,
      reason: 'Connector is offline.',
      state: 'blocked'
    });
  });

  test('keeps a slow empty Codex scan stale instead of proving an empty task slot', async () => {
    const receivedAt = '2026-07-14T00:00:31.000Z';
    let currentTime = checkedAt;
    const client = codexClient();
    const source = createProjectTopologyProductionSource({
      clock: () => currentTime,
      codex: {
        ...client,
        async list({ machineId }) {
          currentTime = receivedAt;
          return {
            ...codex(machineId, []),
            publishedAt: checkedAt
          };
        }
      },
      projectSpace: projectClient()
    });

    const result = await source.listCodexSessions('machine-a');
    expect(result).toMatchObject({
      data: {
        checkedAt,
        publishedAt: receivedAt,
        sessions: []
      },
      lastSafeAt: checkedAt,
      state: 'stale'
    });
    const topologyMachine = snapshot(buildProjectTopology(inventory({
      codexByMachine: { 'machine-a': result }
    }))).projects[0]!.machines[0]!;
    expect(topologyMachine.taskInventory.state).toBe('stale');
    expect(topologyMachine.tasks).toEqual([]);
  });

  test('uses the connected GitHub catalog identity for the Project Lead room', async () => {
    const client = projectClient();
    const source = createProjectTopologyProductionSource({
      clock: () => checkedAt,
      codex: codexClient(),
      projectSpace: {
        ...client,
        async getGitHubCatalog() {
          const discovery = await client.loadProjectDiscovery();
          return {
            checkedAt,
            repositories: [{ ...discovery.projects[0]!.github!, id: 987654 }],
            status: 'connected' as const
          };
        }
      }
    });

    const result = await source.loadProjectDiscovery();

    expect(result.state).toBe('ready');
    if (result.state === 'ready') {
      expect(result.data.projects[0]!.github?.id).toBe(987654);
    }
  });

  test('uses the atomic project snapshot and never calls the legacy worktree endpoint', async () => {
    const client = projectClient();
    const discovery = await client.loadProjectDiscovery();
    const projectRecord = discovery.projects[0]!;
    let snapshots = 0;
    let legacyWorktreeCalls = 0;
    const source = createProjectTopologyProductionSource({
      clock: () => checkedAt,
      codex: codexClient(),
      async loadProjectWorktreeSnapshot() {
        snapshots += 1;
        return {
          authorization: {
            connectorOverviewCheckedAt: checkedAt,
            projectDiscoveryCheckedAt: checkedAt
          },
          checkedAt,
          publishedAt: checkedAt,
          projectDiscovery: discovery,
          worktrees: [{
            machineId: projectRecord.machineId,
            projectId: projectRecord.id,
            result: worktrees(projectRecord.rootPath, [])
          }]
        };
      },
      projectSpace: {
        ...client,
        async discoverProjectWorktrees(projectId, machineId) {
          legacyWorktreeCalls += 1;
          return client.discoverProjectWorktrees(projectId, machineId);
        },
        async getGitHubCatalog() {
          return {
            checkedAt,
            repositories: [{ ...projectRecord.github!, id: 987654 }],
            status: 'connected' as const
          };
        }
      }
    });

    const loaded = await loadProjectTopologyInventory(source, {
      clock: () => checkedAt,
      includeTranscripts: false
    });

    expect(snapshots).toBe(1);
    expect(legacyWorktreeCalls).toBe(0);
    expect(loaded.projects.state).toBe('ready');
    if (loaded.projects.state === 'ready') {
      expect(loaded.projects.data[0]!.github?.id).toBe(987654);
    }
  });

  test('keeps slow authorization evidence stale after a later batch publication', async () => {
    const publishedAt = '2026-07-14T00:00:31.000Z';
    const client = projectClient();
    const discovery = await client.loadProjectDiscovery();
    const projectRecord = discovery.projects[0]!;
    const source = createProjectTopologyProductionSource({
      clock: () => publishedAt,
      codex: codexClient(),
      async loadProjectWorktreeSnapshot() {
        return {
          authorization: {
            connectorOverviewCheckedAt: checkedAt,
            projectDiscoveryCheckedAt: checkedAt
          },
          checkedAt,
          projectDiscovery: discovery,
          publishedAt,
          worktrees: [{
            machineId: projectRecord.machineId,
            projectId: projectRecord.id,
            result: worktrees(projectRecord.rootPath, [])
          }]
        };
      },
      projectSpace: client
    });

    const loaded = await loadProjectTopologyInventory(source, {
      clock: () => publishedAt,
      includeTranscripts: false
    });

    expect(loaded.projects).toMatchObject({ lastSafeAt: checkedAt, state: 'stale' });
  });

  test('does not start a client call after cancellation', async () => {
    let calls = 0;
    const client = projectClient();
    const source = createProjectTopologyProductionSource({
      clock: () => checkedAt,
      codex: codexClient(),
      projectSpace: {
        ...client,
        async loadProjectDiscovery() {
          calls += 1;
          return client.loadProjectDiscovery();
        }
      }
    });
    const controller = new AbortController();
    controller.abort();

    await expect(source.loadProjectDiscovery(controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    });
    expect(calls).toBe(0);
  });
});

function projectClient(): ProjectTopologyProductionSourceOptions['projectSpace'] {
  const projectRecord = project('project-a', 'machine-a', '/projects/project-space');
  return {
    async discoverProjectWorktrees() {
      return worktrees(projectRecord.rootPath, []);
    },
    async getConnectorOverview() {
      return {
        machines: [machine('machine-a')],
        machinesRepo: { exists: true, path: '/machines' },
        tailscale: {
          connected: true,
          installed: true,
          ips: [],
          peersOnline: 0,
          serveOrigins: []
        }
      };
    },
    async getDeployedEnvironmentStatus(repositoryFullName) {
      return { checkedAt, environments: [], repositoryFullName, status: 'available' };
    },
    async getGitHubRepositoryDetails() {
      return repositoryDetails();
    },
    async getGitHubCatalog() {
      return {
        checkedAt,
        repositories: [projectRecord.github!],
        status: 'connected'
      };
    },
    async loadProjectDiscovery() {
      return {
        groups: [],
        projects: [projectRecord],
        rootItems: [],
        rootPath: '/projects',
        structureViolations: []
      };
    }
  };
}

function codexClient(
  candidate?: CodexSessionRecord,
  online = true,
  includeWriteCapability = false
): CodexSessionsClient {
  const unsupported = async () => {
    throw new Error('Unsupported in this test.');
  };
  return {
    approve: unsupported,
    continue: unsupported,
    interrupt: unsupported,
    ...(includeWriteCapability ? {
      async inspect() {
        if (!candidate) throw new Error('Session not found.');
        const taskLocation = location(
          candidate,
          '/projects/project-space/src',
          '/projects/project-space'
        );
        return {
          checkedAt,
          openedReadOnly: true as const,
          session: candidate,
          sessionRevision: taskLocation.sessionRevision,
          taskLocation,
          writeCapability: writable(candidate, {
            expiresAt: '2026-07-14T00:00:30.000Z'
          })
        };
      }
    } : {}),
    async list({ machineId }) {
      const result = codex(machineId, candidate ? [candidate] : [], online);
      return online
        ? result
        : { ...result, machine: { ...result.machine, statusMessage: 'Connector is offline.' } };
    },
    async read() {
      if (!candidate) throw new Error('Session not found.');
      return conversation(candidate);
    },
    respondToUserInput: unsupported,
    subscribe() {
      return () => {};
    }
  };
}
