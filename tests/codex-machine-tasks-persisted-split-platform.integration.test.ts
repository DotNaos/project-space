import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, test } from 'bun:test';

import { createConfiguredCodexMachineTasksRuntime } from '../server/codex-machine-tasks/configured-runtime';
import { createCodexMachineTasksHttpApi } from '../server/codex-machine-tasks/http';
import type { DatabaseQueryClient } from '../server/database/client';
import { ProjectSpaceDatabaseRepository } from '../server/database/repository';
import type { CodexSessionsRuntime } from '../server/codex-sessions/runtime';
import type {
  WorkspaceRuntimeCodexCommand,
  WorkspaceRuntimeCodexMessage
} from '../src/shared/workspace-runtime-codex-api';
import type { WorkspaceRuntimeSessionService } from '../server/workspace-runtime-session/service';
import { memoryStore } from './fixtures/codex-machine-tasks-service';

const userId = 'user-owner';
const deploymentOwnerId = 'project-space:tailscale-deployment';
const environmentId = '1cbcf4d5-985d-4216-8782-6107cb36562f';
const hostId = '24000000-0000-4000-8000-000000000002';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const branch = '842-preserve-environment-ownership';
const commit = 'a'.repeat(40);
const taskThreadId = '019f6d33-6aad-7302-a45e-bb7a33fc399c';
const reportingThreadId = '019f6d33-6aad-7302-a45e-bb7a33fc399d';
const servers: Server[] = [];

interface Row extends Record<string, unknown> {
  owner_user_id?: string;
}

type SplitPlatformMode =
  | 'valid'
  | 'ambiguous'
  | 'unresolved-copy'
  | 'unrelated-copy'
  | 'user-defined-copy';

class SplitPlatformDatabase implements DatabaseQueryClient {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];

  constructor(private readonly mode: SplitPlatformMode = 'valid') {}

  async query<Result>(sql: string, values: readonly unknown[] = []) {
    this.calls.push({ sql, values });
    const requestedOwners = Array.isArray(values[0]) ? values[0] as string[] : [userId];
    const combined = requestedOwners.includes(deploymentOwnerId);

    if (sql.includes('from compute_environment_definitions') && sql.includes('order by lower')) {
      return { rows: this.visible([
        definition(userId, 'a', 'built_in', 'macOS'),
        definition(deploymentOwnerId, 'x', 'built_in', 'macOS'),
        definition(userId, 'x', 'user_defined', 'User macOS')
      ], combined) as Result[] };
    }
    if (sql.includes('from compute_platforms') && sql.includes('order by lower')) {
      return { rows: this.visible([
        platform(userId, 'b721aada-d38b-4f44-a9ff-4fa86bb7cc31', 'Local & self-hosted'),
        platform(deploymentOwnerId, 'a4731568-0d82-460a-b048-1db063b4b470', 'Local & self-hosted')
      ], combined) as Result[] };
    }
    if (sql.includes('from compute_hosts') && sql.includes('order by lower')) {
      const hosts = this.mode === 'ambiguous'
        ? [
            host(userId, hostId, 'os-macbook', 'b721aada-d38b-4f44-a9ff-4fa86bb7cc31'),
            host(userId, hostId, 'os-macbook-copy', 'b721aada-d38b-4f44-a9ff-4fa86bb7cc31')
          ]
        : [
            host(userId, hostId, 'os-macbook', 'b721aada-d38b-4f44-a9ff-4fa86bb7cc31'),
            host(deploymentOwnerId, '24000000-0000-4000-8000-000000000099', 'deployment-mac', 'a4731568-0d82-460a-b048-1db063b4b470')
          ];
      return { rows: this.visible(hosts, combined) as Result[] };
    }
    if (sql.includes('from compute_environments') && sql.includes('order by lower')) {
      if (this.mode === 'ambiguous') {
        return { rows: [environment(
          userId,
          environmentId,
          'a',
          'b721aada-d38b-4f44-a9ff-4fa86bb7cc31',
          {
            host_evidence: 'none', host_id: null, host_resolution: 'unresolved'
          }
        )] as Result[] };
      }
      const userAssociation = this.mode === 'unresolved-copy'
        ? { host_evidence: 'none', host_id: null, host_resolution: 'unresolved' }
        : { host_evidence: 'user', host_id: hostId, host_resolution: 'manual' };
      const environments = [
        environment(
          userId,
          environmentId,
          this.mode === 'user-defined-copy' ? 'x' : 'a',
          'b721aada-d38b-4f44-a9ff-4fa86bb7cc31',
          userAssociation,
          this.mode === 'unrelated-copy' ? 'unrelated-mac' : 'os-macbook'
        ),
        environment(deploymentOwnerId, environmentId, 'x', 'a4731568-0d82-460a-b048-1db063b4b470', {
          host_evidence: 'none', host_id: null, host_resolution: 'unresolved'
        }),
        environment(userId, '1cbcf4d5-985d-4216-8782-6107cb365688', 'x', 'b721aada-d38b-4f44-a9ff-4fa86bb7cc31', {
          host_evidence: 'none', host_id: null, host_resolution: 'unresolved'
        })
      ];
      return { rows: this.visible(environments, combined) as Result[] };
    }
    if (sql.includes('from connector_compute_environments') && sql.includes('order by connector_id')) {
      return { rows: [] as Result[] };
    }
    return { rows: [] as Result[] };
  }

  private visible(rows: Row[], combined: boolean) {
    return rows.filter((row) => combined || row.owner_user_id === userId);
  }
}

function definition(owner: string, id: string, ownership: 'built_in' | 'user_defined', name: string) {
  return {
    bootstrap_strategy: 'ssh', id, kind: 'native_macos', name,
    operating_system_family: 'macos', owner_user_id: owner, ownership,
    slug: ownership === 'user_defined' ? 'user-macos' : 'macos', supported_architectures: []
  };
}

function platform(owner: string, id: string, name: string) {
  return { id, kind: 'local', name, owner_user_id: owner };
}

function host(owner: string, id: string, name: string, platformId: string) {
  return {
    id, identity_key: `host:${owner}:${id}`, identity_version: 1,
    legacy_tombstoned_only: false, name, owner_user_id: owner, platform_id: platformId,
    resources: null
  };
}

function environment(
  owner: string,
  id: string,
  definitionId: string,
  platformId: string,
  association: { host_evidence: string; host_id: string | null; host_resolution: string },
  name = 'os-macbook'
) {
  return {
    ...association, environment_definition_id: definitionId, id,
    identity_key: `environment:${owner}:${id}`, identity_resolution: 'resolved', identity_version: 1,
    kind: 'native_macos', legacy_tombstoned_only: false, name, owner_user_id: owner,
    parent_environment_id: null, platform_id: platformId, resource_mode: 'dedicated', resources: null,
    tailscale_projected: owner === deploymentOwnerId
  };
}

function runtimeSessions(commands: WorkspaceRuntimeCodexCommand[]) {
  const listeners = new Set<(message: WorkspaceRuntimeCodexMessage) => Promise<void> | void>();
  const snapshot = {
    branch, capabilities: ['runtime.codex.v1'], codexAcceptedCommandSequence: 0,
    commit, connectionState: 'online', devServers: [], environmentId,
    expiresAt: '2026-08-21T00:00:00.000Z', generation: '22222222-2222-4222-8222-222222222222',
    lastEventAt: '2026-08-20T18:00:00.000Z', lastHeartbeatAt: '2026-08-20T18:00:00.000Z',
    lastSequence: 1, lifecycleState: 'running', manifestDigest: 'b'.repeat(64),
    runtimeVersion: '0.4.66', schemaVersion: 1, sessionId: 'split-platform-session', workspaceId
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
        : {
            operationId: command.request.operationId, replayed: false, status: 'accepted' as const,
            threadId: command.request.threadId, turnId: 'turn-send-842'
          };
      queueMicrotask(() => {
        const message = { ...command, result, type: 'runtime.codex.result' } as unknown as WorkspaceRuntimeCodexMessage;
        for (const listener of listeners) void listener(message);
      });
    }
  } as unknown as WorkspaceRuntimeSessionService;
}

function backend() {
  return {
    async createGitHubBranch() { throw new Error('The persisted path must not create a branch.'); },
    async getGitHubCatalog() {
      return {
        checkedAt: '', repositories: [{
          defaultBranch: 'main', fullName: 'DotNaos/project-space', id: 42,
          isPrivate: true, name: 'project-space', owner: 'DotNaos',
          projectConfig: { projectYaml: true, status: 'complete' as const, templateLock: true },
          url: 'https://github.com/DotNaos/project-space'
        }], status: 'connected' as const
      };
    },
    async getGitHubRepositoryDetails() {
      return {
        branches: [{ commitSha: commit, isDefault: false, name: branch }], checkedAt: '',
        issues: [{ labels: [], number: 842, state: 'open' as const, title: 'Preserve Environment ownership', url: 'https://github.com/DotNaos/project-space/issues/842' }],
        pullRequests: [], status: 'connected' as const
      };
    }
  };
}

async function configuredHttp(mode: SplitPlatformMode = 'valid') {
  const database = new SplitPlatformDatabase(mode);
  const commands: WorkspaceRuntimeCodexCommand[] = [];
  const runtime = await createConfiguredCodexMachineTasksRuntime({
    backend: backend() as never,
    database,
    runtimeSessions: runtimeSessions(commands),
    sessionsRuntime: Promise.reject(new Error('Compatibility runtime is outside this path')) as Promise<CodexSessionsRuntime>,
    taskStore: memoryStore(),
    workspaceBindingStore: {
      list: async () => [{ id: 'execution-842' }],
      readWorkspace: async () => ({
        branch, commit, id: workspaceId, state: 'ready',
        target: { kind: 'project_worktree', reference: 'worktree-842' }
      })
    } as never
  });
  const api = createCodexMachineTasksHttpApi(runtime.service, async () => ({
    reportingTask: { role: 'project-manager', threadId: reportingThreadId }, userId
  }));
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!await api(request, response, url)) response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing integration HTTP address.');
  return {
    commands, database, origin: `http://127.0.0.1:${address.port}`,
    repository: new ProjectSpaceDatabaseRepository(database)
  };
}

function mutation(operationId: string, body: Record<string, unknown>) {
  return {
    body: JSON.stringify({ ...body, operationId }),
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': operationId }, method: 'POST'
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

describe('persisted split-platform Codex ownership integration', () => {
  test('starts and sends through the exact user-owned Host after the scoped backfill', async () => {
    const configured = await configuredHttp();
    const userInventory = await configured.repository.listComputeInventory(userId);
    expect(userInventory.environmentDefinitions).toContainEqual(expect.objectContaining({
      id: 'x', ownership: 'user_defined'
    }));
    const combinedInventory = await configured.repository.listComputeInventory(userId, {
      additionalOwnerUserIds: [deploymentOwnerId]
    });
    expect(combinedInventory.violations).toEqual([]);
    expect(combinedInventory.environments.filter(({ id }) => id === environmentId)).toHaveLength(1);
    const configuredCallStart = configured.database.calls.length;
    const start = await fetch(`${configured.origin}/api/codex/tasks/start`, mutation('split-start-842', {
      expectedBranch: branch, expectedCommit: commit, issue: 842,
      physicalMachineId: hostId, repositoryId: 'DotNaos/project-space'
    }));
    const started = await start.json() as { state: string; task?: { threadId?: string } };
    expect(start.status).toBe(200);
    expect(started).toMatchObject({
      state: 'confirmed',
      task: { physicalMachine: { id: hostId, name: 'os-macbook' } }
    });

    const threadId = started.task?.threadId;
    expect(threadId).toBe(taskThreadId);
    const send = await fetch(
      `${configured.origin}/api/codex/tasks/${threadId}/send`,
      mutation('split-send-842', {
        delivery: 'new-turn', message: 'Continue through the persisted owner boundary.',
        physicalMachineId: hostId
      })
    );
    expect(send.status).toBe(200);
    expect(await send.json()).toMatchObject({
      state: 'accepted', target: { physicalMachine: { id: hostId, name: 'os-macbook' } }
    });
    expect(configured.commands.map(({ kind, environmentId: selectedEnvironment, request }) => ({
      kind, selectedEnvironment, machineId: request.machineId
    }))).toEqual([
      { kind: 'start', selectedEnvironment: environmentId, machineId: expect.any(String) },
      { kind: 'continue', selectedEnvironment: environmentId, machineId: expect.any(String) }
    ]);
    expect(configured.commands[0]?.request.machineId).toBe(configured.commands[1]?.request.machineId);
    expect(configured.database.calls.slice(configuredCallStart)
      .filter(({ sql }) => sql.includes('where owner_user_id = any($1::text[])'))
      .every(({ values }) => values[0] === userId || (Array.isArray(values[0]) && values[0].length === 1 && values[0][0] === userId)))
      .toBe(true);
  });

  test('does not authorize deployment-only same-UUID evidence', async () => {
    const configured = await configuredHttp();
    const response = await fetch(`${configured.origin}/api/codex/tasks/start`, mutation('split-wrong-owner-842', {
      expectedBranch: branch, expectedCommit: commit, issue: 842,
      physicalMachineId: '24000000-0000-4000-8000-000000000099', repositoryId: 'DotNaos/project-space'
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: 'blocked', reason: 'unauthorized' });
    expect(configured.commands).toEqual([]);
  });

  test('does not authorize ambiguous user-owned Host evidence', async () => {
    const configured = await configuredHttp('ambiguous');
    const response = await fetch(`${configured.origin}/api/codex/tasks/start`, mutation('split-ambiguous-842', {
      expectedBranch: branch, expectedCommit: commit, issue: 842,
      physicalMachineId: hostId, repositoryId: 'DotNaos/project-space'
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: 'blocked', reason: 'unauthorized' });
    expect(configured.commands).toEqual([]);
  });

  test.each([
    ['unresolved user built-in', 'unresolved-copy'],
    ['unrelated user built-in', 'unrelated-copy'],
    ['user-defined user Environment', 'user-defined-copy']
  ] as const)('keeps deployment evidence beside an %s', async (_description, mode) => {
    const configured = await configuredHttp(mode);
    const combinedInventory = await configured.repository.listComputeInventory(userId, {
      additionalOwnerUserIds: [deploymentOwnerId]
    });
    const collisionRows = combinedInventory.environments.filter(({ id }) => id === environmentId);

    expect(collisionRows).toHaveLength(2);
    expect(collisionRows.some(({ hostAssociation }) => (
      hostAssociation.resolution === 'unresolved'
    ))).toBe(true);
    if (mode === 'user-defined-copy') {
      expect(collisionRows.some(({ environmentDefinitionId }) => environmentDefinitionId === 'x'))
        .toBe(true);
    }
  });
});
