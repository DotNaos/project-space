import { describe, expect, test } from 'bun:test';

import { createPullRequestPrototypeIterationService } from '../server/pr-prototype-iteration-service';
import type {
  CodexSessionInspectResult,
  CodexSessionListResult
} from '../src/shared/codex-sessions-api';
import type {
  DevServerOverviewResult,
  GitHubRepositoryDetailsResult,
  MachineRecord,
  ProjectDiscoveryResult,
  ProjectWorktreeRecord
} from '../src/shared/project-space-api';

const checkedAt = '2026-07-30T10:00:00.000Z';
const headSha = 'a'.repeat(40);
const connectorId = 'connector-os-mac';
const machineId = 'physical-os-mac';
const projectId = 'connector-os-mac:project-space';
const worktreeId = 'wt_project_space_395';
const worktreePath = '/srv/projects/.worktrees/project-space/issue-395';
const threadId = '019fb130-acf7-78b1-b63b-8f18323e58f1';
const request = {
  headSha,
  pullRequestNumber: 395,
  repositoryFullName: 'DotNaos/project-space',
  surface: 'desktop-prototype' as const
};

function repository(
  input: Partial<GitHubRepositoryDetailsResult['pullRequests'][number]> = {}
): GitHubRepositoryDetailsResult {
  return {
    branches: [],
    checkedAt,
    issues: [],
    pullRequests: [{
      headBranch: 'issue-395-secure-prototypes',
      headSha,
      number: 395,
      state: 'open',
      title: 'Secure prototypes',
      url: 'https://github.com/DotNaos/project-space/pull/397',
      ...input
    }],
    status: 'connected'
  };
}

function discovery(): ProjectDiscoveryResult {
  return {
    groups: [],
    projects: [{
      github: {
        fullName: 'DotNaos/project-space'
      } as ProjectDiscoveryResult['projects'][number]['github'],
      id: projectId,
      kind: 'github',
      machineId: connectorId,
      name: 'project-space',
      rootPath: '/srv/projects/project-space'
    }],
    rootItems: [],
    rootPath: '/srv/projects',
    structureViolations: []
  };
}

function worktree(input: Partial<ProjectWorktreeRecord> = {}): ProjectWorktreeRecord {
  return {
    branchName: 'issue-395-secure-prototypes',
    detached: false,
    headSha,
    id: worktreeId,
    isBase: false,
    kind: 'project-managed',
    locked: false,
    name: 'issue-395',
    path: worktreePath,
    prunable: false,
    status: 'ready',
    ...input
  };
}

function connector(input: { lastSeen?: string; online?: boolean } = {}): MachineRecord {
  return {
    connector: {
      capabilities: [],
      installCommand: 'project-space-connector',
      lastSeen: input.lastSeen ?? checkedAt,
      serviceName: 'project-space-connector',
      status: input.online === false ? 'offline' : 'online',
      update: { state: 'checking' }
    },
    id: connectorId,
    kind: 'connector',
    name: 'os-mac connector',
    network: {},
    roles: ['connector'],
    sourcePath: '/srv'
  } as MachineRecord;
}

function taskList(input: Partial<CodexSessionListResult> = {}): CodexSessionListResult {
  return {
    checkedAt,
    inventoryState: 'live',
    machine: { id: connectorId, name: 'os-mac', online: true },
    sessions: [{
      archived: false,
      cwd: worktreePath,
      id: threadId,
      lastActivityAt: checkedAt,
      loadedByProjectSpace: true,
      machineId: connectorId,
      machineName: 'os-mac',
      status: 'idle',
      title: '#395/2 · Eos · Implement secure prototype iteration'
    }],
    ...input
  };
}

function taskInspection(
  input: Partial<CodexSessionInspectResult> = {}
): CodexSessionInspectResult {
  return {
    checkedAt,
    openedReadOnly: true,
    session: taskList().sessions[0]!,
    sessionRevision: 'revision-1',
    taskLocation: {
      canonicalCwd: worktreePath,
      checkedAt,
      machineId: connectorId,
      sessionRevision: 'revision-1',
      source: 'connector-realpath',
      threadId,
      worktreeRoot: worktreePath
    },
    writeCapability: {
      canContinue: true,
      checkedAt,
      expiresAt: '2026-07-30T10:01:00.000Z',
      machineId: connectorId,
      sessionLastActivityAt: checkedAt,
      sessionRevision: 'revision-1',
      state: 'ready',
      threadId
    },
    ...input
  };
}

function overview(state: 'running' | 'stopped' = 'stopped'): DevServerOverviewResult {
  return {
    access: 'owner',
    machineId: connectorId,
    projectId,
    servers: [{
      capability: 'configured',
      checkedAt,
      ...(state === 'running'
        ? {
            publicPort: 44419,
            tailscaleIPv4: '100.80.135.9',
            tailscaleUrl: 'http://100.80.135.9:44419/prototype/desktop/'
          }
        : {}),
      machineId: connectorId,
      projectId,
      runTarget: 'prototype-desktop',
      serverId: 'prototype-desktop',
      serverLabel: 'PR desktop prototype',
      state,
      worktreeId
    }]
  };
}

function fixture() {
  const calls = {
    register: [] as unknown[],
    start: [] as unknown[]
  };
  const values = {
    afterStart: undefined as (() => void) | undefined,
    connectors: [connector()],
    discovery: discovery(),
    inspect: taskInspection(),
    physicalMachines: [{ connectorIds: [connectorId], id: machineId, name: 'os-mac' }],
    repository: repository(),
    servers: overview(),
    tasks: taskList(),
    worktrees: [worktree()],
    nowSequence: [] as Date[]
  };
  const dependencies: Parameters<typeof createPullRequestPrototypeIterationService>[0] = {
    devServers: {
      async inspect() {
        return values.servers;
      },
      async start(input) {
        calls.start.push(input);
        const result = overview('running');
        values.servers = result;
        values.afterStart?.();
        return result;
      }
    },
    async inspectCodexTask() {
      return values.inspect;
    },
    async listCodexTasks() {
      return values.tasks;
    },
    async listConnectorMachines() {
      return values.connectors;
    },
    async listPhysicalMachines() {
      return values.physicalMachines;
    },
    async loadDiscovery() {
      return values.discovery;
    },
    async loadRepository() {
      return values.repository;
    },
    async loadWorktrees() {
      return values.worktrees;
    },
    now: () => values.nowSequence.shift() ?? new Date(checkedAt),
    async register(input) {
      calls.register.push(input);
      return {
        lease: {
          branchName: 'issue-395-secure-prototypes',
          codexThreadId: threadId,
          commitSha: headSha,
          connectorId,
          createdAt: checkedAt,
          expiresAt: '2026-07-30T10:00:45.000Z',
          generation: 1,
          heartbeatAt: checkedAt,
          id: 'lease-395',
          machineId,
          ownerUserId: 'user-1',
          projectId,
          pullRequestNumber: 395,
          repositoryFullName: 'DotNaos/project-space',
          servedSurface: 'desktop-prototype',
          serverId: 'prototype-desktop',
          tailscaleIpv4: '100.80.135.9',
          tailscalePort: 44419,
          tailscaleUrl: 'http://100.80.135.9:44419/prototype/desktop/',
          updatedAt: checkedAt,
          worktreeId
        }
      };
    }
  };
  return {
    calls,
    service: createPullRequestPrototypeIterationService(dependencies),
    values
  };
}

describe('pull request prototype iteration service', () => {
  test('offers Start only with exact online machine, worktree, head, task, and declaration', async () => {
    const { service } = fixture();
    expect(await service.read('user-1', request)).toMatchObject({
      action: 'start',
      identity: {
        branchName: 'issue-395-secure-prototypes',
        codexTask: { threadId, title: '#395/2 · Eos · Implement secure prototype iteration' },
        connectorId,
        headSha,
        machineId,
        projectId,
        serverId: 'prototype-desktop',
        worktreeId,
        worktreePath
      },
      serverState: 'stopped',
      state: 'startable'
    });
  });

  test('keeps the native surface on its separate predefined server declaration', async () => {
    const native = fixture();
    native.values.servers = {
      ...overview(),
      servers: [{
        ...overview().servers[0]!,
        runTarget: 'prototype-mobile',
        serverId: 'prototype-mobile',
        serverLabel: 'PR native prototype'
      }]
    };
    expect(await native.service.read('user-1', {
      ...request,
      surface: 'mobile-prototype'
    })).toMatchObject({
      action: 'start',
      identity: {
        serverId: 'prototype-mobile',
        surface: 'mobile-prototype'
      },
      state: 'startable'
    });
  });

  test('offers Open only for the exact fresh live lease', async () => {
    const { calls, service } = fixture();
    expect(await service.read('user-1', request, {
      commitSha: headSha,
      connectorId,
      kind: 'dev-server',
      leaseExpiresAt: '2026-07-30T10:00:45.000Z',
      machineId,
      servedSurface: 'desktop-prototype',
      source: 'live',
      state: 'available',
      url: 'http://100.80.135.9:44419/prototype/desktop/',
      verifiedAt: checkedAt
    })).toMatchObject({
      action: 'open',
      state: 'available',
      url: 'http://100.80.135.9:44419/prototype/desktop/'
    });
    expect(calls.start).toHaveLength(0);
  });

  test('withholds Open when the lease expires during verification', async () => {
    const expiring = fixture();
    expiring.values.nowSequence = [
      new Date(checkedAt),
      new Date(checkedAt),
      new Date('2026-07-30T10:00:46.000Z')
    ];
    expect(await expiring.service.read('user-1', request, {
      commitSha: headSha,
      connectorId,
      kind: 'dev-server',
      leaseExpiresAt: '2026-07-30T10:00:45.000Z',
      machineId,
      servedSurface: 'desktop-prototype',
      source: 'live',
      state: 'available',
      url: 'http://100.80.135.9:44419/prototype/desktop/',
      verifiedAt: checkedAt
    })).toMatchObject({
      action: 'start',
      state: 'startable'
    });
  });

  test('starts only the predefined exact target and attributes the lease', async () => {
    const { calls, service } = fixture();
    expect(await service.start('user-1', request)).toMatchObject({
      action: 'open',
      state: 'available',
      url: 'http://100.80.135.9:44419/prototype/desktop/'
    });
    expect(calls.start).toEqual([{
      machineId: connectorId,
      projectId,
      serverId: 'prototype-desktop',
      worktreeId
    }]);
    expect(calls.register).toHaveLength(1);
    expect(calls.register[0]).toMatchObject({
      identity: {
        codexTask: { threadId },
        headSha,
        machineId,
        pullRequestNumber: 395,
        repositoryFullName: 'DotNaos/project-space',
        worktreeId
      },
      userId: 'user-1'
    });
  });

  test('re-verifies the exact identity after the remote start', async () => {
    const changed = fixture();
    changed.values.afterStart = () => {
      changed.values.worktrees = [worktree({ headSha: 'b'.repeat(40) })];
    };
    expect(await changed.service.start('user-1', request)).toMatchObject({
      action: 'none',
      reasonCode: 'worktree-mismatched',
      state: 'mismatched'
    });
    expect(changed.calls.start).toHaveLength(1);
    expect(changed.calls.register).toHaveLength(0);
  });

  test('refreshes runtime evidence and refuses a stale post-start lease', async () => {
    const staleRuntime = fixture();
    staleRuntime.values.afterStart = () => {
      staleRuntime.values.servers = {
        ...overview('running'),
        servers: [{
          ...overview('running').servers[0]!,
          checkedAt: '2026-07-30T09:59:40.000Z'
        }]
      };
    };
    expect(await staleRuntime.service.start('user-1', request)).toMatchObject({
      action: 'none',
      reasonCode: 'dev-server-undeclared',
      state: 'unavailable'
    });
    expect(staleRuntime.calls.start).toHaveLength(1);
    expect(staleRuntime.calls.register).toHaveLength(0);
  });

  test('fails closed for a changed PR head and mismatched worktree', async () => {
    const headFixture = fixture();
    headFixture.values.repository = repository({ headSha: 'b'.repeat(40) });
    expect(await headFixture.service.read('user-1', request)).toMatchObject({
      action: 'none',
      reasonCode: 'head-mismatch',
      state: 'mismatched'
    });

    const worktreeFixture = fixture();
    worktreeFixture.values.worktrees = [worktree({ headSha: 'b'.repeat(40) })];
    expect(await worktreeFixture.service.read('user-1', request)).toMatchObject({
      action: 'none',
      reasonCode: 'worktree-mismatched',
      state: 'mismatched'
    });
  });

  test('distinguishes offline and stale machine evidence', async () => {
    const offline = fixture();
    offline.values.connectors = [connector({ online: false })];
    expect(await offline.service.read('user-1', request)).toMatchObject({
      evidence: {
        machineId,
        machineName: 'os-mac',
        pullRequestNumber: 395,
        repositoryFullName: 'DotNaos/project-space'
      },
      reasonCode: 'machine-offline',
      state: 'offline'
    });

    const stale = fixture();
    stale.values.connectors = [connector({ lastSeen: '2026-07-30T09:58:00.000Z' })];
    expect(await stale.service.read('user-1', request)).toMatchObject({
      evidence: {
        machineId,
        machineName: 'os-mac'
      },
      reasonCode: 'machine-stale',
      state: 'stale'
    });
  });

  test('fails closed for missing, stale, or ambiguous Codex task evidence', async () => {
    const missing = fixture();
    missing.values.tasks = taskList({ sessions: [] });
    expect(await missing.service.read('user-1', request)).toMatchObject({
      reasonCode: 'codex-task-missing',
      state: 'unavailable'
    });

    const stale = fixture();
    stale.values.tasks = taskList({ checkedAt: '2026-07-30T09:58:00.000Z' });
    expect(await stale.service.read('user-1', request)).toMatchObject({
      reasonCode: 'codex-task-stale',
      state: 'stale'
    });

    const ambiguous = fixture();
    ambiguous.values.tasks = taskList({
      sessions: [
        taskList().sessions[0]!,
        { ...taskList().sessions[0]!, id: '019fb130-acf7-78b1-b63b-8f18323e58f2' }
      ]
    });
    expect(await ambiguous.service.read('user-1', request)).toMatchObject({
      reasonCode: 'evidence-ambiguous',
      state: 'mismatched'
    });
  });

  test('never starts for unauthorized machines or undeclared servers', async () => {
    const unauthorized = fixture();
    unauthorized.values.physicalMachines = [];
    expect(await unauthorized.service.start('user-1', request)).toMatchObject({
      action: 'none',
      reasonCode: 'repository-unauthorized',
      state: 'unauthorized'
    });
    expect(unauthorized.calls.start).toHaveLength(0);

    const undeclared = fixture();
    undeclared.values.servers = { ...overview(), servers: [] };
    expect(await undeclared.service.start('user-1', request)).toMatchObject({
      action: 'none',
      reasonCode: 'dev-server-undeclared',
      state: 'unavailable'
    });
    expect(undeclared.calls.start).toHaveLength(0);
  });
});
