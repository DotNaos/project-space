import { describe, expect, test } from 'bun:test';

import {
  createConfiguredCodexMachineTasksRuntime
} from '../server/codex-machine-tasks/configured-runtime';
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
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const environmentId = '11111111-1111-4111-8111-111111111111';
const hostId = '24000000-0000-4000-8000-000000000002';
const deploymentOnlyHostId = '24000000-0000-4000-8000-000000000099';
const branch = '262-build-codex-machine-task-core-and-cli';
const commit = 'a'.repeat(40);
const generation = '22222222-2222-4222-8222-222222222222';
const startThreadId = '019f6d33-6aad-7302-a45e-bb7a33fc399c';
const reportingThreadId = '019f6d33-6aad-7302-a45e-bb7a33fc399d';

function environment(hostAssociation: ComputeEnvironmentRecord['hostAssociation']): ComputeEnvironmentRecord {
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

function inventory(options: {
  association?: ComputeEnvironmentRecord['hostAssociation'];
  hosts?: ComputeInventorySnapshot['hosts'];
} = {}): ComputeInventorySnapshot {
  return {
    connectors: [],
    environmentDefinitions: [],
    environments: [options.association ? environment(options.association) : environment({
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
    branch,
    capabilities: ['runtime.codex.v1'],
    codexAcceptedCommandSequence: 0,
    commit,
    connectionState: 'online',
    devServers: [],
    environmentId,
    expiresAt: '2026-08-20T12:00:00.000Z',
    generation,
    lastEventAt: '2026-08-20T11:59:00.000Z',
    lastHeartbeatAt: '2026-08-20T11:59:00.000Z',
    lastSequence: 1,
    lifecycleState: 'running',
    manifestDigest: 'b'.repeat(64),
    runtimeVersion: '0.4.66',
    schemaVersion: 1,
    sessionId: 'configured-session-842',
    workspaceId
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
        ? { initialTurnId: 'turn-initial-842', machineId: command.request.machineId, threadId: startThreadId }
        : {
            operationId: command.request.operationId,
            replayed: false,
            status: 'accepted' as const,
            threadId: command.request.threadId,
            turnId: 'turn-send-842'
          };
      queueMicrotask(() => {
        const message = {
          ...command,
          result,
          type: 'runtime.codex.result'
        } as unknown as WorkspaceRuntimeCodexMessage;
        for (const listener of listeners) void listener(message);
      });
    }
  } as unknown as WorkspaceRuntimeSessionService;
}

function backend() {
  return {
    async createGitHubBranch() {
      throw new Error('The configured test must not create a branch.');
    },
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
        branches: [{ commitSha: commit, isDefault: false, name: branch }],
        checkedAt: '',
        issues: [{
          labels: [], number: 262, state: 'open' as const,
          title: 'Build Codex machine task core and CLI',
          url: 'https://github.com/DotNaos/project-space/issues/262'
        }],
        pullRequests: [], status: 'connected' as const
      };
    }
  } as Pick<ProjectSpaceBackend, 'createGitHubBranch' | 'getGitHubCatalog' | 'getGitHubRepositoryDetails'>;
}

async function configuredRuntime(computeInventory: ComputeInventorySnapshot, commands: WorkspaceRuntimeCodexCommand[]) {
  return createConfiguredCodexMachineTasksRuntime({
    backend: backend() as never,
    database: { query: async () => { throw new Error('legacy database boundary was used'); } } as never,
    inventory: async () => computeInventory,
    runtimeSessions: runtimeSessions(commands),
    sessionsRuntime: Promise.reject(new Error('compatibility runtime is not part of this path')) as Promise<CodexSessionsRuntime>,
    taskStore: memoryStore(),
    workspaceBindingStore: {
      list: async () => [{ id: 'execution-842' }],
      readWorkspace: async () => ({
        branch,
        commit,
        id: workspaceId,
        state: 'ready',
        target: { kind: 'project_worktree', reference: 'worktree-842' }
      })
    } as never
  });
}

function startRequest(operationId: string, physicalMachineId: string) {
  return {
    expectedBranch: branch,
    expectedCommit: commit,
    issue: 262,
    operationId,
    physicalMachineId,
    repositoryId: 'DotNaos/project-space',
    worker: { model: 'gpt-5.6-luna', reasoningEffort: 'high' }
  };
}

describe('configured Codex start and send ownership boundary', () => {
  test('starts and sends through the exact user-owned Host and Environment', async () => {
    const commands: WorkspaceRuntimeCodexCommand[] = [];
    const runtime = await configuredRuntime(inventory(), commands);
    const actor = {
      reportingTask: { role: 'project-manager' as const, threadId: reportingThreadId },
      userId
    };

    const started = await runtime.service.start(actor, startRequest('start-842-valid', hostId));
    expect(started).toMatchObject({
      state: 'confirmed',
      task: {
        physicalMachine: { id: hostId, name: 'os-macbook' }
      }
    });

    const sent = await runtime.service.send({ userId }, {
      delivery: 'new-turn',
      message: 'Continue on the verified workspace.',
      operationId: 'send-842-valid',
      physicalMachineId: hostId,
      threadId: started.state === 'confirmed' ? started.task.threadId : startThreadId
    });
    expect(sent).toMatchObject({
      state: 'accepted',
      target: {
        physicalMachine: { id: hostId, name: 'os-macbook' }
      }
    });
    expect(commands.map(({ kind }) => kind)).toEqual(['start', 'continue']);
    expect(commands).toEqual([
      expect.objectContaining({
        environmentId,
        kind: 'start',
        request: expect.objectContaining({ machineId: expect.any(String) })
      }),
      expect.objectContaining({
        environmentId,
        kind: 'continue',
        request: expect.objectContaining({ machineId: commands[0]?.request.machineId })
      })
    ]);
    expect(commands[0]?.request.machineId).toBe(commands[1]?.request.machineId);
  });

  test('fails closed when only deployment-owned or duplicate same-UUID Host evidence remains', async () => {
    const cases = [
      {
        name: 'deployment-only evidence',
        computeInventory: inventory({
          association: { evidence: 'smbios', hostId: deploymentOnlyHostId, resolution: 'verified' }
        })
      },
      {
        name: 'same UUID in user and deployment scopes',
        computeInventory: inventory({
          hosts: [
            {
              id: hostId,
              identity: { key: 'host:user-owner', version: 1 },
              name: 'user-host',
              platformId: 'platform-local'
            },
            {
              id: hostId,
              identity: { key: 'host:deployment-only', version: 1 },
              name: 'deployment-host',
              platformId: 'platform-local'
            }
          ]
        })
      }
    ];

    for (const [index, candidate] of cases.entries()) {
      const commands: WorkspaceRuntimeCodexCommand[] = [];
      const runtime = await configuredRuntime(candidate.computeInventory, commands);
      const result = await runtime.service.start(
        { reportingTask: { role: 'project-manager', threadId: reportingThreadId }, userId },
        startRequest(`start-842-invalid-${index}`, hostId)
      );
      expect(result, candidate.name).toMatchObject({
        reason: 'unauthorized',
        state: 'blocked'
      });
      expect(commands, candidate.name).toEqual([]);
    }
  });
});
