import { describe, expect, test } from 'bun:test';

import { createWorkspaceRuntimeCodexBridge } from '../server/codex-machine-tasks/workspace-runtime';
import type { WorkspaceRuntimeCodexCommand, WorkspaceRuntimeCodexMessage } from '../src/shared/workspace-runtime-codex-api';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const environmentId = '11111111-1111-4111-8111-111111111111';
const generation = '22222222-2222-4222-8222-222222222222';
const branch = 'issue-763-dispatch';
const commit = 'a'.repeat(40);

function fixture(options: {
  connectionState?: 'online' | 'disconnected';
  resolveWorkspaceBinding?: Parameters<typeof createWorkspaceRuntimeCodexBridge>[0]['resolveWorkspaceBinding'];
} = {}) {
  const listeners = new Set<(message: WorkspaceRuntimeCodexMessage) => Promise<void> | void>();
  const commands: WorkspaceRuntimeCodexCommand[] = [];
  const snapshot = {
    branch,
    capabilities: ['runtime.codex.v1'],
    commit,
    connectionState: options.connectionState ?? 'online',
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
    sessionId: 'session-1',
    workspaceId
  } as const;
  const sessions = {
    list: async () => [snapshot],
    onCodexMessage(listener: (message: WorkspaceRuntimeCodexMessage) => Promise<void> | void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatchCodex(_userId: string, command: WorkspaceRuntimeCodexCommand) {
      commands.push(command);
      queueMicrotask(() => {
        const message = {
          ...command,
          result: { machineId: command.request.machineId, threadId: '019f6d33-6aad-7302-a45e-bb7a33fc399c' },
          type: 'runtime.codex.result'
        } as unknown as WorkspaceRuntimeCodexMessage;
        for (const listener of listeners) void listener(message);
      });
    }
  } as never;
  const bridge = createWorkspaceRuntimeCodexBridge({
    loadInventory: async () => ({
      connectors: [], environmentDefinitions: [], environments: [], hosts: [], platforms: [], violations: []
    } as never),
    resolveWorkspaceBinding: options.resolveWorkspaceBinding,
    sessions
  });
  return { bridge, commands };
}

const input = {
  branch,
  commit,
  connectorId: '',
  generation: 1,
  issue: { number: 763, url: 'https://github.com/DotNaos/project-space/issues/763' },
  operationId: 'start-763-runtime',
  physicalMachineId: environmentId,
  repository: { id: 'DotNaos/project-space', nameWithOwner: 'DotNaos/project-space' },
  userId: 'user-owner'
};

describe('Workspace Runtime Codex bridge', () => {
  test('returns a read-only workspace plan and preserves exact revision fencing', async () => {
    const { bridge } = fixture({
      resolveWorkspaceBinding: async () => ({ branch, commit, id: workspaceId })
    });
    const inventory = await bridge.inventory('user-owner');
    const connectorId = inventory.connectors[0]!.id;
    const planned = await bridge.plan({ ...input, connectorId });
    expect(planned).toMatchObject({
      state: 'ready',
      plan: {
        environment: { id: environmentId },
        workspace: { branch, id: workspaceId }
      }
    });
    const mismatch = await bridge.plan({ ...input, connectorId, branch: 'other-branch' });
    expect(mismatch).toEqual(expect.objectContaining({ state: 'uncertain' }));
  });

  test('correlates the start response and returns only an authoritative worktree binding', async () => {
    const { bridge, commands } = fixture({
      resolveWorkspaceBinding: async () => ({
        branch,
        commit,
        id: workspaceId,
        worktree: { branch, id: 'worktree-763' }
      })
    });
    const connectorId = (await bridge.inventory('user-owner')).connectors[0]!.id;
    const started = await bridge.start({ ...input, connectorId });
    expect(started).toMatchObject({
      result: {
        state: 'confirmed',
        threadId: '019f6d33-6aad-7302-a45e-bb7a33fc399c',
        workspace: { id: workspaceId },
        worktreeId: 'worktree-763'
      }
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ environmentId, operationId: input.operationId, workspaceId });
  });

  test('fails closed before dispatch when the managed worktree binding is unavailable', async () => {
    const { bridge, commands } = fixture();
    const connectorId = (await bridge.inventory('user-owner')).connectors[0]!.id;
    const started = await bridge.start({ ...input, connectorId });
    expect(started).toMatchObject({ result: { state: 'worktree_failure' } });
    expect(commands).toHaveLength(0);
  });

  test('reports an unavailable runtime without inventing a workspace identity', async () => {
    const { bridge } = fixture({
      connectionState: 'disconnected',
      resolveWorkspaceBinding: async () => ({ branch, commit, id: workspaceId })
    });
    const connectorId = (await bridge.inventory('user-owner')).connectors[0]!.id;
    const started = await bridge.start({ ...input, connectorId });
    expect(started.result.state).toBe('offline');
  });
});
