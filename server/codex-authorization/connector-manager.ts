import type {
  CodexAuthorizationConnectorRequest,
  CodexAuthorizationConnectorResult
} from '../../src/shared/codex-authorization-api';
import type { CodexProcessFactory } from '../codex-sessions/contracts';
import { CodexOperationUncertainError } from '../codex-sessions/operation-ledger';
import { CodexStdioTransport } from '../codex-sessions/stdio-transport';
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
  private startPromise?: Promise<CodexStdioTransport>;
  private transport?: CodexStdioTransport;

  constructor(private readonly options: {
    binaryPath?: string;
    codexHome?: string;
    now?: () => number;
    operationPersistence?: CodexAuthorizationOperationPersistence;
    processFactory?: CodexProcessFactory;
    authorizationDeadlineMs?: number;
  } = {}) {
    for (const record of options.operationPersistence?.snapshot ?? []) {
      this.operations.set(record.operationId, record);
    }
  }

  execute(request: CodexAuthorizationConnectorRequest) {
    const execution = this.executionTail.then(() => this.executeSerial(request));
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
    this.transport = undefined;
    this.startPromise = undefined;
    await transport?.close();
  }

  private async executeSerial(
    request: CodexAuthorizationConnectorRequest
  ): Promise<CodexAuthorizationConnectorResult> {
    if (request.action === 'start') return this.start(request.operationId);
    if (request.action === 'cancel') return this.cancel(request.operationId);
    return this.status(request.operationId);
  }

  private async start(operationId: string): Promise<CodexAuthorizationConnectorResult> {
    const replay = await this.replay(operationId);
    if (replay) return replay;
    const current = this.attempt;
    if (current?.operationId === operationId) {
      if (this.deadlineReached(current.result.deadlineAt)) return this.expire(current);
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
    const unresolved = [...this.operations.values()].find((record) => (
      record.state === 'pending'
    ));
    if (unresolved) {
      await this.remember(
        unresolved.operationId,
        this.deadlineReached(unresolved.deadlineAt) ? 'expired' : 'ambiguous',
        unresolved.deadlineAt
      );
      await this.remember(operationId, 'ambiguous');
      return { state: 'ambiguous' };
    }
    if (await this.accountReady()) {
      await this.remember(operationId, 'ready');
      await this.close();
      return { state: 'ready' };
    }
    const deadlineAt = new Date(
      this.now() + (this.options.authorizationDeadlineMs ?? authorizationDeadlineMs)
    ).toISOString();
    await this.remember(operationId, 'ambiguous', deadlineAt);
    let raw: unknown;
    try {
      raw = await (await this.ensureTransport()).call<unknown>(
        'account/login/start',
        { type: 'chatgptDeviceCode' }
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
      await this.cancelUpstream(started.loginId);
      this.attempt = undefined;
      await this.remember(operationId, 'ambiguous', deadlineAt).catch(() => undefined);
      await this.close();
      return { state: 'ambiguous' };
    }
    this.scheduleExpiry(operationId, deadlineAt);
    return result;
  }

  private async status(operationId: string): Promise<CodexAuthorizationConnectorResult> {
    const replay = await this.replay(operationId);
    if (replay) return replay;
    if (await this.accountReady()) return this.finish(operationId, 'ready');
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
      return this.expire(current);
    }
    return current.result;
  }

  private async cancel(operationId: string): Promise<CodexAuthorizationConnectorResult> {
    const replay = await this.replay(operationId);
    if (replay) return replay;
    if (await this.accountReady()) return this.finish(operationId, 'ready');
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
    if (this.deadlineReached(current.result.deadlineAt)) return this.expire(current);
    const cancelled = await this.cancelUpstream(current.loginId);
    return this.finish(
      operationId,
      cancelled ? 'cancelled' : 'ambiguous',
      current.result.deadlineAt
    );
  }

  private async expire(attempt: AuthorizationAttempt) {
    const cancelled = await this.cancelUpstream(attempt.loginId);
    return this.finish(
      attempt.operationId,
      cancelled ? 'expired' : 'ambiguous',
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
    return { state };
  }

  private async replay(operationId: string): Promise<CodexAuthorizationConnectorResult | undefined> {
    const record = this.operations.get(operationId);
    return record && record.state !== 'pending' ? { state: record.state } : undefined;
  }

  private async accountReady() {
    const result = await (await this.ensureTransport()).call<unknown>(
      'account/read',
      { refreshToken: false }
    );
    return readAccountReady(result);
  }

  private async cancelUpstream(loginId: string) {
    try {
      await (await this.ensureTransport()).call('account/login/cancel', { loginId });
      return true;
    } catch {
      return false;
    }
  }

  private ensureTransport() {
    if (this.transport?.isOpen) return Promise.resolve(this.transport);
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      const transport = CodexStdioTransport.launch({
        binaryPath: this.options.binaryPath,
        codexHome: this.options.codexHome,
        onClose: () => {
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
        },
        onMessage: (message) => this.handleMessage(message),
        processFactory: this.options.processFactory
      });
      try {
        await transport.initialize();
        this.transport = transport;
        return transport;
      } catch (error) {
        await transport.close();
        throw error;
      } finally {
        this.startPromise = undefined;
      }
    })();
    return this.startPromise;
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
          await this.expire(current);
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
    typeof value.requiresOpenaiAuth === 'boolean' &&
    (value.requiresOpenaiAuth === false || isRecord(value.account));
}

function validOpaque(value: string, maximum: number) {
  return value.length > 0 && value.length <= maximum && !/[\u0000\r\n]/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
