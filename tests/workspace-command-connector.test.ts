import { describe, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  registerLocalWorkspaceCommandExecutor,
  requestConnectorWorkspaceCommand
} from '../server/connector-command-hub';
import {
  isConnectorHubMessage,
  isConnectorMachineMessage
} from '../server/connector-command-protocol';
import type {
  WorkspaceSandboxExecution,
  WorkspaceSandboxRequest
} from '../server/workspace-command/sandbox-runner';
import { startWorkspaceSandbox } from '../server/workspace-command/sandbox-runner';
import { createLocalWorkspaceCommandAdapter } from '../server/workspace-command/local-adapter';
import { WorkspaceCommandConnectorExecutor } from '../server/workspace-command/connector-executor';
import { createWorkspaceCommandWireRequest } from '../server/workspace-command/connector-routing';
import type { WorkspaceCommandConnectorRequest } from '../server/workspace-command/connector-contract';

const ids = {
  command: '11111111-1111-4111-8111-111111111111',
  environment: '22222222-2222-4222-8222-222222222222',
  execution: '33333333-3333-4333-8333-333333333333',
  workspace: '44444444-4444-4444-8444-444444444444'
};

function request(operation: WorkspaceCommandConnectorRequest['operation'], command = 'printf ok') {
  return {
    allowNetwork: false,
    ...(operation === 'start' ? { command } : {}),
    commandId: ids.command,
    commandSha256: createHash('sha256').update(command).digest('hex'),
    environmentId: ids.environment,
    executionId: ids.execution,
    expectedHeadSha: 'a'.repeat(40),
    machineId: 'connector-1',
    maxOutputBytes: 4_096,
    operation,
    projectId: 'github:480',
    repositoryWritable: false,
    timeoutSeconds: 30,
    workspaceId: ids.workspace,
    workspaceWritable: false,
    worktreeId: 'wt_aaaaaaaaaaaaaaaaaaaaaaaa'
  } satisfies WorkspaceCommandConnectorRequest;
}

describe('workspace command connector boundary', () => {
  test('binds every target and rejects a replayed signed grant', async () => {
    const pair = generateKeyPairSync('ed25519');
    const adapter = {
      async execute(input: Parameters<ReturnType<typeof createLocalWorkspaceCommandAdapter>['execute']>[0]) {
        return {
          checkedAt: new Date().toISOString(), commandId: input.commandId,
          environmentId: input.environmentId, executionId: input.executionId,
          generation: input.actor.generation, machineId: input.machineId,
          operation: input.operation, state: 'completed' as const, stderr: '', stdout: 'ok',
          truncated: false, workspaceId: input.workspaceId
        };
      }
    };
    const executor = new WorkspaceCommandConnectorExecutor(adapter, pair.publicKey, 'connector-1');
    const trusted = request('start');
    const wire = createWorkspaceCommandWireRequest(
      'start', trusted, { generation: 7, userId: 'user-1' }, pair.privateKey,
      { nonce: 'abcdefghijklmnopqrstuvwx', now: Date.now() }
    );
    expect((await executor.execute('start', wire)).stdout).toBe('ok');
    expect(isConnectorMachineMessage({
      id: 'workspace-wire-1', payload: wire, type: 'workspace.command'
    })).toBe(true);
    await expect(executor.execute('start', wire)).rejects.toThrow('replayed');
    await expect(executor.execute('start', {
      ...wire, workspaceId: '55555555-5555-4555-8555-555555555555'
    })).rejects.toThrow('invalid workspace command');

    executor.setExpectedGeneration(8);
    const stale = createWorkspaceCommandWireRequest(
      'start', { ...trusted, commandId: '55555555-5555-4555-8555-555555555555' },
      { generation: 7, userId: 'user-1' }, pair.privateKey,
      { nonce: 'zyxwvutsrqponmlkjihgfedc', now: Date.now() }
    );
    await expect(executor.execute('start', stale)).rejects.toThrow('stale connector generation');
    expect(isConnectorHubMessage({
      id: 'workspace-result-1',
      payload: {
        checkedAt: new Date().toISOString(), commandId: trusted.commandId,
        environmentId: trusted.environmentId, executionId: trusted.executionId,
        generation: 7, machineId: trusted.machineId, operation: 'start', state: 'completed',
        stderr: '', stdout: 'ok', truncated: false, workspaceId: trusted.workspaceId
      },
      type: 'workspace.command.result'
    })).toBe(true);
  });

  test('resolves the opaque worktree and never accepts a caller path', async () => {
    let sandboxInput: WorkspaceSandboxRequest | undefined;
    const completion = Promise.resolve({
      exitCode: 0, finishedAt: new Date().toISOString(), startedAt: new Date().toISOString(),
      state: 'completed' as const, stderr: '', stdout: 'safe', truncated: false
    });
    const adapter = createLocalWorkspaceCommandAdapter({
      resolveProjectPath: async (machineId, projectId) => {
        expect([machineId, projectId]).toEqual(['connector-1', 'github:480']);
        return '/private/project';
      },
      resolveWorktree: async (path, worktreeId, options) => {
        expect([path, worktreeId, options.expectedHeadSha]).toEqual([
          '/private/project', 'wt_aaaaaaaaaaaaaaaaaaaaaaaa', 'a'.repeat(40)
        ]);
        return { path: '/private/exact-worktree' } as never;
      },
      startSandbox: async (input) => {
        sandboxInput = input;
        return { cancel() {}, completion } satisfies WorkspaceSandboxExecution;
      }
    });
    const started = await adapter.execute({
      ...request('start'), actor: { generation: 7, userId: 'user-1' }
    });
    expect(started.state).toBe('running');
    expect(sandboxInput!).toMatchObject({
      allowNetwork: false, repositoryWritable: false,
      workspacePath: '/private/exact-worktree', workspaceWritable: false
    });
    await completion;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const status = await adapter.execute({
      ...request('status'), actor: { generation: 7, userId: 'user-1' }
    });
    expect(status).toMatchObject({ state: 'completed', stdout: 'safe' });
    await expect(adapter.execute({
      ...request('status'), allowNetwork: true,
      actor: { generation: 7, userId: 'user-1' }
    })).rejects.toThrow('identity changed');
  });

  test('routes the public hub boundary through an exact registered local executor', async () => {
    const adapter = {
      async execute(input: Parameters<ReturnType<typeof createLocalWorkspaceCommandAdapter>['execute']>[0]) {
        return {
          checkedAt: new Date().toISOString(), commandId: input.commandId,
          environmentId: input.environmentId, executionId: input.executionId,
          generation: input.actor.generation, machineId: input.machineId,
          operation: input.operation, state: 'completed' as const, stderr: '', stdout: 'local',
          truncated: false, workspaceId: input.workspaceId
        };
      }
    };
    const dispose = registerLocalWorkspaceCommandExecutor('connector-1', adapter);
    try {
      expect(await requestConnectorWorkspaceCommand(
        'start', request('start'), { generation: 7, userId: 'user-1' }
      )).toMatchObject({ state: 'completed', stdout: 'local' });
    } finally {
      dispose();
    }
  });

  test.skipIf(process.platform !== 'darwin')('executes a real command inside the macOS sandbox', async () => {
    const sandbox = await startWorkspaceSandbox({
      allowNetwork: false, command: 'printf sandbox-ok', maxOutputBytes: 4_096,
      repositoryWritable: false, timeoutSeconds: 10,
      workspacePath: process.cwd(), workspaceWritable: false
    });
    expect(await sandbox.completion).toMatchObject({
      exitCode: 0, state: 'completed', stdout: 'sandbox-ok'
    });
  });

  test.skipIf(process.platform !== 'darwin')('keeps Git metadata read-only without repository write permission', async () => {
    const marker = await readFile('.git', 'utf8');
    const sandbox = await startWorkspaceSandbox({
      allowNetwork: false, command: 'printf tampered > .git', maxOutputBytes: 4_096,
      repositoryWritable: false, timeoutSeconds: 10,
      workspacePath: process.cwd(), workspaceWritable: true
    });
    expect(await sandbox.completion).toMatchObject({ state: 'failed' });
    expect(await readFile('.git', 'utf8')).toBe(marker);
  });
});
