import type {
  CodexApprovalResponseInput,
  CodexInterruptTurnInput,
  CodexLoadedThreadListResult,
  CodexOperationSnapshot,
  CodexPermissionResponseInput,
  CodexProcessFactory,
  CodexResumeThreadInput,
  CodexRpcId,
  CodexSessionEvent,
  CodexSessionEventListener,
  CodexStartTurnInput,
  CodexThreadListInput,
  CodexThreadListResult,
  CodexThreadResult,
  CodexThreadSummary,
  CodexTurnResult,
  CodexUserInputResponseInput
} from './contracts';
import { CodexOperationLedger, CodexOperationUncertainError } from './operation-ledger';
import { CodexAppServerProtocolError, CodexStdioTransport } from './stdio-transport';
import {
  isNotificationMethod,
  isServerRequestMethod,
  rpcIdKey,
  sanitizeProtocolValue,
  validateAnswers,
  validateIdentifier,
  validatePrompt,
  validateRpcId,
  validateThreadListInput
} from './validation';

type IncomingMessage = {
  id?: CodexRpcId;
  method?: string;
  params?: unknown;
};

type PendingServerRequest = {
  method: string;
  params: Record<string, unknown>;
  requestId: CodexRpcId;
  threadId: string;
  turnId?: string;
};

const unknownActiveTurn = '__active_turn__';

export interface CodexSessionManagerOptions {
  binaryPath?: string;
  codexHome?: string;
  operationSnapshot?: CodexOperationSnapshot;
  processFactory?: CodexProcessFactory;
}

export class CodexThreadActiveError extends Error {
  readonly code = 'codex_thread_active';
}

export class CodexSessionManager {
  private readonly activeTurns = new Map<string, string>();
  private readonly listeners = new Set<CodexSessionEventListener>();
  private readonly ledger: CodexOperationLedger;
  private readonly pendingServerRequests = new Map<string, PendingServerRequest>();
  private readonly resolutionWaiters = new Map<
    string,
    { reject: (error: Error) => void; resolve: () => void }
  >();
  private readonly startingThreads = new Set<string>();
  private startPromise?: Promise<CodexStdioTransport>;
  private transport?: CodexStdioTransport;

  constructor(private readonly options: CodexSessionManagerOptions = {}) {
    this.ledger = new CodexOperationLedger(options.operationSnapshot);
  }

  subscribe(listener: CodexSessionEventListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async listThreads(input: CodexThreadListInput = {}): Promise<CodexThreadListResult> {
    const result = await this.call<unknown>('thread/list', validateThreadListInput(input));
    const record = requireRecord(result);
    if (!Array.isArray(record.data)) throw protocolError();
    return {
      data: record.data.map(readThread),
      nextCursor: typeof record.nextCursor === 'string' ? record.nextCursor : null
    };
  }

  async listLoadedThreads(): Promise<CodexLoadedThreadListResult> {
    const result = requireRecord(await this.call<unknown>('thread/loaded/list', {}));
    if (!Array.isArray(result.data)) throw protocolError();
    return { data: result.data.map((id) => validateIdentifier(id, 'threadId')) };
  }

  async readThread(threadId: string, includeTurns = true): Promise<CodexThreadResult> {
    validateIdentifier(threadId, 'threadId');
    return readThreadResult(await this.call('thread/read', { includeTurns, threadId }));
  }

  resumeThread(input: CodexResumeThreadInput) {
    const threadId = validateIdentifier(input.threadId, 'threadId');
    return this.ledger.execute(
      input.operationId,
      fingerprint('thread/resume', { threadId }),
      async () => {
        const result = readThreadResult(await this.call('thread/resume', { threadId }));
        this.captureThreadStatus(result.thread);
        return result;
      }
    );
  }

  startTurn(input: CodexStartTurnInput) {
    const threadId = validateIdentifier(input.threadId, 'threadId');
    const prompt = validatePrompt(input.prompt);
    return this.ledger.execute(
      input.operationId,
      fingerprint('turn/start', { prompt, threadId }),
      async () => {
        if (this.activeTurns.has(threadId) || this.startingThreads.has(threadId)) {
          throw new CodexThreadActiveError('Wait for the active turn to finish.');
        }
        this.startingThreads.add(threadId);
        try {
          const result = readTurnResult(
            await this.call('turn/start', {
              input: [{ text: prompt, type: 'text' }],
              threadId
            })
          );
          this.activeTurns.set(threadId, result.turn.id);
          return result;
        } finally {
          this.startingThreads.delete(threadId);
        }
      }
    );
  }

  interruptTurn(input: CodexInterruptTurnInput) {
    const threadId = validateIdentifier(input.threadId, 'threadId');
    const turnId = validateIdentifier(input.turnId, 'turnId');
    return this.ledger.execute(
      input.operationId,
      fingerprint('turn/interrupt', { threadId, turnId }),
      () => this.call<Record<string, never>>('turn/interrupt', { threadId, turnId })
    );
  }

  respondToApproval(input: CodexApprovalResponseInput) {
    const pending = this.requirePending(input, [
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval'
    ]);
    return this.respondWithLedger(input.operationId, pending, { decision: input.decision });
  }

  respondToPermissions(input: CodexPermissionResponseInput) {
    const pending = this.requirePending(input, ['item/permissions/requestApproval']);
    const requested = pending.params.permissions ?? pending.params.requestedPermissions ?? {};
    return this.respondWithLedger(input.operationId, pending, {
      permissions: input.grant === 'allRequested' ? requested : {},
      scope: input.scope ?? 'turn'
    });
  }

  respondToUserInput(input: CodexUserInputResponseInput) {
    const pending = this.requirePending(input, [
      'item/tool/requestUserInput',
      'tool/requestUserInput'
    ]);
    const answers = validateAnswers(input.answers);
    const questions = Array.isArray(pending.params.questions) ? pending.params.questions : [];
    const questionIds = new Set(
      questions.flatMap((question) => {
        if (!question || typeof question !== 'object') return [];
        const id = (question as Record<string, unknown>).id;
        return typeof id === 'string' ? [id] : [];
      })
    );
    if (
      questionIds.size > 0 &&
      ([...questionIds].some((id) => !(id in answers)) ||
        Object.keys(answers).some((id) => !questionIds.has(id)))
    ) {
      throw new CodexAppServerProtocolError('Answers must match the pending questions.');
    }
    const result = {
      answers: Object.fromEntries(
        Object.entries(answers).map(([id, values]) => [id, { answers: values }])
      )
    };
    return this.respondWithLedger(input.operationId, pending, result);
  }

  reconcileOperationNotApplied(operationId: string) {
    this.ledger.reconcileNotApplied(operationId);
  }

  reconcileOperationCompleted<Result>(operationId: string, result: Result) {
    this.ledger.reconcileCompleted(operationId, result);
  }

  operationSnapshot() {
    return this.ledger.snapshot();
  }

  async close() {
    const transport = this.transport;
    this.transport = undefined;
    this.startPromise = undefined;
    await transport?.close();
  }

  private async call<Result>(method: string, params?: unknown): Promise<Result> {
    const transport = await this.ensureTransport();
    return transport.call<Result>(method, params);
  }

  private ensureTransport() {
    if (this.transport?.isOpen) return Promise.resolve(this.transport);
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      const transport = CodexStdioTransport.launch({
        ...this.options,
        onClose: () => this.handleTransportClose(),
        onMessage: (message) => this.handleMessage(message)
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

  private handleMessage(message: IncomingMessage) {
    try {
      if (!message.method) return;
      if (isServerRequestMethod(message.method) && message.id !== undefined) {
        const requestId = validateRpcId(message.id);
        const params = requireRecord(message.params);
        const threadId = validateIdentifier(params.threadId, 'threadId');
        const turnId = params.turnId === undefined
          ? undefined
          : validateIdentifier(params.turnId, 'turnId');
        const pending = { method: message.method, params, requestId, threadId, turnId };
        this.pendingServerRequests.set(rpcIdKey(requestId), pending);
        this.emit({
          kind: 'request',
          method: message.method,
          params: sanitizeProtocolValue(params),
          requestId
        });
        return;
      }
      if (!isNotificationMethod(message.method)) return;
      const rawParams = message.params;
      const commandItem = Boolean(
        message.method === 'item/completed' &&
        rawParams &&
        typeof rawParams === 'object' &&
        !Array.isArray(rawParams) &&
        (rawParams as { item?: { type?: unknown } }).item?.type === 'commandExecution'
      );
      const params = message.method === 'error'
        ? sanitizeErrorNotification(rawParams)
        : sanitizeProtocolValue(rawParams, {
            commandOutput:
              commandItem || message.method === 'item/commandExecution/outputDelta'
          });
      this.trackLifecycle(message.method, params);
      this.emit({ kind: 'notification', method: message.method, params });
    } catch {
      // Ignore malformed or unscoped process messages instead of exposing or crashing on them.
    }
  }

  private trackLifecycle(method: string, params: unknown) {
    if (!params || typeof params !== 'object') return;
    const record = params as Record<string, unknown>;
    if (method === 'turn/started') {
      const threadId = validateIdentifier(record.threadId, 'threadId');
      const turn = requireRecord(record.turn);
      this.activeTurns.set(threadId, validateIdentifier(turn.id, 'turnId'));
    }
    if (method === 'turn/completed') {
      const threadId = validateIdentifier(record.threadId, 'threadId');
      const turn = requireRecord(record.turn);
      const turnId = validateIdentifier(turn.id, 'turnId');
      const activeTurn = this.activeTurns.get(threadId);
      if (activeTurn === turnId || activeTurn === unknownActiveTurn) {
        this.activeTurns.delete(threadId);
      }
    }
    if (method === 'thread/status/changed' && record.status) {
      const threadId = validateIdentifier(record.threadId, 'threadId');
      const status = requireRecord(record.status);
      if (status.type !== 'active') this.activeTurns.delete(threadId);
    }
    if (method === 'serverRequest/resolved') {
      const requestId = record.requestId;
      if (requestId !== undefined) {
        const key = rpcIdKey(validateRpcId(requestId));
        this.pendingServerRequests.delete(key);
        this.resolutionWaiters.get(key)?.resolve();
        this.resolutionWaiters.delete(key);
      }
    }
  }

  private requirePending(
    input: { requestId: CodexRpcId; threadId: string; turnId?: string },
    methods: string[]
  ) {
    const requestId = validateRpcId(input.requestId);
    const pending = this.pendingServerRequests.get(rpcIdKey(requestId));
    if (!pending || !methods.includes(pending.method)) {
      throw new CodexAppServerProtocolError('The pending Codex request was not found.');
    }
    if (
      pending.threadId !== validateIdentifier(input.threadId, 'threadId') ||
      pending.turnId !== (input.turnId ? validateIdentifier(input.turnId, 'turnId') : undefined)
    ) {
      throw new CodexAppServerProtocolError('The pending Codex request does not match this turn.');
    }
    return pending;
  }

  private respondWithLedger(operationId: string, pending: PendingServerRequest, result: unknown) {
    return this.ledger.execute(
      operationId,
      fingerprint(pending.method, { requestId: pending.requestId, result }),
      async () => {
        const transport = await this.ensureTransport();
        await transport.respond(pending.requestId, result);
        await this.waitForResolution(pending.requestId);
        return {};
      }
    );
  }

  private waitForResolution(requestId: CodexRpcId) {
    const key = rpcIdKey(requestId);
    if (!this.pendingServerRequests.has(key)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.resolutionWaiters.delete(key);
        reject(new CodexOperationUncertainError('The Codex request response was not confirmed.'));
      }, 120_000);
      this.resolutionWaiters.set(key, {
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
  }

  private handleTransportClose() {
    this.activeTurns.clear();
    this.startingThreads.clear();
    this.pendingServerRequests.clear();
    for (const waiter of this.resolutionWaiters.values()) {
      waiter.reject(new CodexOperationUncertainError('Codex app-server restarted before confirmation.'));
    }
    this.resolutionWaiters.clear();
  }

  private captureThreadStatus(thread: CodexThreadSummary) {
    if (thread.status?.type === 'active') {
      this.activeTurns.set(thread.id, unknownActiveTurn);
    } else {
      this.activeTurns.delete(thread.id);
    }
  }

  private emit(event: CodexSessionEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw protocolError();
  return value as Record<string, unknown>;
}

function readThread(value: unknown): CodexThreadSummary {
  const thread = sanitizeProtocolValue(requireRecord(value)) as CodexThreadSummary;
  thread.id = validateIdentifier(thread.id, 'threadId');
  return thread;
}

function readThreadResult(value: unknown): CodexThreadResult {
  return { thread: readThread(requireRecord(value).thread) };
}

function readTurnResult(value: unknown): CodexTurnResult {
  const turn = sanitizeProtocolValue(requireRecord(requireRecord(value).turn)) as CodexTurnResult['turn'];
  turn.id = validateIdentifier(turn.id, 'turnId');
  return { turn };
}

function protocolError() {
  return new CodexAppServerProtocolError('Codex app-server returned invalid data.');
}

function fingerprint(method: string, params: unknown) {
  return `${method}:${JSON.stringify(params)}`;
}

function sanitizeErrorNotification(value: unknown) {
  const params = requireRecord(value);
  const result: Record<string, unknown> = {
    error: { message: 'Codex turn failed.' }
  };
  if (typeof params.threadId === 'string') {
    result.threadId = validateIdentifier(params.threadId, 'threadId');
  }
  if (typeof params.turnId === 'string') {
    result.turnId = validateIdentifier(params.turnId, 'turnId');
  }
  return result;
}
