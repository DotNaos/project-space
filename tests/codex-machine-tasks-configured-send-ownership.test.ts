import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, test } from 'bun:test';

import { createConfiguredCodexMachineTasksRuntime } from '../server/codex-machine-tasks/configured-runtime';
import { createCodexMachineTasksHttpApi } from '../server/codex-machine-tasks/http';
import type { DatabaseQueryClient } from '../server/database/client';
import type { WorkspaceRuntimeCodexCommand, WorkspaceRuntimeCodexMessage } from '../src/shared/workspace-runtime-codex-api';
import type { WorkspaceRuntimeSessionService } from '../server/workspace-runtime-session/service';
import type {
  ComputeEnvironmentRecord,
  ComputeInventorySnapshot
} from '../src/shared/compute-environment-api';
import type { CodexSessionsRuntime } from '../server/codex-sessions/runtime';
import type { ProjectSpaceBackend } from '../src/shared/project-space-api';
import { memoryStore } from './fixtures/codex-machine-tasks-service';

const userId = 'user-owner';
const deploymentOwnerId = 'project-space:tailscale-deployment';
const environmentId = '11111111-1111-4111-8111-111111111111';
const deploymentEnvironmentId = '33333333-3333-4333-8333-333333333333';
const hostId = '24000000-0000-4000-8000-000000000002';
const deploymentOnlyHostId = '24000000-0000-4000-8000-000000000099';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const branch = '262-build-codex-machine-task-core-and-cli';
const commit = 'a'.repeat(40);
const generation = '22222222-2222-4222-8222-222222222222';
const taskThreadId = '019f6d33-6aad-7302-a45e-bb7a33fc399c';
const reportingThreadId = '019f6d33-6aad-7302-a45e-bb7a33fc399d';
const servers: Server[] = [];

type InventoryState = 'verified' | 'unresolved' | 'deployment-only' | 'duplicate';

/** Owner-scoped persisted rows; the configured runtime must apply the repository boundary. */
class StrictInventoryDatabase implements DatabaseQueryClient {
  constructor(private readonly state: InventoryState = 'verified') {}

  async query<Row>(sql: string, values: readonly unknown[] = []) {
    const requestedOwners = Array.isArray(values[0])
      ? values[0].map(String)
      : [String(values[0] ?? '')];
    const visible = (owner: string) => requestedOwners.includes(owner);
    if (sql.includes('from compute_environment_definitions') && sql.includes('order by lower')) {
      return { rows: [
        definition(userId, 'same-definition-id', 'built_in', 'macOS'),
        definition(userId, 'user-defined-definition', 'user_defined', 'User macOS'),
        definition(deploymentOwnerId, 'same-definition-id', 'built_in', 'macOS')
      ].filter(({ owner_user_id }) => visible(owner_user_id)) as Row[] };
    }
    if (sql.includes('from compute_platforms') && sql.includes('order by lower')) {
      return { rows: [{ id: 'platform-local', kind: 'local', name: 'Local & self-hosted' }] as Row[] };
    }
    if (sql.includes('from compute_hosts') && sql.includes('order by lower')) {
      return { rows: [
        host(userId, hostId, 'os-macbook'),
        ...(this.state === 'duplicate' ? [host(userId, hostId, 'os-macbook-duplicate')] : []),
        host(deploymentOwnerId, hostId, 'deployment-host'),
        ...(this.state === 'deployment-only'
          ? [host(deploymentOwnerId, deploymentOnlyHostId, 'deployment-only-host')]
          : [])
      ].filter(({ owner_user_id }) => visible(owner_user_id)) as Row[] };
    }
    if (sql.includes('from compute_environments') && sql.includes('order by lower')) {
      return { rows: [
        environment(userId, environmentId, 'same-definition-id', this.state === 'verified' || this.state === 'duplicate'
          ? { host_evidence: 'smbios', host_id: hostId, host_resolution: 'verified' }
          : { host_evidence: 'none', host_id: null, host_resolution: 'unresolved' }),
        environment(deploymentOwnerId, deploymentEnvironmentId, 'same-definition-id', {
          host_evidence: 'smbios',
          host_id: this.state === 'deployment-only' ? deploymentOnlyHostId : hostId,
          host_resolution: 'verified'
        }),
        environment(userId, '44444444-4444-4444-8444-444444444444', 'user-defined-definition', {
          host_evidence: 'none', host_id: null, host_resolution: 'unresolved'
        })
      ].filter(({ owner_user_id }) => visible(owner_user_id)) as Row[] };
    }
    if (sql.includes('from connector_compute_environments') && sql.includes('order by connector_id')) {
      return { rows: [{ associated_at: '2026-08-20T11:59:00.000Z', connector_id: 'unused', environment_id: environmentId }] as Row[] };
    }
    throw new Error(`Unexpected configured inventory query: ${sql}`);
  }
}

function definition(owner: string, id: string, ownership: 'built_in' | 'user_defined', name: string) {
  return {
    bootstrap_strategy: 'ssh', id, kind: 'native_macos', name,
    operating_system_family: 'macos', owner_user_id: owner, ownership,
    slug: ownership === 'built_in' ? 'macos' : 'user-macos', supported_architectures: []
  };
}

function host(owner: string, id: string, name: string) {
  return {
    id, identity_key: `host:${owner}:${id}:${name}`, identity_version: 1,
    legacy_tombstoned_only: false, name, owner_user_id: owner,
    platform_id: 'platform-local', resources: null
  };
}

function environment(
  owner: string,
  id: string,
  definitionId: string,
  association: { host_evidence: string; host_id: string | null; host_resolution: string }
) {
  return {
    ...association, environment_definition_id: definitionId, id,
    identity_key: `environment:${owner}:${id}`, identity_resolution: 'resolved', identity_version: 1,
    kind: 'native_macos', legacy_tombstoned_only: false, name: id,
    owner_user_id: owner, parent_environment_id: null, platform_id: 'platform-local',
    resource_mode: 'dedicated', resources: null
  };
}

function unitEnvironment(
  hostAssociation: ComputeEnvironmentRecord['hostAssociation']
): ComputeEnvironmentRecord {
  return {
    environmentDefinitionId: 'definition-macos',
    hostAssociation,
    id: environmentId,
    identity: { key: 'environment:canonical-macos', version: 1 },
    kind: 'native_macos',
    name: 'macOS Workspace Runtime',
    platformId: 'platform-local',
    resourceMode: 'dedicated'
  };
}

function unitInventory(options: {
  association?: ComputeEnvironmentRecord['hostAssociation'];
  hosts?: ComputeInventorySnapshot['hosts'];
} = {}): ComputeInventorySnapshot {
  return {
    connectors: [],
    environmentDefinitions: [],
    environments: [unitEnvironment(options.association ?? {
      evidence: 'smbios', hostId, resolution: 'verified'
    })],
    hosts: options.hosts ?? [{
      id: hostId,
      identity: { key: 'host:canonical-macos', version: 1 },
      name: 'os-macbook',
      platformId: 'platform-local'
    }],
    platforms: [{ id: 'platform-local', kind: 'local', name: 'Local & self-hosted' }],
    violations: []
  };
}

function runtimeSessions(commands: WorkspaceRuntimeCodexCommand[]) {
  const listeners = new Set<(message: WorkspaceRuntimeCodexMessage) => Promise<void> | void>();
  const snapshot = {
    branch, capabilities: ['runtime.codex.v1'], codexAcceptedCommandSequence: 0, commit,
    connectionState: 'online', devServers: [], environmentId, expiresAt: '2026-08-21T00:00:00.000Z',
    generation, lastEventAt: '2026-08-20T18:00:00.000Z', lastHeartbeatAt: '2026-08-20T18:00:00.000Z',
    lastSequence: 1, lifecycleState: 'running', manifestDigest: 'b'.repeat(64),
    runtimeVersion: '0.4.66', schemaVersion: 1, sessionId: 'configured-session-842', workspaceId
  };
  return {
    list: async (owner: string) => owner === userId ? [snapshot] : [],
    onCodexMessage(listener: (message: WorkspaceRuntimeCodexMessage) => Promise<void> | void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatchCodex(_owner: string, command: WorkspaceRuntimeCodexCommand) {
      commands.push(command);
      const result = command.kind === 'start'
        ? { initialTurnId: 'turn-initial-842', machineId: command.request.machineId, threadId: taskThreadId }
        : { operationId: command.request.operationId, replayed: false, status: 'accepted' as const,
            threadId: command.request.threadId, turnId: 'turn-send-842' };
      queueMicrotask(() => {
        const message = { ...command, result, type: 'runtime.codex.result' } as unknown as WorkspaceRuntimeCodexMessage;
        for (const listener of listeners) void listener(message);
      });
    }
  } as unknown as WorkspaceRuntimeSessionService;
}

function backend() {
  return {
    async createGitHubBranch() { throw new Error('The configured test must not create a branch.'); },
    async getGitHubCatalog() {
      return { checkedAt: '', repositories: [{
        defaultBranch: 'main', fullName: 'DotNaos/project-space', id: 42,
        isPrivate: true, name: 'project-space', owner: 'DotNaos',
        projectConfig: { projectYaml: true, status: 'complete' as const, templateLock: true },
        url: 'https://github.com/DotNaos/project-space'
      }], status: 'connected' as const };
    },
    async getGitHubRepositoryDetails() {
      return { branches: [{ commitSha: commit, isDefault: false, name: branch }], checkedAt: '',
        issues: [{ labels: [], number: 262, state: 'open' as const, title: 'Build Codex machine task core and CLI', url: 'https://github.com/DotNaos/project-space/issues/262' }],
        pullRequests: [], status: 'connected' as const };
    }
  } as Pick<ProjectSpaceBackend, 'createGitHubBranch' | 'getGitHubCatalog' | 'getGitHubRepositoryDetails'>;
}

async function configuredRuntime(database: DatabaseQueryClient, commands: WorkspaceRuntimeCodexCommand[]) {
  return createConfiguredCodexMachineTasksRuntime({
    backend: backend() as never, database: database as never, runtimeSessions: runtimeSessions(commands),
    sessionsRuntime: Promise.reject(new Error('compatibility runtime is not part of this path')) as Promise<CodexSessionsRuntime>,
    taskStore: memoryStore(),
    workspaceBindingStore: {
      list: async () => [{ id: 'execution-842' }],
      readWorkspace: async () => ({ branch, commit, id: workspaceId, state: 'ready', target: { kind: 'project_worktree', reference: 'worktree-842' } })
    } as never
  });
}

async function configuredUnitRuntime(
  inventory: ComputeInventorySnapshot,
  commands: WorkspaceRuntimeCodexCommand[]
) {
  return createConfiguredCodexMachineTasksRuntime({
    backend: backend() as never,
    database: { query: async () => { throw new Error('The repository boundary is outside this unit test.'); } } as never,
    inventory: async () => inventory,
    runtimeSessions: runtimeSessions(commands),
    sessionsRuntime: Promise.reject(new Error('compatibility runtime is not part of this path')) as Promise<CodexSessionsRuntime>,
    taskStore: memoryStore(),
    workspaceBindingStore: {
      list: async () => [{ id: 'execution-842' }],
      readWorkspace: async () => ({
        branch, commit, id: workspaceId, state: 'ready',
        target: { kind: 'project_worktree', reference: 'worktree-842' }
      })
    } as never
  });
}

async function configuredHttp(runtime: Awaited<ReturnType<typeof configuredRuntime>>) {
  const api = createCodexMachineTasksHttpApi(runtime.service, async () => ({
    reportingTask: { role: 'project-manager' as const, threadId: reportingThreadId }, userId
  }));
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!await api(request, response, url)) response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing configured HTTP address.');
  return `http://127.0.0.1:${address.port}`;
}

function mutation(operationId: string, body: Record<string, unknown>) {
  return { body: JSON.stringify({ ...body, operationId }), headers: { 'Content-Type': 'application/json', 'Idempotency-Key': operationId }, method: 'POST' };
}

function startBody(physicalMachineId: string) {
  return { expectedBranch: branch, expectedCommit: commit, issue: 262, physicalMachineId, repositoryId: 'DotNaos/project-space' };
}

function unitStartRequest(operationId: string, physicalMachineId: string) {
  return {
    ...startBody(physicalMachineId),
    operationId,
    worker: { model: 'gpt-5.6-luna', reasoningEffort: 'high' as const }
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('configured Codex start and send ownership boundary', () => {
  test('reconciles persisted owner rows before HTTP start and send', async () => {
    const commands: WorkspaceRuntimeCodexCommand[] = [];
    const runtime = await configuredRuntime(new StrictInventoryDatabase(), commands);
    const origin = await configuredHttp(runtime);
    const start = await fetch(`${origin}/api/codex/tasks/start`, mutation('start-842-valid', startBody(hostId)));
    const started = await start.json();
    expect(start.status).toBe(200);
    expect(started).toMatchObject({ state: 'confirmed', task: { physicalMachine: { id: hostId, name: 'os-macbook' } } });
    const send = await fetch(`${origin}/api/codex/tasks/${started.task.threadId}/send`, mutation('send-842-valid', {
      delivery: 'new-turn', message: 'Continue on the verified workspace.', physicalMachineId: hostId
    }));
    expect(send.status).toBe(200);
    expect(await send.json()).toMatchObject({ state: 'accepted', target: { physicalMachine: { id: hostId, name: 'os-macbook' } } });
    expect(commands.map(({ kind, environmentId: selectedEnvironment }) => ({ kind, selectedEnvironment }))).toEqual([
      { kind: 'start', selectedEnvironment: environmentId }, { kind: 'continue', selectedEnvironment: environmentId }
    ]);
    expect(commands[0]?.request.machineId).toBe(commands[1]?.request.machineId);
  });

  test.each([
    ['deployment-only', 'deployment-only' as InventoryState, deploymentOnlyHostId],
    ['unresolved', 'unresolved' as InventoryState, hostId],
    ['duplicate user Host UUID', 'duplicate' as InventoryState, hostId]
  ])('fails closed for %s evidence before dispatch', async (_name, state, physicalMachineId) => {
    const commands: WorkspaceRuntimeCodexCommand[] = [];
    const runtime = await configuredRuntime(new StrictInventoryDatabase(state), commands);
    const origin = await configuredHttp(runtime);
    const response = await fetch(`${origin}/api/codex/tasks/start`, mutation(`start-842-${state}`, startBody(physicalMachineId)));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ reason: 'unauthorized', state: 'blocked' });
    expect(commands).toEqual([]);
  });
});

describe('configured Codex service ownership unit boundary', () => {
  test('retains the exact selected Host across direct start and send', async () => {
    const commands: WorkspaceRuntimeCodexCommand[] = [];
    const runtime = await configuredUnitRuntime(unitInventory(), commands);
    const started = await runtime.service.start(
      { reportingTask: { role: 'project-manager', threadId: reportingThreadId }, userId },
      unitStartRequest('unit-start-842-valid', hostId)
    );
    expect(started).toMatchObject({
      state: 'confirmed', task: { physicalMachine: { id: hostId, name: 'os-macbook' } }
    });
    const sent = await runtime.service.send({ userId }, {
      delivery: 'new-turn',
      message: 'Continue on the verified workspace.',
      operationId: 'unit-send-842-valid',
      physicalMachineId: hostId,
      threadId: started.state === 'confirmed' ? started.task.threadId : taskThreadId
    });
    expect(sent).toMatchObject({
      state: 'accepted', target: { physicalMachine: { id: hostId, name: 'os-macbook' } }
    });
    expect(commands.map(({ kind }) => kind)).toEqual(['start', 'continue']);
  });

  test.each([
    ['missing owner-valid Host', unitInventory({
      association: { evidence: 'smbios', hostId: deploymentOnlyHostId, resolution: 'verified' }
    })],
    ['duplicate same-UUID Hosts', unitInventory({
      hosts: [
        { id: hostId, identity: { key: 'host:user', version: 1 }, name: 'user-host', platformId: 'platform-local' },
        { id: hostId, identity: { key: 'host:deployment', version: 1 }, name: 'deployment-host', platformId: 'platform-local' }
      ]
    })]
  ])('fails closed for %s before direct dispatch', async (_name, inventory) => {
    const commands: WorkspaceRuntimeCodexCommand[] = [];
    const runtime = await configuredUnitRuntime(inventory, commands);
    const result = await runtime.service.start(
      { reportingTask: { role: 'project-manager', threadId: reportingThreadId }, userId },
      unitStartRequest(`unit-start-842-${commands.length}-${inventory.hosts.length}`, hostId)
    );
    expect(result).toMatchObject({ reason: 'unauthorized', state: 'blocked' });
    expect(commands).toEqual([]);
  });
});
