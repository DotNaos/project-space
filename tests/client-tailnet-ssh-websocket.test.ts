import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';

import { afterEach, describe, expect, mock, test } from 'bun:test';
import { WebSocket } from 'ws';

import {
  attachClientSshSession,
  createClientTailnetSshUpgradeHandler,
  isSameOriginClientSshRequest,
  resolveLocalTailnetSshTarget,
  sshArgsForTailnetTarget
} from '../server/client-tailnet-ssh-websocket';
import type { TailscaleInventorySource } from '../server/tailscale-inventory/source';

const previousAuthDisabled = process.env.PROJECT_SPACE_AUTH_DISABLED;

afterEach(() => {
  if (previousAuthDisabled === undefined) delete process.env.PROJECT_SPACE_AUTH_DISABLED;
  else process.env.PROJECT_SPACE_AUTH_DISABLED = previousAuthDisabled;
});

function source(online = true): TailscaleInventorySource {
  return {
    async observe() {
      return {
        available: true as const,
        snapshot: {
          backendState: 'running' as const,
          deviceErrors: [],
          devices: [{
            addresses: ['100.80.135.9', 'fd7a:115c:a1e0::1'],
            id: '2903136989709213',
            observedName: 'os-macbook',
            online,
            tags: []
          }],
          freshness: {
            freshUntil: '2026-08-22T22:01:00.000Z',
            observedAt: '2026-08-22T22:00:00.000Z',
            state: 'fresh' as const
          },
          source: 'tailscale_status_json' as const
        }
      };
    }
  };
}

describe('client Tailnet SSH bridge', () => {
  test('resolves only an exact online device from fresh local Tailscale evidence', async () => {
    expect(await resolveLocalTailnetSshTarget(source(), '2903136989709213')).toEqual({
      address: '100.80.135.9',
      deviceId: '2903136989709213',
      deviceName: 'os-macbook'
    });
    expect(await resolveLocalTailnetSshTarget(source(), 'os-macbook')).toMatchObject({
      address: '100.80.135.9', deviceName: 'os-macbook'
    });
    expect(resolveLocalTailnetSshTarget(source(false), '2903136989709213'))
      .rejects.toThrow('offline');
    expect(resolveLocalTailnetSshTarget(source(), 'another-device'))
      .rejects.toThrow('not present');
  });

  test('uses the local agent with isolated SSH config and strict host verification', () => {
    const args = sshArgsForTailnetTarget({
      address: '100.80.135.9',
      deviceId: '2903136989709213',
      deviceName: 'os-macbook'
    }, 'oli');

    expect(args).toContain('/dev/null');
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('PasswordAuthentication=no');
    expect(args).toContain('KbdInteractiveAuthentication=no');
    expect(args).toContain('StrictHostKeyChecking=accept-new');
    expect(args).toContain('ProxyCommand=none');
    expect(args).toContain('ProxyJump=none');
    expect(args.at(-1)).toBe('oli@100.80.135.9');
    expect(() => sshArgsForTailnetTarget({
      address: '100.80.135.9', deviceId: 'device', deviceName: 'device'
    }, '-oProxyCommand=attacker')).toThrow('invalid');
  });

  test('accepts only same-origin browser upgrades', () => {
    expect(isSameOriginClientSshRequest({
      headers: { host: 'project.test', origin: 'https://project.test' }
    } as never)).toBe(true);
    expect(isSameOriginClientSshRequest({
      headers: { host: 'project.test', origin: 'https://attacker.test' }
    } as never)).toBe(false);
  });

  test('kills the local PTY and disposes listeners when the browser disconnects', () => {
    const disposeOutput = mock(() => undefined);
    const disposeExit = mock(() => undefined);
    const kill = mock(() => undefined);
    const socket = Object.assign(new EventEmitter(), {
      bufferedAmount: 0,
      close: mock(() => undefined),
      readyState: WebSocket.OPEN,
      send: mock(() => undefined)
    }) as unknown as WebSocket;
    const pty = {
      kill,
      onData() { return { dispose: disposeOutput }; },
      onExit() { return { dispose: disposeExit }; },
      resize() {},
      write() {}
    };

    attachClientSshSession(socket, pty);
    socket.emit('close');

    expect(disposeOutput).toHaveBeenCalledTimes(1);
    expect(disposeExit).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  test('opens a bounded interactive PTY without accepting a browser-supplied host', async () => {
    process.env.PROJECT_SPACE_AUTH_DISABLED = '1';
    const write = mock((_data: string) => undefined);
    const resize = mock((_cols: number, _rows: number) => undefined);
    const kill = mock(() => undefined);
    const spawn = mock(async () => ({
      kill,
      onData() { return { dispose() {} }; },
      onExit() { return { dispose() {} }; },
      resize,
      write
    }));
    const verify = mock(async () => undefined);
    const handleUpgrade = createClientTailnetSshUpgradeHandler({ source: source(), spawn, verify });
    const server = createServer();
    server.on('upgrade', (request, socket, head) => {
      if (!handleUpgrade(request, socket, head)) socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not expose a port.');
    const origin = `http://127.0.0.1:${address.port}`;
    const socket = new WebSocket(
      `${origin}/api/client/tailnet/devices/2903136989709213/ssh`,
      ['project-space'],
      { headers: { Origin: origin } }
    );

    try {
      await once(socket, 'open');
      socket.send(JSON.stringify({ type: 'connect', username: 'oli' }));
      const event = await Promise.race([
        once(socket, 'message').then(([raw]) => ({ raw: raw as Buffer, type: 'message' as const })),
        once(socket, 'close').then(([code, reason]) => ({
          code: code as number,
          reason: (reason as Buffer).toString('utf8'),
          type: 'close' as const
        }))
      ]);
      if (event.type === 'close') {
        throw new Error(`SSH bridge closed early (${event.code}): ${event.reason}`);
      }
      const raw = event.raw;
      expect(JSON.parse(raw.toString('utf8'))).toMatchObject({
        address: '100.80.135.9', type: 'connected'
      });
      expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
        address: '100.80.135.9', deviceId: '2903136989709213'
      }), 'oli');
      expect(verify).toHaveBeenCalledWith(expect.objectContaining({
        address: '100.80.135.9', deviceId: '2903136989709213'
      }), 'oli');

      socket.send(JSON.stringify({ data: 'uptime\r', type: 'input' }));
      socket.send(JSON.stringify({ cols: 120, rows: 40, type: 'resize' }));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(write).toHaveBeenCalledWith('uptime\r');
      expect(resize).toHaveBeenCalledWith(120, 40);
    } finally {
      if (socket.readyState !== WebSocket.CLOSED) {
        const closed = once(socket, 'close');
        socket.close();
        await closed;
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
