import type {
  CodexSessionApprovalRequest,
  CodexSessionContinueRequest,
  CodexSessionInterruptRequest,
  CodexSessionListRequest,
  CodexSessionListResult,
  CodexSessionMachineRecord,
  CodexSessionOperationResult,
  CodexSessionReadRequest,
  CodexSessionReadResult,
  CodexSessionRecord,
  CodexSessionStreamEvent,
  CodexSessionUserInputResponse
} from '../../src/shared/codex-sessions-api';
import type {
  CodexSessionsStore,
  CodexStoredOperationInput,
  CodexStoredOperationName
} from '../codex-sessions-store';

export interface CodexSessionsActor {
  userId: string;
}

export interface CodexSessionStreamRequest extends CodexSessionReadRequest {
  afterSequence?: number;
}

export interface CodexSessionsTransport {
  describeMachine(machineId: string): Promise<CodexSessionMachineRecord>;
  list(machineId: string): Promise<CodexSessionListResult>;
  mutate(input: {
    kind: 'approval' | 'continue' | 'input' | 'interrupt';
    machineId: string;
    request:
      | CodexSessionApprovalRequest
      | CodexSessionContinueRequest
      | CodexSessionInterruptRequest
      | CodexSessionUserInputResponse;
    threadId: string;
  }): Promise<{
    machineId: string;
    result: CodexSessionOperationResult;
    threadId: string;
  }>;
  read(input: CodexSessionReadRequest): Promise<CodexSessionReadResult>;
}

interface MachineScope {
  machineId: string;
  userId: string;
}

interface SessionScope extends MachineScope {
  threadId: string;
}

type ScopedOperation = CodexStoredOperationInput;

interface StreamSubscriber {
  emit(event: CodexSessionStreamEvent): void;
  queued: CodexSessionStreamEvent[];
  ready: boolean;
  seen: Set<string>;
}

export class CodexSessionsAccessError extends Error {
  readonly code = 'codex_sessions_access_denied';
}

export class CodexSessionsConflictError extends Error {
  readonly code = 'codex_sessions_operation_conflict';
}

export class CodexTransportUnavailableError extends Error {}
export class CodexTransportUncertainError extends Error {}
export class CodexThreadMissingError extends Error {}

export function createCodexSessionsService(options: {
  authorize(actor: CodexSessionsActor, machineId: string): Promise<void>;
  now?: () => Date;
  store: Pick<
    CodexSessionsStore,
    | 'appendEvent'
    | 'completeOperation'
    | 'listEvents'
    | 'listInventory'
    | 'markOperationAmbiguous'
    | 'reserveOperation'
    | 'saveInventory'
  >;
  transport: CodexSessionsTransport;
}) {
  const now = options.now ?? (() => new Date());
  const activeOperations = new Map<string, Promise<CodexSessionOperationResult>>();
  const subscribers = new Map<string, Set<StreamSubscriber>>();

  async function scope(actor: CodexSessionsActor, machineId: string): Promise<MachineScope> {
    const userId = required(actor.userId, 'userId');
    const normalizedMachineId = required(machineId, 'machineId');
    await options.authorize({ userId }, normalizedMachineId);
    return { machineId: normalizedMachineId, userId };
  }

  async function list(actor: CodexSessionsActor, request: CodexSessionListRequest) {
    const machineScope = await scope(actor, request.machineId);
    try {
      const inventory = validateInventory(await options.transport.list(machineScope.machineId), machineScope.machineId);
      await options.store.saveInventory({
        ...machineScope,
        checkedAt: inventory.checkedAt,
        completeInventory: true,
        sessions: inventory.sessions
      });
      return filterInventory(inventory, request);
    } catch (error) {
      if (!(error instanceof CodexTransportUnavailableError)) throw error;
      const machine = await offlineMachine(options.transport, machineScope.machineId);
      const sessions = await options.store.listInventory(machineScope.userId, machineScope.machineId);
      return filterInventory(asOfflineInventory(machine, sessions, now), request);
    }
  }

  async function read(actor: CodexSessionsActor, request: CodexSessionReadRequest) {
    const sessionScope = { ...(await scope(actor, request.machineId)), threadId: required(request.threadId, 'threadId') };
    try {
      const result = validateRead(await options.transport.read(request), sessionScope);
      return result;
    } catch (error) {
      if (error instanceof CodexThreadMissingError) return missingRead(await storedRecord(options.store, sessionScope), sessionScope);
      if (!(error instanceof CodexTransportUnavailableError)) throw error;
      return missingRead(await storedRecord(options.store, sessionScope), sessionScope, 'offline');
    }
  }

  function mutate(
    actor: CodexSessionsActor,
    kind: 'approval' | 'continue' | 'input' | 'interrupt',
    request: CodexSessionApprovalRequest | CodexSessionContinueRequest | CodexSessionInterruptRequest | CodexSessionUserInputResponse
  ) {
    return runMutation(actor, kind, request);
  }

  async function runMutation(
    actor: CodexSessionsActor,
    kind: 'approval' | 'continue' | 'input' | 'interrupt',
    request: CodexSessionApprovalRequest | CodexSessionContinueRequest | CodexSessionInterruptRequest | CodexSessionUserInputResponse
  ) {
    const machineScope = await scope(actor, request.machineId);
    const threadId = required(request.threadId, 'threadId');
    const operationId = required(request.operationId, 'operationId');
    const fingerprint = { kind, request: { ...request, operationId: undefined }, threadId };
    const operation = {
      ...machineScope,
      fingerprint,
      operation: operationName(kind),
      operationId,
      threadId
    } satisfies ScopedOperation;
    const key = operationKey(operation);
    const running = activeOperations.get(key);
    if (running) return running;

    const reserved = await options.store.reserveOperation(operation);
    if (reserved.kind === 'conflict') throw new CodexSessionsConflictError('The operation id was reused for different input.');
    if (reserved.kind === 'replayed') return { ...reserved.result, replayed: true };
    if (reserved.kind === 'ambiguous') return ambiguousResult(operation, true);
    if (reserved.kind === 'pending') {
      const joined = activeOperations.get(key);
      if (joined) return joined;
      const result = ambiguousResult(operation, true);
      await options.store.markOperationAmbiguous(operation);
      return result;
    }

    const execution = executeReserved(kind, request, operation).finally(() => {
      if (activeOperations.get(key) === execution) activeOperations.delete(key);
    });
    activeOperations.set(key, execution);
    return execution;
  }

  async function executeReserved(
    kind: 'approval' | 'continue' | 'input' | 'interrupt',
    request: CodexSessionApprovalRequest | CodexSessionContinueRequest | CodexSessionInterruptRequest | CodexSessionUserInputResponse,
    operation: ScopedOperation
  ) {
    try {
      const response = await options.transport.mutate({
        kind,
        machineId: operation.machineId,
        request,
        threadId: operation.threadId
      });
      if (response.machineId !== operation.machineId || response.threadId !== operation.threadId || response.result.threadId !== operation.threadId || response.result.operationId !== operation.operationId) {
        throw new CodexTransportUncertainError('The connector returned an operation for a different target.');
      }
      const result = { ...response.result, replayed: false };
      await options.store.completeOperation(operation, result);
      return result;
    } catch (error) {
      if (error instanceof CodexTransportUnavailableError) {
        const result: CodexSessionOperationResult = {
          operationId: operation.operationId,
          replayed: false,
          status: 'rejected',
          threadId: operation.threadId
        };
        await options.store.completeOperation(operation, result);
        return result;
      }
      const result = ambiguousResult(operation, false);
      await options.store.markOperationAmbiguous(operation);
      return result;
    }
  }

  async function publishEvent(actor: CodexSessionsActor, request: CodexSessionReadRequest, event: CodexSessionStreamEvent) {
    const sessionScope = { ...(await scope(actor, request.machineId)), threadId: required(request.threadId, 'threadId') };
    required(event.eventId, 'eventId');
    await options.store.appendEvent({ ...sessionScope, event });
    for (const subscriber of subscribers.get(sessionKey(sessionScope)) ?? []) deliver(subscriber, event);
    return true;
  }

  async function stream(
    actor: CodexSessionsActor,
    request: CodexSessionStreamRequest,
    emit: (event: CodexSessionStreamEvent) => void,
    signal: AbortSignal
  ) {
    const sessionScope = { ...(await scope(actor, request.machineId)), threadId: required(request.threadId, 'threadId') };
    const key = sessionKey(sessionScope);
    const subscriber: StreamSubscriber = { emit, queued: [], ready: false, seen: new Set() };
    const group = subscribers.get(key) ?? new Set<StreamSubscriber>();
    group.add(subscriber);
    subscribers.set(key, group);
    try {
      for (const { event } of await options.store.listEvents({ ...sessionScope, afterSequence: request.afterSequence })) deliver(subscriber, event, true);
      subscriber.ready = true;
      subscriber.queued.splice(0).forEach((event) => deliver(subscriber, event, true));
      if (signal.aborted) return;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    } finally {
      group.delete(subscriber);
      if (group.size === 0) subscribers.delete(key);
    }
  }

  return {
    approve: (actor: CodexSessionsActor, request: CodexSessionApprovalRequest) => mutate(actor, 'approval', request),
    continue: (actor: CodexSessionsActor, request: CodexSessionContinueRequest) => mutate(actor, 'continue', request),
    interrupt: (actor: CodexSessionsActor, request: CodexSessionInterruptRequest) => mutate(actor, 'interrupt', request),
    list,
    publishEvent,
    read,
    respondToUserInput: (actor: CodexSessionsActor, request: CodexSessionUserInputResponse) => mutate(actor, 'input', request),
    stream
  };
}

function validateInventory(result: CodexSessionListResult, machineId: string) {
  if (result.machine.id !== machineId || result.sessions.some((session) => session.machineId !== machineId)) {
    throw new CodexTransportUncertainError('The connector returned inventory for a different machine.');
  }
  return result;
}

function validateRead(result: CodexSessionReadResult, scope: SessionScope) {
  if (result.openedReadOnly !== true || result.session.machineId !== scope.machineId || result.session.id !== scope.threadId) {
    throw new CodexTransportUncertainError('The connector returned history for a different session.');
  }
  return result;
}

function filterInventory(inventory: CodexSessionListResult, request: CodexSessionListRequest) {
  const search = request.search?.trim().toLocaleLowerCase();
  return {
    ...inventory,
    sessions: inventory.sessions
      .filter((session) => request.includeArchived || !session.archived)
      .filter((session) => !search || [session.title, session.cwd, session.project, session.model].some((value) => value?.toLocaleLowerCase().includes(search)))
      .sort((left, right) => Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt))
  };
}

function asOfflineInventory(
  machine: CodexSessionMachineRecord,
  sessions: CodexSessionRecord[],
  now: () => Date
): CodexSessionListResult {
  return {
    checkedAt: now().toISOString(),
    machine: { ...machine, online: false, statusMessage: 'The connector is offline. Showing the last saved session inventory.' },
    sessions: sessions.map((session) => ({ ...session, loadedByProjectSpace: false, status: 'offline' }))
  };
}

async function offlineMachine(transport: CodexSessionsTransport, machineId: string) {
  try {
    const machine = await transport.describeMachine(machineId);
    if (machine.id !== machineId) throw new Error();
    return { ...machine, online: false, statusMessage: 'The connector is offline.' };
  } catch {
    return { id: machineId, name: machineId, online: false, statusMessage: 'The connector is offline.' };
  }
}

async function storedRecord(
  store: Pick<CodexSessionsStore, 'listInventory'>,
  scope: SessionScope
) {
  return (await store.listInventory(scope.userId, scope.machineId))
    .find((session) => session.id === scope.threadId);
}

function missingRead(record: CodexSessionRecord | undefined, scope: SessionScope, status: 'missing' | 'offline' = 'missing'): CodexSessionReadResult {
  return {
    openedReadOnly: true,
    session: {
      archived: record?.archived ?? false,
      ...record,
      id: scope.threadId,
      lastActivityAt: record?.lastActivityAt ?? new Date(0).toISOString(),
      loadedByProjectSpace: false,
      machineId: scope.machineId,
      machineName: record?.machineName ?? scope.machineId,
      status,
      title: record?.title ?? scope.threadId
    },
    turns: []
  };
}

function ambiguousResult(operation: ScopedOperation, replayed: boolean): CodexSessionOperationResult {
  return { operationId: operation.operationId, replayed, status: 'ambiguous', threadId: operation.threadId };
}

function deliver(subscriber: StreamSubscriber, event: CodexSessionStreamEvent, force = false) {
  if (subscriber.seen.has(event.eventId)) return;
  if (!subscriber.ready && !force) {
    subscriber.queued.push(event);
    return;
  }
  subscriber.seen.add(event.eventId);
  subscriber.emit(event);
}

function required(value: string, label: string) {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) throw new TypeError(`${label} is invalid.`);
  return normalized;
}

function operationKey(scope: ScopedOperation) {
  return `${scope.userId}\0${scope.machineId}\0${scope.threadId}\0${scope.operationId}`;
}

function sessionKey(scope: SessionScope) {
  return `${scope.userId}\0${scope.machineId}\0${scope.threadId}`;
}

function operationName(
  kind: 'approval' | 'continue' | 'input' | 'interrupt'
): CodexStoredOperationName {
  return kind;
}
