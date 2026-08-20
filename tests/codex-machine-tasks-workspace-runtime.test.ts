import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';

import type { WorkspaceRuntimeCodexCommand, WorkspaceRuntimeCodexMessage } from '../src/shared/workspace-runtime-codex-api';
import type { WorkspaceRuntimeSessionService } from '../server/workspace-runtime-session/service';
import { createWorkspaceRuntimeCodexBridge } from '../server/codex-machine-tasks/workspace-runtime';
import { generationNumber } from '../server/workspace-runtime-codex-host/validation';

const userId = 'user-owner';
const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const environmentId = 'environment-1';
const branch = 'issue-763-dispatch';
const commit = 'a'.repeat(40);
const generationId = '22222222-2222-4222-8222-222222222222';
const connectorId = `workspace-runtime:${createHash('sha256').update([
  workspaceId, environmentId
].join('\0')).digest('hex').slice(0, 32)}`;

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    branch,
    capabilities: ['runtime.codex.v1'],
    codexAcceptedCommandSequence: 0,
    commit,
    connectionState: 'online',
    devServers: [],
    environmentId,
    expiresAt: '2026-08-21T00:00:00.000Z',
    generation: generationId,
    lastEventAt: '2026-08-20T00:00:00.000Z',
    lastHeartbeatAt: '2026-08-20T00:00:00.000Z',
    lastSequence: 1,
    lifecycleState: 'running',
    manifestDigest: 'digest-1',
    presentation: { repository: 'DotNaos/project-space', task: { number: 763 } },
    runtimeVersion: 'runtime-1',
    schemaVersion: 1,
    sessionId: 'session-1',
    workspaceId,
    ...overrides
  } as never;
}

function bridgeFixture(options: { binding?: boolean; online?: boolean } = {}) {
  let listener: ((message: WorkspaceRuntimeCodexMessage) => void) | undefined;
  let dispatched: WorkspaceRuntimeCodexCommand | undefined;
  const current = snapshot({
    ...(options.online === false ? { connectionState: 'offline' } : {})
  });
  const sessions = {
    list: async () => [current],
    onCodexMessage: (next: (message: WorkspaceRuntimeCodexMessage) => void) => {
      listener = next;
      return () => { listener = undefined; };
    },
    dispatchCodex: (_owner: string, command: WorkspaceRuntimeCodexCommand) => {
      dispatched = command;
      queueMicrotask(() => listener?.({
        ...command,
        result: { initialTurnId: 'turn-763', threadId: '019f6d33-6aad-7302-a45e-bb7a33fc399c' },
        type: 'runtime.codex.result'
      } as WorkspaceRuntimeCodexMessage));
    }
  } as unknown as WorkspaceRuntimeSessionService;
  const bridge = createWorkspaceRuntimeCodexBridge({
    loadInventory: async () => ({
      connectors: [], environmentDefinitions: [], environments: [], hosts: [], platforms: [], violations: []
    }),
    sessions,
    ...(options.binding === false ? {} : {
      resolveWorkspaceBinding: async () => ({
        branch,
        commit,
        id: workspaceId,
        worktree: { branch, id: 'worktree-1' }
      })
    })
  });
  return { bridge, get command() { return dispatched; } };
}

const input = {
  branch,
  commit,
  connectorId,
  durableOperations: true,
  generation: generationNumber(generationId),
  issue: { number: 763, url: 'https://github.com/DotNaos/project-space/issues/763' },
  operationId: 'operation-763',
  physicalMachineId: environmentId,
  reconcile: false,
  repository: { id: 'R_project-space', nameWithOwner: 'DotNaos/project-space' },
  reportingTask: { role: 'project-manager' as const, threadId: '019f6d33-6aad-7302-a45e-bb7a33fc399c' },
  worker: { model: 'gpt-5.6-luna', reasoningEffort: 'high' },
  userId
};

describe('Workspace Runtime Codex bridge', () => {
  test('proves Environment/workspace/worktree binding before planning and starting', async () => {
    const fixture = bridgeFixture();
    const plan = await fixture.bridge.plan(input);
    expect(plan).toEqual({
      plan: {
        environment: { id: environmentId, name: 'DotNaos/project-space' },
        workspace: { branch, commit, id: workspaceId },
        worktree: { branch, id: 'worktree-1' }
      },
      state: 'ready'
    });
    const started = await fixture.bridge.start(input);
    expect(started).toEqual({
      generation: fixture.bridge.generationFor(connectorId),
      result: {
        state: 'confirmed',
        handoff: { state: 'accepted', turnId: 'turn-763' },
        threadId: '019f6d33-6aad-7302-a45e-bb7a33fc399c',
        workspace: { branch, commit, id: workspaceId },
        worktreeId: 'worktree-1'
      }
    });
    expect(fixture.command?.request).toMatchObject({
      cwd: '.', machineId: connectorId, operationId: input.operationId,
      handoff: {
        branch, commit, environmentId,
        issue: input.issue, repository: input.repository,
        workspaceId, worktreeId: 'worktree-1'
      }
    });
  });

  test('returns an honest unavailable plan when no Project binding is proven', async () => {
    const fixture = bridgeFixture({ binding: false });
    await expect(fixture.bridge.plan(input)).resolves.toEqual({
      message: 'The Project-managed workspace/worktree binding is unavailable.',
      state: 'unavailable'
    });
    await expect(fixture.bridge.start(input)).resolves.toEqual({
      generation: generationNumber(generationId),
      result: {
        message: 'The Project-managed workspace/worktree binding is unavailable.',
        state: 'worktree_failure'
      }
    });
  });

  test('does not dispatch to an offline or branch-fenced runtime', async () => {
    const offline = bridgeFixture({ online: false });
    await expect(offline.bridge.plan(input)).resolves.toMatchObject({ state: 'unavailable' });
    const fenced = bridgeFixture();
    await expect(fenced.bridge.plan({ ...input, branch: 'other-branch' })).resolves.toMatchObject({ state: 'uncertain' });
    expect(fenced.command).toBeUndefined();
  });
});
