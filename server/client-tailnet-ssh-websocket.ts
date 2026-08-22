import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { IPty } from 'node-pty';
import { WebSocketServer, WebSocket } from 'ws';

import {
  isProjectSpaceAuthRequired,
  readAuthSessionFromWebSocketRequest
} from './local-auth-store';
import { createCommandTailscaleInventorySource } from './tailscale-inventory/command-source';
import { isTailscaleAddress } from './tailscale-inventory/status-decoder';
import type { TailscaleInventorySource } from './tailscale-inventory/source';

interface ClientSshMessage {
  cols?: number;
  data?: string;
  rows?: number;
  type: 'connect' | 'input' | 'resize';
  username?: string;
}

interface SpawnedPty extends Pick<IPty, 'kill' | 'onData' | 'onExit' | 'resize' | 'write'> {}

const routePattern = /^\/api\/client\/tailnet\/devices\/([^/]+)\/ssh$/;
const identifier = /^[A-Za-z0-9._:-]{1,256}$/;
const usernamePattern = /^[A-Za-z_][A-Za-z0-9._-]{0,63}$/;
const maxPayloadBytes = 64 * 1024;
const maxBufferedOutputBytes = 256 * 1024;
const connectTimeoutMs = 10_000;
const columnBounds = { maximum: 500, minimum: 20 } as const;
const rowBounds = { maximum: 200, minimum: 8 } as const;
const execFileAsync = promisify(execFile);

export interface ClientTailnetSshTarget {
  address: string;
  deviceId: string;
  deviceName: string;
}

function parseDeviceId(pathname: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname.match(routePattern)?.[1] ?? '');
  } catch {
    return undefined;
  }
  return identifier.test(decoded) ? decoded : undefined;
}

function parseMessage(data: WebSocket.RawData): ClientSshMessage | undefined {
  try {
    const value = JSON.parse(data.toString('utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as ClientSshMessage
      : undefined;
  } catch {
    return undefined;
  }
}

function validDimension(value: unknown, bounds: { maximum: number; minimum: number }) {
  return typeof value === 'number' && Number.isInteger(value) &&
    value >= bounds.minimum && value <= bounds.maximum;
}

function send(socket: WebSocket, payload: unknown) {
  if (socket.readyState !== WebSocket.OPEN) return false;
  if (socket.bufferedAmount > maxBufferedOutputBytes) {
    socket.close(1009, 'Terminal output exceeded the local bridge limit.');
    return false;
  }
  socket.send(JSON.stringify(payload));
  return true;
}

function sendAndClose(socket: WebSocket, payload: unknown, code: number, reason: string) {
  if (socket.readyState !== WebSocket.OPEN) {
    socket.close(code, reason);
    return;
  }
  socket.send(JSON.stringify(payload), () => {
    setTimeout(() => socket.close(code, reason), 100);
  });
}

export function isSameOriginClientSshRequest(request: IncomingMessage) {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      parsed.host.toLowerCase() === host.toLowerCase() &&
      parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
}

export async function resolveLocalTailnetSshTarget(
  source: TailscaleInventorySource,
  deviceSelector: string
): Promise<ClientTailnetSshTarget> {
  const observed = await source.observe('local-client');
  if (!observed.available) {
    throw new Error('This device cannot be reached because local Tailscale is unavailable.');
  }
  const devices = observed.snapshot.devices.filter(({ id, observedName }) =>
    id === deviceSelector || observedName === deviceSelector
  );
  if (devices.length === 0) {
    throw new Error('This device is not present in the local Tailnet inventory.');
  }
  if (devices.length > 1) {
    throw new Error('This device name is ambiguous in the local Tailnet inventory.');
  }
  const [device] = devices;
  if (!device) throw new Error('This device is not present in the local Tailnet inventory.');
  if (!device.online) {
    throw new Error('This device is offline in the fresh local Tailnet inventory.');
  }
  const address = device.addresses.find((candidate) =>
    isTailscaleAddress(candidate) && candidate.includes('.')
  ) ?? device.addresses.find(isTailscaleAddress);
  if (!address) {
    throw new Error('This device has no valid Tailnet address.');
  }
  return {
    address,
    deviceId: device.id,
    deviceName: device.observedName ?? device.id
  };
}

export function sshArgsForTailnetTarget(target: ClientTailnetSshTarget, username: string) {
  if (!usernamePattern.test(username) || !isTailscaleAddress(target.address)) {
    throw new Error('The SSH target is invalid.');
  }
  return [
    '-F', '/dev/null',
    '-o', 'BatchMode=yes',
    '-o', 'CanonicalizeHostname=no',
    '-o', 'CheckHostIP=yes',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'ConnectTimeout=8',
    '-o', 'ConnectionAttempts=1',
    '-o', 'ForwardAgent=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'PasswordAuthentication=no',
    '-o', 'PermitLocalCommand=no',
    '-o', 'PreferredAuthentications=publickey',
    '-o', 'ProxyCommand=none',
    '-o', 'ProxyJump=none',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${join(homedir(), '.ssh', 'known_hosts')}`,
    '-tt',
    '--', `${username}@${target.address}`
  ];
}

function sanitizedEnvironment() {
  const environment: Record<string, string> = {};
  for (const key of ['HOME', 'LANG', 'LC_ALL', 'LOGNAME', 'PATH', 'SSH_AUTH_SOCK', 'TMPDIR', 'TZ', 'USER']) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  return { ...environment, COLORTERM: 'truecolor', TERM: 'xterm-256color' };
}

async function spawnSshPty(target: ClientTailnetSshTarget, username: string): Promise<SpawnedPty> {
  const { spawn } = await import('node-pty');
  return spawn('ssh', sshArgsForTailnetTarget(target, username), {
    cols: 100,
    cwd: homedir(),
    env: sanitizedEnvironment(),
    name: 'xterm-256color',
    rows: 28
  });
}

function sshPreflightArgs(target: ClientTailnetSshTarget, username: string) {
  const interactive = sshArgsForTailnetTarget(target, username);
  return [...interactive.filter((argument) => argument !== '-tt'), 'true'];
}

function preflightError(error: unknown) {
  const record = error && typeof error === 'object' ? error as {
    code?: unknown;
    killed?: unknown;
    signal?: unknown;
    stderr?: unknown;
  } : {};
  const stderr = typeof record.stderr === 'string' ? record.stderr.toLowerCase() : '';
  if (stderr.includes('host key verification failed') || stderr.includes('remote host identification has changed')) {
    return new Error('The saved SSH host key changed. Verify the device before replacing its local known_hosts entry.');
  }
  if (stderr.includes('permission denied')) {
    return new Error('The local SSH agent has no key accepted for this username.');
  }
  if (stderr.includes('connection refused')) {
    return new Error('SSH is not listening on this device.');
  }
  if (record.code === 'ETIMEDOUT' || record.killed === true || record.signal === 'SIGTERM' ||
    stderr.includes('operation timed out') || stderr.includes('connection timed out')) {
    return new Error('The SSH connection timed out over the Tailnet.');
  }
  return new Error('The SSH preflight failed before an interactive session was opened.');
}

async function verifySshTarget(target: ClientTailnetSshTarget, username: string) {
  try {
    await execFileAsync('ssh', sshPreflightArgs(target, username), {
      encoding: 'utf8',
      env: sanitizedEnvironment(),
      maxBuffer: 16 * 1024,
      timeout: connectTimeoutMs,
      windowsHide: true
    });
  } catch (error) {
    throw preflightError(error);
  }
}

export function attachClientSshSession(socket: WebSocket, pty: SpawnedPty) {
  const output = pty.onData((data) => {
    send(socket, { data, type: 'output' });
  });
  const exit = pty.onExit(({ exitCode, signal }) => {
    sendAndClose(socket, { exitCode, signal, type: 'exit' }, 1000, 'SSH session ended.');
  });
  socket.on('message', (raw) => {
    const message = parseMessage(raw);
    try {
      if (message?.type === 'input' && typeof message.data === 'string') {
        pty.write(message.data);
      } else if (message?.type === 'resize' &&
        validDimension(message.cols, columnBounds) && validDimension(message.rows, rowBounds)) {
        pty.resize(message.cols as number, message.rows as number);
      }
    } catch {
      socket.close(1011, 'SSH terminal input failed.');
    }
  });
  socket.on('close', () => {
    output.dispose();
    exit.dispose();
    pty.kill();
  });
}

export function createClientTailnetSshUpgradeHandler(options: {
  source?: TailscaleInventorySource;
  spawn?: (target: ClientTailnetSshTarget, username: string) => Promise<SpawnedPty>;
  verify?: (target: ClientTailnetSshTarget, username: string) => Promise<void>;
} = {}) {
  const source = options.source ?? createCommandTailscaleInventorySource();
  const spawn = options.spawn ?? spawnSshPty;
  const verify = options.verify ?? verifySshTarget;
  const webSocketServer = new WebSocketServer({ maxPayload: maxPayloadBytes, noServer: true });

  webSocketServer.on('connection', async (socket, request) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const deviceId = parseDeviceId(url.pathname);
    if (!deviceId || !isSameOriginClientSshRequest(request)) {
      socket.close(1008, 'Client SSH access denied.');
      return;
    }
    const session = readAuthSessionFromWebSocketRequest(request, url);

    let initialized = false;
    const timeout = setTimeout(() => {
      if (!initialized) socket.close(1008, 'SSH connection details were not received.');
    }, connectTimeoutMs);
    const connect = async (raw: WebSocket.RawData) => {
      socket.off('message', connect);
      clearTimeout(timeout);
      const message = parseMessage(raw);
      const username = message?.type === 'connect' ? message.username : undefined;
      if (!username || !usernamePattern.test(username)) {
        socket.close(1008, 'The SSH username is invalid.');
        return;
      }
      try {
        if (isProjectSpaceAuthRequired() && !await session) {
          socket.close(1008, 'Login required.');
          return;
        }
        const target = await resolveLocalTailnetSshTarget(source, deviceId);
        await verify(target, username);
        const pty = await spawn(target, username);
        initialized = true;
        attachClientSshSession(socket, pty);
        send(socket, {
          address: target.address,
          deviceName: target.deviceName,
          type: 'connected'
        });
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : 'The SSH session could not start.';
        sendAndClose(socket, {
          message,
          type: 'error'
        }, 1011, message);
      }
    };
    socket.on('message', connect);
    socket.on('close', () => clearTimeout(timeout));
  });

  return function handleClientTailnetSshUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!routePattern.test(url.pathname)) return false;
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit('connection', webSocket, request);
    });
    return true;
  };
}
