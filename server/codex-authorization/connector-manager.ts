import type {
  CodexAuthorizationConnectorRequest,
  CodexAuthorizationConnectorResult
} from '../../src/shared/codex-authorization-api';
import type { CodexProcessFactory } from '../codex-sessions/contracts';
import { CodexOperationUncertainError } from '../codex-sessions/operation-ledger';
import {
  CodexAppServerRequestCancelledError,
  CodexStdioTransport,
  type CodexAppServerTransport
} from '../codex-sessions/stdio-transport';
import { CodexWebSocketTransport } from '../codex-sessions/websocket-transport';
import type {
  CodexAuthorizationOperationPersistence,
  CodexAuthorizationOperationRecord
} from './operation-store';

type PendingResult = Extract<CodexAuthorizationConnectorResult, { state: 'pending' }>;
type AuthorizationAttempt = {
  loginId: string;
  operationId: string;
  result: PendingResult;
};
type RpcMessage = { method?: string; params?: unknown };

const authorizationDeadlineMs = 15 * 60_000;
const authorizationRpcTimeoutMs = 10_000;
const maximumOperationRecords = 64;
const verificationUrl = new URL('https://auth.openai.com/codex/device');

export class CodexAuthorizationConflictError extends Error {
  constructor() {
    super('Another Codex authorization attempt is already active.');
    this.name = 'CodexAuthorizationConflictError';
  }
}

export class CodexDeviceAuthorizationManager {
  private attempt?: AuthorizationAttempt;
  private executionTail = Promise.resolve();
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private readonly operations = new Map<string, CodexAuthorizationOperationRecord>();
  private startPromise?: Promise<CodexAppServerTransport>;
  private startingTransport?: CodexAppServerTransport;
  private transport?: CodexAppServerTransport;
  private transportStartGeneration = 0;

  constructor(private readonly options: {
    binaryPath?: string;
    codexHome?: string;
    now?: () => number;
    onReady?: () => Promise<void> | void;
    operationPersistence?: CodexAuthorizationOperationPersistence;
    processFactory?: CodexProcessFactory;
    authorizationDeadlineMs?: number;
    rpcTimeoutMs?: number;
    sharedDaemon?: boolean;
    transportFactory?: () => Promise<CodexAppServerTransport>;
  } = {}) {
    for (const record of options.operationPersistence?.snapshot ?? []) {
      this.operations.set(record.operationId, record);
    }
  }

  execute(request: CodexAuthorizationConnectorRequest) {
    const execution = this.executionTail.then(() => this.withRpcDeadline(
      (signal) => this.executeSerial(request, signal)
    ));
    this.executionTail = execution.then(() => undefined, () => undefined);
    return execution;
  }

  async close() {
    this.clearExpiryTimer();
    const pending = this.attempt;
    this.attempt = undefined;
    if (pending) {
      await this.remember(pending.operationId, 'ambiguous', pending.result.deadlineAt);
    }
    const transport = this.transport;
    const startingTransport = this.startingTransport;
    this.transportStartGeneration += 1;
    this.transport = undefined;
    this.startingTransport = undefined;
    this.startPromise = undefined;
    await Promise.all([
      transport?.close(),
      startingTransport && startingTransport !== transport
        ? startingTransport.close()
        : undefined
    ]);
  }

  private async executeSerial(
    request: CodexAuthorizationConnectorRequest,
    signal: AbortSignal
  ): Promise<CodexAuthorizationConnectorResult> {
    if (request.action === 'start') return this.start(request.operationId, signal);
    if (request.action === 'cancel') return this.cancel(request.operationId, signal);
    return this.status(request.operationId, signal);
  }

  private async start(
    operationId: string,
    signal: AbortSignal
  ): Promise<CodexAuthorizationConnectorResult> {
    const replay = await this.replay(operationId);
    if (replay) return replay;
    const current = this.attempt;
    if (current?.operationId === operationId) {
      if (this.deadlineReached(current.result.deadlineAt)) {
        return this.expire(current, signal);
      }
      return current.result;
    }
    const stored = this.operations.get(operationId);
    if (stored?.state === 'pending') {
      return this.finish(
        operationId,
        this.deadlineReached(stored.deadlineAt) ? 'expired' : 'ambiguous',
        stored.deadlineAt
      );
    }
    if (this.attempt) throw new CodexAuthorizationConflictError();
    for (const unresolved of [...this.operations.values()]) {
      if (
        unresolved.state !== 'pending' &&
        (unresolved.state !== 'ambiguous' || unresolved.deadlineAt === undefined)
      ) {
        continue;
      }
      if (this.deadlineReached(unresolved.deadlineAt)) {
        await this.remember(unresolved.operationId, 'expired', unresolved.deadlineAt);
        continue;
      }
      await this.remember(
        unresolved.operationId,
        'ambiguous',
        unresolved.deadlineAt
      );
      await this.remember(operationId, 'ambiguous');
      return { state: 'ambiguous' };
    }
    if (await this.accountReady(signal)) {
      return this.finish(operationId, 'ready');
    }
    const deadlineAt = new Date(
      this.now() + (this.options.authorizationDeadlineMs ?? authorizationDeadlineMs)
    ).toISOString();
    await this.remember(operationId, 'ambiguous', deadlineAt);
    let raw: unknown;
    try {
      raw = await this.call<unknown>(
        'account/login/start',
        { type: 'chatgptDeviceCode' },
        signal,
        true
      );
    } catch (error) {
      if (error instanceof CodexOperationUncertainError) {
        await this.close();
        return { state: 'ambiguous' };
      }
      await this.remember(operationId, 'failed', deadlineAt);
      throw error;
    }
    let started: ReturnType<typeof readStartedLogin>;
    try {
      started = readStartedLogin(raw);
    } catch {
      await this.close();
      return { state: 'ambiguous' };
    }
    const result = {
      deadlineAt,
      state: 'pending' as const,
      userCode: started.userCode,
      verificationUrl: started.verificationUrl
    };
    this.attempt = { loginId: started.loginId, operationId, result };
    try {
      await this.remember(operationId, 'pending', deadlineAt);
    } catch {
      await this.cancelUpstream(started.loginId, signal);
      this.attempt = undefined;
      await this.remember(operationId, 'ambiguous', deadlineAt).catch(() => undefined);
      await this.close();
      return { state: 'ambiguous' };
    }
    this.scheduleExpiry(operationId, deadlineAt);
    return result;
  }

  private async status(
    operationId: string,
    signal: AbortSignal
  ): Promise<CodexAuthorizationConnectorResult> {
    const stored = this.operations.get(operationId);
    if (await this.accountReady(signal)) {
      return stored?.state === 'ready'
        ? { state: 'ready' }
        : this.finish(operationId, 'ready');
    }
    if (stored?.state === 'ready') return { state: 'authorization-required' };
    const replay = await this.replay(operationId);
    if (replay) return replay;
    const current = this.attempt;
    if (!current || current.operationId !== operationId) {
      const record = this.operations.get(operationId);
      if (record?.state === 'pending') {
        return this.finish(
          operationId,
          this.deadlineReached(record.deadlineAt) ? 'expired' : 'ambiguous',
          record.deadlineAt
        );
      }
      return { state: 'authorization-required' };
    }
    if (this.deadlineReached(current.result.deadlineAt)) {
      return this.expire(current, signal);
    }
    return current.result;
  }

  private async cancel(
    operationId: string,
    signal: AbortSignal
  ): Promise<CodexAuthorizationConnectorResult> {
    const replay = await this.replay(operationId);
    if (replay) return replay;
    if (await this.accountReady(signal)) return this.finish(operationId, 'ready');
    const current = this.attempt;
    if (!current || current.operationId !== operationId) {
      const record = this.operations.get(operationId);
      if (record?.state === 'pending') {
        return this.finish(
          operationId,
          this.deadlineReached(record.deadlineAt) ? 'expired' : 'ambiguous',
          record.deadlineAt
        );
      }
      return { state: 'authorization-required' };
    }
    if (this.deadlineReached(current.result.deadlineAt)) {
      return this.expire(current, signal);
    }
    const cancellation = await this.cancelUpstream(current.loginId, signal);
    return this.finish(
      operationId,
      cancellation === 'ready'
        ? 'ready'
        : cancellation === 'cancelled'
          ? 'cancelled'
          : 'ambiguous',
      current.result.deadlineAt
    );
  }

  private async expire(attempt: AuthorizationAttempt, signal: AbortSignal) {
    const cancellation = await this.cancelUpstream(attempt.loginId, signal);
    return this.finish(
      attempt.operationId,
      cancellation === 'ready'
        ? 'ready'
        : cancellation === 'cancelled'
          ? 'expired'
          : 'ambiguous',
      attempt.result.deadlineAt
    );
  }

  private async finish(
    operationId: string,
    state: Exclude<CodexAuthorizationOperationRecord['state'], 'pending'>,
    deadlineAt?: string
  ): Promise<CodexAuthorizationConnectorResult> {
    if (this.attempt?.operationId === operationId) {
      this.clearExpiryTimer();
      this.attempt = undefined;
    }
    await this.remember(operationId, state, deadlineAt);
    if (!this.attempt) await this.close();
    if (state === 'ready') {
      try {
        await this.options.onReady?.();
      } catch {
        // Authorization is already durable; the session runtime will reconnect on its next call.
      }
    }
    return { state };
  }

  private async replay(operationId: string): Promise<CodexAuthorizationConnectorResult | undefined> {
    const record = this.operations.get(operationId);
    if (
      record?.state === 'ambiguous' &&
      record.deadlineAt !== undefined &&
      this.deadlineReached(record.deadlineAt)
    ) {
      await this.remember(operationId, 'expired', record.deadlineAt);
      return { state: 'expired' };
    }
    return record && record.state !== 'pending' ? { state: record.state } : undefined;
  }

  private async accountReady(signal: AbortSignal) {
    const result = await this.call<unknown>(
      'account/read',
      { refreshToken: false },
      signal
    );
    return readAccountReady(result);
  }

  private async cancelUpstream(loginId: string, signal: AbortSignal) {
    try {
      const result = await this.call<unknown>(
        'account/login/cancel',
        { loginId },
        signal,
        true
      );
      if (isRecord(result) && result.status === 'canceled') return 'cancelled' as const;
      if (isRecord(result) && result.status === 'notFound') {
        return await this.accountReady(signal) ? 'ready' as const : 'ambiguous' as const;
      }
      return 'ambiguous' as const;
    } catch {
      return 'ambiguous' as const;
    }
  }

  private ensureTransport(signal: AbortSignal) {
    if (this.transport?.isOpen) return Promise.resolve(this.transport);
    if (this.startPromise) return this.startPromise;
    const startGeneration = ++this.transportStartGeneration;
    let startPromise!: Promise<CodexAppServerTransport>;
    startPromise = (async () => {
      const onClose = () => {
        this.clearExpiryTimer();
        if (this.transport === transport) this.transport = undefined;
        const pending = this.attempt;
        this.attempt = undefined;
        if (pending) {
          void this.remember(
            pending.operationId,
            'ambiguous',
            pending.result.deadlineAt
          );
        }
      };
      const transport = this.options.transportFactory
        ? await this.options.transportFactory()
        : this.options.sharedDaemon
          ? await CodexWebSocketTransport.connect({
              onClose,
              onMessage: (message) => this.handleMessage(message)
            })
          : CodexStdioTransport.launch({
              binaryPath: this.options.binaryPath,
              codexHome: this.options.codexHome,
              onClose,
              onMessage: (message) => this.handleMessage(message),
              processFactory: this.options.processFactory
            });
      if (startGeneration !== this.transportStartGeneration) {
        await transport.close();
        throw new CodexAppServerRequestCancelledError();
      }
      this.startingTransport = transport;
      try {
        await transport.initialize({ signal });
        if (this.startingTransport !== transport) {
          await transport.close();
          throw new CodexAppServerRequestCancelledError();
        }
        this.startingTransport = undefined;
        this.transport = transport;
        return transport;
      } catch (error) {
        await transport.close();
        throw error;
      } finally {
        if (this.startPromise === startPromise) this.startPromise = undefined;
        if (this.startingTransport === transport) this.startingTransport = undefined;
      }
    })();
    this.startPromise = startPromise;
    return startPromise;
  }

  private async call<Result>(
    method: string,
    params: unknown,
    signal: AbortSignal,
    uncertainWhenAborted = false
  ) {
    const transport = await this.ensureTransport(signal);
    try {
      return await transport.call<Result>(method, params, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
      if (this.transport === transport) this.transport = undefined;
      await transport.close().catch(() => undefined);
      if (uncertainWhenAborted) {
        throw new CodexOperationUncertainError(
          'The Codex authorization operation exceeded its safe response window.'
        );
      }
      throw error;
    }
  }

  private async withRpcDeadline<Result>(
    operation: (signal: AbortSignal) => Promise<Result>
  ) {
    const controller = new AbortController();
    const deadline = setTimeout(
      () => controller.abort(),
      this.options.rpcTimeoutMs ?? authorizationRpcTimeoutMs
    );
    deadline.unref?.();
    try {
      return await operation(controller.signal);
    } finally {
      clearTimeout(deadline);
    }
  }

  private handleMessage(message: RpcMessage) {
    if (message.method !== 'account/login/completed' || !isRecord(message.params)) return;
    const current = this.attempt;
    if (!current || message.params.loginId !== current.loginId) return;
    if (message.params.success !== true) {
      this.clearExpiryTimer();
      this.attempt = undefined;
      void this.remember(current.operationId, 'failed', current.result.deadlineAt);
    }
  }

  private async remember(
    operationId: string,
    state: CodexAuthorizationOperationRecord['state'],
    deadlineAt?: string
  ) {
    this.operations.delete(operationId);
    this.operations.set(operationId, {
      ...(deadlineAt ? { deadlineAt } : {}),
      operationId,
      state,
      updatedAt: new Date(this.now()).toISOString()
    });
    while (this.operations.size > maximumOperationRecords) {
      const oldest = this.operations.keys().next().value;
      if (oldest === undefined) break;
      this.operations.delete(oldest);
    }
    await this.options.operationPersistence?.persist([...this.operations.values()]);
  }

  private deadlineReached(value?: string) {
    return value !== undefined && this.now() >= Date.parse(value);
  }

  private scheduleExpiry(operationId: string, deadlineAt: string) {
    this.clearExpiryTimer();
    const timer = setTimeout(() => {
      const expiration = this.executionTail.then(async () => {
        const current = this.attempt;
        if (current?.operationId === operationId && this.deadlineReached(deadlineAt)) {
          await this.withRpcDeadline((signal) => this.expire(current, signal));
        }
      });
      this.executionTail = expiration.then(() => undefined, () => undefined);
    }, Math.max(0, Date.parse(deadlineAt) - this.now()));
    timer.unref?.();
    this.expiryTimer = timer;
  }

  private clearExpiryTimer() {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
  }

  private now() { return (this.options.now ?? Date.now)(); }
}

function readStartedLogin(value: unknown) {
  if (!isRecord(value) ||
      value.type !== 'chatgptDeviceCode' ||
      typeof value.loginId !== 'string' ||
      !validOpaque(value.loginId, 512) ||
      typeof value.verificationUrl !== 'string' ||
      typeof value.userCode !== 'string' ||
      !/^[A-Z0-9][A-Z0-9-]{3,31}$/.test(value.userCode)) {
    throw new Error('Codex returned an invalid device authorization response.');
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(value.verificationUrl);
  } catch {
    throw new Error('Codex returned an invalid device authorization URL.');
  }
  if (
    parsedUrl.protocol !== verificationUrl.protocol ||
    parsedUrl.hostname !== verificationUrl.hostname ||
    parsedUrl.port !== '' ||
    parsedUrl.pathname !== verificationUrl.pathname ||
    parsedUrl.username !== '' ||
    parsedUrl.password !== '' ||
    parsedUrl.search !== '' ||
    parsedUrl.hash !== ''
  ) {
    throw new Error('Codex returned an untrusted device authorization URL.');
  }
  return {
    loginId: value.loginId,
    userCode: value.userCode,
    verificationUrl: parsedUrl.toString()
  };
}

function readAccountReady(value: unknown) {
  return isRecord(value) &&
    value.requiresOpenaiAuth === true &&
    isRecord(value.account) &&
    value.account.type === 'chatgpt';
}

function validOpaque(value: string, maximum: number) {
  return value.length > 0 && value.length <= maximum && !/[\u0000\r\n]/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
