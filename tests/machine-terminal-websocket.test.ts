import { once } from 'node:events';
import { createServer } from 'node:http';

import { describe, expect, mock, test } from 'bun:test';
import type { IPty } from 'node-pty';
import { WebSocket } from 'ws';

import {
  applyTerminalMessage,
  createMachineTerminalUpgradeHandler,
  resolveMachineTerminalTransport
} from '../server/machine-terminal-websocket';
import type { MachineRecord, ProjectSpaceBackend } from '../src/shared/project-space-api';

function untrustedConnectorMachine(kind = 'connector'): MachineRecord {
  return {
    connector: { installCommand: 'project-space-connector', status: 'online' },
    id: 'terminal-untrusted-connector',
    kind,
    name: '-oProxyCommand=attacker',
    network: {
      localName: '127.0.0.1:1',
      sshUser: 'root',
      tailscaleIp: '203.0.113.17'
    },
    roles: ['connector'],
    sourcePath: 'connector-hub'
  };
}

describe('machine terminal websocket', () => {
  test('connector source overrides fake local kind and connector-chosen SSH metadata', () => {
    expect(resolveMachineTerminalTransport(untrustedConnectorMachine('local'))).toEqual({
      kind: 'connector'
    });
  });

  test('rejects connector-sourced interactive terminals before opening SSH', async () => {
    const previousAuthDisabled = process.env.PROJECT_SPACE_AUTH_DISABLED;
    process.env.PROJECT_SPACE_AUTH_DISABLED = '1';
    const machine = untrustedConnectorMachine();
    const backend = {
      async getConnectorOverview() {
        return {
          machines: [machine],
          machinesRepo: { exists: false, path: '' },
          tailscale: {
            connected: false,
            installed: false,
            ips: [],
            peersOnline: 0,
            serveOrigins: []
          }
        };
      }
    } as ProjectSpaceBackend;
    const handleUpgrade = createMachineTerminalUpgradeHandler(backend);
    const server = createServer();
    server.on('upgrade', (request, socket, head) => {
      if (!handleUpgrade(request, socket, head)) {
        socket.destroy();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Test server did not expose a port.');
    }

    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/api/machines/${machine.id}/terminal`
    );

    try {
      const [[data], [code, reason]] = (await Promise.all([
        once(socket, 'message'),
        once(socket, 'close')
      ])) as [[Buffer], [number, Buffer]];
      const message = JSON.parse(data.toString('utf-8')) as { data?: string };

      expect(message.data).toContain('through its machine connector');
      expect(code).toBe(1008);
      expect(reason.toString()).toBe('Machine access denied.');
    } finally {
      socket.terminate();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previousAuthDisabled === undefined) {
        delete process.env.PROJECT_SPACE_AUTH_DISABLED;
      } else {
        process.env.PROJECT_SPACE_AUTH_DISABLED = previousAuthDisabled;
      }
    }
  });

  test('closes malformed percent-encoded machine ids as a policy violation', async () => {
    let backendCalled = false;
    const backend = {
      async getConnectorOverview() {
        backendCalled = true;
        throw new Error('The backend must not be called for an invalid machine id.');
      }
    } as ProjectSpaceBackend;
    const handleUpgrade = createMachineTerminalUpgradeHandler(backend);
    const server = createServer();
    server.on('upgrade', (request, socket, head) => {
      if (!handleUpgrade(request, socket, head)) {
        socket.destroy();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Test server did not expose a port.');
    }

    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/api/machines/%/terminal`
    );

    try {
      const [code, reason] = (await once(socket, 'close')) as [number, Buffer];

      expect(code).toBe(1008);
      expect(reason.toString()).toBe('Machine access denied.');
      expect(backendCalled).toBe(false);
    } finally {
      socket.terminate();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('only passes finite integer resize dimensions within the terminal bounds to node-pty', () => {
    const resize = mock((_cols: number, _rows: number) => undefined);
    const pty = { resize } as unknown as IPty;

    applyTerminalMessage(pty, { cols: 20, rows: 8, type: 'resize' });
    applyTerminalMessage(pty, { cols: 500, rows: 200, type: 'resize' });

    expect(resize).toHaveBeenCalledTimes(2);
    expect(resize).toHaveBeenNthCalledWith(1, 20, 8);
    expect(resize).toHaveBeenNthCalledWith(2, 500, 200);

    for (const [cols, rows] of [
      [19, 28],
      [501, 28],
      [100, 7],
      [100, 201],
      [100.5, 28],
      [100, 28.5],
      [Number.POSITIVE_INFINITY, 28],
      [100, Number.NEGATIVE_INFINITY],
      [Number.NaN, 28]
    ]) {
      applyTerminalMessage(pty, { cols, rows, type: 'resize' });
    }

    expect(resize).toHaveBeenCalledTimes(2);
  });
});
