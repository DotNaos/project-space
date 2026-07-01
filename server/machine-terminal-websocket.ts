import { createRequire } from 'node:module';
import { chmodSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Duplex } from 'node:stream';
import type { IncomingMessage } from 'node:http';

import type { IPty } from 'node-pty';
import { WebSocketServer, WebSocket } from 'ws';

import {
  isProjectSpaceAuthRequired,
  readAuthSessionFromUrl,
  runWithAuthSession
} from './local-auth-store';
import type { MachineRecord, ProjectSpaceBackend } from '../src/shared/project-space-api';

interface TerminalClientMessage {
  cols?: number;
  data?: string;
  rows?: number;
  type: 'input' | 'resize';
}

const terminalPathPattern = /^\/api\/machines\/([^/]+)\/terminal$/;
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

function sanitizeEnv() {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }

  return {
    ...env,
    COLORTERM: 'truecolor',
    TERM: 'xterm-256color'
  };
}

function getCommandShell() {
  return process.env.SHELL ?? shellCandidates[0];
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

function applyTerminalMessage(pty: IPty, message: TerminalClientMessage | undefined) {
  if (!message) {
    return;
  }

  if (message.type === 'input' && typeof message.data === 'string') {
    pty.write(message.data);
    return;
  }

  if (
    message.type === 'resize' &&
    typeof message.cols === 'number' &&
    typeof message.rows === 'number'
  ) {
    pty.resize(Math.max(20, message.cols), Math.max(8, message.rows));
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
    applyTerminalMessage(pty, parseMessage(data));
  });

  socket.on('close', () => {
    dataDisposable.dispose();
    exitDisposable.dispose();
    pty.kill();
  });
}

export function createMachineTerminalUpgradeHandler(backend: ProjectSpaceBackend) {
  const webSocketServer = new WebSocketServer({
    noServer: true
  });

  webSocketServer.on('connection', async (socket, request) => {
    const queuedMessages: WebSocket.RawData[] = [];
    const queueMessage = (data: WebSocket.RawData) => {
      queuedMessages.push(data);
    };
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const machineId = decodeURIComponent(url.pathname.match(terminalPathPattern)?.[1] ?? '');
    const cols = Math.max(20, Number(url.searchParams.get('cols') ?? 100));
    const rows = Math.max(8, Number(url.searchParams.get('rows') ?? 28));

    socket.on('message', queueMessage);

    try {
      const authSession = await readAuthSessionFromUrl(url);

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
        socket.close();
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
      socket.off('message', queueMessage);
      attachPtyToSocket(socket, pty);

      for (const message of queuedMessages) {
        applyTerminalMessage(pty, parseMessage(message));
      }
      });
    } catch (error) {
      socket.off('message', queueMessage);
      sendJson(socket, {
        data: `${error instanceof Error ? error.message : 'Could not start terminal.'}\r\n`,
        type: 'output'
      });
      socket.close();
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
