import { isIP } from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';

const loopbackNames = new Set(['localhost', 'localhost.localdomain']);

export function isLoopbackHost(hostname: string) {
  const host = hostname.trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (loopbackNames.has(host)) return true;
  const family = isIP(host);
  if (family === 4) return host.startsWith('127.');
  if (family === 6) return host === '::1' || host === '0:0:0:0:0:0:0:1';
  return false;
}

function fetchTarget(input: Parameters<typeof fetch>[0]) {
  if (input instanceof URL) return input;
  if (typeof input === 'string') return new URL(input);
  return new URL(input.url);
}

function socketTarget(args: unknown[]) {
  const first = args[0];
  if (typeof first === 'object' && first !== null) {
    const options = first as { host?: string; hostname?: string; path?: string };
    if (options.path) return { local: true, target: options.path };
    const host = options.hostname ?? options.host ?? 'localhost';
    return { local: isLoopbackHost(host), target: host };
  }
  if (typeof first === 'string') return { local: true, target: first };
  const host = typeof args[1] === 'string' ? args[1] : 'localhost';
  return { local: isLoopbackHost(host), target: host };
}

export function installOutboundNetworkGuard() {
  const originalFetch = globalThis.fetch;
  const originalConnect = net.Socket.prototype.connect;
  const originalDatagramConnect = dgram.Socket.prototype.connect;
  const originalDatagramSend = dgram.Socket.prototype.send;
  const originalLookup = dns.lookup;
  const originalResolve = dns.resolve;

  globalThis.fetch = (async (input, init) => {
    const target = fetchTarget(input);
    if (!isLoopbackHost(target.hostname)) {
      throw new Error(`Local simulation blocked outbound request to ${target.hostname}.`);
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  net.Socket.prototype.connect = function guardedConnect(
    this: net.Socket,
    ...args: Parameters<net.Socket['connect']>
  ) {
    const target = socketTarget(args);
    if (!target.local) {
      throw new Error(`Local simulation blocked outbound socket to ${target.target}.`);
    }
    return originalConnect.apply(this, args);
  } as typeof net.Socket.prototype.connect;

  dns.lookup = function guardedLookup(hostname, ...args) {
    if (!isLoopbackHost(hostname)) {
      throw new Error(`Local simulation blocked DNS lookup for ${hostname}.`);
    }
    return Reflect.apply(originalLookup, dns, [hostname, ...args]) as ReturnType<typeof dns.lookup>;
  } as typeof dns.lookup;

  dns.resolve = function guardedResolve(hostname, ...args) {
    if (!isLoopbackHost(hostname)) {
      throw new Error(`Local simulation blocked DNS resolution for ${hostname}.`);
    }
    return Reflect.apply(originalResolve, dns, [hostname, ...args]) as ReturnType<typeof dns.resolve>;
  } as typeof dns.resolve;

  dgram.Socket.prototype.connect = function guardedDatagramConnect(
    this: dgram.Socket,
    ...args: Parameters<dgram.Socket['connect']>
  ) {
    const address = args.find((value) => typeof value === 'string') ?? 'localhost';
    if (!isLoopbackHost(address)) {
      throw new Error(`Local simulation blocked outbound datagram to ${address}.`);
    }
    return originalDatagramConnect.apply(this, args);
  } as typeof dgram.Socket.prototype.connect;

  dgram.Socket.prototype.send = function guardedDatagramSend(
    this: dgram.Socket,
    ...args: Parameters<dgram.Socket['send']>
  ) {
    const addresses = args.filter((value): value is string => typeof value === 'string');
    const address = addresses.at(-1);
    if (address && !isLoopbackHost(address)) {
      throw new Error(`Local simulation blocked outbound datagram to ${address}.`);
    }
    return originalDatagramSend.apply(this, args);
  } as typeof dgram.Socket.prototype.send;

  return () => {
    globalThis.fetch = originalFetch;
    net.Socket.prototype.connect = originalConnect;
    dns.lookup = originalLookup;
    dns.resolve = originalResolve;
    dgram.Socket.prototype.connect = originalDatagramConnect;
    dgram.Socket.prototype.send = originalDatagramSend;
  };
}
