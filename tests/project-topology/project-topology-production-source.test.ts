import { describe, expect, test } from 'bun:test';
import type {
  CodexSessionRecord,
  CodexSessionsClient
} from '@/shared/codex-sessions-api';
import { loadProjectTopologyInventory } from '../../src/features/project-topology/project-topology-loader';
import { buildProjectTopology } from '../../src/features/project-topology/project-topology-model';
import {
  createProjectTopologyProductionSource,
  type ProjectTopologyProductionSourceOptions
} from '../../src/features/project-topology/project-topology-production-source';
import {
  checkedAt,
  codex,
  conversation,
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
      'Canonical task location is not supported by the current server contract.'
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
          return { checkedAt, data: location(candidate, '/projects/project-space/src'), state: 'ready' };
        }
      },
      clock: () => checkedAt,
      codex: codexClient(candidate),
      projectSpace: projectClient()
    });
    const loaded = await loadProjectTopologyInventory(source, { clock: () => checkedAt });
    const task = snapshot(buildProjectTopology(loaded)).projects[0]!.machines[0]!.tasks[0]!;

    expect(task.cwd).toBe('/projects/project-space/src');
    expect(task.interaction).toMatchObject({
      canContinue: true,
      composerVisible: true
    });
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
  online = true
): CodexSessionsClient {
  const unsupported = async () => {
    throw new Error('Unsupported in this test.');
  };
  return {
    approve: unsupported,
    continue: unsupported,
    interrupt: unsupported,
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
