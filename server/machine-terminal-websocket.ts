import { createRequire } from 'node:module';
import { chmodSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import type { IncomingMessage } from 'node:http';

import type { IPty } from 'node-pty';
import { WebSocketServer, WebSocket } from 'ws';

import {
  isProjectSpaceAuthRequired,
  readAuthSessionFromWebSocketRequest,
  runWithAuthSession
} from './local-auth-store';
import { ProjectSpaceAccessError } from './authorized-project-space-backend';
import type { MachineRecord, ProjectSpaceBackend } from '../src/shared/project-space-api';

interface TerminalClientMessage {
  cols?: number;
  data?: string;
  rows?: number;
  type: 'input' | 'resize';
}

const terminalPathPattern = /^\/api\/machines\/([^/]+)\/terminal$/;
const projectTerminalPathPattern = /^\/api\/projects\/terminal$/;
const terminalMaxPayloadBytes = 64 * 1024;
const terminalMaxQueuedBytes = 128 * 1024;
const terminalMaxQueuedMessages = 64;
const terminalColumnBounds = { fallback: 100, maximum: 500, minimum: 20 } as const;
const terminalRowBounds = { fallback: 28, maximum: 200, minimum: 8 } as const;
const shellCandidates = ['/bin/zsh', '/usr/bin/zsh', '/bin/bash', '/usr/bin/bash', '/bin/sh'];
const require = createRequire(import.meta.url);

function sendJson(socket: WebSocket, payload: unknown) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function parseMessage(data: WebSocket.RawData): TerminalClientMessage | undefined {
  try {
    return JSON.parse(data.toString('utf-8')) as TerminalClientMessage;
  } catch {
    return undefined;
  }
}

interface TerminalDimensionBounds {
  fallback: number;
  maximum: number;
  minimum: number;
}

function boundedDimension(value: string | null, bounds: TerminalDimensionBounds) {
  const parsed = Number(value ?? bounds.fallback);
  return Number.isFinite(parsed)
    ? Math.min(bounds.maximum, Math.max(bounds.minimum, Math.floor(parsed)))
    : bounds.fallback;
}

function isValidResizeDimension(value: unknown, bounds: TerminalDimensionBounds): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= bounds.minimum &&
    value <= bounds.maximum
  );
}

function decodeMachineId(pathname: string) {
  try {
    return decodeURIComponent(pathname.match(terminalPathPattern)?.[1] ?? '');
  } catch {
    throw new ProjectSpaceAccessError('Invalid machine identifier.');
  }
}

function rawDataBytes(data: WebSocket.RawData) {
  if (Array.isArray(data)) {
    return data.reduce((total, entry) => total + entry.byteLength, 0);
  }
  return data.byteLength;
}

function queueMessagesUntilAuthenticated(socket: WebSocket) {
  const messages: WebSocket.RawData[] = [];
  let queuedBytes = 0;
  const onMessage = (data: WebSocket.RawData) => {
    const nextBytes = rawDataBytes(data);
    if (
      messages.length >= terminalMaxQueuedMessages ||
      queuedBytes + nextBytes > terminalMaxQueuedBytes
    ) {
      socket.close(1009, 'Too much terminal input before authentication.');
      return;
    }
    queuedBytes += nextBytes;
    messages.push(data);
  };
  socket.on('message', onMessage);
  return { messages, onMessage };
}

function sanitizeEnv() {
  const env: Record<string, string> = {};
  const allowed = new Set([
    'HOME',
    'LANG',
    'LC_ALL',
    'LOGNAME',
    'PATH',
    'SHELL',
    'TERM',
    'TMPDIR',
    'TZ',
    'USER'
  ]);

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && (allowed.has(key) || key.startsWith('LC_'))) {
      env[key] = value;
    }
  }

  return {
    ...env,
    BASH_SILENCE_DEPRECATION_WARNING: '1',
    COLORTERM: 'truecolor',
    PS1: '\\h$ ',
    TERM: 'xterm-256color'
  };
}

function getCommandShell() {
  return process.env.SHELL ?? shellCandidates[0];
}

function getProjectCommandShell() {
  const bash = shellCandidates.find((candidate) => basename(candidate) === 'bash');

  return bash ?? getCommandShell();
}

function getProjectShellArgs(shell: string) {
  const shellName = basename(shell);

  if (shellName === 'zsh') {
    return ['-f'];
  }

  if (shellName === 'bash') {
    return ['--noprofile', '--norc', '-i'];
  }

  return [];
}

function ensureNodePtySpawnHelperExecutable() {
  try {
    const nodePtyRoot = dirname(require.resolve('node-pty/package.json'));
    const helperPath = join(
      nodePtyRoot,
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'spawn-helper'
    );

    if (existsSync(helperPath)) {
      chmodSync(helperPath, 0o755);
    }
  } catch {
    // node-pty can still work from source builds without a prebuilt spawn-helper.
  }
}

function isMachineConnected(machine: MachineRecord) {
  return machine.connector.status === 'local' || machine.connector.status === 'online';
}

function createMachineSshTarget(machine: MachineRecord) {
  const host = machine.network.localName ?? machine.name ?? machine.network.tailscaleIp;

  if (!host) {
    return '';
  }

  return machine.network.sshUser ? `${machine.network.sshUser}@${host}` : host;
}

async function createTerminalProcess(machine: MachineRecord, cols: number, rows: number) {
  ensureNodePtySpawnHelperExecutable();
  const { spawn: spawnPty } = await import('node-pty');

  const ptyOptions = {
    cols,
    cwd: homedir(),
    env: sanitizeEnv(),
    name: 'xterm-256color',
    rows
  };

  if (machine.connector.status === 'local' || machine.kind === 'local') {
    const shell = getCommandShell();
    return spawnPty(shell, ['-l'], ptyOptions);
  }

  const target = createMachineSshTarget(machine);

  if (!target) {
    throw new Error(`${machine.name} does not have an SSH target.`);
  }

  return spawnPty(
    'ssh',
    ['-tt', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', target],
    ptyOptions
  );
}

async function createProjectTerminalProcess(cwd: string, cols: number, rows: number) {
  const resolvedCwd = resolve(cwd);

  if (!existsSync(resolvedCwd) || !statSync(resolvedCwd).isDirectory()) {
    throw new Error(`${resolvedCwd} is not a directory.`);
  }

  ensureNodePtySpawnHelperExecutable();
  const { spawn: spawnPty } = await import('node-pty');
  const shell = getProjectCommandShell();

  return spawnPty(shell, getProjectShellArgs(shell), {
    cols,
    cwd: resolvedCwd,
    env: sanitizeEnv(),
    name: 'xterm-256color',
    rows
  });
}

export function applyTerminalMessage(pty: IPty, message: TerminalClientMessage | undefined) {
  if (!message) {
    return;
  }

  if (message.type === 'input' && typeof message.data === 'string') {
    pty.write(message.data);
    return;
  }

  if (
    message.type === 'resize' &&
    isValidResizeDimension(message.cols, terminalColumnBounds) &&
    isValidResizeDimension(message.rows, terminalRowBounds)
  ) {
    pty.resize(message.cols, message.rows);
  }
}

function attachPtyToSocket(socket: WebSocket, pty: IPty) {
  const dataDisposable = pty.onData((data) => {
    sendJson(socket, {
      data,
      type: 'output'
    });
  });
  const exitDisposable = pty.onExit(({ exitCode, signal }) => {
    sendJson(socket, {
      exitCode,
      signal,
      type: 'exit'
    });
    socket.close();
  });

  socket.on('message', (data) => {
    try {
      applyTerminalMessage(pty, parseMessage(data));
    } catch {
      socket.close(1011, 'Terminal input failed.');
    }
  });

  socket.on('close', () => {
    dataDisposable.dispose();
    exitDisposable.dispose();
    pty.kill();
  });
}

export function createMachineTerminalUpgradeHandler(backend: ProjectSpaceBackend) {
  const webSocketServer = new WebSocketServer({
    maxPayload: terminalMaxPayloadBytes,
    noServer: true
  });

  webSocketServer.on('connection', async (socket, request) => {
    const queue = queueMessagesUntilAuthenticated(socket);

    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const machineId = decodeMachineId(url.pathname);
      const cols = boundedDimension(url.searchParams.get('cols'), terminalColumnBounds);
      const rows = boundedDimension(url.searchParams.get('rows'), terminalRowBounds);
      const authSession = await readAuthSessionFromWebSocketRequest(request, url);

      if (isProjectSpaceAuthRequired() && !authSession) {
        sendJson(socket, {
          data: 'Login required.\r\n',
          type: 'output'
        });
        socket.close();
        return;
      }

      await runWithAuthSession(authSession, async () => {
      const overview = await backend.getConnectorOverview();
      const machine = overview.machines.find((entry) => entry.id === machineId);

      if (!machine) {
        sendJson(socket, {
          data: `Machine ${machineId} was not found.\r\n`,
          type: 'output'
        });
        socket.close(
          isProjectSpaceAuthRequired() ? 1008 : 1000,
          isProjectSpaceAuthRequired() ? 'Machine access denied.' : 'Machine not found.'
        );
        return;
      }

      if (!isMachineConnected(machine)) {
        sendJson(socket, {
          data: `${machine.name} is ${machine.connector.status}.\r\n`,
          type: 'output'
        });
        socket.close();
        return;
      }

      const pty = await createTerminalProcess(machine, cols, rows);
      socket.off('message', queue.onMessage);
      attachPtyToSocket(socket, pty);

      for (const message of queue.messages) {
        applyTerminalMessage(pty, parseMessage(message));
      }
      });
    } catch (error) {
      socket.off('message', queue.onMessage);
      sendJson(socket, {
        data: `${error instanceof Error ? error.message : 'Could not start terminal.'}\r\n`,
        type: 'output'
      });
      socket.close(
        error instanceof ProjectSpaceAccessError ? 1008 : 1011,
        error instanceof ProjectSpaceAccessError ? 'Machine access denied.' : 'Terminal failed.'
      );
    }
  });

  return function handleMachineTerminalUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (!terminalPathPattern.test(url.pathname)) {
      return false;
    }

    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit('connection', webSocket, request);
    });

    return true;
  };
}

export function createProjectTerminalUpgradeHandler() {
  const webSocketServer = new WebSocketServer({
    maxPayload: terminalMaxPayloadBytes,
    noServer: true
  });

  webSocketServer.on('connection', async (socket, request) => {
    const queue = queueMessagesUntilAuthenticated(socket);
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const cwd = url.searchParams.get('cwd') ?? '';
    const cols = boundedDimension(url.searchParams.get('cols'), terminalColumnBounds);
    const rows = boundedDimension(url.searchParams.get('rows'), terminalRowBounds);

    try {
      const authSession = await readAuthSessionFromWebSocketRequest(request, url);

      if (isProjectSpaceAuthRequired() && !authSession) {
        sendJson(socket, {
          data: 'Login required.\r\n',
          type: 'output'
        });
        socket.close();
        return;
      }

      if (isProjectSpaceAuthRequired()) {
        sendJson(socket, {
          data: 'Project terminals are disabled in the hosted multi-user app.\r\n',
          type: 'output'
        });
        socket.close(1008, 'Hosted project terminals are disabled.');
        return;
      }

      await runWithAuthSession(authSession, async () => {
        const pty = await createProjectTerminalProcess(cwd, cols, rows);
        socket.off('message', queue.onMessage);
        attachPtyToSocket(socket, pty);

        for (const message of queue.messages) {
          applyTerminalMessage(pty, parseMessage(message));
        }
      });
    } catch (error) {
      socket.off('message', queue.onMessage);
      sendJson(socket, {
        data: `${error instanceof Error ? error.message : 'Could not start terminal.'}\r\n`,
        type: 'output'
      });
      socket.close();
    }
  });

  return function handleProjectTerminalUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (!projectTerminalPathPattern.test(url.pathname)) {
      return false;
    }

    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit('connection', webSocket, request);
    });

    return true;
  };
}
