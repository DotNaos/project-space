import type {
  CodexApprovalResponseInput,
  CodexInterruptTurnInput,
  CodexLoadedThreadListResult,
  CodexOperationSnapshot,
  CodexPermissionProfileListResult,
  CodexPermissionResponseInput,
  CodexProcessFactory,
  CodexResumeThreadInput,
  CodexRpcId,
  CodexSessionEvent,
  CodexSessionEventListener,
  CodexStartThreadInput,
  CodexStartTurnInput,
  CodexSteerTurnInput,
  CodexThreadListInput,
  CodexThreadListResult,
  CodexThreadResult,
  CodexThreadSettingsSnapshot,
  CodexThreadSummary,
  CodexThreadTokenUsageSnapshot,
  CodexUpdateThreadSettingsInput,
  CodexUserInputResponseInput
} from './contracts';
import {
  codexSessionMaintenanceBlockers,
  type CodexPendingMaintenanceRequest
} from './maintenance-blockers';
import { CodexSessionMaintenanceReconciler } from './maintenance-reconciliation';
import { CodexResolutionWaiters } from './resolution-waiters';
import {
  CodexOperationLedger,
  CodexOperationUncertainError,
  type CodexOperationSnapshotPersist
} from './operation-ledger';
import {
  type CodexAppServerTransport,
  CodexAppServerProtocolError,
  CodexAppServerRequestCancelledError,
  CodexStdioTransport
} from './stdio-transport';
import { CodexWebSocketTransport } from './websocket-transport';
import {
  isNotificationMethod,
  isServerRequestMethod,
  rpcIdKey,
  validateAnswers,
  validateIdentifier,
  validatePrompt,
  validateRpcId,
  validateThreadListInput,
  sanitizeProtocolValue
} from './validation';
import {
  fingerprint,
  protocolError,
  readLoadedThreads,
  readPermissionProfile,
  readResumedThreadResult,
  readStartedThreadResult,
  readStartedTurnResult,
  readThread,
  readThreadResult,
  readThreadTokenUsage,
  requireRecord,
  sanitizeErrorNotification,
  validateCwd,
  validateLocalImagePaths,
  validatePermissionProfileId
} from './protocol-readers';

type IncomingMessage = {
  id?: CodexRpcId;
  method?: string;
  params?: unknown;
};

const unknownActiveTurn = '__active_turn__';

export interface CodexSessionManagerOptions {
  binaryPath?: string;
  codexHome?: string;
  daemonSocketPath?: string;
  maximumThreadReadLineCharacters?: number;
  operationSnapshot?: CodexOperationSnapshot;
  persistOperationSnapshot?: CodexOperationSnapshotPersist;
  processFactory?: CodexProcessFactory;
  sharedDaemon?: boolean;
  transportFactory?: () => Promise<CodexAppServerTransport>;
}

export class CodexThreadActiveError extends Error {
  readonly code = 'codex_thread_active';
}

export class CodexSessionManager {
  private readonly activeTurns = new Map<string, string>();
  private readonly listeners = new Set<CodexSessionEventListener>();
  private readonly ledger: CodexOperationLedger;
  private readonly maintenanceReconciler: CodexSessionMaintenanceReconciler;
  private readonly pendingServerRequests = new Map<string, CodexPendingMaintenanceRequest>();
  private readonly settingsByThread = new Map<string, CodexThreadSettingsSnapshot>();
  private readonly tokenUsageByThread = new Map<string, CodexThreadTokenUsageSnapshot>();
  private readonly resolutionWaiters = new CodexResolutionWaiters();
  private runtimeEpoch = 0;
  private readonly startingThreads = new Set<string>();
  private startPromise?: Promise<CodexAppServerTransport>;
  private startingTransport?: CodexAppServerTransport;
  private transport?: CodexAppServerTransport;
  private transportStartGeneration = 0;
  private readonly transportEpochs = new WeakMap<CodexAppServerTransport, number>();

  constructor(private readonly options: CodexSessionManagerOptions = {}) {
    this.ledger = new CodexOperationLedger(
      options.operationSnapshot,
      options.persistOperationSnapshot
    );
    this.maintenanceReconciler = new CodexSessionMaintenanceReconciler(options.sharedDaemon === true);
  }

  subscribe(listener: CodexSessionEventListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async listThreads(
    input: CodexThreadListInput = {},
    signal?: AbortSignal
  ): Promise<CodexThreadListResult> {
    const result = await this.call<unknown>(
      'thread/list',
      validateThreadListInput(input),
      signal
    );
    const record = requireRecord(result);
    if (!Array.isArray(record.data)) throw protocolError();
    return {
      data: record.data.map(readThread),
      nextCursor: typeof record.nextCursor === 'string' ? record.nextCursor : null
    };
  }

  async listLoadedThreads(signal?: AbortSignal): Promise<CodexLoadedThreadListResult> {
    return readLoadedThreads(await this.call<unknown>('thread/loaded/list', {}, signal));
  }

  async listPermissionProfiles(
    cwd?: string,
    signal?: AbortSignal
  ): Promise<CodexPermissionProfileListResult> {
    const result = requireRecord(await this.call<unknown>(
      'permissionProfile/list',
      { ...(cwd ? { cwd: validateCwd(cwd) } : {}), limit: 100 },
      signal
    ));
    if (!Array.isArray(result.data) || result.data.length > 100) throw protocolError();
    return {
      data: result.data.map(readPermissionProfile),
      nextCursor: typeof result.nextCursor === 'string' ? result.nextCursor : null
    };
  }

  async readThread(
    threadId: string,
    includeTurns = true,
    signal?: AbortSignal
  ): Promise<CodexThreadResult> {
    validateIdentifier(threadId, 'threadId');
    return readThreadResult(await this.call('thread/read', { includeTurns, threadId }, signal));
  }

  async readInspectionSnapshot(
    threadId: string,
    signal?: AbortSignal,
    includeTurns = true
  ) {
    const normalizedThreadId = validateIdentifier(threadId, 'threadId');
    const transport = await waitForCodexRequest(this.ensureTransport(), signal);
    const runtimeEpoch = this.transportEpochs.get(transport);
    if (!runtimeEpoch) throw protocolError();
    const [thread, loaded] = await Promise.all([
      transport.call<unknown>(
        'thread/read',
        { includeTurns, threadId: normalizedThreadId },
        { signal }
      ),
      transport.call<unknown>('thread/loaded/list', {}, { signal })
    ]);
    return {
      loaded: readLoadedThreads(loaded),
      runtimeEpoch,
      thread: readThreadResult(thread).thread
    };
  }

  resumeThread(input: CodexResumeThreadInput) {
    const threadId = validateIdentifier(input.threadId, 'threadId');
    return this.ledger.execute(
      input.operationId,
      fingerprint('thread/resume', { threadId }),
      async () => {
        const response = await this.call<unknown>('thread/resume', { threadId });
        const result = readResumedThreadResult(
          response,
          threadId
        );
        this.captureThreadSettings(threadId, response);
        this.captureThreadStatus(result.thread);
        return result;
      }
    );
  }

  updateThreadSettings(input: CodexUpdateThreadSettingsInput) {
    const threadId = validateIdentifier(input.threadId, 'threadId');
    const permissionProfileId = validatePermissionProfileId(input.permissionProfileId);
    return this.ledger.execute(
      input.operationId,
      fingerprint('thread/settings/update', { permissionProfileId, threadId }),
      async () => {
        await this.call('thread/settings/update', {
          permissions: permissionProfileId,
          threadId
        });
        this.settingsByThread.set(threadId, { permissionProfileId });
        return {};
      }
    );
  }

  threadSettings(threadId: string) {
    return this.settingsByThread.get(validateIdentifier(threadId, 'threadId'));
  }

  threadTokenUsage(threadId: string) {
    return this.tokenUsageByThread.get(validateIdentifier(threadId, 'threadId'));
  }

  startThread(input: CodexStartThreadInput) {
    const cwd = validateCwd(input.cwd);
    const params = {
      approvalPolicy: 'on-request',
      cwd,
      ephemeral: false,
      sandbox: 'workspace-write'
    } as const;
    return this.ledger.execute(
      input.operationId,
      fingerprint('thread/start', params),
      async () => readStartedThreadResult(await this.call('thread/start', params))
    );
  }

  startTurn(input: CodexStartTurnInput) {
    const threadId = validateIdentifier(input.threadId, 'threadId');
    const prompt = validatePrompt(input.prompt);
    const localImagePaths = validateLocalImagePaths(input.localImagePaths);
    const effort = input.effort === undefined
      ? undefined
      : validateIdentifier(input.effort, 'effort');
    const model = input.model === undefined
      ? undefined
      : validateIdentifier(input.model, 'model');
    const permissionProfileId = input.permissionProfileId === undefined
      ? undefined
      : validatePermissionProfileId(input.permissionProfileId);
    const serviceTier = input.serviceTier === null
      ? null
      : input.serviceTier === undefined
        ? undefined
        : validateIdentifier(input.serviceTier, 'serviceTier');
    const settings = {
      ...(effort ? { effort } : {}),
      ...(model ? { model } : {}),
      ...(permissionProfileId ? { permissions: permissionProfileId } : {}),
      ...(serviceTier !== undefined ? { serviceTier } : {})
    };
    return this.ledger.execute(
      input.operationId,
      fingerprint('turn/start', { ...settings, localImagePaths, prompt, threadId }),
      async () => {
        if (this.activeTurns.has(threadId) || this.startingThreads.has(threadId)) {
          throw new CodexThreadActiveError('Wait for the active turn to finish.');
        }
        this.startingThreads.add(threadId);
        try {
          const result = readStartedTurnResult(
            await this.call('turn/start', {
              clientUserMessageId: input.operationId,
              input: [
                { text: prompt, text_elements: [], type: 'text' },
                ...localImagePaths.map((path) => ({ path, type: 'localImage' as const }))
              ],
              ...settings,
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

  steerTurn(input: CodexSteerTurnInput) {
    const threadId = validateIdentifier(input.threadId, 'threadId');
    const expectedTurnId = validateIdentifier(input.expectedTurnId, 'turnId');
    const prompt = validatePrompt(input.prompt);
    const localImagePaths = validateLocalImagePaths(input.localImagePaths);
    return this.ledger.execute(
      input.operationId,
      fingerprint('turn/steer', { expectedTurnId, localImagePaths, prompt, threadId }),
      async () => {
        const result = requireRecord(await this.call('turn/steer', {
          clientUserMessageId: input.operationId,
          expectedTurnId,
          input: [
            { text: prompt, text_elements: [], type: 'text' },
            ...localImagePaths.map((path) => ({ path, type: 'localImage' as const }))
          ],
          threadId
        }));
        const turnId = validateIdentifier(result.turnId, 'turnId');
        this.activeTurns.set(threadId, turnId);
        return { turnId };
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

  async reconcileOperationNotApplied(operationId: string) {
    await this.ledger.reconcileNotApplied(operationId);
  }

  async reconcileOperationCompleted<Result>(operationId: string, result: Result) {
    await this.ledger.reconcileCompleted(operationId, result);
  }

  operationSnapshot() {
    return this.ledger.snapshot();
  }

  maintenanceBlockers() {
    if (!this.maintenanceReconciler.isAuthoritative()) {
      void this.reconcileMaintenanceState().catch(() => undefined);
    }
    return [
      ...this.maintenanceReconciler.maintenanceBlockers(),
      ...codexSessionMaintenanceBlockers({
        activeTurns: this.activeTurns, operationSnapshot: this.ledger.snapshot(),
        pendingServerRequests: this.pendingServerRequests.values(),
        startingThreads: this.startingThreads, unknownActiveTurn
      })
    ];
  }

  invalidateMaintenanceState() { this.maintenanceReconciler.markUncertain(); }

  reconcileMaintenanceState(signal?: AbortSignal) {
    return this.maintenanceReconciler.reconcile({
      apply: (threads) => {
        this.activeTurns.clear();
        for (const thread of threads) this.captureThreadStatus(thread);
      },
      getTransport: () => waitForCodexRequest(this.ensureTransport(), signal),
      isRuntimeEpochCurrent: (runtimeEpoch) => this.runtimeEpochIsCurrent(runtimeEpoch),
      runtimeEpochFor: (transport) => this.transportEpochs.get(transport),
      signal
    });
  }

  executeManagedOperation<Result>(
    operationId: string,
    fingerprint: string,
    action: () => Promise<Result>
  ) {
    return this.ledger.execute(operationId, fingerprint, action);
  }

  currentRuntimeEpoch() {
    return this.runtimeEpoch;
  }

  runtimeEpochIsCurrent(runtimeEpoch: number) {
    const transport = this.transport;
    return Boolean(
      transport?.isOpen
      && this.runtimeEpoch === runtimeEpoch
      && this.transportEpochs.get(transport) === runtimeEpoch
    );
  }

  async close() {
    const transport = this.transport;
    const startingTransport = this.startingTransport;
    this.transportStartGeneration += 1;
    this.transport = undefined;
    this.startingTransport = undefined;
    this.startPromise = undefined;
    this.maintenanceReconciler.markUncertain();
    await Promise.all([
      transport?.close(),
      startingTransport && startingTransport !== transport
        ? startingTransport.close()
        : undefined
    ]);
  }

  private async call<Result>(
    method: string,
    params?: unknown,
    signal?: AbortSignal
  ): Promise<Result> {
    const transport = await waitForCodexRequest(this.ensureTransport(), signal);
    return transport.call<Result>(method, params, { signal });
  }

  private ensureTransport() {
    if (this.transport?.isOpen) return Promise.resolve(this.transport);
    if (this.startPromise) return this.startPromise;
    const startGeneration = ++this.transportStartGeneration;
    let startPromise!: Promise<CodexAppServerTransport>;
    startPromise = (async () => {
      const transport = this.options.transportFactory
        ? await this.options.transportFactory()
        : this.options.sharedDaemon
          ? await CodexWebSocketTransport.connect({
              onClose: () => this.handleTransportClose(),
              onMessage: (message) => this.handleMessage(message),
              socketPath: this.options.daemonSocketPath
            })
          : CodexStdioTransport.launch({
              ...this.options,
              onClose: () => this.handleTransportClose(),
              onMessage: (message) => this.handleMessage(message)
            });
      if (startGeneration !== this.transportStartGeneration) {
        await transport.close();
        throw new CodexAppServerRequestCancelledError();
      }
      this.startingTransport = transport;
      try {
        await transport.initialize();
        if (this.startingTransport !== transport) {
          await transport.close();
          throw new CodexAppServerRequestCancelledError();
        }
        this.startingTransport = undefined;
        this.runtimeEpoch += 1;
        this.transportEpochs.set(transport, this.runtimeEpoch);
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

  private handleMessage(message: IncomingMessage) {
    try {
      if (!message.method) return;
      if (isServerRequestMethod(message.method) && message.id !== undefined) {
        this.maintenanceReconciler.noteLifecycleChange();
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
      this.maintenanceReconciler.noteLifecycleChange();
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
    if (method === 'thread/settings/updated') {
      const threadId = validateIdentifier(record.threadId, 'threadId');
      this.captureThreadSettings(threadId, record.threadSettings);
    }
    if (method === 'thread/tokenUsage/updated') {
      const threadId = validateIdentifier(record.threadId, 'threadId');
      this.tokenUsageByThread.set(threadId, readThreadTokenUsage(record.tokenUsage));
    }
    if (method === 'serverRequest/resolved') {
      const requestId = record.requestId;
      if (requestId !== undefined) {
        const key = rpcIdKey(validateRpcId(requestId));
        this.pendingServerRequests.delete(key);
        this.resolutionWaiters.resolve(validateRpcId(requestId));
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

  private respondWithLedger(
    operationId: string, pending: CodexPendingMaintenanceRequest, result: unknown
  ) {
    return this.ledger.execute(
      operationId,
      fingerprint(pending.method, { requestId: pending.requestId, result }),
      async () => {
        const transport = await this.ensureTransport();
        const confirmation = this.resolutionWaiters.wait(
          pending.requestId,
          this.pendingServerRequests.has(rpcIdKey(pending.requestId))
        );
        try {
          await transport.respond(pending.requestId, result);
        } catch {
          const uncertain = new CodexOperationUncertainError(
            'The Codex request response was not confirmed.'
          );
          this.resolutionWaiters.reject(pending.requestId, uncertain);
          await confirmation.catch(() => undefined);
          throw uncertain;
        }
        await confirmation;
        return {};
      }
    );
  }

  private handleTransportClose() {
    this.maintenanceReconciler.markUncertain();
    this.activeTurns.clear();
    this.startingThreads.clear();
    this.pendingServerRequests.clear();
    this.settingsByThread.clear();
    this.tokenUsageByThread.clear();
    this.resolutionWaiters.rejectAll(
      new CodexOperationUncertainError('Codex app-server restarted before confirmation.')
    );
  }

  private captureThreadStatus(thread: CodexThreadSummary) {
    if (thread.status?.type === 'active') {
      this.activeTurns.set(thread.id, unknownActiveTurn);
    } else {
      this.activeTurns.delete(thread.id);
    }
  }

  private captureThreadSettings(threadId: string, value: unknown) {
    const record = requireRecord(value);
    const settings = record.threadSettings && typeof record.threadSettings === 'object'
      ? requireRecord(record.threadSettings)
      : record;
    const active = settings.activePermissionProfile;
    if (!active || typeof active !== 'object' || Array.isArray(active)) return;
    const profileId = validatePermissionProfileId(requireRecord(active).id);
    this.settingsByThread.set(threadId, { permissionProfileId: profileId });
  }

  private emit(event: CodexSessionEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

function waitForCodexRequest<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new CodexAppServerRequestCancelledError());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new CodexAppServerRequestCancelledError());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
