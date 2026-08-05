import type { KeyLike } from 'node:crypto';

import type {
  CodexSessionApprovalRequest,
  CodexSessionBrowserRequest,
  CodexSessionBrowserResult,
  CodexSessionContinueRequest,
  CodexSessionInspectRequest,
  CodexSessionInterruptRequest,
  CodexSessionListRequest,
  CodexSessionOperationResult,
  CodexSessionReadRequest,
  CodexSessionSettingsRequest,
  CodexSessionStreamEvent,
  CodexSessionUserInputResponse
} from '../../src/shared/codex-sessions-api';
import type {
  CodexMachineTaskConnectorStartRequest,
  CodexMachineTaskConnectorStartResult
} from '../../src/shared/codex-machine-tasks-api';
import {
  CodexSessionsGrantReplayProtection,
  isCodexSessionsWireRequest,
  verifyCodexSessionsWireRequest,
  type CodexSessionsConnectorOperation,
  type CodexSessionsWireRequest,
  type CodexSessionsWireResult
} from '../codex-sessions-connector-contract';
import type {
  CodexStartTurnInput,
  CodexSteerTurnInput,
  CodexRpcId,
  CodexSessionEvent,
  CodexThreadListInput,
  CodexThreadSummary
} from './contracts';
import {
  CodexOperationUncertainError,
  CodexThreadActiveError,
  type CodexSessionManager
} from './index';
import {
  throwIfCodexExecutionCancelled,
  waitForCodexExecution
} from './execution-control';
import { createLocalCodexTransport } from './local-transport';
import {
  CodexThreadMissingError,
  type CodexSessionsTransport
} from './service';
import {
  CodexPublicEventPresenter,
  eventThreadId,
  presentCodexPermissionSummary,
  presentCodexSession,
  presentCodexTurns,
  publicCodexRequestId
} from './public-presenter';
import { startTurnWithReadReconciliation } from './reconciled-turn-start';
import {
  codexSessionRevision,
  resolveCodexTaskLocation,
  type CodexTaskLocationResolver
} from './task-access-evidence';
import { readCodexBrowserSnapshot } from './browser-snapshot-reader';
import type { LocalCodexTranscriptSource } from './transcript-reader';
import {
  asRecord,
  derivedOperationId,
  operationResult,
  stringValue
} from './connector-executor-helpers';

type ExecutableOperation = Exclude<
  CodexSessionsConnectorOperation,
  'attach' | 'authorization' | 'daemon' | 'stream'
>;
type PendingRequest = {
  canAllow?: boolean;
  method: string;
  requestId: CodexRpcId;
  threadId: string;
  turnId?: string;
};

export interface CodexSessionsConnectorExecutorOptions {
  expectedGeneration: number | (() => number);
  expectedMachineId: string;
  machineName: string;
  manager: CodexSessionManager;
  now?: () => number;
  readBrowserSnapshot?: (
    machineId: string,
    threadId: string,
    options?: { afterImageRevision?: string }
  ) => Promise<CodexSessionBrowserResult>;
  replayProtection?: CodexSessionsGrantReplayProtection;
  resolveImageAttachments?: (attachmentIds: readonly string[]) => Promise<string[]>;
  resolveTaskLocation?: CodexTaskLocationResolver;
  startTask?(
    request: CodexMachineTaskConnectorStartRequest,
    context: { generation: number; userId: string }
  ): Promise<CodexMachineTaskConnectorStartResult>;
  startTurn?(input: CodexStartTurnInput): Promise<{ turn: { id: string } }>;
  steerTurn?(input: CodexSteerTurnInput): Promise<{ turnId: string }>;
  transcript?: LocalCodexTranscriptSource;
  verificationKey: KeyLike;
}

export class CodexSessionsExecutorError extends Error {
  readonly code = 'codex_sessions_executor_rejected';

  constructor() {
    super('The Codex session operation was rejected.');
    this.name = 'CodexSessionsExecutorError';
  }
}

export class CodexSessionsConnectorExecutor {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly presenter = new CodexPublicEventPresenter();
  private readonly replay: CodexSessionsGrantReplayProtection;
  private readonly subscribers = new Map<string, Set<(event: CodexSessionStreamEvent) => void>>();
  private readonly unsubscribeManager: () => boolean;

  constructor(private readonly options: CodexSessionsConnectorExecutorOptions) {
    this.replay = options.replayProtection ?? new CodexSessionsGrantReplayProtection();
    this.unsubscribeManager = options.manager.subscribe((event) => this.handleEvent(event));
  }

  async execute(
    operation: ExecutableOperation,
    value: unknown,
    signal?: AbortSignal
  ): Promise<CodexSessionsWireResult> {
    const request = this.verify(value, operation);
    switch (operation) {
      case 'browser':
        return {
          operation,
          result: await waitForCodexExecution(
            this.browser(request.payload as CodexSessionBrowserRequest),
            signal
          )
        };
      case 'list':
        return {
          operation,
          result: await waitForCodexExecution(
            this.list(request.payload as CodexSessionListRequest, signal),
            signal
          )
        };
      case 'read':
        return {
          operation,
          result: await waitForCodexExecution(
            this.read(request.payload as CodexSessionReadRequest, signal),
            signal
          )
        };
      case 'inspect':
        return {
          operation,
          result: await waitForCodexExecution(
            this.inspect(
              request.payload as CodexSessionInspectRequest,
              request.grant.generation,
              signal
            ),
            signal
          )
        };
      case 'continue':
        return {
          operation,
          result: await this.continue(request.payload as CodexSessionContinueRequest)
        };
      case 'settings':
        return {
          operation,
          result: await this.settings(request.payload as CodexSessionSettingsRequest)
        };
      case 'start':
        if (!this.options.startTask) throw new CodexSessionsExecutorError();
        return {
          operation,
          result: await this.options.startTask(
            request.payload as CodexMachineTaskConnectorStartRequest,
            { generation: request.grant.generation, userId: request.grant.userId }
          )
        };
      case 'interrupt':
        return {
          operation,
          result: await this.interrupt(request.payload as CodexSessionInterruptRequest)
        };
      case 'approval':
        return {
          operation,
          result: await this.approve(request.payload as CodexSessionApprovalRequest)
        };
      case 'input':
        return {
          operation,
          result: await this.respondToInput(request.payload as CodexSessionUserInputResponse)
        };
    }
  }

  stream(value: unknown, emit: (event: CodexSessionStreamEvent) => void) {
    const request = this.verify(value, 'stream');
    const payload = request.payload as CodexSessionReadRequest;
    const listeners = this.subscribers.get(payload.threadId) ?? new Set();
    listeners.add(emit);
    this.subscribers.set(payload.threadId, listeners);
    return () => {
      listeners.delete(emit);
      if (listeners.size === 0) this.subscribers.delete(payload.threadId);
    };
  }

  close() {
    this.unsubscribeManager();
    this.subscribers.clear();
    this.pending.clear();
  }

  createLocalTransport(
    threadId: string,
    transcript?: LocalCodexTranscriptSource
  ): CodexSessionsTransport {
    return createLocalCodexTransport({
      createInvalidResponseError: () => new CodexSessionsExecutorError(),
      expectedGeneration: () => this.expectedGeneration(),
      expectedMachineId: this.options.expectedMachineId,
      inspectFallback: (request) => this.inspect(request, this.expectedGeneration()),
      machineName: this.options.machineName,
      manager: this.options.manager,
      mutate: async ({ kind, machineId, request, threadId: candidateThreadId }) => {
        const result = kind === 'continue'
          ? await this.continue(request as CodexSessionContinueRequest)
          : kind === 'interrupt'
            ? await this.interrupt(request as CodexSessionInterruptRequest)
            : kind === 'approval'
              ? await this.approve(request as CodexSessionApprovalRequest)
              : kind === 'settings'
                ? await this.settings(request as CodexSessionSettingsRequest)
                : await this.respondToInput(request as CodexSessionUserInputResponse);
        return { machineId, result, threadId: candidateThreadId };
      },
      now: () => this.options.now?.() ?? Date.now(),
      readFallback: (request) => this.read(request),
      resolveTaskLocation: this.options.resolveTaskLocation,
      streamFallback: async (_request, emit, signal) => {
        const listeners = this.subscribers.get(threadId) ?? new Set();
        listeners.add(emit);
        this.subscribers.set(threadId, listeners);
        try {
          if (!signal.aborted) {
            await new Promise<void>((resolve) => {
              signal.addEventListener('abort', () => resolve(), { once: true });
            });
          }
        } finally {
          listeners.delete(emit);
          if (listeners.size === 0) this.subscribers.delete(threadId);
        }
      },
      threadId,
      transcript: transcript ?? this.options.transcript
    });
  }

  private verify(value: unknown, operation: CodexSessionsConnectorOperation) {
    if (!isCodexSessionsWireRequest(value)) throw new CodexSessionsExecutorError();
    verifyCodexSessionsWireRequest(value, operation, this.options.verificationKey, {
      expectedGeneration: typeof this.options.expectedGeneration === 'function'
        ? this.options.expectedGeneration()
        : this.options.expectedGeneration,
      expectedMachineId: this.options.expectedMachineId,
      now: this.options.now?.(),
      replayProtection: this.replay
    });
    return value;
  }

  private async list(request: CodexSessionListRequest, signal?: AbortSignal) {
    const checkedAt = new Date(this.options.now?.() ?? Date.now()).toISOString();
    const [active, archived, loaded] = await Promise.all([
      listAllThreads(this.options.manager, {
        searchTerm: request.search,
        sortDirection: 'desc',
        sortKey: 'recency_at'
      }, signal),
      request.includeArchived
        ? listAllThreads(this.options.manager, {
            archived: true,
            searchTerm: request.search,
            sortDirection: 'desc',
            sortKey: 'recency_at'
          }, signal)
        : Promise.resolve([]),
      this.options.manager.listLoadedThreads(signal)
    ]);
    const loadedIds = new Set(loaded.data);
    const storedIds = new Set([...active, ...archived].map((thread) => thread.id));
    const loadedOnly = await mapWithConcurrency(
      [...loadedIds].filter((threadId) => !storedIds.has(threadId)),
      8,
      (threadId) => this.options.manager.readThread(threadId, false, signal).catch((error) => {
        if (signal?.aborted) throw error;
        return undefined;
      }),
      signal
    );
    const sessionsById = new Map([
      ...archived.map((thread) => [thread.id, presentCodexSession(thread, {
        archived: true,
        loadedThreadIds: loadedIds,
        machineId: this.options.expectedMachineId,
        machineName: this.options.machineName
      })] as const),
      ...active.map((thread) => [thread.id, presentCodexSession(thread, {
        archived: false,
        loadedThreadIds: loadedIds,
        machineId: this.options.expectedMachineId,
        machineName: this.options.machineName
      })] as const),
      ...loadedOnly.flatMap((result) => result ? [[result.thread.id, presentCodexSession(
        result.thread,
        {
          archived: result.thread.archived === true,
          loadedThreadIds: loadedIds,
          machineId: this.options.expectedMachineId,
          machineName: this.options.machineName
        }
      )] as const] : [])
    ]);
    const sessions = [...sessionsById.values()].map((session) => {
      const requests = [...this.pending.values()].filter((request) => request.threadId === session.id);
      const attention = requests.some((request) => (
        request.method === 'item/tool/requestUserInput' || request.method === 'tool/requestUserInput'
      ))
        ? 'input' as const
        : requests.length > 0
          ? 'approval' as const
          : undefined;
      return { ...session, ...(attention ? { attention } : {}) };
    }).sort((left, right) => (
      Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt)
      || Number(left.archived) - Number(right.archived)
      || left.title.localeCompare(right.title)
    ));
    return {
      checkedAt,
      machine: {
        id: this.options.expectedMachineId,
        name: this.options.machineName,
        online: true
      },
      publishedAt: new Date(this.options.now?.() ?? Date.now()).toISOString(),
      sessions
    };
  }

  private async read(request: CodexSessionReadRequest, signal?: AbortSignal) {
    const history = await this.options.transcript?.read(request.threadId)
      .catch(() => undefined);
    const [result, loaded] = await Promise.all([
      this.options.manager.readThread(
        request.threadId,
        history === undefined,
        signal
      ),
      this.options.manager.listLoadedThreads(signal)
    ]);
    const session = presentCodexSession(result.thread, {
      archived: result.thread.archived === true,
      loadedThreadIds: new Set(loaded.data),
      machineId: this.options.expectedMachineId,
      machineName: this.options.machineName
    });
    const manager = this.options.manager as Partial<CodexSessionManager>;
    const profiles = await manager.listPermissionProfiles?.(session.cwd, signal)
      .catch(() => undefined);
    const settings = manager.threadSettings?.(request.threadId);
    const tokenUsage = manager.threadTokenUsage?.(request.threadId);
    return {
      openedReadOnly: true as const,
      ...(settings?.permissionProfileId
        ? { permissionProfileId: settings.permissionProfileId }
        : {}),
      ...(profiles ? { permissionProfiles: profiles.data } : {}),
      session,
      ...(tokenUsage ? { tokenUsage } : {}),
      turns: history?.turns ?? presentCodexTurns(result.thread)
    };
  }

  private async browser(request: CodexSessionBrowserRequest) {
    return (this.options.readBrowserSnapshot ?? readCodexBrowserSnapshot)(
      this.options.expectedMachineId,
      request.threadId,
      { afterImageRevision: request.afterImageRevision }
    );
  }

  private async inspect(
    request: CodexSessionInspectRequest,
    connectorGeneration: number,
    signal?: AbortSignal
  ) {
    const checkedAt = new Date(this.options.now?.() ?? Date.now()).toISOString();
    const snapshot = await this.options.manager.readInspectionSnapshot(request.threadId, signal);
    const session = presentCodexSession(snapshot.thread, {
      archived: snapshot.thread.archived === true,
      loadedThreadIds: new Set(snapshot.loaded.data),
      machineId: this.options.expectedMachineId,
      machineName: this.options.machineName
    });
    const inProgressTurns = presentCodexTurns(snapshot.thread)
      .filter((turn) => turn.status === 'in-progress');
    if (
      (session.status === 'idle' && inProgressTurns.length !== 0)
      || (session.status === 'active' && inProgressTurns.length !== 1)
    ) throw new CodexSessionsExecutorError();
    if (!session.cwd) throw new CodexSessionsExecutorError();
    const taskLocation = await (this.options.resolveTaskLocation ?? resolveCodexTaskLocation)(session.cwd);
    if (
      this.expectedGeneration() !== connectorGeneration
      || !this.options.manager.runtimeEpochIsCurrent(snapshot.runtimeEpoch)
    ) throw new CodexSessionsExecutorError();
    const activeTurnId = session.status === 'active' ? inProgressTurns[0]!.id : undefined;
    const sessionRevision = codexSessionRevision({
      ...(activeTurnId ? { activeTurnId } : {}),
      connectorGeneration,
      runtimeEpoch: snapshot.runtimeEpoch,
      session,
      taskLocation
    });
    return {
      ...(activeTurnId ? { activeTurnId } : {}),
      checkedAt,
      openedReadOnly: true as const,
      session,
      sessionRevision,
      taskLocation: {
        ...taskLocation,
        checkedAt,
        machineId: session.machineId,
        sessionRevision,
        source: 'connector-realpath' as const,
        threadId: session.id
      }
    };
  }

  private expectedGeneration() {
    return typeof this.options.expectedGeneration === 'function'
      ? this.options.expectedGeneration()
      : this.options.expectedGeneration;
  }

  private async continue(request: CodexSessionContinueRequest) {
    try {
      const localImagePaths = request.imageAttachmentIds?.length
        ? await this.options.resolveImageAttachments?.(request.imageAttachmentIds)
        : undefined;
      if (request.imageAttachmentIds?.length && !localImagePaths) {
        throw new CodexSessionsExecutorError();
      }
      if (request.delivery === 'steer') {
        if (
          !request.expectedTurnId ||
          request.effort !== undefined ||
          request.model !== undefined ||
          request.permissionProfileId !== undefined ||
          request.serviceTier !== undefined
        ) {
          throw new CodexSessionsExecutorError();
        }
        if (!this.options.steerTurn) {
          const resumed = await this.options.manager.resumeThread({
            operationId: derivedOperationId(request.operationId, 'resume-steer'),
            threadId: request.threadId
          });
          if (resumed.thread.status?.type !== 'active') {
            return operationResult(request, 'rejected');
          }
        }
        const steerTurn = this.options.steerTurn ??
          ((input: CodexSteerTurnInput) => this.options.manager.steerTurn(input));
        const result = await steerTurn({
          expectedTurnId: request.expectedTurnId,
          ...(localImagePaths?.length ? { localImagePaths } : {}),
          operationId: derivedOperationId(request.operationId, 'steer'),
          prompt: request.message,
          threadId: request.threadId
        });
        return operationResult(request, 'accepted', result.turnId);
      }
      const resumed = await this.options.manager.resumeThread({
        operationId: derivedOperationId(request.operationId, 'resume'),
        threadId: request.threadId
      });
      if (resumed.thread.status?.type === 'active') {
        return operationResult(request, 'rejected', undefined, 'thread_active');
      }
      const startInput = {
        effort: request.effort,
        ...(localImagePaths?.length ? { localImagePaths } : {}),
        model: request.model,
        operationId: derivedOperationId(request.operationId, 'turn'),
        permissionProfileId: request.permissionProfileId,
        prompt: request.message,
        serviceTier: request.serviceTier,
        threadId: request.threadId
      };
      const result = this.options.startTurn
        ? await this.options.startTurn(startInput)
        : await startTurnWithReadReconciliation(this.options.manager, startInput);
      return operationResult(request, 'accepted', result.turn.id);
    } catch (error) {
      if (error instanceof CodexThreadActiveError) {
        return operationResult(request, 'rejected', undefined, 'thread_active');
      }
      if (error instanceof CodexOperationUncertainError) return operationResult(request, 'ambiguous');
      return operationResult(request, 'rejected');
    }
  }

  private async interrupt(request: CodexSessionInterruptRequest) {
    try {
      await this.options.manager.interruptTurn({
        operationId: derivedOperationId(request.operationId, 'interrupt'),
        threadId: request.threadId,
        turnId: request.turnId
      });
      return operationResult(request, 'accepted', request.turnId);
    } catch (error) {
      if (error instanceof CodexOperationUncertainError) return operationResult(request, 'ambiguous');
      throw new CodexSessionsExecutorError();
    }
  }

  private async settings(request: CodexSessionSettingsRequest) {
    try {
      const thread = await this.options.manager.readThread(request.threadId, false);
      const profiles = await this.options.manager.listPermissionProfiles(thread.thread.cwd);
      const selected = profiles.data.find(
        (profile) => profile.id === request.permissionProfileId
      );
      if (!selected?.allowed) {
        return operationResult(request, 'rejected');
      }
      await this.options.manager.updateThreadSettings({
        operationId: derivedOperationId(request.operationId, 'settings'),
        permissionProfileId: selected.id,
        threadId: request.threadId
      });
      return operationResult(request, 'completed');
    } catch (error) {
      if (error instanceof CodexOperationUncertainError) {
        return operationResult(request, 'ambiguous');
      }
      throw new CodexSessionsExecutorError();
    }
  }

  private async approve(request: CodexSessionApprovalRequest) {
    const pending = this.requirePending(request.requestId, request.threadId, request.turnId);
    try {
      if (pending.method === 'item/permissions/requestApproval') {
        if (request.decision === 'allow-once' && pending.canAllow === false) {
          return operationResult(request, 'rejected', request.turnId);
        }
        await this.options.manager.respondToPermissions({
          grant: request.decision === 'allow-once' ? 'allRequested' : 'none',
          operationId: derivedOperationId(request.operationId, 'permission'),
          requestId: pending.requestId,
          scope: 'turn',
          threadId: request.threadId,
          turnId: request.turnId
        });
      } else {
        await this.options.manager.respondToApproval({
          decision: request.decision === 'allow-once' ? 'accept' : 'decline',
          operationId: derivedOperationId(request.operationId, 'approval'),
          requestId: pending.requestId,
          threadId: request.threadId,
          turnId: request.turnId
        });
      }
      return operationResult(request, 'completed', request.turnId);
    } catch (error) {
      if (error instanceof CodexOperationUncertainError) return operationResult(request, 'ambiguous');
      throw new CodexSessionsExecutorError();
    }
  }

  private async respondToInput(request: CodexSessionUserInputResponse) {
    const pending = this.requirePending(request.requestId, request.threadId, request.turnId);
    if (pending.method !== 'item/tool/requestUserInput' && pending.method !== 'tool/requestUserInput') {
      throw new CodexSessionsExecutorError();
    }
    try {
      await this.options.manager.respondToUserInput({
        answers: Object.fromEntries(request.answers.map((answer) => [answer.questionId, [answer.value]])),
        operationId: derivedOperationId(request.operationId, 'input'),
        requestId: pending.requestId,
        threadId: request.threadId,
        turnId: request.turnId
      });
      return operationResult(request, 'completed', request.turnId);
    } catch (error) {
      if (error instanceof CodexOperationUncertainError) return operationResult(request, 'ambiguous');
      throw new CodexSessionsExecutorError();
    }
  }

  private requirePending(requestId: string, threadId: string, turnId: string) {
    const pending = this.pending.get(requestId);
    if (!pending || pending.threadId !== threadId || pending.turnId !== turnId) {
      throw new CodexSessionsExecutorError();
    }
    return pending;
  }

  private handleEvent(event: CodexSessionEvent) {
    if (event.kind === 'request' && event.requestId !== undefined) {
      const params = asRecord(event.params);
      const threadId = stringValue(params?.threadId);
      const turnId = stringValue(params?.turnId);
      if (threadId) {
        const permission = event.method === 'item/permissions/requestApproval'
          ? presentCodexPermissionSummary(params?.permissions ?? params?.requestedPermissions)
          : undefined;
        this.pending.set(publicCodexRequestId(event.requestId), {
          ...(permission ? { canAllow: permission.complete } : {}),
          method: event.method,
          requestId: event.requestId,
          threadId,
          ...(turnId ? { turnId } : {})
        });
      }
    }
    if (event.kind === 'notification' && event.method === 'serverRequest/resolved') {
      const params = asRecord(event.params);
      const requestId = params?.requestId;
      if (typeof requestId === 'number' || typeof requestId === 'string') {
        this.pending.delete(publicCodexRequestId(requestId));
      }
    }
    const presented = this.presenter.present(event);
    const threadId = eventThreadId(event);
    if (!presented || !threadId) return;
    for (const listener of this.subscribers.get(threadId) ?? []) listener(presented);
  }
}

async function mapWithConcurrency<Input, Result>(
  input: Input[],
  concurrency: number,
  operation: (value: Input) => Promise<Result>,
  signal?: AbortSignal
) {
  const results = new Array<Result>(input.length);
  let index = 0;
  const worker = async () => {
    while (index < input.length) {
      throwIfCodexExecutionCancelled(signal);
      const current = index;
      index += 1;
      results[current] = await operation(input[current]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, input.length) }, worker));
  return results;
}

async function listAllThreads(
  manager: Pick<CodexSessionManager, 'listThreads'>,
  input: CodexThreadListInput,
  signal?: AbortSignal
): Promise<CodexThreadSummary[]> {
  const threads: CodexThreadSummary[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    throwIfCodexExecutionCancelled(signal);
    const result = await manager.listThreads({ ...input, cursor, limit: 100 }, signal);
    threads.push(...result.data);
    if (!result.nextCursor) return threads;
    if (seenCursors.has(result.nextCursor)) throw new CodexSessionsExecutorError();
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new CodexSessionsExecutorError();
}
