import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';

import { afterEach, describe, expect, test } from 'bun:test';
import { WebSocket } from 'ws';

import {
  createConnectorCommandUpgradeHandler,
  requestConnectorProjectWorktrees,
  requestConnectorRuntimeMaintenance
} from '../server/connector-command-hub';
import {
  isConnectorMachineMessage,
  type ConnectorMachineMessage
} from '../server/connector-command-protocol';
import type { ConnectorRuntimeRestartPlan } from '../server/connector-runtime-command-contract';
import {
  ConnectorRuntimeCommandOutcomeUnknownError,
  connectorRegistryForRuntimeConfiguration,
  connectorRuntimeCommandBinding,
  requestConnectorRuntimeCommand
} from '../server/connector-runtime-command-routing';
import type { ConnectorRuntimeReleaseTarget } from '../server/connector-runtime-maintenance-contract';
import type { ConnectorProjectRegistryResult } from '../src/shared/project-space-api';

const originalSigningKey = process.env.PROJECT_CONNECTOR_COMMAND_SIGNING_PRIVATE_KEY;

afterEach(() => {
  if (originalSigningKey === undefined) {
    delete process.env.PROJECT_CONNECTOR_COMMAND_SIGNING_PRIVATE_KEY;
  } else {
    process.env.PROJECT_CONNECTOR_COMMAND_SIGNING_PRIVATE_KEY = originalSigningKey;
  }
});

function target(): ConnectorRuntimeReleaseTarget {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64';
  if (process.platform === 'win32' && process.arch === 'x64') return 'windows-x64';
  return 'linux-x64';
}

function registration(machineId: string, capabilities = ['runtime.restart']) {
  const payload: ConnectorProjectRegistryResult = {
    checkedAt: '2026-07-14T00:00:00.000Z',
    connector: {
      capabilities,
      machineId,
      machineName: machineId,
      runtime: {
        architecture: target().endsWith('arm64') ? 'arm64' : 'x64',
        buildId: 'a'.repeat(40),
        bundleVersions: { connector: '1.0.0', machineTools: '1.0.0', projectCli: '1.0.0' },
        channel: 'stable',
        instanceId: 'stable-instance',
        lastCheckedAt: '2026-07-14T00:00:00.000Z',
        platform: target().startsWith('darwin') ? 'darwin' :
          target().startsWith('windows') ? 'windows' : 'linux',
        protocolVersion: '2',
        releaseId: 'v1.0.0',
        source: 'managed',
        version: '1.0.0'
      }
    },
    discovery: {
      groups: [], projects: [], rootItems: [], rootPath: '/tmp', structureViolations: []
    }
  };
  return JSON.stringify({ payload, token: 'credential', type: 'connector.register' });
}

function restartPlan(machineId: string, operationId: string): ConnectorRuntimeRestartPlan {
  return {
    machineId,
    operation: 'restart',
    operationId,
    previousRuntime: {
      buildId: 'a'.repeat(40),
      bundleVersions: { connector: '1.0.0', machineTools: '1.0.0', projectCli: '1.0.0' },
      capabilities: ['runtime.restart'],
      instanceId: 'stable-instance',
      protocolVersion: '2',
      releaseId: 'v1.0.0',
      version: '1.0.0'
    },
    schema: 'project-space.connector-runtime-command/v1',
    target: target()
  };
}

async function openConnector(
  machineId: string,
  capabilities?: string[],
  recordCompatibilityUse?: (...input: never[]) => Promise<boolean>
) {
  const commands = createConnectorCommandUpgradeHandler({
    async authenticateConnectorCredential() { return { machineId, userId: 'user_test' }; },
    recordCompatibilityUse
  });
  const server = createServer();
  server.on('upgrade', (request, socket, head) => {
    if (!commands.handleUpgrade(request, socket, head)) socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server did not expose a port.');
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/connectors/socket`);
  await once(socket, 'open');
  socket.send(registration(machineId, capabilities));
  const [registeredRaw] = await once(socket, 'message') as [Buffer];
  const registered = JSON.parse(registeredRaw.toString()) as ConnectorMachineMessage;
  if (!isConnectorMachineMessage(registered) || registered.type !== 'connector.registered') {
    throw new Error('Connector registration failed.');
  }
  return { commands, generation: registered.generation, server, socket };
}

async function closeConnector(
  opened: Awaited<ReturnType<typeof openConnector>>
) {
  opened.socket.close();
  opened.server.closeAllConnections();
  await opened.commands.close();
  await new Promise<void>((resolve) => opened.server.close(() => resolve()));
}

describe('connector runtime command routing', () => {
  test('advertises managed maintenance or source stop without mixing capabilities', () => {
    const registry = JSON.parse(registration('runtime-capabilities', [
      'runtime.restart', 'runtime.stop', 'runtime.update', 'worktrees.list'
    ])).payload as ConnectorProjectRegistryResult;
    expect(connectorRegistryForRuntimeConfiguration(registry, true).connector.capabilities)
      .toEqual(['runtime.restart', 'runtime.update', 'worktrees.list']);
    expect(connectorRegistryForRuntimeConfiguration(
      registry,
      ['runtime.stop']
    ).connector.capabilities).toEqual(['runtime.stop', 'worktrees.list']);
    expect(connectorRegistryForRuntimeConfiguration(registry, false).connector.capabilities)
      .toEqual(['worktrees.list']);
  });

  test('relays a signed generation-bound operation with bounded progress', async () => {
    const recorded: unknown[] = [];
    const keys = generateKeyPairSync('ed25519');
    process.env.PROJECT_CONNECTOR_COMMAND_SIGNING_PRIVATE_KEY = keys.privateKey
      .export({ format: 'pem', type: 'pkcs8' }).toString();
    const opened = await openConnector('runtime-routing', undefined, async (...input) => {
      recorded.push(input);
      return true;
    });
    const incoming = once(opened.socket, 'message');
    const stages: string[] = [];
    const result = requestConnectorRuntimeMaintenance({
      onProgress(stage) { stages.push(stage); },
      plan: restartPlan('runtime-routing', 'operation-routing'),
      userId: 'user_test'
    });
    try {
      const [raw] = await incoming as [Buffer];
      const message = JSON.parse(raw.toString());
      expect(isConnectorMachineMessage(message)).toBe(true);
      expect(message.type).toBe('runtime.maintenance');
      expect(message.payload.grant).toMatchObject({
        generation: opened.generation,
        machineId: 'runtime-routing',
        operation: 'restart',
        operationId: 'operation-routing',
        userId: 'user_test'
      });
      const binding = connectorRuntimeCommandBinding(message.payload);
      opened.socket.send(JSON.stringify({
        id: message.id,
        payload: { binding, stage: 'verifying' },
        type: 'runtime.maintenance.progress'
      }));
      opened.socket.send(JSON.stringify({
        id: message.id,
        payload: { binding, status: 'accepted' },
        type: 'runtime.maintenance.result'
      }));
      await result;
      expect(stages).toEqual(['verifying']);
      await Promise.resolve();
      expect(recorded).toContainEqual([
        'user_test', 'connector.runtime-maintenance.websocket.v2'
      ]);
    } finally {
      await closeConnector(opened);
    }
  });

  test('records one bound legacy worktree result and ignores its duplicate', async () => {
    const recorded: unknown[] = [];
    const opened = await openConnector(
      'legacy-worktrees',
      ['worktrees.list.v2'],
      async (...input) => {
        recorded.push(input);
        return true;
      }
    );
    recorded.length = 0;
    const incoming = once(opened.socket, 'message');
    const result = requestConnectorProjectWorktrees({
      machineId: 'legacy-worktrees',
      projectPath: '/tmp/project'
    });
    try {
      const [raw] = await incoming as [Buffer];
      const request = JSON.parse(raw.toString());
      const response = { id: request.id, payload: [], type: 'worktrees.result' };
      opened.socket.send(JSON.stringify(response));
      await expect(result).resolves.toEqual([]);
      opened.socket.send(JSON.stringify(response));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(recorded.filter((entry) => JSON.stringify(entry) === JSON.stringify([
        'user_test', 'connector.project-registry.websocket.v2'
      ]))).toHaveLength(1);
    } finally {
      await closeConnector(opened);
    }
  });

  test('fails an in-flight operation when the authenticated connector disconnects', async () => {
    const keys = generateKeyPairSync('ed25519');
    const opened = await openConnector('runtime-interrupted');
    const incoming = once(opened.socket, 'message');
    const result = requestConnectorRuntimeCommand(
      restartPlan('runtime-interrupted', 'operation-interrupted'),
      'user_test',
      { signingKey: keys.privateKey, timeoutMs: 1_000 }
    );
    await incoming;
    opened.socket.close();
    try {
      await expect(result).rejects.toBeInstanceOf(ConnectorRuntimeCommandOutcomeUnknownError);
    } finally {
      await closeConnector(opened);
    }
  });

  test('does not send maintenance to a connector without the named capability', async () => {
    const opened = await openConnector('runtime-unsupported', []);
    try {
      expect(() => requestConnectorRuntimeCommand(
        restartPlan('runtime-unsupported', 'operation-unsupported'), 'user_test',
        { signingKey: generateKeyPairSync('ed25519').privateKey }
      )).toThrow('does not provide managed runtime maintenance');
    } finally {
      await closeConnector(opened);
    }
  });
});
