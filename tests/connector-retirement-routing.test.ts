import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, expect, test } from 'bun:test';

import {
  compatibilitySurfaceForPendingKind,
  successfulCompatibilityResult,
  successfulWorkspaceCompatibilityResult
} from '../server/connector-retirement/command-classification';
import {
  connectorSessionOwnerUserId,
  registerConnectorSession,
  removeConnectorSession
} from '../server/connector-command-session-registry';
import { registryCompatibilitySurfaces } from '../server/connector-command-upgrade-handler';
import {
  codexCompatibilitySurface,
  successfulCodexCompatibilityResult
} from '../server/codex-sessions/connector-hub';
import type { ConnectorProjectRegistryResult } from '../src/shared/project-space-api';
import { createProjectSpaceCoreApiRoutes } from '../server/project-space-api-core-routes';
import {
  handleWorkspaceCommandHubMessage,
  requestConnectorWorkspaceCommand
} from '../server/workspace-command/connector-hub';

describe('Connector compatibility routing classification', () => {
  test('maps every command family to its actual versioned surface', () => {
    expect(compatibilitySurfaceForPendingKind('terminal')).toBe('connector.command.remote.v2');
    expect(compatibilitySurfaceForPendingKind('worktrees'))
      .toBe('connector.project-registry.websocket.v2');
    expect(compatibilitySurfaceForPendingKind('models'))
      .toBe('connector.codex-models.websocket.v1');
    expect(compatibilitySurfaceForPendingKind('chat'))
      .toBe('connector.codex-chat.websocket.v1');
    expect(codexCompatibilitySurface('start'))
      .toBe('connector.codex-sessions-launch.websocket.v1');
    expect(codexCompatibilitySurface('continue'))
      .toBe('connector.codex-sessions-control.websocket.v1');
  });

  test('does not classify explicit command failures as successful use', () => {
    expect(successfulCompatibilityResult('chat', undefined)).toBe(true);
    expect(successfulCompatibilityResult('terminal', { exitCode: 1 } as never)).toBe(false);
    expect(successfulCompatibilityResult('filesystem-file', {
      status: 'error'
    } as never)).toBe(false);
    expect(successfulCompatibilityResult('folder-create', {
      status: 'success'
    } as never)).toBe(true);
    expect(successfulCompatibilityResult('dev-server-start', {
      capability: 'configured', state: 'error'
    } as never)).toBe(false);
    expect(successfulCompatibilityResult('dev-server-inspect', {
      capability: 'configured', state: 'running'
    } as never)).toBe(true);
    expect(successfulCompatibilityResult('models', { status: 'error' } as never)).toBe(false);
    expect(successfulCompatibilityResult('worktrees', [] as never)).toBe(true);
    expect(successfulCompatibilityResult('worktrees', [{ id: 'worktree-one' }] as never)).toBe(true);
    expect(successfulWorkspaceCompatibilityResult({
      operation: 'start', state: 'failed'
    })).toBe(false);
    expect(successfulWorkspaceCompatibilityResult({
      operation: 'start', state: 'running'
    })).toBe(true);
    expect(successfulWorkspaceCompatibilityResult({
      operation: 'cancel', state: 'cancelled'
    })).toBe(true);
    expect(successfulWorkspaceCompatibilityResult({
      operation: 'cancel', state: 'failed'
    })).toBe(false);
  });

  test('counts only successful, non-replayed modern Codex results', () => {
    expect(successfulCodexCompatibilityResult({
      operation: 'continue',
      result: {
        operationId: 'operation-one', replayed: false, status: 'completed',
        threadId: '019ff2a1-7f21-7f22-98c9-f47c47b4238b'
      }
    })).toBe(true);
    expect(successfulCodexCompatibilityResult({
      operation: 'continue',
      result: {
        operationId: 'operation-one', replayed: true, status: 'completed',
        threadId: '019ff2a1-7f21-7f22-98c9-f47c47b4238b'
      }
    })).toBe(false);
    expect(successfulCodexCompatibilityResult({
      operation: 'continue',
      result: {
        operationId: 'operation-one', replayed: false, status: 'rejected',
        threadId: '019ff2a1-7f21-7f22-98c9-f47c47b4238b'
      }
    })).toBe(false);
    expect(successfulCodexCompatibilityResult({
      operation: 'start', result: { message: 'failed', state: 'codex_failure' }
    })).toBe(false);
    expect(successfulCodexCompatibilityResult({
      operation: 'daemon',
      result: { evidence: {} as never, operation: 'status', operationId: 'one', state: 'blocked' }
    })).toBe(false);
    expect(successfulCodexCompatibilityResult({
      operation: 'authorization', result: { state: 'pending', deadlineAt: '', userCode: '', verificationUrl: '' }
    })).toBe(true);
    expect(successfulCodexCompatibilityResult({
      operation: 'authorization', result: { state: 'failed' }
    })).toBe(false);
  });

  test('records only registry evidence that was actually supplied', () => {
    const base = {
      checkedAt: '2026-08-12T00:00:00.000Z',
      connector: { machineId: 'machine-one', machineName: 'Machine one' },
      discovery: { groups: [], projects: [], rootItems: [], structureViolations: [] }
    } as unknown as ConnectorProjectRegistryResult;
    expect(registryCompatibilitySurfaces(base)).toEqual([
      'connector.presence.websocket.v2',
      'connector.project-registry.websocket.v2'
    ]);
    expect(registryCompatibilitySurfaces({
      ...base,
      connector: { ...base.connector, compute: {} as never, network: {} as never }
    })).toEqual([
      'connector.presence.websocket.v2',
      'connector.project-registry.websocket.v2'
    ]);
    expect(registryCompatibilitySurfaces({
      ...base,
      connector: {
        ...base.connector,
        compute: { resources: {} } as never,
        network: { tailscaleIp: '100.64.0.1' }
      }
    })).toEqual([
      'connector.presence.websocket.v2',
      'connector.project-registry.websocket.v2',
      'connector.private-network.websocket.v2',
      'connector.resource-report.websocket.v2'
    ]);
  });

  test('clears stale owner attribution when an ownerless session replaces a machine', () => {
    const machineId = 'owner-replacement-fixture';
    const socket = { readyState: 1 } as never;
    registerConnectorSession(machineId, socket, 'token-one', [], 'owner-one');
    expect(connectorSessionOwnerUserId(machineId)).toBe('owner-one');
    registerConnectorSession(machineId, socket, 'token-two', []);
    expect(connectorSessionOwnerUserId(machineId)).toBeUndefined();
    removeConnectorSession(machineId);
  });

  test('records successful owner-facing compatibility reads at their actual routes', async () => {
    const recorded: unknown[] = [];
    const backend = {
      async getConnectorProjectRegistry() {
        return { checkedAt: '', connector: {}, discovery: {} };
      }
    } as never;
    const route = createProjectSpaceCoreApiRoutes(backend, {
      recordCompatibilityUse: async (...input) => {
        recorded.push(input);
        return true;
      }
    });
    for (const path of ['/api/connectors/credentials', '/api/connectors/project-registry']) {
      let body = '';
      const response = {
        end(value = '') { body = value; },
        setHeader() {},
        writeHead() {}
      } as never;
      expect(await route(
        { method: 'GET' } as never,
        response,
        new URL(`https://projects.example${path}`),
        'owner-one'
      )).toBe(true);
      expect(body).not.toBe('');
    }
    expect(recorded).toEqual([
      ['owner-one', 'connector.credentials.http.v1'],
      ['owner-one', 'connector.project-registry.owner-http.v1']
    ]);
  });

  test('records one exact successful workspace command and no duplicate', async () => {
    const sent: string[] = [];
    const socket = { readyState: 1, send(value: string) { sent.push(value); } } as never;
    const machineId = 'workspace-hook-machine';
    const generation = registerConnectorSession(
      machineId, socket, 'workspace-hook-token', ['workspace.commands.v1'], 'owner-one'
    );
    const pair = generateKeyPairSync('ed25519');
    const command = 'printf ok';
    const request = {
      allowNetwork: false,
      command,
      commandId: '11111111-1111-4111-8111-111111111111',
      commandSha256: createHash('sha256').update(command).digest('hex'),
      environmentId: '22222222-2222-4222-8222-222222222222',
      executionId: '33333333-3333-4333-8333-333333333333',
      machineId,
      maxOutputBytes: 4096,
      operation: 'start' as const,
      projectId: 'github:480',
      repositoryWritable: false,
      timeoutSeconds: 30,
      workspaceId: '44444444-4444-4444-8444-444444444444',
      workspaceWritable: false,
      worktreeId: 'wt_aaaaaaaaaaaaaaaaaaaaaaaa'
    };
    const pending = requestConnectorWorkspaceCommand(
      'start', request, { generation, userId: 'owner-one' },
      { nonce: 'abcdefghijklmnopqrstuvwx', signingKey: pair.privateKey, timeoutMs: 1000 }
    );
    const wire = JSON.parse(sent[0]!);
    const result = {
      checkedAt: '2026-08-12T00:00:00.000Z',
      commandId: request.commandId,
      environmentId: request.environmentId,
      executionId: request.executionId,
      generation,
      machineId,
      operation: 'start' as const,
      state: 'completed' as const,
      stderr: '', stdout: 'ok', truncated: false,
      workspaceId: request.workspaceId
    };
    const recorded: unknown[] = [];
    const message = { id: wire.id, payload: result, type: 'workspace.command.result' } as never;
    handleWorkspaceCommandHubMessage(machineId, message, {
      recordCompatibilityUse: async (...input) => {
        recorded.push(input);
        return true;
      }
    });
    await expect(pending).resolves.toEqual(result);
    await Promise.resolve();
    expect(recorded).toEqual([
      ['owner-one', 'connector.workspace-command.websocket.v1']
    ]);
    handleWorkspaceCommandHubMessage(machineId, message, {
      recordCompatibilityUse: async (...input) => {
        recorded.push(input);
        return true;
      }
    });
    expect(recorded).toHaveLength(1);
    removeConnectorSession(machineId);
  });
});
