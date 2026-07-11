import { describe, expect, test } from 'bun:test';

import {
  createDevServerService,
  type DevServerConnectorGateway,
  type DevServerDatabaseGateway
} from '../server/dev-server-service';
import type {
  DevServerSession,
  MachineMembership,
  ProjectRunSettings,
  TransitionDevServerSessionInput,
  UpsertProjectRunSettingsInput
} from '../server/local-database-store';
import type {
  DevServerConnectorResult,
  ProjectWorktreeRecord
} from '../src/shared/project-space-api';

const now = new Date('2026-07-11T12:00:00.000Z');
const machineId = 'machine-a';
const projectId = `${machineId}:project-a`;
const projectPath = '/srv/projects/project-a';
const worktree: ProjectWorktreeRecord = {
  branchName: 'feature/dev-server',
  id: 'worktree-opaque-id',
  isBase: false,
  name: 'feature-dev-server',
  path: '/srv/projects/.worktrees/project-a/feature-dev-server',
  status: 'ready'
};

type ConnectorRequest = Parameters<DevServerConnectorGateway['inspect']>[0];
type ConnectorActor = Parameters<DevServerConnectorGateway['inspect']>[1];
type ConnectorOperation = 'inspect' | 'start' | 'stop';

interface ConnectorCall {
  actor: ConnectorActor;
  operation: ConnectorOperation;
  request: ConnectorRequest;
}

type ConnectorResultFactory = (
  operation: ConnectorOperation,
  request: ConnectorRequest,
  actor: ConnectorActor
) => DevServerConnectorResult;

function membership(userId: string, role: 'member' | 'owner' = 'owner'): MachineMembership {
  return {
    createdAt: now.toISOString(),
    id: `membership-${userId}`,
    machineId,
    role,
    updatedAt: now.toISOString(),
    userId
  };
}

function settings(userId: string, input: Partial<ProjectRunSettings> = {}): ProjectRunSettings {
  return {
    allowedHosts: [],
    createdAt: now.toISOString(),
    id: `settings-${userId}`,
    machineId,
    projectId,
    runTarget: 'dev',
    updatedAt: now.toISOString(),
    userId,
    ...input
  };
}

function resultFor(
  request: ConnectorRequest,
  actor: ConnectorActor,
  input: Partial<DevServerConnectorResult> = {}
): DevServerConnectorResult {
  return {
    capability: 'configured',
    checkedAt: now.toISOString(),
    generation: actor.generation,
    localPort: 43117,
    localUrl: 'http://127.0.0.1:43117/',
    machineId: request.machineId,
    projectId: request.projectId,
    publicPort: 44419,
    runTarget: request.runTarget,
    startedAt: '2026-07-11T11:59:00.000Z',
    state: 'running',
    tailscaleIPv4: '100.80.135.9',
    tailscaleUrl: 'http://100.80.135.9:44419/',
    worktreeId: request.worktreeId,
    ...input
  };
}

class InMemoryDatabase implements DevServerDatabaseGateway {
  configured = true;
  memberships = new Map<string, MachineMembership>();
  settings = new Map<string, ProjectRunSettings>();
  sessions: DevServerSession[] = [];
  beforeSettingsRead?: (readNumber: number) => Promise<void>;
  listSessionUsers: string[] = [];
  readSettingsUsers: string[] = [];
  settingsReadCount = 0;
  upsertCalls: UpsertProjectRunSettingsInput[] = [];
  private nextSessionId = 1;

  private membershipKey(userId: string, selectedMachineId: string) {
    return `${userId}\u0000${selectedMachineId}`;
  }

  private settingsKey(userId: string, selectedMachineId: string, selectedProjectId: string) {
    return `${userId}\u0000${selectedMachineId}\u0000${selectedProjectId}`;
  }

  addMembership(value: MachineMembership) {
    this.memberships.set(this.membershipKey(value.userId, value.machineId), value);
  }

  addSettings(value: ProjectRunSettings) {
    this.settings.set(this.settingsKey(value.userId, value.machineId, value.projectId), value);
  }

  isConfigured() {
    return this.configured;
  }

  async isMachineClaimed(selectedMachineId: string) {
    return [...this.memberships.values()].some(
      (candidate) => candidate.machineId === selectedMachineId
    );
  }

  async readMachineMembership(input: { machineId: string; userId: string }) {
    return this.memberships.get(this.membershipKey(input.userId, input.machineId)) ?? null;
  }

  async readProjectRunSettings(input: {
    machineId: string;
    projectId: string;
    userId: string;
  }) {
    this.readSettingsUsers.push(input.userId);
    const value = this.settings.get(
      this.settingsKey(input.userId, input.machineId, input.projectId)
    ) ?? null;
    this.settingsReadCount += 1;
    await this.beforeSettingsRead?.(this.settingsReadCount);
    return value;
  }

  async upsertProjectRunSettings(input: UpsertProjectRunSettingsInput) {
    this.upsertCalls.push({ ...input, allowedHosts: input.allowedHosts && [...input.allowedHosts] });
    const key = this.settingsKey(input.userId, input.machineId, input.projectId);
    const existing = this.settings.get(key);
    const value: ProjectRunSettings = {
      allowedHosts: [...(input.allowedHosts ?? [])],
      createdAt: existing?.createdAt ?? now.toISOString(),
      id: existing?.id ?? `settings-${input.userId}`,
      machineId: input.machineId,
      preferredWorktreeId: input.preferredWorktreeId ?? undefined,
      projectId: input.projectId,
      runTarget: input.runTarget ?? 'dev',
      updatedAt: now.toISOString(),
      userId: input.userId
    };
    this.settings.set(key, value);
    return value;
  }

  async createDevServerSession(input: {
    localPort?: number;
    machineId: string;
    ownerUserId: string;
    projectId: string;
    runTarget?: string;
    state?: DevServerSession['state'];
    tailscalePort?: number;
    tailscaleUrl?: string;
    worktreeId: string;
  }) {
    const timestamp = now.toISOString();
    const value: DevServerSession = {
      createdAt: timestamp,
      generation: 0,
      id: `session-${this.nextSessionId++}`,
      localPort: input.localPort,
      machineId: input.machineId,
      ownerUserId: input.ownerUserId,
      projectId: input.projectId,
      runTarget: input.runTarget ?? 'dev',
      state: input.state ?? 'starting',
      tailscalePort: input.tailscalePort,
      tailscaleUrl: input.tailscaleUrl,
      updatedAt: timestamp,
      worktreeId: input.worktreeId
    };
    this.sessions.unshift(value);
    return value;
  }

  async listDevServerSessions(
    userId: string,
    filter: {
      activeOnly?: boolean;
      machineId?: string;
      projectId?: string;
      worktreeId?: string;
    } = {}
  ) {
    this.listSessionUsers.push(userId);
    return this.sessions.filter(
      (candidate) =>
        candidate.ownerUserId === userId &&
        (!filter.machineId || candidate.machineId === filter.machineId) &&
        (!filter.projectId || candidate.projectId === filter.projectId) &&
        (!filter.worktreeId || candidate.worktreeId === filter.worktreeId) &&
        (!filter.activeOnly || ['starting', 'running', 'stopping'].includes(candidate.state))
    );
  }

  async transitionDevServerSession(input: TransitionDevServerSessionInput) {
    const index = this.sessions.findIndex(
      (candidate) =>
        candidate.id === input.sessionId &&
        candidate.ownerUserId === input.userId &&
        candidate.generation === input.expectedGeneration
    );
    if (index < 0) {
      return null;
    }

    const existing = this.sessions[index]!;
    const value: DevServerSession = {
      ...existing,
      generation: existing.generation + 1,
      state: input.state,
      updatedAt: now.toISOString()
    };
    const assign = <Key extends keyof Pick<
      DevServerSession,
      | 'lastError'
      | 'lastSeenAt'
      | 'localPort'
      | 'startedAt'
      | 'stoppedAt'
      | 'tailscalePort'
      | 'tailscaleUrl'
    >>(key: Key, candidate: DevServerSession[Key] | null | undefined) => {
      if (candidate === undefined) {
        return;
      }
      if (candidate === null) {
        delete value[key];
        return;
      }
      value[key] = candidate;
    };
    assign('lastError', input.lastError);
    assign('lastSeenAt', input.lastSeenAt);
    assign('localPort', input.localPort);
    assign('startedAt', input.startedAt);
    assign('stoppedAt', input.stoppedAt);
    assign('tailscalePort', input.tailscalePort);
    assign('tailscaleUrl', input.tailscaleUrl);
    this.sessions[index] = value;
    return value;
  }
}

interface HarnessOptions {
  configured?: boolean;
  connectorResult?: ConnectorResultFactory;
  currentUser?: string;
  memberships?: MachineMembership[];
  runSettings?: ProjectRunSettings[];
  worktrees?: ProjectWorktreeRecord[];
}

function createHarness(options: HarnessOptions = {}) {
  let currentUser = options.currentUser ?? 'user-a';
  const connectorCalls: ConnectorCall[] = [];
  const database = new InMemoryDatabase();
  database.configured = options.configured ?? true;
  for (const value of options.memberships ?? []) {
    database.addMembership(value);
  }
  for (const value of options.runSettings ?? []) {
    database.addSettings(value);
  }

  const resultFactory: ConnectorResultFactory =
    options.connectorResult ?? ((_operation, request, actor) => resultFor(request, actor));
  const invoke = async (
    operation: ConnectorOperation,
    request: ConnectorRequest,
    actor: ConnectorActor
  ) => {
    connectorCalls.push({
      actor: { ...actor },
      operation,
      request: { ...request, allowedHosts: [...request.allowedHosts] }
    });
    return resultFactory(operation, request, actor);
  };
  const connector: DevServerConnectorGateway = {
    inspect: (request, actor) => invoke('inspect', request, actor),
    start: (request, actor) => invoke('start', request, actor),
    stop: (request, actor) => invoke('stop', request, actor)
  };
  const selectedWorktrees = options.worktrees ?? [worktree];
  const service = createDevServerService({
    backend: {
      async getConnectorOverview() {
        return {
          machines: [
            {
              connector: { installCommand: '', status: 'online' },
              id: machineId,
              kind: 'development',
              name: 'Machine A',
              network: { tailscaleIp: '100.80.135.9' },
              roles: [],
              sourcePath: 'connector-hub'
            }
          ],
          machinesRepo: { exists: true, path: '/srv/machines' },
          tailscale: {
            connected: true,
            installed: true,
            ips: ['100.80.135.9'],
            peersOnline: 1,
            serveOrigins: []
          }
        };
      },
      async loadProjectDiscovery() {
        return {
          groups: [],
          projects: [
            {
              id: projectId,
              kind: 'standalone',
              machineId,
              name: 'Project A',
              rootPath: projectPath
            }
          ],
          rootItems: [],
          rootPath: '/srv/projects',
          structureViolations: []
        };
      },
      async loadProjectWorktrees(requestedProjectPath, requestedMachineId) {
        expect(requestedProjectPath).toBe(projectPath);
        expect(requestedMachineId).toBe(machineId);
        return selectedWorktrees;
      }
    },
    connector,
    database,
    now: () => new Date(now),
    userId: () => currentUser
  });

  return {
    connectorCalls,
    database,
    service,
    setUser(userId: string) {
      currentUser = userId;
    }
  };
}

describe('development-server service authorization boundary', () => {
  test('database-required access never reaches the connector', async () => {
    const harness = createHarness({ configured: false });

    const inspected = await harness.service.inspect({ machineId, projectId });
    const started = await harness.service.start({ machineId, projectId, worktreeId: worktree.id });

    expect(inspected.access).toBe('database-required');
    expect(inspected.servers).toEqual([]);
    expect(started.access).toBe('database-required');
    expect(started.servers).toEqual([]);
    expect(harness.connectorCalls).toEqual([]);
  });

  test('an unclaimed machine never reaches the connector', async () => {
    const harness = createHarness();

    const inspected = await harness.service.inspect({ machineId, projectId });
    const started = await harness.service.start({ machineId, projectId, worktreeId: worktree.id });

    expect(inspected.access).toBe('unclaimed');
    expect(started.access).toBe('unclaimed');
    expect(harness.connectorCalls).toEqual([]);
  });

  test('access and persisted runtime state stay scoped to the authenticated user', async () => {
    const harness = createHarness({ memberships: [membership('user-a')] });
    await harness.service.start({ machineId, projectId, worktreeId: worktree.id });
    const callsAfterOwnerStart = harness.connectorCalls.length;

    harness.setUser('user-b');
    const otherUser = await harness.service.inspect({ machineId, projectId });

    expect(otherUser.access).toBe('denied');
    expect(otherUser.servers).toEqual([]);
    expect(harness.connectorCalls).toHaveLength(callsAfterOwnerStart);
    expect(harness.database.sessions.every((session) => session.ownerUserId === 'user-a')).toBe(true);
    expect(harness.database.listSessionUsers).not.toContain('user-b');
    expect(harness.database.readSettingsUsers).not.toContain('user-b');
  });

  test('checks user access before resolving a user-supplied worktree id', async () => {
    const harness = createHarness({
      currentUser: 'user-b',
      memberships: [membership('user-a')]
    });

    const result = await harness.service.start({
      machineId,
      projectId,
      worktreeId: 'unknown-to-the-browser-user'
    });

    expect(result.access).toBe('denied');
    expect(result.servers).toEqual([]);
    expect(harness.connectorCalls).toEqual([]);
  });
});

describe('development-server service trusted execution inputs', () => {
  test('resolves the exact worktree path from the backend instead of treating the browser id as a path', async () => {
    const harness = createHarness({ memberships: [membership('user-a')] });

    await harness.service.start({ machineId, projectId, worktreeId: worktree.id });

    expect(harness.connectorCalls.map((call) => call.operation)).toEqual(['start', 'inspect']);
    expect(harness.connectorCalls.every((call) => call.request.worktreeId === worktree.id)).toBe(true);
    expect(
      harness.connectorCalls.every((call) => call.request.worktreePath === worktree.path)
    ).toBe(true);
    expect(harness.connectorCalls.some((call) => call.request.worktreePath === worktree.id)).toBe(false);
  });

  test('rejects an unknown worktree before any connector command can execute', async () => {
    const harness = createHarness({ memberships: [membership('user-a')] });

    await expect(
      harness.service.start({ machineId, projectId, worktreeId: 'browser-supplied-path' })
    ).rejects.toThrow('The selected worktree is not available on this machine.');
    expect(harness.connectorCalls).toEqual([]);
  });

  test('starts with per-user allowed hosts and run target and persists the preferred worktree', async () => {
    const harness = createHarness({
      memberships: [membership('user-a')],
      runSettings: [
        settings('user-a', {
          allowedHosts: ['Preview.Example.Test', '100.80.135.9'],
          runTarget: 'storybook'
        })
      ]
    });

    await harness.service.start({ machineId, projectId, worktreeId: worktree.id });

    const startCall = harness.connectorCalls.find((call) => call.operation === 'start');
    expect(startCall?.request).toMatchObject({
      allowedHosts: ['100.80.135.9', 'preview.example.test'],
      runTarget: 'storybook',
      worktreeId: worktree.id,
      worktreePath: worktree.path
    });
    expect(startCall?.actor.userId).toBe('user-a');
    expect(harness.database.upsertCalls).toEqual([
      {
        allowedHosts: ['100.80.135.9', 'preview.example.test'],
        machineId,
        preferredWorktreeId: worktree.id,
        projectId,
        runTarget: 'storybook',
        userId: 'user-a'
      }
    ]);
    expect(
      harness.database.settings.get(`user-a\u0000${machineId}\u0000${projectId}`)
        ?.preferredWorktreeId
    ).toBe(worktree.id);
  });

  test('does not forget an active runtime when the run target changes', async () => {
    const harness = createHarness();
    harness.database.addMembership(membership('user-a'));

    await harness.service.start({ machineId, projectId, worktreeId: worktree.id });

    await expect(
      harness.service.updateSettings({
        allowedHosts: [],
        preferredWorktreeId: worktree.id,
        machineId,
        projectId,
        runTarget: 'storybook'
      })
    ).rejects.toThrow('Stop active development servers');
    expect(harness.database.settings.get(`user-a\u0000${machineId}\u0000${projectId}`)?.runTarget)
      .toBe('dev');
  });

  test('requires a restart before allowed hosts can change', async () => {
    const harness = createHarness();
    harness.database.addMembership(membership('user-a'));

    await harness.service.start({ machineId, projectId, worktreeId: worktree.id });

    await expect(
      harness.service.updateSettings({
        allowedHosts: ['preview.example.test'],
        machineId,
        projectId,
        runTarget: 'dev'
      })
    ).rejects.toThrow('Stop active development servers');
    expect(
      harness.database.settings.get(`user-a\u0000${machineId}\u0000${projectId}`)?.allowedHosts
    ).toEqual([]);
  });

  test('serializes settings updates with startup so the runtime and database cannot diverge', async () => {
    const harness = createHarness({
      memberships: [membership('user-a')],
      runSettings: [settings('user-a', { allowedHosts: ['old.example.test'] })]
    });
    let releaseFirstSettingsRead = () => {};
    let markFirstSettingsRead = () => {};
    const firstSettingsRead = new Promise<void>((resolve) => {
      markFirstSettingsRead = resolve;
    });
    const continueFirstSettingsRead = new Promise<void>((resolve) => {
      releaseFirstSettingsRead = resolve;
    });
    harness.database.beforeSettingsRead = async (readNumber) => {
      if (readNumber === 1) {
        markFirstSettingsRead();
        await continueFirstSettingsRead;
      }
    };

    const start = harness.service.start({ machineId, projectId, worktreeId: worktree.id });
    await firstSettingsRead;

    let updateSettled = false;
    const update = harness.service
      .updateSettings({
        allowedHosts: ['new.example.test'],
        machineId,
        projectId,
        runTarget: 'dev'
      })
      .then(
        (value) => ({ error: undefined, value }),
        (error: unknown) => ({ error, value: undefined })
      )
      .finally(() => {
        updateSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(updateSettled).toBe(false);

    releaseFirstSettingsRead();
    await start;
    const updateOutcome = await update;
    expect(updateOutcome.error).toBeInstanceOf(Error);
    expect((updateOutcome.error as Error).message).toContain('Stop active development servers');

    const startCall = harness.connectorCalls.find((call) => call.operation === 'start');
    expect(startCall?.request.allowedHosts).toEqual(['old.example.test']);
    expect(
      harness.database.settings.get(`user-a\u0000${machineId}\u0000${projectId}`)?.allowedHosts
    ).toEqual(['old.example.test']);
  });
});

describe('development-server service exposure verification', () => {
  test('preserves a bounded connector error string for the worktree row', async () => {
    const harness = createHarness({
      connectorResult: (_operation, request, actor) =>
        resultFor(request, actor, {
          lastError: 'The configured dev command exited before it opened a port.',
          state: 'error'
        }),
      memberships: [membership('user-a')]
    });

    const overview = await harness.service.inspect({ machineId, projectId });

    expect(overview.servers[0]?.lastError).toBe(
      'The configured dev command exited before it opened a port.'
    );
  });

  test('emits a canonical Tailscale URL for a fresh verified 100.64/10 IPv4 and port', async () => {
    const harness = createHarness({ memberships: [membership('user-a')] });

    const overview = await harness.service.inspect({ machineId, projectId });

    expect(overview.servers).toHaveLength(1);
    expect(overview.servers[0]).toMatchObject({
      checkedAt: now.toISOString(),
      publicPort: 44419,
      state: 'running',
      tailscaleIPv4: '100.80.135.9',
      tailscaleUrl: 'http://100.80.135.9:44419/',
      verifiedAt: now.toISOString()
    });
  });

  test.each([
    ['stale', '2026-07-10T12:00:00.000Z'],
    ['implausibly future-dated', '2026-07-11T12:01:00.000Z']
  ])('does not emit a running URL from a %s connector observation', async (_label, observedAt) => {
    const harness = createHarness({
      connectorResult: (_operation, request, actor) =>
        resultFor(request, actor, { checkedAt: observedAt }),
      memberships: [membership('user-a')]
    });

    const overview = await harness.service.inspect({ machineId, projectId });

    expect(overview.servers[0]?.state).toBe('error');
    expect(overview.servers[0]?.tailscaleUrl).toBeUndefined();
    expect(overview.servers[0]?.verifiedAt).toBeUndefined();
  });

  test.each([
    ['a non-Tailscale address', '192.168.1.20', 'http://192.168.1.20:44419/'],
    ['an address immediately outside 100.64/10', '100.128.0.1', 'http://100.128.0.1:44419/'],
    ['HTTPS instead of the verified TCP HTTP origin', '100.80.135.9', 'https://100.80.135.9:44419/'],
    ['a different host', '100.80.135.9', 'http://100.80.135.10:44419/'],
    ['a different port', '100.80.135.9', 'http://100.80.135.9:44420/'],
    ['credentials in the URL', '100.80.135.9', 'http://attacker@100.80.135.9:44419/'],
    ['a query string', '100.80.135.9', 'http://100.80.135.9:44419/?redirect=evil']
  ])('turns %s into an error without exposing a URL', async (_label, tailscaleIPv4, tailscaleUrl) => {
    const harness = createHarness({
      connectorResult: (_operation, request, actor) =>
        resultFor(request, actor, { tailscaleIPv4, tailscaleUrl }),
      memberships: [membership('user-a')]
    });

    const overview = await harness.service.inspect({ machineId, projectId });

    expect(overview.servers[0]?.state).toBe('error');
    expect(overview.servers[0]?.tailscaleUrl).toBeUndefined();
    expect(overview.servers[0]?.publicPort).toBeUndefined();
    expect(overview.servers[0]?.verifiedAt).toBeUndefined();
  });

  test('persists a failed start without retaining an unverified public URL', async () => {
    const harness = createHarness({
      connectorResult: (_operation, request, actor) =>
        resultFor(request, actor, { tailscaleUrl: 'http://attacker.example:44419/' }),
      memberships: [membership('user-a')]
    });

    await expect(
      harness.service.start({ machineId, projectId, worktreeId: worktree.id })
    ).rejects.toThrow('The connector did not verify a canonical Tailscale TCP exposure.');

    expect(harness.database.sessions[0]).toMatchObject({ state: 'error' });
    expect(harness.database.sessions[0]?.tailscaleUrl).toBeUndefined();
    expect(harness.database.sessions[0]?.tailscalePort).toBeUndefined();
  });
});
