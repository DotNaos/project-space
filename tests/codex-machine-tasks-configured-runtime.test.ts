import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, test } from 'bun:test';

import {
  createConfiguredCodexMachineTasksRuntime,
  createConfiguredCodexMachineTasksService
} from '../server/codex-machine-tasks/configured-runtime';
import { createCodexMachineTasksHttpApi } from '../server/codex-machine-tasks/http';
import type { WorkspaceRuntimeCodexBridge } from '../server/codex-machine-tasks/workspace-runtime';
import type { ComputeEnvironmentRecord, ComputeInventorySnapshot } from '../src/shared/compute-environment-api';
import type { CodexSessionsRuntime } from '../server/codex-sessions/runtime';
import {
  connector,
  memoryStore,
  request,
  threadId
} from './fixtures/codex-machine-tasks-service';

const configuredWorkspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const configuredEnvironmentId = '11111111-1111-4111-8111-111111111111';
const configuredHostId = '24000000-0000-4000-8000-000000000002';
const configuredBranch = '262-build-codex-machine-task-core-and-cli';
const configuredCommit = 'a'.repeat(40);
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

function configuredInventory(
  hostAssociation: ComputeEnvironmentRecord['hostAssociation'],
  hosts = [{
    id: configuredHostId,
    identity: { key: 'host:canonical-macos', version: 1 },
    name: 'os-macbook',
    platformId: 'platform-local'
  }]
): ComputeInventorySnapshot {
  return {
    connectors: [],
    environmentDefinitions: [],
    environments: [{
      environmentDefinitionId: 'definition-macos',
      hostAssociation,
      id: configuredEnvironmentId,
      identity: { key: 'environment:canonical-macos', version: 1 },
      kind: 'native_macos',
      name: 'macOS Workspace Runtime',
      platformId: 'platform-local',
      resourceMode: 'dedicated'
    }],
    hosts,
    platforms: [{ id: 'platform-local', kind: 'local', name: 'Local & self-hosted' }],
    violations: []
  };
}

function configuredRuntimeSessions() {
  const snapshot = {
    branch: configuredBranch,
    capabilities: ['runtime.codex.v1'],
    codexAcceptedCommandSequence: 0,
    commit: configuredCommit,
    connectionState: 'online',
    devServers: [],
    environmentId: configuredEnvironmentId,
    expiresAt: '2026-08-20T12:00:00.000Z',
    generation: '22222222-2222-4222-8222-222222222222',
    lastEventAt: '2026-08-20T11:59:00.000Z',
    lastHeartbeatAt: '2026-08-20T11:59:00.000Z',
    lastSequence: 1,
    lifecycleState: 'running',
    manifestDigest: 'b'.repeat(64),
    runtimeVersion: '0.4.66',
    schemaVersion: 1,
    sessionId: 'configured-session-1',
    workspaceId: configuredWorkspaceId
  };
  return { list: async () => [snapshot] } as never;
}

async function configuredService(inventory: ComputeInventorySnapshot) {
  const workspaceBindingStore = {
    list: async () => [{ id: 'execution-835' }],
    readWorkspace: async () => ({
      branch: configuredBranch,
      commit: configuredCommit,
      id: configuredWorkspaceId,
      state: 'ready',
      target: { kind: 'project_worktree', reference: 'worktree-835' }
    })
  } as never;
  const backend = {
    async getGitHubCatalog() {
      return {
        checkedAt: '',
        repositories: [{
          defaultBranch: 'main', fullName: 'DotNaos/project-space', id: 42,
          isPrivate: true, name: 'project-space', owner: 'DotNaos',
          projectConfig: { projectYaml: true, status: 'complete' as const, templateLock: true },
          url: 'https://github.com/DotNaos/project-space'
        }],
        status: 'connected' as const
      };
    },
    async getGitHubRepositoryDetails() {
      return {
        branches: [{ commitSha: configuredCommit, isDefault: false, name: configuredBranch }],
        checkedAt: '',
        issues: [{
          labels: [], number: 262, state: 'open' as const,
          title: 'Build Codex machine task core and CLI',
          url: 'https://github.com/DotNaos/project-space/issues/262'
        }],
        pullRequests: [], status: 'connected' as const
      };
    }
  } as never;
  const runtime = await createConfiguredCodexMachineTasksRuntime({
    backend,
    database: { query: async () => { throw new Error('legacy database boundary was used'); } } as never,
    inventory: async () => inventory,
    runtimeSessions: configuredRuntimeSessions(),
    sessionsRuntime: Promise.reject(new Error('compatibility runtime is not part of this path')) as Promise<CodexSessionsRuntime>,
    taskStore: memoryStore(),
    workspaceBindingStore
  });
  return runtime.service;
}

async function configuredHttp(inventory: ComputeInventorySnapshot) {
  const service = await configuredService(inventory);
  const api = createCodexMachineTasksHttpApi(service, async () => ({
    reportingTask: { role: 'project-manager', threadId },
    userId: 'user-owner'
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

function httpMutation(operationId: string) {
  return {
    body: JSON.stringify({
      dryRun: true,
      expectedBranch: configuredBranch,
      expectedCommit: configuredCommit,
      issue: 262,
      operationId,
      physicalMachineId: configuredHostId,
      repositoryId: 'DotNaos/project-space',
      reasoningEffort: 'high',
      model: 'gpt-5.6-luna'
    }),
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': operationId },
    method: 'POST'
  };
}

describe('configured Codex machine-task runtime', () => {
  test('resolves the canonical Host through the configured service without a legacy mapping', async () => {
    const service = await configuredService(configuredInventory({
      evidence: 'smbios', hostId: configuredHostId, resolution: 'verified'
    }));
    const result = await service.start(
      { userId: 'user-owner', reportingTask: { role: 'project-manager', threadId } },
      {
        ...request,
        dryRun: true,
        physicalMachineId: configuredHostId,
        repositoryId: 'DotNaos/project-space',
        worker: { model: 'gpt-5.6-luna', reasoningEffort: 'high' }
      }
    );

    expect(result).toMatchObject({
      state: 'ready',
      target: { physicalMachine: { id: configuredHostId, name: 'os-macbook' } }
    });
  });

  test('fails closed for unresolved, conflicting, missing, and wrong-owner Host evidence', async () => {
    const cases: Array<{
      name: string;
      inventory: ComputeInventorySnapshot;
    }> = [
      {
        name: 'unresolved',
        inventory: configuredInventory({ evidence: 'none', resolution: 'unresolved' })
      },
      {
        name: 'conflict',
        inventory: configuredInventory({ evidence: 'host_broker', expectedHostId: configuredHostId, resolution: 'conflict' })
      },
      {
        name: 'missing host',
        inventory: configuredInventory({ evidence: 'smbios', hostId: configuredHostId, resolution: 'verified' }, [])
      },
      {
        name: 'wrong owner',
        inventory: configuredInventory({ evidence: 'smbios', hostId: '24000000-0000-4000-8000-000000000099', resolution: 'verified' })
      }
    ];
    for (const candidate of cases) {
      const service = await configuredService(candidate.inventory);
      const result = await service.start(
        { userId: 'user-owner', reportingTask: { role: 'project-manager', threadId } },
        {
          ...request,
          dryRun: true,
          operationId: `start-262-${candidate.name.replaceAll(' ', '-')}`,
          physicalMachineId: configuredHostId,
          repositoryId: 'DotNaos/project-space',
          worker: { model: 'gpt-5.6-luna', reasoningEffort: 'high' }
        }
      );
      expect(result).toMatchObject({ reason: 'unauthorized', state: 'blocked' });
    }
  });

  test('selects the exact Host through the configured HTTP route and reports unavailable evidence', async () => {
    const readyOrigin = await configuredHttp(configuredInventory({
      evidence: 'smbios', hostId: configuredHostId, resolution: 'verified'
    }));
    const readyResponse = await fetch(
      `${readyOrigin}/api/codex/tasks/start`,
      httpMutation('configured-http-valid-host')
    );
    const readyBody = await readyResponse.json();

    expect(readyResponse.status).toBe(200);
    expect(readyBody).toMatchObject({
      state: 'ready',
      target: { physicalMachine: { id: configuredHostId, name: 'os-macbook' } }
    });

    const unavailableOrigin = await configuredHttp(configuredInventory({
      evidence: 'none', resolution: 'unresolved'
    }));
    const unavailableResponse = await fetch(
      `${unavailableOrigin}/api/codex/tasks/start`,
      httpMutation('configured-http-missing-host')
    );
    const unavailableBody = await unavailableResponse.json();

    expect(unavailableResponse.status).toBe(200);
    expect(unavailableBody).toMatchObject({
      message: 'Select one exact physical machine.',
      reason: 'unauthorized',
      state: 'blocked'
    });
  });

  test('reconciles an uncertain initial handoff exactly once after a runtime restart', async () => {
    const starts: Array<{ durableOperations: boolean; reconcile: boolean }> = [];
    let readReconciliationCount = 0;
    const bridge = {
      inventory: async () => ({
        computeInventory: {
          connectors: [], environmentDefinitions: [], environments: [], hosts: [],
          platforms: [], violations: []
        },
        connectors: [connector()],
        physicalMachines: [{ connectorIds: ['connector-local'], id: 'physical-local', name: 'Mac' }],
        runtimeStatuses: new Map()
      }),
      generationFor: () => 7,
      durableGenerationFor: () => true,
      issue: undefined,
      plan: async () => ({
        plan: {
          environment: { id: 'environment-local', name: 'Workspace Runtime' },
          workspace: {
            branch: 'issue-262-build-codex-machine-task-core-and-cli',
            commit: 'a'.repeat(40),
            id: 'workspace-local'
          },
          worktree: {
            branch: 'issue-262-build-codex-machine-task-core-and-cli',
            id: 'worktree-local'
          }
        },
        state: 'ready' as const
      }),
      sessions: {} as never,
      start: async (input: { durableOperations: boolean; reconcile: boolean }) => {
        starts.push(input);
        if (!input.reconcile) {
          return { generation: 7, result: { state: 'uncertain' as const } };
        }
        readReconciliationCount += 1;
        return {
          generation: 7,
          result: {
            handoff: { state: 'accepted' as const, turnId: 'turn-reconciled' },
            state: 'confirmed' as const,
            threadId,
            workspace: {
              branch: 'issue-262-build-codex-machine-task-core-and-cli',
              commit: 'a'.repeat(40),
              id: 'workspace-local',
              worktree: { branch: 'issue-262-build-codex-machine-task-core-and-cli', id: 'worktree-local' }
            },
            worktreeId: 'worktree-local'
          }
        };
      }
    } as unknown as WorkspaceRuntimeCodexBridge;
    const tasks = createConfiguredCodexMachineTasksService({
      bridge,
      issue: async () => ({
        branch: 'issue-262-build-codex-machine-task-core-and-cli',
        commit: 'a'.repeat(40),
        issue: { number: 262, url: 'https://github.com/DotNaos/project-space/issues/262' },
        repository: { id: 'R_test', nameWithOwner: 'DotNaos/project-space' }
      }),
      store: memoryStore(),
      taskUrl: (machineId, id) => `https://projects.example/codex/machines/${machineId}/threads/${id}`
    });

    const actor = { userId: 'user-owner', reportingTask: { role: 'project-manager' as const, threadId } };
    const first = await tasks.start(actor, request);
    const second = await tasks.start(actor, request);

    expect(first.state).toBe('uncertain');
    expect(second).toMatchObject({
      state: 'confirmed',
      task: { handoff: { state: 'accepted', turnId: 'turn-reconciled' } }
    });
    expect(starts.map(({ durableOperations, reconcile }) => ({ durableOperations, reconcile }))).toEqual([
      { durableOperations: true, reconcile: false },
      { durableOperations: true, reconcile: true }
    ]);
    expect(readReconciliationCount).toBe(1);
  });
});
