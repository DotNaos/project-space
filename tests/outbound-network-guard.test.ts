import { afterEach, describe, expect, test } from 'bun:test';
import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';

import { installOutboundNetworkGuard, isLoopbackHost } from '../server/outbound-network-guard';

let dispose: undefined | (() => void);
afterEach(() => dispose?.());

describe('local simulation outbound network guard', () => {
  test('recognizes only loopback hosts', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('github.com')).toBe(false);
    expect(isLoopbackHost('10.0.0.4')).toBe(false);
  });

  test('blocks HTTP, TCP, DNS, and UDP egress before connection', async () => {
    dispose = installOutboundNetworkGuard();
    await expect(fetch('https://github.com')).rejects.toThrow('blocked outbound request');
    expect(() => new net.Socket().connect({ host: 'github.com', port: 443 })).toThrow(
      'blocked outbound socket'
    );
    expect(() => dns.lookup('github.com', () => undefined)).toThrow('blocked DNS lookup');
    expect(() => dns.resolve('github.com', () => undefined)).toThrow('blocked DNS resolution');
    const socket = dgram.createSocket('udp4');
    expect(() => socket.connect(53, '8.8.8.8')).toThrow('blocked outbound datagram');
    expect(() => socket.send('test', 53, '8.8.8.8')).toThrow('blocked outbound datagram');
  });
});
