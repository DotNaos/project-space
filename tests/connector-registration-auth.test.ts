import { once } from 'node:events';
import { createServer } from 'node:http';

import { describe, expect, test } from 'bun:test';
import { WebSocket } from 'ws';

import {
  createConnectorCommandUpgradeHandler,
  disconnectConnectorCommandChannel,
  isConnectorCommandChannelAuthenticated,
  isConnectorCommandChannelAvailable
} from '../server/connector-command-hub';
import type { ConnectorProjectRegistryResult } from '../src/shared/project-space-api';

function registrationMessage(machineId: string, token: string) {
  const payload: ConnectorProjectRegistryResult = {
    checkedAt: new Date().toISOString(),
    connector: { machineId, machineName: machineId },
    discovery: {
      groups: [],
      projects: [],
      rootItems: [],
      rootPath: '/tmp',
      structureViolations: []
    }
  };
  return JSON.stringify({ payload, token, type: 'connector.register' });
}

function registryMessage(machineId: string) {
  const registration = JSON.parse(registrationMessage(machineId, 'unused')) as {
    payload: ConnectorProjectRegistryResult;
  };
  return JSON.stringify({ payload: registration.payload, type: 'connector.registry' });
}

async function connect(url: string) {
  const socket = new WebSocket(url);
  await once(socket, 'open');
  return socket;
}

describe('connector credential authentication', () => {
  test('awaits the injected per-connector credential and machine binding', async () => {
    const authentications: Array<[string, string]> = [];
    const commands = createConnectorCommandUpgradeHandler({
      async authenticateConnectorCredential(token, machineId) {
        authentications.push([token, machineId]);
        return token === 'machine-specific-credential' && machineId === 'bound-machine';
      }
    });
    const server = createServer();
    server.on('upgrade', (request, socket, head) => {
      if (!commands.handleUpgrade(request, socket, head)) {
        socket.destroy();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Test server did not expose a port.');
    }
    const url = `ws://127.0.0.1:${address.port}/api/connectors/socket`;

    try {
      const rejected = await connect(url);
      rejected.send(registrationMessage('bound-machine', 'wrong-credential'));
      const [code] = (await once(rejected, 'close')) as [number, Buffer];
      expect(code).toBe(1008);
      expect(isConnectorCommandChannelAvailable('bound-machine')).toBe(false);

      const accepted = await connect(url);
      accepted.send(registrationMessage('bound-machine', 'machine-specific-credential'));
      const [message] = (await once(accepted, 'message')) as [Buffer];
      expect(JSON.parse(message.toString())).toMatchObject({
        generation: expect.any(Number),
        type: 'connector.registered'
      });
      expect(isConnectorCommandChannelAvailable('bound-machine')).toBe(true);
      expect(
        isConnectorCommandChannelAuthenticated(
          'bound-machine',
          'machine-specific-credential'
        )
      ).toBe(true);
      expect(
        isConnectorCommandChannelAuthenticated('bound-machine', 'rotated-credential')
      ).toBe(false);
      expect(authentications).toEqual([
        ['wrong-credential', 'bound-machine'],
        ['machine-specific-credential', 'bound-machine']
      ]);
      accepted.close();
    } finally {
      server.closeAllConnections();
      await commands.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('revalidates the credential before accepting a registry refresh', async () => {
    let valid = true;
    let authenticationCount = 0;
    const commands = createConnectorCommandUpgradeHandler({
      async authenticateConnectorCredential() {
        authenticationCount += 1;
        return valid;
      }
    });
    const server = createServer();
    server.on('upgrade', (request, socket, head) => {
      if (!commands.handleUpgrade(request, socket, head)) {
        socket.destroy();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Test server did not expose a port.');
    }

    try {
      const socket = await connect(`ws://127.0.0.1:${address.port}/api/connectors/socket`);
      socket.send(registrationMessage('revalidated-machine', 'credential'));
      await once(socket, 'message');
      valid = false;
      socket.send(registryMessage('revalidated-machine'));
      const [code] = (await once(socket, 'close')) as [number, Buffer];

      expect(code).toBe(1008);
      expect(authenticationCount).toBe(2);
      expect(isConnectorCommandChannelAvailable('revalidated-machine')).toBe(false);
    } finally {
      server.closeAllConnections();
      await commands.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('periodically closes a socket after its credential is revoked', async () => {
    let valid = true;
    const commands = createConnectorCommandUpgradeHandler({
      async authenticateConnectorCredential() {
        return valid;
      },
      credentialRevalidationIntervalMs: 10
    });
    const server = createServer();
    server.on('upgrade', (request, socket, head) => {
      if (!commands.handleUpgrade(request, socket, head)) {
        socket.destroy();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Test server did not expose a port.');
    }

    try {
      const socket = await connect(`ws://127.0.0.1:${address.port}/api/connectors/socket`);
      socket.send(registrationMessage('periodic-machine', 'credential'));
      await once(socket, 'message');
      const closed = once(socket, 'close');
      valid = false;
      const [code] = (await closed) as [number, Buffer];

      expect(code).toBe(1008);
      expect(isConnectorCommandChannelAvailable('periodic-machine')).toBe(false);
    } finally {
      server.closeAllConnections();
      await commands.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('removes a revoked machine from the command channel immediately', async () => {
    const commands = createConnectorCommandUpgradeHandler({
      async authenticateConnectorCredential() {
        return true;
      }
    });
    const server = createServer();
    server.on('upgrade', (request, socket, head) => {
      if (!commands.handleUpgrade(request, socket, head)) {
        socket.destroy();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Test server did not expose a port.');
    }

    try {
      const socket = await connect(`ws://127.0.0.1:${address.port}/api/connectors/socket`);
      socket.send(registrationMessage('immediate-revocation-machine', 'credential'));
      await once(socket, 'message');
      const closed = once(socket, 'close');

      expect(disconnectConnectorCommandChannel('immediate-revocation-machine')).toBe(true);
      expect(isConnectorCommandChannelAvailable('immediate-revocation-machine')).toBe(false);
      const [code] = (await closed) as [number, Buffer];
      expect(code).toBe(1008);
      expect(disconnectConnectorCommandChannel('immediate-revocation-machine')).toBe(false);
    } finally {
      server.closeAllConnections();
      await commands.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
