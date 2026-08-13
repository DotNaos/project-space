import { once } from 'node:events';
import { createServer } from 'node:http';

import { describe, expect, test } from 'bun:test';
import { WebSocket } from 'ws';

import {
  isConnectorCommandChannelAuthenticated,
  isConnectorCommandChannelAvailable,
  disconnectConnectorSession
} from '../server/connector-command-session-registry';
import { createCodexSessionsConnectorUpgradeHandler } from '../server/codex-sessions/connector-upgrade-handler';
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

function developmentRegistrationMessage(machineId: string, token: string) {
  const registration = JSON.parse(registrationMessage(machineId, token)) as {
    payload: ConnectorProjectRegistryResult;
    token: string;
    type: 'connector.register';
  };
  registration.payload.connector.runtime = {
    architecture: 'x64',
    buildId: 'dev-source-checkout',
    bundleVersions: {
      connector: '0.4.7',
      machineTools: '0.4.7',
      projectCli: '0.4.7'
    },
    channel: 'dev',
    instanceId: 'dev-instance',
    lastCheckedAt: '2026-07-11T00:00:00.000Z',
    platform: 'linux',
    protocolVersion: '1',
    releaseId: 'dev-source-checkout',
    source: 'source',
    version: '0.4.7'
  };
  return JSON.stringify(registration);
}

async function connect(url: string) {
  const socket = new WebSocket(url);
  await once(socket, 'open');
  return socket;
}

describe('connector credential authentication', () => {
  test('measures both initial and recurring authenticated registry use', async () => {
    const uses: unknown[] = [];
    const commands = createCodexSessionsConnectorUpgradeHandler({
      async authenticateConnectorCredential(_token, machineId) {
        return { machineId, userId: 'owner-one' };
      },
      async recordCompatibilityUse(...input) {
        uses.push(input);
        return true;
      }
    });
    const server = createServer();
    server.on('upgrade', (request, socket, head) => {
      if (!commands.handleUpgrade(request, socket, head)) socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test port.');
    const socket = await connect(
      `ws://127.0.0.1:${address.port}/api/connectors/socket`
    );
    try {
      socket.send(registrationMessage('measured-machine', 'credential'));
      await once(socket, 'message');
      socket.send(registryMessage('measured-machine'));
      await waitFor(() => uses.length === 4);
      expect(uses).toEqual([
        ['owner-one', 'connector.presence.websocket.v2'],
        ['owner-one', 'connector.project-registry.websocket.v2'],
        ['owner-one', 'connector.presence.websocket.v2'],
        ['owner-one', 'connector.project-registry.websocket.v2']
      ]);
    } finally {
      socket.close();
      server.closeAllConnections();
      await commands.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('requires authenticated profile binding before registering a source connector', async () => {
    const commands = createCodexSessionsConnectorUpgradeHandler({
      async authenticateConnectorCredential(_token, machineId) {
        return machineId === 'bound-development-machine'
          ? {
              connectorProfile: { channel: 'dev', source: 'source' },
              machineId
            }
          : true;
      }
    });
    const server = createServer();
    server.on('upgrade', (request, socket, head) => {
      if (!commands.handleUpgrade(request, socket, head)) socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test port.');
    const url = `ws://127.0.0.1:${address.port}/api/connectors/socket`;

    try {
      const unbound = await connect(url);
      unbound.send(developmentRegistrationMessage('unbound-development-machine', 'token'));
      const [unboundCode] = (await once(unbound, 'close')) as [number, Buffer];
      expect(unboundCode).toBe(1008);

      const bound = await connect(url);
      bound.send(developmentRegistrationMessage('bound-development-machine', 'token'));
      const [message] = (await once(bound, 'message')) as [Buffer];
      expect(JSON.parse(message.toString())).toMatchObject({
        generation: expect.any(Number),
        type: 'connector.registered'
      });
      bound.close();
    } finally {
      server.closeAllConnections();
      await commands.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('awaits the injected per-connector credential and machine binding', async () => {
    const authentications: Array<[string, string]> = [];
    const commands = createCodexSessionsConnectorUpgradeHandler({
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
    const commands = createCodexSessionsConnectorUpgradeHandler({
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
    const commands = createCodexSessionsConnectorUpgradeHandler({
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
    const commands = createCodexSessionsConnectorUpgradeHandler({
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

      expect(disconnectConnectorSession('immediate-revocation-machine')).not.toBeNull();
      expect(isConnectorCommandChannelAvailable('immediate-revocation-machine')).toBe(false);
      const [code] = (await closed) as [number, Buffer];
      expect(code).toBe(1008);
      expect(disconnectConnectorSession('immediate-revocation-machine')).toBeNull();
    } finally {
      server.closeAllConnections();
      await commands.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error('Timed out waiting for the Connector usage hook.');
}
