import { describe, expect, test } from 'bun:test';

import { createWorkspaceRuntimeCodexBridge } from '../server/codex-machine-tasks/workspace-runtime';
import { resolveCodexMachineTaskServiceTarget } from '../server/codex-machine-tasks/target-resolver';
import { generationNumber } from '../server/workspace-runtime-codex-host/validation';
import type { WorkspaceRuntimeCodexCommand, WorkspaceRuntimeCodexMessage } from '../src/shared/workspace-runtime-codex-api';
import type { ComputeInventorySnapshot } from '../src/shared/compute-environment-api';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const environmentId = '11111111-1111-4111-8111-111111111111';
const generation = '22222222-2222-4222-8222-222222222222';
const branch = 'issue-763-dispatch';
const commit = 'a'.repeat(40);
const physicalHostId = '24000000-0000-4000-8000-000000000002';

function createBridgeFixture(options: {
  connectionState?: 'online' | 'disconnected';
  inventory?: ComputeInventorySnapshot;
  resolveWorkspaceBinding?: Parameters<typeof createWorkspaceRuntimeCodexBridge>[0]['resolveWorkspaceBinding'];
} = {}) {
  const listeners = new Set<(message: WorkspaceRuntimeCodexMessage) => Promise<void> | void>();
  const commands: WorkspaceRuntimeCodexCommand[] = [];
  let currentSnapshot = {
    branch,
    capabilities: ['runtime.codex.v1'],
    codexAcceptedCommandSequence: 0,
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
    list: async () => [currentSnapshot],
    onCodexMessage(listener: (message: WorkspaceRuntimeCodexMessage) => Promise<void> | void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatchCodex(_userId: string, command: WorkspaceRuntimeCodexCommand) {
      commands.push(command);
      queueMicrotask(() => {
        const message = {
          ...command,
          result: { initialTurnId: 'turn-763', machineId: command.request.machineId, threadId: '019f6d33-6aad-7302-a45e-bb7a33fc399c' },
          type: 'runtime.codex.result'
        } as unknown as WorkspaceRuntimeCodexMessage;
        for (const listener of listeners) void listener(message);
      });
    }
  } as never;
  const bridge = createWorkspaceRuntimeCodexBridge({
    loadInventory: async () => options.inventory ?? emptyInventory(),
    resolveWorkspaceBinding: options.resolveWorkspaceBinding,
    sessions
  });
  return {
    bridge,
    commands,
    replaceSnapshot(overrides: Record<string, unknown>) {
      currentSnapshot = { ...currentSnapshot, ...overrides } as typeof currentSnapshot;
    }
  };
}

function emptyInventory(): ComputeInventorySnapshot {
  return { connectors: [], environmentDefinitions: [], environments: [], hosts: [], platforms: [], violations: [] };
}

function canonicalInventory(overrides: Partial<ComputeInventorySnapshot> = {}): ComputeInventorySnapshot {
  return {
    ...emptyInventory(),
    environments: [{
      environmentDefinitionId: 'definition-macos',
      hostAssociation: { evidence: 'smbios', hostId: physicalHostId, resolution: 'verified' },
      id: environmentId,
      identity: { key: 'environment:macos', version: 1 },
      kind: 'native_macos',
      name: 'macOS Workspace Runtime',
      platformId: 'platform-local',
      resourceMode: 'dedicated'
    }],
    hosts: [{
      id: physicalHostId,
      identity: { key: 'host:macos', version: 1 },
      name: 'os-macbook',
      platformId: 'platform-local'
    }],
    platforms: [{ id: 'platform-local', kind: 'local', name: 'Local & self-hosted' }],
    ...overrides
  };
}

const input = {
  branch,
  commit,
  connectorId: '',
  durableOperations: true,
  generation: generationNumber(generation),
  issue: { number: 763, url: 'https://github.com/DotNaos/project-space/issues/763' },
  operationId: 'start-763-runtime',
  physicalMachineId: environmentId,
  reconcile: false,
  repository: { id: 'DotNaos/project-space', nameWithOwner: 'DotNaos/project-space' },
  reportingTask: { role: 'project-manager' as const, threadId: '019f6d33-6aad-7302-a45e-bb7a33fc399c' },
  worker: { model: 'gpt-5.6-luna', reasoningEffort: 'high' },
  userId: 'user-owner'
};

describe('Workspace Runtime Codex bridge', () => {
  test('resolves the catalog physical Host through the configured runtime inventory path', async () => {
    const fixture = createBridgeFixture({ inventory: canonicalInventory() });
    const inventory = await fixture.bridge.inventory('user-owner');
    const connectorId = inventory.connectors[0]!.id;

    const target = await resolveCodexMachineTaskServiceTarget(
      { generationFor: fixture.bridge.generationFor, inventory: fixture.bridge.inventory },
      'user-owner',
      { physicalMachineId: physicalHostId }
    );

    expect(inventory.physicalMachines).toEqual([{
      connectorIds: [connectorId], id: physicalHostId, name: 'os-macbook'
    }]);
    expect(target).toMatchObject({
      connector: { id: connectorId, generation: generationNumber(generation) },
      physicalMachine: { id: physicalHostId, name: 'os-macbook' }
    });
  });

  test('fails closed when the canonical Environment Host evidence is missing or ambiguous', async () => {
    const missing = createBridgeFixture({ inventory: canonicalInventory({ hosts: [] }) });
    await expect(resolveCodexMachineTaskServiceTarget(
      { generationFor: missing.bridge.generationFor, inventory: missing.bridge.inventory },
      'user-owner',
      { physicalMachineId: physicalHostId }
    )).rejects.toThrow('Select one exact physical machine.');

    const ambiguous = createBridgeFixture({ inventory: canonicalInventory({
      environments: [{
        ...canonicalInventory().environments[0]!,
        hostAssociation: { evidence: 'host_broker', expectedHostId: physicalHostId, resolution: 'conflict' }
      }]
    }) });
    await expect(resolveCodexMachineTaskServiceTarget(
      { generationFor: ambiguous.bridge.generationFor, inventory: ambiguous.bridge.inventory },
      'user-owner',
      { physicalMachineId: physicalHostId }
    )).rejects.toThrow('Select one exact physical machine.');
  });

  test('returns a read-only workspace plan and preserves exact revision fencing', async () => {
    const { bridge } = createBridgeFixture({
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
    const { bridge, commands } = createBridgeFixture({
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
        handoff: { state: 'accepted', turnId: 'turn-763' },
        threadId: '019f6d33-6aad-7302-a45e-bb7a33fc399c',
        workspace: { id: workspaceId },
        worktreeId: 'worktree-763'
      }
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ environmentId, operationId: input.operationId, workspaceId });
  });

  test('fails closed before dispatch when the managed worktree binding is unavailable', async () => {
    const { bridge, commands } = createBridgeFixture();
    const connectorId = (await bridge.inventory('user-owner')).connectors[0]!.id;
    const started = await bridge.start({ ...input, connectorId });
    expect(started).toMatchObject({ result: { state: 'worktree_failure' } });
    expect(commands).toHaveLength(0);
  });

  test('reports an unavailable runtime without inventing a workspace identity', async () => {
    const { bridge } = createBridgeFixture({
      connectionState: 'disconnected',
      resolveWorkspaceBinding: async () => ({ branch, commit, id: workspaceId })
    });
    const connectorId = (await bridge.inventory('user-owner')).connectors[0]!.id;
    const started = await bridge.start({ ...input, connectorId });
    expect(started.result.state).toBe('offline');
  });

  test('restarts from the authoritative host watermark with a stable runtime identity', async () => {
    const fixture = createBridgeFixture({
      resolveWorkspaceBinding: async () => ({
        branch, commit, id: workspaceId,
        worktree: { branch, id: 'worktree-763' }
      })
    });
    const connectorId = (await fixture.bridge.inventory('user-owner')).connectors[0]!.id;
    expect(fixture.bridge.durableGenerationFor(connectorId, generationNumber(generation))).toBeTrue();
    await fixture.bridge.start({ ...input, connectorId });
    fixture.replaceSnapshot({
      codexAcceptedCommandSequence: 0,
      generation: '33333333-3333-4333-8333-333333333333',
      sessionId: 'session-reconnected'
    });
    const replacement = (await fixture.bridge.inventory('user-owner')).connectors[0]!.id;
    expect(replacement).toBe(connectorId);
    expect(fixture.bridge.durableGenerationFor(
      replacement,
      generationNumber('33333333-3333-4333-8333-333333333333')
    )).toBeTrue();
    expect(fixture.bridge.durableGenerationFor(replacement, generationNumber(generation))).toBeFalse();
    await fixture.bridge.start({
      ...input,
      connectorId: replacement,
      generation: generationNumber('33333333-3333-4333-8333-333333333333'),
      operationId: 'start-763-reconnect'
    });
    expect(fixture.commands.map((command) => command.commandSequence)).toEqual([1, 1]);
  });

  test('does not claim durable retries without host resume evidence', async () => {
    const fixture = createBridgeFixture();
    const connectorId = (await fixture.bridge.inventory('user-owner')).connectors[0]!.id;
    fixture.replaceSnapshot({ codexAcceptedCommandSequence: undefined });
    await fixture.bridge.inventory('user-owner');
    expect(fixture.bridge.durableGenerationFor(connectorId, generationNumber(generation))).toBeFalse();
  });

  test('fences an unresolved old-generation reservation before dispatch', async () => {
    const fixture = createBridgeFixture({
      resolveWorkspaceBinding: async () => ({
        branch, commit, id: workspaceId,
        worktree: { branch, id: 'worktree-763' }
      })
    });
    const connectorId = (await fixture.bridge.inventory('user-owner')).connectors[0]!.id;
    fixture.replaceSnapshot({ generation: '33333333-3333-4333-8333-333333333333' });
    const result = await fixture.bridge.start({ ...input, connectorId, reconcile: true });
    expect(result.result).toEqual({ state: 'uncertain' });
    expect(fixture.commands).toHaveLength(0);
  });
});
