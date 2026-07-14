import { afterEach, describe, expect, test } from 'bun:test';

import { createAuthorizedProjectSpaceBackend } from '../../server/authorized-project-space-backend';
import { createProjectTopologyInventoryService } from '../../server/project-topology/project-inventory-service';
import { createProjectSpaceServer } from '../../server/project-space-http';
import type {
  ConnectorOverviewResult,
  MachineRecord,
  ProjectDiscoveryResult,
  ProjectSpaceBackend,
  ProjectSpaceRecord,
  ProjectWorktreeRecord
} from '../../src/shared/project-space-api';
import { parseProjectTopologyWorktreeSnapshot } from '../../src/shared/project-topology-api';

const originalAuthDisabled = process.env.PROJECT_SPACE_AUTH_DISABLED;

afterEach(() => {
  if (originalAuthDisabled === undefined) delete process.env.PROJECT_SPACE_AUTH_DISABLED;
  else process.env.PROJECT_SPACE_AUTH_DISABLED = originalAuthDisabled;
});

describe('project topology inventory HTTP contract', () => {
  test('loads 37 projects through one trusted discovery and one machine overview', async () => {
    process.env.PROJECT_SPACE_AUTH_DISABLED = '1';
    const projects = Array.from({ length: 37 }, (_, index) => project(
      `project-${index}`,
      'machine-local',
      `/projects/project-${index}`
    ));
    let discoveries = 0;
    let overviews = 0;
    const scans: Array<[string, string | undefined]> = [];
    const server = await createProjectSpaceServer({
      backend: backend({
        async loadProjectDiscovery() {
          discoveries += 1;
          return discovery(projects);
        },
        async getConnectorOverview() {
          overviews += 1;
          return overview([machine('machine-local', 'local')]);
        },
        async loadProjectWorktrees(rootPath, machineId) {
          scans.push([rootPath, machineId]);
          return [worktree(rootPath)];
        }
      }),
      host: '127.0.0.1',
      port: 0
    });
    try {
      const response = await fetch(`${server.origin}/api/project-topology/inventory`);
      const snapshot = parseProjectTopologyWorktreeSnapshot(await response.json());

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(discoveries).toBe(1);
      expect(overviews).toBe(1);
      expect(scans).toHaveLength(37);
      expect(scans.every(([, machineId]) => machineId === undefined)).toBe(true);
      expect(snapshot.worktrees).toHaveLength(37);
    } finally {
      await server.close();
    }
  });

  test('rejects selectors and non-GET requests before inventory starts', async () => {
    process.env.PROJECT_SPACE_AUTH_DISABLED = '1';
    let calls = 0;
    const server = await createProjectSpaceServer({
      backend: backend({
        async loadProjectDiscovery() {
          calls += 1;
          return discovery([]);
        },
        async getConnectorOverview() {
          calls += 1;
          return overview([]);
        }
      }),
      host: '127.0.0.1',
      port: 0
    });
    try {
      const injected = await fetch(
        `${server.origin}/api/project-topology/inventory?rootPath=${encodeURIComponent('/secret')}`
      );
      const posted = await fetch(`${server.origin}/api/project-topology/inventory`, {
        body: JSON.stringify({ command: 'git worktree list', rootPath: '/secret' }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST'
      });

      expect(injected.status).toBe(400);
      expect(posted.status).toBe(400);
      expect(calls).toBe(0);
    } finally {
      await server.close();
    }
  });

  test('requires authentication before inventory starts', async () => {
    delete process.env.PROJECT_SPACE_AUTH_DISABLED;
    let calls = 0;
    const server = await createProjectSpaceServer({
      backend: backend({
        async loadProjectDiscovery() {
          calls += 1;
          return discovery([]);
        },
        async getConnectorOverview() {
          calls += 1;
          return overview([]);
        }
      }),
      host: '127.0.0.1',
      port: 0
    });
    try {
      const response = await fetch(`${server.origin}/api/project-topology/inventory`);
      expect(response.status).toBe(401);
      expect(calls).toBe(0);
    } finally {
      await server.close();
    }
  });
});

describe('project topology inventory authorization and truth', () => {
  test('never scans a project filtered out by machine membership', async () => {
    const projects = [
      project('allowed', 'machine-a', '/allowed'),
      project('hidden', 'machine-b', '/hidden')
    ];
    const scans: string[] = [];
    const raw = backend({
      async getConnectorOverview() {
        return overview([machine('machine-a'), machine('machine-b')]);
      },
      async loadProjectDiscovery() {
        return discovery(projects);
      },
      async loadProjectWorktrees(rootPath) {
        scans.push(rootPath);
        return [worktree(rootPath)];
      }
    });
    const authorized = createAuthorizedProjectSpaceBackend(raw, {
      authRequired: () => true,
      currentUserId: () => 'user-a',
      databaseConfigured: () => true,
      listMemberships: async () => [{ machineId: 'machine-a' }]
    });
    const result = await createProjectTopologyInventoryService({
      authorizedBackend: authorized,
      worktreeBackend: raw
    }).load();

    expect(result.projectDiscovery.projects.map(({ id }) => id)).toEqual(['allowed']);
    expect(scans).toEqual(['/allowed']);
  });

  test('isolates failed and offline scopes without fabricating empty inventory', async () => {
    const projects = [
      project('ready', 'machine-local', '/ready'),
      project('failed', 'machine-local', '/failed'),
      project('offline', 'machine-offline', '/offline')
    ];
    const scans: string[] = [];
    const raw = backend({
      async getConnectorOverview() {
        return overview([
          machine('machine-local', 'local'),
          machine('machine-offline', 'offline')
        ]);
      },
      async loadProjectDiscovery() {
        return discovery(projects);
      },
      async loadProjectWorktrees(rootPath) {
        scans.push(rootPath);
        if (rootPath === '/failed') throw new Error('Connector read failed.');
        return [worktree(rootPath)];
      }
    });
    const result = await createProjectTopologyInventoryService({
      authorizedBackend: raw,
      worktreeBackend: raw
    }).load();
    const states = Object.fromEntries(result.worktrees.map((entry) => [
      entry.projectId,
      entry.result.state
    ]));

    expect(states).toEqual({ failed: 'blocked', offline: 'blocked', ready: 'ready' });
    expect(scans.sort()).toEqual(['/failed', '/ready']);
  });

  test('blocks conflicting roots and reconciles authoritative empty scans', async () => {
    const checkout = project('checkout', 'machine-local', '/checkout');
    checkout.gitStatus = {
      branchName: 'main', changed: 0, hasUnstagedChanges: false,
      staged: 0, unstaged: 0, untracked: 0
    };
    const projects = [
      project('conflict', 'machine-local', '/one'),
      project('conflict', 'machine-local', '/two'),
      checkout,
      project('empty', 'machine-local', '/empty')
    ];
    const scans: string[] = [];
    const raw = backend({
      async getConnectorOverview() {
        return overview([machine('machine-local', 'local')]);
      },
      async loadProjectDiscovery() {
        return discovery(projects);
      },
      async loadProjectWorktrees(rootPath) {
        scans.push(rootPath);
        return [];
      }
    });
    const result = await createProjectTopologyInventoryService({
      authorizedBackend: raw,
      worktreeBackend: raw
    }).load();
    const byId = Object.fromEntries(result.worktrees.map((entry) => [entry.projectId, entry.result]));

    expect(byId.conflict).toMatchObject({ reason: 'source-disagreement', state: 'blocked' });
    expect(byId.checkout).toMatchObject({ reason: 'source-disagreement', state: 'blocked' });
    expect(byId.empty).toMatchObject({ state: 'proven-empty', worktrees: [] });
    expect(scans.sort()).toEqual(['/checkout', '/empty']);
  });

  test('preserves authorization acquisition time instead of relabeling a slow batch', async () => {
    const times = [
      '2026-07-14T00:00:00.000Z',
      '2026-07-14T00:00:01.000Z',
      '2026-07-14T00:00:21.000Z'
    ];
    const raw = backend({
      async getConnectorOverview() {
        return overview([machine('machine-local', 'local')]);
      },
      async loadProjectDiscovery() {
        return discovery([project('project-a', 'machine-local', '/project-a')]);
      },
      async loadProjectWorktrees(rootPath) {
        return [worktree(rootPath)];
      }
    });
    const result = await createProjectTopologyInventoryService({
      authorizedBackend: raw,
      clock: () => times.shift()!,
      worktreeBackend: raw
    }).load();

    expect(result.authorization).toEqual({
      connectorOverviewCheckedAt: '2026-07-14T00:00:01.000Z',
      projectDiscoveryCheckedAt: '2026-07-14T00:00:00.000Z'
    });
    expect(result.checkedAt).toBe('2026-07-14T00:00:00.000Z');
    expect(result.publishedAt).toBe('2026-07-14T00:00:21.000Z');
  });

  test('turns deadline-expired scopes into blocked evidence and aborts their scan', async () => {
    let scanSignal: AbortSignal | undefined;
    const raw = backend({
      async getConnectorOverview() {
        return overview([machine('machine-local', 'local')]);
      },
      async loadProjectDiscovery() {
        return discovery([project('project-a', 'machine-local', '/project-a')]);
      },
      async loadProjectWorktrees(_rootPath, _machineId, options) {
        scanSignal = options?.signal;
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true
          });
        });
      }
    } as never);
    const result = await createProjectTopologyInventoryService({
      authorizedBackend: raw,
      deadlineMs: 10,
      worktreeBackend: raw as never
    }).load();

    expect(scanSignal?.aborted).toBe(true);
    expect(result.worktrees[0]?.result).toMatchObject({
      message: 'Topology inventory exceeded its safe evidence deadline.',
      state: 'blocked'
    });
  });

  test('deduplicates one user scope without sharing inventory across users', async () => {
    let discoveries = 0;
    let scans = 0;
    const raw = backend({
      async getConnectorOverview() {
        return overview([machine('machine-local', 'local')]);
      },
      async loadProjectDiscovery() {
        discoveries += 1;
        return discovery([project('project-a', 'machine-local', '/project-a')]);
      },
      async loadProjectWorktrees(rootPath) {
        scans += 1;
        await Promise.resolve();
        return [worktree(rootPath)];
      }
    });
    const service = createProjectTopologyInventoryService({
      authorizedBackend: raw,
      worktreeBackend: raw
    });
    await Promise.all([
      service.load({ scopeKey: 'user-a' }),
      service.load({ scopeKey: 'user-a' })
    ]);
    expect(discoveries).toBe(1);
    expect(scans).toBe(1);

    await Promise.all([
      service.load({ scopeKey: 'user-a' }),
      service.load({ scopeKey: 'user-b' })
    ]);
    expect(discoveries).toBe(3);
    expect(scans).toBe(3);
  });

  test('propagates an HTTP disconnect to the in-flight worktree scan', async () => {
    process.env.PROJECT_SPACE_AUTH_DISABLED = '1';
    let markStarted!: () => void;
    let markAborted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
    const server = await createProjectSpaceServer({
      backend: backend({
        async getConnectorOverview() {
          return overview([machine('machine-local', 'local')]);
        },
        async loadProjectDiscovery() {
          return discovery([project('project-a', 'machine-local', '/project-a')]);
        },
        async loadProjectWorktrees(_rootPath, _machineId, options) {
          markStarted();
          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => {
              markAborted();
              reject(options.signal?.reason);
            }, { once: true });
          });
        }
      } as never),
      host: '127.0.0.1',
      port: 0
    });
    try {
      const controller = new AbortController();
      const request = fetch(`${server.origin}/api/project-topology/inventory`, {
        signal: controller.signal
      }).catch(() => undefined);
      await started;
      controller.abort();
      await Promise.race([
        aborted,
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error('The server did not cancel the disconnected inventory.')),
          1_000
        ))
      ]);
      await request;
    } finally {
      await server.close();
    }
  });
});

function backend(
  implementation: Partial<Pick<
    ProjectSpaceBackend,
    'getConnectorOverview' | 'loadProjectDiscovery' | 'loadProjectWorktrees'
  >> & {
    loadProjectWorktrees?(
      rootPath: string,
      machineId?: string,
      options?: { signal?: AbortSignal; timeoutMs?: number }
    ): Promise<ProjectWorktreeRecord[]>;
  }
) {
  return implementation as ProjectSpaceBackend;
}

function project(id: string, machineId: string, rootPath: string): ProjectSpaceRecord {
  return { id, kind: 'standalone', machineId, name: id, rootPath };
}

function discovery(projects: ProjectSpaceRecord[]): ProjectDiscoveryResult {
  return { groups: [], projects, rootItems: [], rootPath: '/projects', structureViolations: [] };
}

function machine(
  id: string,
  status: MachineRecord['connector']['status'] = 'online'
): MachineRecord {
  return {
    connector: { installCommand: '', status },
    id,
    kind: 'connector',
    name: id,
    network: {},
    roles: [],
    sourcePath: 'test'
  };
}

function overview(machines: MachineRecord[]): ConnectorOverviewResult {
  return {
    machines,
    machinesRepo: { exists: true, path: '/machines' },
    tailscale: { connected: false, installed: false, ips: [], peersOnline: 0, serveOrigins: [] }
  };
}

function worktree(rootPath: string): ProjectWorktreeRecord {
  return {
    branchName: 'main',
    detached: false,
    headSha: 'a'.repeat(40),
    id: `wt-${rootPath}`,
    isBase: true,
    kind: 'project-managed',
    locked: false,
    name: 'main',
    path: rootPath,
    prunable: false,
    status: 'ready'
  };
}
