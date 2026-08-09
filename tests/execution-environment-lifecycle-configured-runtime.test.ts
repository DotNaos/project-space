import { describe, expect, test } from 'bun:test';

import {
  createConfiguredExecutionEnvironmentLifecycle
} from '../server/execution-environment-lifecycle/configured-runtime';
import {
  MemoryEnvironmentLifecycleStore,
  type EnvironmentLifecycleState
} from '../server/execution-environment-lifecycle/store';
import type { DatabaseQueryClient } from '../server/database/client';
import type { GitHubCodespaceRunnerRequest } from '../src/shared/github-codespace-runner-api';

function backend(linked = true) {
  return {
    async getConnectorOverview() {
      return { machines: [], physicalMachines: [] } as never;
    },
    async getGitHubCatalog() {
      return {
        repositories: [{ fullName: 'DotNaos/project-space', id: 480 }],
        status: 'connected'
      } as never;
    },
    async getGitHubRepositoryDetails() {
      return {
        branches: [{
          linkedIssueNumbers: linked ? [536] : [],
          name: 'issue-536-lifecycle'
        }],
        issues: [{ number: 536, state: 'open' }],
        status: 'connected'
      } as never;
    }
  };
}

const environmentId = '019f6d33-6aad-7302-a45e-bb7a33fc399c';

async function guardFixture(input: {
  cachedState: EnvironmentLifecycleState;
  connectorIds?: string[];
  inventoryState?: 'live' | 'offline' | 'partial';
  providerState?: EnvironmentLifecycleState;
  sessions?: Array<{ archived: boolean; status: string }>;
  unresolved?: boolean;
  violations?: Array<{ code: string; message: string; subject: string }>;
}) {
  const store = new MemoryEnvironmentLifecycleStore();
  await store.saveBinding({
    branch: 'issue-536-lifecycle',
    environmentId,
    id: '019f6d33-6aad-7302-a45e-bb7a33fc3000',
    lifecycleState: input.cachedState,
    nativeState: input.cachedState === 'stopped' ? 'Shutdown' : undefined,
    observedAt: '2020-01-01T00:00:00.000Z',
    providerKind: 'github_codespaces',
    providerResourceId: 'project-space-536',
    repositoryFullName: 'DotNaos/project-space',
    task: 536,
    userId: 'user-one'
  });
  let githubCalls = 0;
  let runtimeCalls = 0;
  const connectorIds = input.connectorIds ?? [];
  const lifecycle = await createConfiguredExecutionEnvironmentLifecycle({
    backend: backend(),
    createCodexRuntime: async () => {
      runtimeCalls += 1;
      return {
        sessions: {
          service: {
            async list() {
              return {
                inventoryState: input.inventoryState ?? 'live',
                sessions: input.sessions ?? []
              };
            }
          }
        }
      } as never;
    },
    database: {
      async query() {
        return { rows: [{ blocked: input.unresolved ?? false }] };
      }
    } as DatabaseQueryClient,
    githubCodespaceRunnerRuntime: {
      async run(request) {
        githubCalls += 1;
        const providerState = input.providerState ?? input.cachedState;
        if (request.action === 'delete') {
          return {
            apiVersion: 1,
            message: 'deleted',
            operationId: request.operationId,
            state: 'not-created'
          };
        }
        const stopped = request.action === 'stop' || providerState !== 'running';
        return {
          apiVersion: 1,
          codespace: {
            name: 'project-space-536',
            state: stopped ? 'Shutdown' : 'Available'
          },
          environmentId,
          message: stopped ? 'stopped' : providerState,
          operationId: request.operationId,
          state: stopped ? 'offline' : 'ready'
        };
      }
    },
    loadComputeInventory: async () => ({
      checkedAt: '2026-08-09T10:01:00.000Z',
      connectors: [],
      generations: new Map(),
      snapshot: {
        connectors: connectorIds.map((connectorId) => ({
          associatedAt: '2026-08-09T10:00:00.000Z',
          connectorId,
          environmentId
        })),
        environments: [],
        hosts: [],
        platforms: [],
        violations: input.violations ?? []
      }
    }),
    store
  });
  return {
    githubCalls: () => githubCalls,
    lifecycle,
    runtimeCalls: () => runtimeCalls
  };
}

describe('configured execution Environment lifecycle', () => {
  test('authorizes the exact open task branch and calls the shared Codespaces runtime', async () => {
    const requests: GitHubCodespaceRunnerRequest[] = [];
    const lifecycle = await createConfiguredExecutionEnvironmentLifecycle({
      backend: backend(),
      createCodexRuntime: async () => { throw new Error('not needed'); },
      executionGuard: { async check() { return { state: 'safe' }; } },
      githubCodespaceRunnerRuntime: {
        async run(request) {
          requests.push(request);
          return {
            apiVersion: 1,
            codespace: { name: 'project-space-536', state: 'Available' },
            environmentId: '019f6d33-6aad-7302-a45e-bb7a33fc399c',
            message: 'ready',
            operationId: request.operationId,
            state: 'ready'
          };
        }
      },
      store: new MemoryEnvironmentLifecycleStore()
    });

    const result = await lifecycle.provision({ userId: 'user-one' }, {
      branch: 'issue-536-lifecycle',
      operationId: 'lifecycle:provision:536',
      provider: 'github_codespaces',
      repositoryId: '480',
      task: 536
    });

    expect(requests).toEqual([{
      action: 'provision',
      branch: 'issue-536-lifecycle',
      issue: 536,
      operationId: 'lifecycle:provision:536',
      repositoryFullName: 'DotNaos/project-space'
    }]);
    expect(result).toMatchObject({
      environment: { id: '019f6d33-6aad-7302-a45e-bb7a33fc399c' },
      lifecycle: { nativeState: 'Available', normalized: 'running' }
    });
  });

  test('does not call GitHub for an unlinked branch', async () => {
    let calls = 0;
    const lifecycle = await createConfiguredExecutionEnvironmentLifecycle({
      backend: backend(false),
      createCodexRuntime: async () => { throw new Error('not needed'); },
      executionGuard: { async check() { return { state: 'safe' }; } },
      githubCodespaceRunnerRuntime: {
        async run() {
          calls += 1;
          throw new Error('must not run');
        }
      },
      store: new MemoryEnvironmentLifecycleStore()
    });

    const result = await lifecycle.provision({ userId: 'user-one' }, {
      branch: 'issue-536-lifecycle',
      operationId: 'lifecycle:provision:536',
      provider: 'github_codespaces',
      repositoryId: '480',
      task: 536
    });

    expect(calls).toBe(0);
    expect(result.blocked?.reason).toBe('not_authorized');
  });

  test.each(['stopped', 'missing', 'deleted'] as const)(
    'does not trust cached %s state when the provider reports it running',
    async (cachedState) => {
      const fixture = await guardFixture({ cachedState, providerState: 'running' });
      const result = await fixture.lifecycle.stop({ userId: 'user-one' }, {
        environmentId,
        operationId: `lifecycle:stop:${cachedState}`
      });

      expect(result.blocked?.reason).toBe('execution_state_uncertain');
      expect(fixture.githubCalls()).toBe(1);
      expect(fixture.runtimeCalls()).toBe(0);
    }
  );

  test('deletes a freshly confirmed stopped Codespace while its connector is offline', async () => {
    const fixture = await guardFixture({
      cachedState: 'stopped',
      connectorIds: ['connector-codespace-536'],
      inventoryState: 'offline'
    });
    const result = await fixture.lifecycle.delete({ userId: 'user-one' }, {
      environmentId,
      operationId: 'lifecycle:delete:offline'
    });

    expect(result).toMatchObject({
      lifecycle: { normalized: 'deleted' },
      reconciliation: { state: 'confirmed' }
    });
    expect(fixture.githubCalls()).toBe(2);
    expect(fixture.runtimeCalls()).toBe(0);
  });

  test('fails closed before runtime inspection when inventory has conflicts', async () => {
    const fixture = await guardFixture({
      cachedState: 'stopped',
      connectorIds: ['connector-codespace-536'],
      violations: [{ code: 'duplicate', message: 'conflict', subject: environmentId }]
    });
    const result = await fixture.lifecycle.stop({ userId: 'user-one' }, {
      environmentId,
      operationId: 'lifecycle:stop:conflict'
    });

    expect(result.blocked?.reason).toBe('execution_state_uncertain');
    expect(fixture.githubCalls()).toBe(1);
    expect(fixture.runtimeCalls()).toBe(0);
  });

  test('allows the provider mutation only after live execution evidence is safe', async () => {
    const fixture = await guardFixture({
      cachedState: 'running',
      connectorIds: ['connector-codespace-536'],
      inventoryState: 'live',
      sessions: []
    });
    const result = await fixture.lifecycle.stop({ userId: 'user-one' }, {
      environmentId,
      operationId: 'lifecycle:stop:live-safe'
    });

    expect(result).toMatchObject({
      lifecycle: { normalized: 'stopped' },
      reconciliation: { state: 'confirmed' }
    });
    expect(fixture.githubCalls()).toBe(2);
    expect(fixture.runtimeCalls()).toBe(1);
  });
});
