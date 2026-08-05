import { spawn } from 'node:child_process';

import type { CodexChildProcess, CodexProcessFactory } from '../codex-sessions/contracts';
import { resolveCodexBinary } from '../codex-sessions/binary-resolver';
import { CODEX_ATTACH_MAXIMUM_MESSAGE_BYTES } from '../codex-sessions/connector-channel';
import {
  UnixWebSocket,
  type UnixWebSocketData
} from '../codex-sessions/unix-websocket';
import { codexAppServerSocketPath } from '../codex-sessions/websocket-transport';

export type ConnectorCodexAttachRelayCloseCode =
  | 'cancelled'
  | 'process_exited'
  | 'protocol_error'
  | 'unavailable';

export interface ConnectorCodexAttachRelay {
  close(code?: ConnectorCodexAttachRelayCloseCode): void;
  send(message: string): Promise<void>;
}

interface ConnectorCodexAttachRelayOptions {
  binaryPath?: string;
  connectTimeoutMs?: number;
  daemonSocketPath?: string;
  idleTimeoutMs?: number;
  maximumLifetimeMs?: number;
  onClose(code: ConnectorCodexAttachRelayCloseCode): void;
  onMessage(message: string): void;
  processFactory?: CodexProcessFactory;
}

type SpawnAwareCodexChild = CodexChildProcess & {
  once(event: 'spawn', listener: () => void): SpawnAwareCodexChild;
  pid?: number;
};

const defaultIdleTimeoutMs = 30 * 60_000;
const defaultMaximumLifetimeMs = 12 * 60 * 60_000;
const maximumPendingInputBytes = 2 * CODEX_ATTACH_MAXIMUM_MESSAGE_BYTES;

const defaultProcessFactory: CodexProcessFactory = ({ args, command, env }) =>
  spawn(command, [...args], {
    env,
    stdio: 'pipe',
    windowsHide: true
  }) as CodexChildProcess;

export async function createConnectorCodexAttachRelay(
  options: ConnectorCodexAttachRelayOptions
): Promise<ConnectorCodexAttachRelay> {
  if (!options.processFactory && !options.binaryPath) {
    return WebSocketCodexAttachRelay.connect(options);
  }
  const command = options.binaryPath ?? resolveCodexBinary().path;
  if (!command) throw new Error('Codex App Server is unavailable.');
  const env = { ...process.env };
  delete env.PROJECT_CODEX_ATTACH_TOKEN;
  const child = (options.processFactory ?? defaultProcessFactory)({
    args: ['app-server', '--listen', 'stdio://'],
    command,
    env
  }) as SpawnAwareCodexChild;
  const relay = new StdioCodexAttachRelay(child, options);
  await relay.ready();
  return relay;
}

class WebSocketCodexAttachRelay implements ConnectorCodexAttachRelay {
  private closed = false;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private readonly lifetimeTimer: ReturnType<typeof setTimeout>;
  private queuedInputBytes = 0;
  private writeQueue = Promise.resolve();

  private constructor(
    private readonly socket: UnixWebSocket,
    private readonly options: ConnectorCodexAttachRelayOptions
  ) {
    socket.on('message', (data, isBinary) => this.handleOutput(data, isBinary));
    socket.once('error', () => this.finish('unavailable'));
    socket.once('close', () => this.finish('process_exited'));
    this.lifetimeTimer = setTimeout(
      () => this.close('cancelled'),
      boundedDuration(options.maximumLifetimeMs, defaultMaximumLifetimeMs)
    );
    this.lifetimeTimer.unref?.();
    this.refreshIdleTimer();
  }

  static connect(options: ConnectorCodexAttachRelayOptions) {
    const socketPath = options.daemonSocketPath ?? codexAppServerSocketPath();
    const connectTimeoutMs = boundedDuration(options.connectTimeoutMs, 5_000);
    const socket = new UnixWebSocket(socketPath, CODEX_ATTACH_MAXIMUM_MESSAGE_BYTES);
    return new Promise<ConnectorCodexAttachRelay>((resolve, reject) => {
      socket.on('error', () => {
        // Suppress private socket diagnostics; the relay reports only a bounded state.
      });
      const fail = () => {
        clearTimeout(timeout);
        reject(new Error('Managed Codex App Server is unavailable.'));
      };
      const timeout = setTimeout(() => {
        socket.terminate();
        fail();
      }, connectTimeoutMs);
      timeout.unref?.();
      socket.once('error', fail);
      socket.once('open', () => {
        clearTimeout(timeout);
        socket.off('error', fail);
        resolve(new WebSocketCodexAttachRelay(socket, options));
      });
    });
  }

  send(message: string) {
    if (this.closed) return Promise.reject(new Error('Codex attach relay is closed.'));
    const bytes = Buffer.byteLength(message, 'utf8');
    if (!validProtocolMessage(message) ||
      this.queuedInputBytes + bytes > maximumPendingInputBytes) {
      this.close('protocol_error');
      return Promise.reject(new Error('Codex attach input is invalid.'));
    }
    this.queuedInputBytes += bytes;
    const write = this.writeQueue.then(() => new Promise<void>((resolve, reject) => {
      this.socket.send(message, (error) => error ? reject(error) : resolve());
    }));
    this.writeQueue = write.catch(() => undefined);
    return write.finally(() => {
      this.queuedInputBytes -= bytes;
      this.refreshIdleTimer();
    });
  }

  close(code: ConnectorCodexAttachRelayCloseCode = 'cancelled') {
    if (this.closed) return;
    this.finish(code);
    this.socket.close();
  }

  private handleOutput(data: UnixWebSocketData, isBinary: boolean) {
    if (this.closed || isBinary) {
      if (isBinary) this.close('protocol_error');
      return;
    }
    const message = Buffer.isBuffer(data)
      ? data.toString('utf8')
      : String(data);
    if (!validProtocolMessage(message)) {
      this.close('protocol_error');
      return;
    }
    try {
      this.options.onMessage(message);
      this.refreshIdleTimer();
    } catch {
      this.close('protocol_error');
    }
  }

  private refreshIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(
      () => this.close('cancelled'),
      boundedDuration(this.options.idleTimeoutMs, defaultIdleTimeoutMs)
    );
    this.idleTimer.unref?.();
  }

  private finish(code: ConnectorCodexAttachRelayCloseCode) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.lifetimeTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.options.onClose(code);
  }
}

class StdioCodexAttachRelay implements ConnectorCodexAttachRelay {
  private closed = false;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private readonly lifetimeTimer: ReturnType<typeof setTimeout>;
  private pendingOutput = Buffer.alloc(0);
  private queuedInputBytes = 0;
  private writeQueue = Promise.resolve();

  constructor(
    private readonly child: SpawnAwareCodexChild,
    private readonly options: ConnectorCodexAttachRelayOptions
  ) {
    child.stdout.on('data', (chunk) => this.handleOutput(chunk));
    child.stderr.on('data', () => {
      // App Server diagnostics may contain local paths or secrets.
    });
    child.on('error', () => this.finish('unavailable'));
    child.once('close', () => this.finish('process_exited'));
    this.lifetimeTimer = setTimeout(
      () => this.close('cancelled'),
      boundedDuration(options.maximumLifetimeMs, defaultMaximumLifetimeMs)
    );
    this.lifetimeTimer.unref?.();
    this.refreshIdleTimer();
  }

  ready() {
    if (typeof this.child.pid === 'number' && this.child.pid > 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const resolveSpawn = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const rejectSpawn = () => {
        if (settled) return;
        settled = true;
        reject(new Error('Codex App Server could not start.'));
      };
      this.child.once('spawn', resolveSpawn);
      this.child.on('error', rejectSpawn);
    });
  }

  send(message: string) {
    if (this.closed) return Promise.reject(new Error('Codex attach relay is closed.'));
    const bytes = Buffer.byteLength(message, 'utf8');
    if (!validProtocolMessage(message) ||
      this.queuedInputBytes + bytes > maximumPendingInputBytes) {
      this.close('protocol_error');
      return Promise.reject(new Error('Codex attach input is invalid.'));
    }
    this.queuedInputBytes += bytes;
    const write = this.writeQueue.then(() => this.write(`${message}\n`));
    this.writeQueue = write.catch(() => undefined);
    return write.finally(() => {
      this.queuedInputBytes -= bytes;
      this.refreshIdleTimer();
    });
  }

  close(code: ConnectorCodexAttachRelayCloseCode = 'cancelled') {
    if (this.closed) return;
    this.finish(code);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGTERM');
      const killTimer = setTimeout(() => {
        if (this.child.exitCode === null && this.child.signalCode === null) {
          this.child.kill('SIGKILL');
        }
      }, 2_000);
      killTimer.unref?.();
    }
  }

  private handleOutput(value: unknown) {
    if (this.closed) return;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    if (this.pendingOutput.byteLength + chunk.byteLength >
      CODEX_ATTACH_MAXIMUM_MESSAGE_BYTES + 1) {
      this.close('protocol_error');
      return;
    }
    this.pendingOutput = Buffer.concat([this.pendingOutput, chunk]);
    while (true) {
      const newline = this.pendingOutput.indexOf(0x0a);
      if (newline < 0) break;
      let line = this.pendingOutput.subarray(0, newline);
      this.pendingOutput = this.pendingOutput.subarray(newline + 1);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      if (line.byteLength === 0) continue;
      let message: string;
      try {
        message = new TextDecoder('utf-8', { fatal: true }).decode(line);
      } catch {
        this.close('protocol_error');
        return;
      }
      if (!validProtocolMessage(message)) {
        this.close('protocol_error');
        return;
      }
      try {
        this.options.onMessage(message);
      } catch {
        this.close('protocol_error');
        return;
      }
      this.refreshIdleTimer();
    }
  }

  private write(value: string) {
    return new Promise<void>((resolve, reject) => {
      this.child.stdin.write(value, (error?: Error | null) => {
        if (error) {
          this.close('unavailable');
          reject(new Error('Codex App Server input failed.'));
        } else {
          resolve();
        }
      });
    });
  }

  private refreshIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(
      () => this.close('cancelled'),
      boundedDuration(this.options.idleTimeoutMs, defaultIdleTimeoutMs)
    );
    this.idleTimer.unref?.();
  }

  private finish(code: ConnectorCodexAttachRelayCloseCode) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.lifetimeTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.pendingOutput = Buffer.alloc(0);
    this.options.onClose(code);
  }
}

function validProtocolMessage(message: string) {
  if (!message || Buffer.byteLength(message, 'utf8') > CODEX_ATTACH_MAXIMUM_MESSAGE_BYTES) {
    return false;
  }
  try {
    const parsed = JSON.parse(message);
    return Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function boundedDuration(value: number | undefined, fallback: number) {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}
