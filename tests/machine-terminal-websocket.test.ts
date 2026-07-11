import { once } from 'node:events';
import { createServer } from 'node:http';

import { describe, expect, mock, test } from 'bun:test';
import type { IPty } from 'node-pty';
import { WebSocket } from 'ws';

import {
  applyTerminalMessage,
  createMachineTerminalUpgradeHandler
} from '../server/machine-terminal-websocket';
import type { ProjectSpaceBackend } from '../src/shared/project-space-api';

describe('machine terminal websocket', () => {
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
