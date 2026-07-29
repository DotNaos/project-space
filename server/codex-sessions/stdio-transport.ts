import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { CodexChildProcess, CodexProcessFactory, CodexRpcId } from './contracts';
import { CodexOperationUncertainError } from './operation-ledger';
import { resolveCodexBinary } from './binary-resolver';

export type RpcMessage = {
  error?: { code?: number; message?: string };
  id?: CodexRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
};

export interface CodexAppServerTransport {
  readonly isOpen: boolean;
  call<Result>(
    method: string,
    params?: unknown,
    options?: { signal?: AbortSignal }
  ): Promise<Result>;
  close(): Promise<void>;
  initialize(options?: { signal?: AbortSignal }): Promise<void>;
  respond(id: CodexRpcId, result: unknown): Promise<void>;
}

type PendingCall = {
  method: string;
  signal?: AbortSignal;
  signalAbort?: () => void;
  reject: (error: Error) => void;
  resolve: (result: unknown) => void;
};

const MAXIMUM_STANDARD_LINE_CHARACTERS = 2_000_000;
const DEFAULT_MAXIMUM_THREAD_READ_LINE_CHARACTERS = 16 * 1024 * 1024;
const UNCERTAIN_ON_PROTOCOL_FAILURE_METHODS = new Set([
  'thread/resume',
  'thread/start',
  'turn/interrupt',
  'turn/start',
  'turn/steer'
]);

export class CodexAppServerProtocolError extends Error {
  readonly code = 'codex_app_server_protocol_error';
}

export class CodexAppServerRequestError extends Error {
  readonly code: string = 'codex_app_server_request_failed';

  constructor(readonly rpcCode?: number) {
    super('Codex app-server rejected the request.');
  }
}

export class CodexThreadUnmaterializedError extends CodexAppServerRequestError {
  readonly code = 'codex_thread_unmaterialized';

  constructor() {
    super(-32600);
  }
}

export class CodexAppServerRequestCancelledError extends Error {
  readonly code = 'codex_app_server_request_cancelled';

  constructor() {
    super('The Codex app-server request was cancelled.');
    this.name = 'CodexAppServerRequestCancelledError';
  }
}

export const defaultCodexAppServerBinary =
  '/Applications/ChatGPT.app/Contents/Resources/codex';

const defaultProcessFactory: CodexProcessFactory = ({ args, command, env }) =>
  spawn(command, [...args], {
    env,
    stdio: 'pipe',
    windowsHide: true
  }) as CodexChildProcess;

export class CodexStdioTransport {
  private nextId = 1;
  private open = true;
  private readonly pending = new Map<number, PendingCall>();
  private readonly stdout: ReturnType<typeof createInterface>;

  constructor(
    private readonly child: CodexChildProcess,
    private readonly onMessage: (message: RpcMessage) => void,
    private readonly onTransportClose: () => void,
    private readonly maximumThreadReadLineCharacters =
      DEFAULT_MAXIMUM_THREAD_READ_LINE_CHARACTERS
  ) {
    this.stdout = createInterface({ input: child.stdout });
    this.stdout.on('line', (line) => this.handleLine(line));
    this.stdout.on('close', () => this.handleClose());
    child.on('error', () => this.handleClose());
    child.once('close', () => this.handleClose());
    child.stderr.on('data', () => {
      // Deliberately discard process diagnostics: they may contain local paths or secrets.
    });
  }

  static launch(options: {
    binaryPath?: string;
    codexHome?: string;
    onClose?: () => void;
    onMessage: (message: RpcMessage) => void;
    processFactory?: CodexProcessFactory;
    maximumThreadReadLineCharacters?: number;
  }) {
    const factory = options.processFactory ?? defaultProcessFactory;
    const command = options.binaryPath ?? (
      options.processFactory ? defaultCodexAppServerBinary : resolveCodexBinary().path
    );
    if (!command) {
      throw new CodexAppServerProtocolError(
        'No working Codex CLI was found. Set PROJECT_CODEX_CLI_PATH to an executable codex binary.'
      );
    }
    const child = factory({
      args: ['app-server', '--listen', 'stdio://'],
      command,
      env: {
        ...process.env,
        ...(options.codexHome ? { CODEX_HOME: options.codexHome } : {})
      }
    });
    return new CodexStdioTransport(
      child,
      options.onMessage,
      options.onClose ?? (() => {}),
      options.maximumThreadReadLineCharacters
    );
  }

  get isOpen() {
    return this.open;
  }

  async initialize(options: { signal?: AbortSignal } = {}) {
    await this.call('initialize', {
      capabilities: { experimentalApi: false },
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
    if (!this.open) {
      return Promise.reject(new CodexOperationUncertainError('Codex app-server is unavailable.'));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new CodexAppServerRequestCancelledError());
    }
    const id = this.nextId++;
    return new Promise<Result>((resolve, reject) => {
      const signalAbort = options.signal ? () => this.cancelCall(id) : undefined;
      this.pending.set(id, {
        method,
        reject,
        resolve: (result) => resolve(result as Result),
        signal: options.signal,
        signalAbort
      });
      signalAbort && options.signal?.addEventListener('abort', signalAbort, { once: true });
      this.write(params === undefined ? { id, method } : { id, method, params }).catch(() => {
        const pending = this.takePending(id);
        pending?.reject(
          new CodexOperationUncertainError('Codex app-server disconnected during the request.')
        );
      });
    });
  }

  respond(id: CodexRpcId, result: unknown) {
    if (!this.open) {
      return Promise.reject(new CodexOperationUncertainError('Codex app-server is unavailable.'));
    }
    return this.write({ id, result });
  }

  async close() {
    if (!this.open) return;
    this.open = false;
    this.stdout.close();
    for (const pending of this.pending.values()) {
      if (pending.signalAbort) pending.signal?.removeEventListener('abort', pending.signalAbort);
      pending.reject(new CodexOperationUncertainError('Codex app-server closed during the request.'));
    }
    this.pending.clear();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGTERM');
    }
  }

  private handleLine(line: string) {
    if (!this.open) return;
    if (!line.trim()) return;
    if (line.length > this.maximumThreadReadLineCharacters) {
      this.failProtocol();
      return;
    }
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      if (line.length > MAXIMUM_STANDARD_LINE_CHARACTERS) this.failProtocol();
      return;
    }
    if (!message || typeof message !== 'object') return;

    if (line.length > MAXIMUM_STANDARD_LINE_CHARACTERS) {
      const pending = typeof message.id === 'number'
        ? this.pending.get(message.id)
        : undefined;
      if (!pending || pending.method !== 'thread/read' || message.method) {
        this.failProtocol();
        return;
      }
    }

    if (typeof message.id === 'number' && !message.method) {
      const pending = this.takePending(message.id);
      if (!pending) return;
      if (message.error) {
        pending.reject(isUnmaterializedThreadRead(pending.method, message.error)
          ? new CodexThreadUnmaterializedError()
          : new CodexAppServerRequestError(message.error.code));
      } else if ('result' in message) {
        pending.resolve(message.result);
      } else {
        pending.reject(new CodexAppServerProtocolError('Codex app-server returned an invalid response.'));
      }
      return;
    }

    if (typeof message.method === 'string') this.onMessage(message);
  }

  private failProtocol() {
    if (!this.open) return;
    this.open = false;
    this.stdout.close();
    for (const pending of this.pending.values()) {
      if (pending.signalAbort) pending.signal?.removeEventListener('abort', pending.signalAbort);
      pending.reject(
        UNCERTAIN_ON_PROTOCOL_FAILURE_METHODS.has(pending.method)
          ? new CodexOperationUncertainError('Codex app-server returned an invalid response after a mutation was sent.')
          : new CodexAppServerProtocolError('Codex app-server returned an invalid response.')
      );
    }
    this.pending.clear();
    this.onTransportClose();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGTERM');
    }
  }

  private handleClose() {
    if (!this.open) return;
    this.open = false;
    for (const pending of this.pending.values()) {
      if (pending.signalAbort) pending.signal?.removeEventListener('abort', pending.signalAbort);
      pending.reject(new CodexOperationUncertainError('Codex app-server disconnected during the request.'));
    }
    this.pending.clear();
    this.onTransportClose();
  }

  private write(message: RpcMessage) {
    return new Promise<void>((resolve, reject) => {
      const line = `${JSON.stringify(message)}\n`;
      this.child.stdin.write(line, (error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private cancelCall(id: number) {
    const pending = this.takePending(id);
    if (!pending) return;
    pending.reject(new CodexAppServerRequestCancelledError());
    void this.write({ method: '$/cancelRequest', params: { id } }).catch(() => undefined);
  }

  private takePending(id: number) {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    if (pending.signalAbort) pending.signal?.removeEventListener('abort', pending.signalAbort);
    return pending;
  }
}

function isUnmaterializedThreadRead(
  method: string,
  error: { code?: number; message?: string }
) {
  return method === 'thread/read' &&
    error.code === -32600 &&
    typeof error.message === 'string' &&
    /^thread [A-Za-z0-9][A-Za-z0-9._:@+-]{0,127} is not materialized yet; includeTurns is unavailable before first user message$/
      .test(error.message);
}
