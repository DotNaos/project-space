import { describe, expect, test } from 'bun:test';

import {
  createAuthorizedProjectSpaceBackend,
  ProjectSpaceAccessError
} from '../server/authorized-project-space-backend';
import type {
  ConnectorOverviewResult,
  ProjectDiscoveryResult,
  ProjectSpaceBackend
} from '../src/shared/project-space-api';

const overview: ConnectorOverviewResult = {
  connectorOrigin: 'http://127.0.0.1:45873',
  machines: [
    {
      connector: { status: 'online' },
      id: 'machine-a',
      kind: 'connector',
      name: 'Machine A',
      network: {},
      roles: ['connector'],
      sourcePath: 'connector-hub'
    },
    {
      connector: { status: 'online' },
      id: 'machine-b',
      kind: 'connector',
      name: 'Machine B',
      network: {},
      roles: ['connector'],
      sourcePath: 'connector-hub'
    }
  ],
  machinesRepo: { exists: true, path: '/Users/hub/.project-space/machines' },
  tailscale: {
    connected: true,
    installed: true,
    ips: ['100.100.100.100'],
    peersOnline: 12,
    selfName: 'private-hub.tailnet.ts.net',
    serveOrigins: ['https://private-hub.tailnet.ts.net'],
    tailnet: 'private-tailnet'
  }
};

const discovery: ProjectDiscoveryResult = {
  groups: [],
  projects: [
    { id: 'same-id', kind: 'standalone', machineId: 'machine-a', name: 'A', rootPath: '/a' },
    { id: 'same-id', kind: 'standalone', machineId: 'machine-b', name: 'B', rootPath: '/b' },
    { id: 'local', kind: 'standalone', name: 'Hub local', rootPath: '/hub' }
  ],
  rootItems: [
    { id: 'a', kind: 'project', label: 'A', projectId: 'same-id' },
    { id: 'local', kind: 'project', label: 'Hub local', projectId: 'local' }
  ],
  rootPath: '/sensitive/root',
  structureViolations: []
};

function backendWith(overrides: Partial<ProjectSpaceBackend> = {}) {
  return new Proxy(overrides as ProjectSpaceBackend, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) {
        return Reflect.get(target, property, receiver);
      }
      return async () => {
        throw new Error(`Unexpected backend call: ${String(property)}`);
      };
    },
    ownKeys(target) {
      return Reflect.ownKeys(target);
    }
  });
}

function hostedFor(machineIds: string[], userId = 'user-a') {
  return {
    authRequired: () => true,
    currentUserId: () => userId,
    databaseConfigured: () => true,
    listMemberships: async () => machineIds.map((machineId) => ({ machineId }))
  };
}

describe('authorized Project Space backend', () => {
  test('returns no environment metadata when repository authorization fails', async () => {
    let statusDispatches = 0;
    const backend = createAuthorizedProjectSpaceBackend(
      backendWith({
        async getGitHubRepositoryDetails() {
          return { branches: [], checkedAt: '', issues: [], pullRequests: [], status: 'error' };
        },
        async getDeployedEnvironmentStatus(repositoryFullName) {
          statusDispatches += 1;
          return { checkedAt: '', environments: [], repositoryFullName, status: 'available' };
        }
      }),
      hostedFor(['machine-a'])
    );
    expect(await backend.getDeployedEnvironmentStatus('private/repository')).toMatchObject({
      environments: [], status: 'unauthorized'
    });
    expect(statusDispatches).toBe(0);
  });

  test('filters machine and project discovery structurally for one user', async () => {
    const backend = createAuthorizedProjectSpaceBackend(
      backendWith({
        async getConnectorOverview() {
          return overview;
        },
        async loadProjectDiscovery() {
          return discovery;
        }
      }),
      hostedFor(['machine-a'])
    );

    expect((await backend.getConnectorOverview()).machines.map((machine) => machine.id)).toEqual([
      'machine-a'
    ]);
    expect(await backend.getConnectorOverview()).toEqual({
      machines: [overview.machines[0]],
      machinesRepo: { exists: false, path: '' },
      tailscale: {
        connected: false,
        installed: false,
        ips: [],
        peersOnline: 0,
        serveOrigins: []
      }
    });
    const visible = await backend.loadProjectDiscovery();
    expect(visible.projects).toEqual([discovery.projects[0]]);
    expect(visible.rootPath).toBe('authorized-connectors');
    expect(visible.rootItems).toEqual([discovery.rootItems[0]]);
  });

  test('denies another user before dispatching a machine command', async () => {
    let dispatches = 0;
    const backend = createAuthorizedProjectSpaceBackend(
      backendWith({
        async runMachineTerminalCommand(request) {
          dispatches += 1;
          return {
            command: request.command,
            cwd: '/',
            durationMs: 0,
            exitCode: 0,
            stderr: '',
            stdout: ''
          };
        }
      }),
      hostedFor(['machine-a'])
    );

    await expect(
      backend.runMachineTerminalCommand({ command: 'id', machineId: 'machine-b' })
    ).rejects.toBeInstanceOf(ProjectSpaceAccessError);
    expect(dispatches).toBe(0);
  });

  test('denies another user before dispatching machine folder mutations', async () => {
    let dispatches = 0;
    const backend = createAuthorizedProjectSpaceBackend(
      backendWith({
        async createMachineDirectory() {
          dispatches += 1;
          return { affectedPaths: [], status: 'success' };
        },
        async deleteMachineDirectories() {
          dispatches += 1;
          return { affectedPaths: [], status: 'success' };
        },
        async renameMachineDirectory() {
          dispatches += 1;
          return { affectedPaths: [], status: 'success' };
        }
      }),
      hostedFor(['machine-a'])
    );

    await expect(
      backend.createMachineDirectory({
        machineId: 'machine-b',
        name: 'new-folder',
        parentPath: '/tmp'
      })
    ).rejects.toBeInstanceOf(ProjectSpaceAccessError);
    await expect(
      backend.renameMachineDirectory({
        machineId: 'machine-b',
        name: 'renamed',
        path: '/tmp/old'
      })
    ).rejects.toBeInstanceOf(ProjectSpaceAccessError);
    await expect(
      backend.deleteMachineDirectories({ machineId: 'machine-b', paths: ['/tmp/old'] })
    ).rejects.toBeInstanceOf(ProjectSpaceAccessError);
    expect(dispatches).toBe(0);
  });

  test('requires a structurally matching project path for worktree requests', async () => {
    let dispatches = 0;
    const backend = createAuthorizedProjectSpaceBackend(
      backendWith({
        async loadProjectDiscovery() {
          return discovery;
        },
        async loadProjectWorktrees() {
          dispatches += 1;
          return [];
        }
      }),
      hostedFor(['machine-a'])
    );

    await expect(
      backend.loadProjectWorktrees('/b', 'machine-a')
    ).rejects.toBeInstanceOf(ProjectSpaceAccessError);
    expect(dispatches).toBe(0);
    await backend.loadProjectWorktrees('/a', 'machine-a');
    expect(dispatches).toBe(1);
  });

  test('disables arbitrary local-host shell execution in hosted mode', async () => {
    let dispatches = 0;
    const backend = createAuthorizedProjectSpaceBackend(
      backendWith({
        async runTerminalCommand(request) {
          dispatches += 1;
          return {
            command: request.command,
            cwd: request.cwd,
            durationMs: 0,
            exitCode: 0,
            stderr: '',
            stdout: ''
          };
        }
      }),
      hostedFor(['machine-a'])
    );

    await expect(
      backend.runTerminalCommand({ command: 'env', cwd: '/' })
    ).rejects.toBeInstanceOf(ProjectSpaceAccessError);
    expect(dispatches).toBe(0);
  });

  test('isolates projects state by user without dispatching to the host file store', async () => {
    const records = new Map<string, Awaited<ReturnType<ProjectSpaceBackend['loadProjectsState']>>>();
    let hostReads = 0;
    let hostWrites = 0;
    const localBackend = backendWith({
      async loadProjectsState() {
        hostReads += 1;
        throw new Error('Hosted state must not read the host file.');
      },
      async saveProjectsState() {
        hostWrites += 1;
        throw new Error('Hosted state must not write the host file.');
      }
    });
    const stateA = {
      activeGroupId: 'group-a',
      pinnedProjectIds: ['project-a'],
      recentProjectIds: ['project-a'],
      selectedExplorerTarget: { kind: 'workspace' as const },
      selectedLauncherAppId: '',
      selectedProjectId: 'project-a'
    };
    const persistence = {
      readProjectsState: async (userId: string) => records.get(userId) ?? null,
      writeProjectsState: async (
        userId: string,
        state: Awaited<ReturnType<ProjectSpaceBackend['loadProjectsState']>>
      ) => {
        records.set(userId, state);
      }
    };
    const backendA = createAuthorizedProjectSpaceBackend(localBackend, {
      ...hostedFor(['machine-a'], 'user-a'),
      ...persistence
    });
    const backendB = createAuthorizedProjectSpaceBackend(localBackend, {
      ...hostedFor(['machine-b'], 'user-b'),
      ...persistence
    });

    await backendA.saveProjectsState(stateA);
    expect(await backendA.loadProjectsState()).toEqual(stateA);
    expect(await backendB.loadProjectsState()).toEqual({
      activeGroupId: '',
      pinnedProjectIds: [],
      recentProjectIds: [],
      selectedExplorerTarget: { kind: 'workspace' },
      selectedLauncherAppId: '',
      selectedProjectId: ''
    });
    expect(hostReads).toBe(0);
    expect(hostWrites).toBe(0);
  });

  test('blocks host-local connector, Codex, launcher and scope operations before dispatch', async () => {
    let dispatches = 0;
    const backend = createAuthorizedProjectSpaceBackend(
      backendWith({
        async getConnectorProjectRegistry() {
          dispatches += 1;
          throw new Error('not reached');
        },
        async getCodexStatus() {
          dispatches += 1;
          throw new Error('not reached');
        },
        async loadLauncherAppIcon() {
          dispatches += 1;
          return undefined;
        },
        async loadLauncherApps() {
          dispatches += 1;
          return [];
        },
        async openWorkspaceTool() {
          dispatches += 1;
          return { message: '', status: 'placeholder' };
        },
        async startScopeDevboxJob() {
          dispatches += 1;
          throw new Error('not reached');
        }
      }),
      hostedFor(['machine-a'])
    );

    await expect(backend.getConnectorProjectRegistry()).rejects.toBeInstanceOf(
      ProjectSpaceAccessError
    );
    await expect(backend.getCodexStatus()).rejects.toBeInstanceOf(ProjectSpaceAccessError);
    await expect(backend.loadLauncherApps()).rejects.toBeInstanceOf(ProjectSpaceAccessError);
    await expect(backend.loadLauncherAppIcon('codex')).rejects.toBeInstanceOf(
      ProjectSpaceAccessError
    );
    await expect(
      backend.openWorkspaceTool({ projectId: 'project-a', tool: 'ide' })
    ).rejects.toBeInstanceOf(ProjectSpaceAccessError);
    await expect(
      backend.startScopeDevboxJob({
        agent: 'codex',
        machineId: 'machine-a',
        model: 'model',
        repoPath: '/srv/project',
        task: 'task',
        writableFiles: []
      })
    ).rejects.toBeInstanceOf(ProjectSpaceAccessError);
    expect(dispatches).toBe(0);
  });

  test('keeps host-file projects state only in auth-disabled local mode', async () => {
    const localState = {
      activeGroupId: '',
      pinnedProjectIds: [],
      recentProjectIds: ['local'],
      selectedExplorerTarget: { kind: 'workspace' as const },
      selectedLauncherAppId: '',
      selectedProjectId: 'local'
    };
    let writes = 0;
    const backend = createAuthorizedProjectSpaceBackend(
      backendWith({
        async loadProjectsState() {
          return localState;
        },
        async saveProjectsState() {
          writes += 1;
        }
      }),
      {
        authRequired: () => false,
        currentUserId: () => undefined,
        databaseConfigured: () => false
      }
    );

    expect(await backend.loadProjectsState()).toEqual(localState);
    await backend.saveProjectsState(localState);
    expect(writes).toBe(1);
  });
});
