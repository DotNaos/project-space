import { createHash, type KeyLike } from 'node:crypto';

import type {
  CodexSessionApprovalRequest,
  CodexSessionContinueRequest,
  CodexSessionInterruptRequest,
  CodexSessionListRequest,
  CodexSessionOperationResult,
  CodexSessionReadRequest,
  CodexSessionStreamEvent,
  CodexSessionUserInputResponse
} from '../../src/shared/codex-sessions-api';
import {
  CodexSessionsGrantReplayProtection,
  isCodexSessionsWireRequest,
  verifyCodexSessionsWireRequest,
  type CodexSessionsConnectorOperation,
  type CodexSessionsWireRequest,
  type CodexSessionsWireResult
} from '../codex-sessions-connector-contract';
import type {
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
  CodexPublicEventPresenter,
  eventThreadId,
  presentCodexSession,
  presentCodexTurns,
  publicCodexRequestId
} from './public-presenter';

type ExecutableOperation = Exclude<CodexSessionsConnectorOperation, 'stream'>;
type PendingRequest = {
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
  replayProtection?: CodexSessionsGrantReplayProtection;
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

  async execute(operation: ExecutableOperation, value: unknown): Promise<CodexSessionsWireResult> {
    const request = this.verify(value, operation);
    switch (operation) {
      case 'list':
        return { operation, result: await this.list(request.payload as CodexSessionListRequest) };
      case 'read':
        return { operation, result: await this.read(request.payload as CodexSessionReadRequest) };
      case 'continue':
        return {
          operation,
          result: await this.continue(request.payload as CodexSessionContinueRequest)
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

  private async list(request: CodexSessionListRequest) {
    const [active, archived, loaded] = await Promise.all([
      listAllThreads(this.options.manager, {
        searchTerm: request.search,
        sortDirection: 'desc',
        sortKey: 'recency_at'
      }),
      request.includeArchived
        ? listAllThreads(this.options.manager, {
            archived: true,
            searchTerm: request.search,
            sortDirection: 'desc',
            sortKey: 'recency_at'
          })
        : Promise.resolve([]),
      this.options.manager.listLoadedThreads()
    ]);
    const loadedIds = new Set(loaded.data);
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
      })] as const)
    ]);
    return {
      checkedAt: new Date(this.options.now?.() ?? Date.now()).toISOString(),
      machine: {
        id: this.options.expectedMachineId,
        name: this.options.machineName,
        online: true
      },
      sessions: [...sessionsById.values()].sort((left, right) => (
        Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt)
        || Number(left.archived) - Number(right.archived)
        || left.title.localeCompare(right.title)
      ))
    };
  }

  private async read(request: CodexSessionReadRequest) {
    const [result, loaded] = await Promise.all([
      this.options.manager.readThread(request.threadId, true),
      this.options.manager.listLoadedThreads()
    ]);
    return {
      openedReadOnly: true as const,
      session: presentCodexSession(result.thread, {
        archived: result.thread.archived === true,
        loadedThreadIds: new Set(loaded.data),
        machineId: this.options.expectedMachineId,
        machineName: this.options.machineName
      }),
      turns: presentCodexTurns(result.thread)
    };
  }

  private async continue(request: CodexSessionContinueRequest) {
    try {
      const resumed = await this.options.manager.resumeThread({
        operationId: derivedOperationId(request.operationId, 'resume'),
        threadId: request.threadId
      });
      if (resumed.thread.status?.type === 'active') {
        return operationResult(request, 'rejected');
      }
      const result = await this.options.manager.startTurn({
        operationId: derivedOperationId(request.operationId, 'turn'),
        prompt: request.message,
        threadId: request.threadId
      });
      return operationResult(request, 'accepted', result.turn.id);
    } catch (error) {
      if (error instanceof CodexThreadActiveError) return operationResult(request, 'rejected');
      if (error instanceof CodexOperationUncertainError) return operationResult(request, 'ambiguous');
      throw new CodexSessionsExecutorError();
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

  private async approve(request: CodexSessionApprovalRequest) {
    const pending = this.requirePending(request.requestId, request.threadId, request.turnId);
    try {
      if (pending.method === 'item/permissions/requestApproval') {
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
        this.pending.set(publicCodexRequestId(event.requestId), {
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

async function listAllThreads(
  manager: Pick<CodexSessionManager, 'listThreads'>,
  input: CodexThreadListInput
): Promise<CodexThreadSummary[]> {
  const threads: CodexThreadSummary[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const result = await manager.listThreads({ ...input, cursor, limit: 100 });
    threads.push(...result.data);
    if (!result.nextCursor) return threads;
    if (seenCursors.has(result.nextCursor)) throw new CodexSessionsExecutorError();
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new CodexSessionsExecutorError();
}

function derivedOperationId(operationId: string, step: string) {
  const digest = createHash('sha256').update(`${step}\u0000${operationId}`).digest('hex').slice(0, 32);
  return `codex:${step}:${digest}`;
}

function operationResult(
  request: { operationId: string; threadId: string },
  status: CodexSessionOperationResult['status'],
  turnId?: string
): CodexSessionOperationResult {
  return {
    operationId: request.operationId,
    replayed: false,
    status,
    threadId: request.threadId,
    ...(turnId ? { turnId } : {})
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value ? value : undefined;
}
