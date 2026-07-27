import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { WebSocket, type RawData } from 'ws';

import type { CodexRpcId } from './contracts';
import { CodexOperationUncertainError } from './operation-ledger';
import {
  CodexAppServerProtocolError,
  CodexAppServerRequestCancelledError,
  CodexAppServerRequestError,
  type CodexAppServerTransport,
  type RpcMessage
} from './stdio-transport';

type PendingCall = {
  method: string;
  reject(error: Error): void;
  resolve(result: unknown): void;
  signal?: AbortSignal;
  signalAbort?: () => void;
  timeout: ReturnType<typeof setTimeout>;
};

const maximumMessageBytes = 16 * 1024 * 1024;
const defaultConnectTimeoutMs = 5_000;
const defaultRpcTimeoutMs = 30_000;
const uncertainMethods = new Set([
  'thread/resume',
  'thread/start',
  'turn/interrupt',
  'turn/start'
]);

export function codexAppServerSocketPath(
  environment: NodeJS.ProcessEnv = process.env
) {
  return join(resolveCodexHome(environment), 'app-server-control', 'app-server-control.sock');
}

export function resolveCodexHome(
  environment: NodeJS.ProcessEnv = process.env
) {
  const configured = environment.CODEX_HOME;
  return configured && configured === configured.trim() &&
    isAbsolute(configured) && !/[\u0000\r\n]/.test(configured)
    ? configured
    : join(homedir(), '.codex');
}

export class CodexWebSocketTransport implements CodexAppServerTransport {
  private nextId = 1;
  private open = true;
  private readonly pending = new Map<number, PendingCall>();

  private constructor(
    private readonly socket: WebSocket,
    private readonly onMessage: (message: RpcMessage) => void,
    private readonly onTransportClose: () => void,
    private readonly rpcTimeoutMs: number
  ) {
    socket.on('message', (data, isBinary) => this.handleMessage(data, isBinary));
    socket.once('close', () => this.handleClose());
    socket.once('error', () => this.handleClose());
  }

  static connect(options: {
    onClose?: () => void;
    onMessage: (message: RpcMessage) => void;
    connectTimeoutMs?: number;
    rpcTimeoutMs?: number;
    socketPath?: string;
    websocketFactory?: (socketPath: string) => WebSocket;
  }) {
    const socketPath = options.socketPath ?? codexAppServerSocketPath();
    const connectTimeoutMs = boundedTimeout(options.connectTimeoutMs, defaultConnectTimeoutMs);
    const socket = options.websocketFactory?.(socketPath) ?? new WebSocket(unixWebSocketUrl(socketPath), {
      handshakeTimeout: connectTimeoutMs,
      maxPayload: maximumMessageBytes,
      perMessageDeflate: false
    });
    return new Promise<CodexWebSocketTransport>((resolve, reject) => {
      socket.on('error', () => {
        // Connection details may contain private local paths; callers receive a bounded error.
      });
      const onError = () => {
        clearTimeout(timeout);
        reject(new CodexOperationUncertainError(
          'The managed Codex app-server is unavailable.'
        ));
      };
      const timeout = setTimeout(() => {
        socket.terminate();
        onError();
      }, connectTimeoutMs);
      timeout.unref?.();
      socket.once('error', onError);
      socket.once('open', () => {
        clearTimeout(timeout);
        socket.off('error', onError);
        resolve(new CodexWebSocketTransport(
          socket,
          options.onMessage,
          options.onClose ?? (() => undefined),
          boundedTimeout(options.rpcTimeoutMs, defaultRpcTimeoutMs)
        ));
      });
    });
  }

  get isOpen() {
    return this.open && this.socket.readyState === WebSocket.OPEN;
  }

  async initialize(options: { signal?: AbortSignal } = {}) {
    await this.call('initialize', {
      capabilities: { experimentalApi: true },
      clientInfo: {
        name: 'project-space',
        title: 'Project Space',
        version: '0.4.0'
      }
    }, options);
    await this.write({ method: 'initialized', params: null });
  }

  call<Result>(
    method: string,
    params?: unknown,
    options: { signal?: AbortSignal } = {}
  ): Promise<Result> {
    if (!this.isOpen) {
      return Promise.reject(new CodexOperationUncertainError('Codex app-server is unavailable.'));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new CodexAppServerRequestCancelledError());
    }
    const id = this.nextId++;
    return new Promise<Result>((resolve, reject) => {
      const signalAbort = options.signal ? () => this.cancelCall(id) : undefined;
      const timeout = setTimeout(() => this.timeoutCall(id), this.rpcTimeoutMs);
      timeout.unref?.();
      this.pending.set(id, {
        method,
        reject,
        resolve: (result) => resolve(result as Result),
        signal: options.signal,
        signalAbort,
        timeout
      });
      signalAbort && options.signal?.addEventListener('abort', signalAbort, { once: true });
      this.write(params === undefined ? { id, method } : { id, method, params }).catch(() => {
        this.takePending(id)?.reject(
          new CodexOperationUncertainError('Codex app-server disconnected during the request.')
        );
      });
    });
  }

  respond(id: CodexRpcId, result: unknown) {
    return this.write({ id, result });
  }

  async close() {
    if (!this.open) return;
    this.open = false;
    this.rejectPending('Codex app-server closed during the request.');
    if (this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
  }

  private handleMessage(data: RawData, isBinary: boolean) {
    if (!this.open || isBinary) {
      if (isBinary) this.failProtocol();
      return;
    }
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    if (bytes.byteLength > maximumMessageBytes) {
      this.failProtocol();
      return;
    }
    let message: RpcMessage;
    try {
      message = JSON.parse(bytes.toString('utf8')) as RpcMessage;
    } catch {
      this.failProtocol();
      return;
    }
    if (!message || typeof message !== 'object') {
      this.failProtocol();
      return;
    }
    if (typeof message.id === 'number' && !message.method) {
      const pending = this.takePending(message.id);
      if (!pending) return;
      if (message.error) pending.reject(new CodexAppServerRequestError(message.error.code));
      else if ('result' in message) pending.resolve(message.result);
      else pending.reject(new CodexAppServerProtocolError('Codex app-server returned invalid data.'));
      return;
    }
    if (typeof message.method === 'string') this.onMessage(message);
  }

  private failProtocol() {
    if (!this.open) return;
    this.open = false;
    for (const pending of this.pending.values()) {
      pending.reject(uncertainMethods.has(pending.method)
        ? new CodexOperationUncertainError(
            'Codex app-server returned invalid data after a mutation was sent.'
          )
        : new CodexAppServerProtocolError('Codex app-server returned invalid data.'));
    }
    this.clearPendingListeners();
    this.pending.clear();
    this.onTransportClose();
    this.socket.terminate();
  }

  private handleClose() {
    if (!this.open) return;
    this.open = false;
    this.rejectPending('Codex app-server disconnected during the request.');
    this.onTransportClose();
  }

  private write(message: RpcMessage) {
    if (!this.isOpen) {
      return Promise.reject(new CodexOperationUncertainError('Codex app-server is unavailable.'));
    }
    return new Promise<void>((resolve, reject) => {
      this.socket.send(JSON.stringify(message), (error) => error ? reject(error) : resolve());
    });
  }

  private cancelCall(id: number) {
    const pending = this.takePending(id);
    if (!pending) return;
    pending.reject(new CodexAppServerRequestCancelledError());
    void this.write({ method: '$/cancelRequest', params: { id } }).catch(() => undefined);
  }

  private timeoutCall(id: number) {
    const pending = this.takePending(id);
    if (!pending) return;
    pending.reject(new CodexOperationUncertainError(
      `Codex app-server did not confirm ${pending.method} within the request deadline.`
    ));
    void this.write({ method: '$/cancelRequest', params: { id } }).catch(() => undefined);
  }

  private takePending(id: number) {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    clearTimeout(pending.timeout);
    if (pending.signalAbort) pending.signal?.removeEventListener('abort', pending.signalAbort);
    return pending;
  }

  private rejectPending(message: string) {
    for (const pending of this.pending.values()) {
      pending.reject(new CodexOperationUncertainError(message));
    }
    this.clearPendingListeners();
    this.pending.clear();
  }

  private clearPendingListeners() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      if (pending.signalAbort) {
        pending.signal?.removeEventListener('abort', pending.signalAbort);
      }
    }
  }
}

function boundedTimeout(value: number | undefined, fallback: number) {
  return Number.isSafeInteger(value) && Number(value) >= 10 && Number(value) <= 120_000
    ? Number(value)
    : fallback;
}

function unixWebSocketUrl(socketPath: string) {
  return `ws+unix://${socketPath}:/`;
}
