import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import {
  CODEX_BROWSER_MAXIMUM_IMAGE_BYTES,
  type CodexSessionApprovalRequest,
  type CodexSessionBrowserRequest,
  type CodexSessionBrowserResult,
  type CodexSessionContinueRequest,
  type CodexSessionInspectRequest,
  type CodexSessionInspectResult,
  type CodexSessionInterruptRequest,
  type CodexSessionListRequest,
  type CodexSessionListResult,
  type CodexSessionMachineRecord,
  type CodexSessionOperationResult,
  type CodexSessionReadRequest,
  type CodexSessionReadResult,
  type CodexSessionRecord,
  type CodexSessionStreamEvent,
  type CodexSessionUserInputResponse
} from '../../src/shared/codex-sessions-api';
import { CODEX_SESSION_LIST_DEADLINE_MS, localizeCodexSessionInventoryWindow } from '../../src/shared/codex-session-inventory-window';
import type {
  CodexSessionsStore,
  CodexStoredOperationInput,
  CodexStoredOperationName
} from '../codex-sessions-store';
import { canonicalJson } from './canonical-json';
import {
  codexSessionInspectionMatchesScope,
  withCodexSessionWriteCapability
} from './task-access-evidence';
import { asLiveCodexSessionInventory, asOfflineCodexSessionInventory, filterCodexSessionInventory } from './inventory-presentation';

export interface CodexSessionsActor {
  userId: string;
}

export interface CodexSessionStreamRequest extends CodexSessionReadRequest {
  afterSequence?: number;
  onDispatched?: () => void;
}

export interface CodexSessionsTransport {
  browser?(
    input: CodexSessionBrowserRequest & { userId: string }
  ): Promise<CodexSessionBrowserResult>;
  describeMachine(input: CodexSessionsMachineScope): Promise<CodexSessionMachineRecord>;
  list(input: CodexSessionsMachineScope): Promise<CodexSessionListResult>;
  inspect(input: CodexSessionInspectRequest & { userId: string }): Promise<CodexSessionInspectResult>;
  mutate(input: {
    kind: 'approval' | 'continue' | 'input' | 'interrupt';
    machineId: string;
    request:
      | CodexSessionApprovalRequest
      | CodexSessionContinueRequest
      | CodexSessionInterruptRequest
      | CodexSessionUserInputResponse;
    threadId: string;
    userId: string;
  }): Promise<{
    machineId: string;
    result: CodexSessionOperationResult;
    threadId: string;
  }>;
  read(input: CodexSessionReadRequest & { userId: string }): Promise<CodexSessionReadResult>;
  stream?(
    input: CodexSessionStreamRequest & { userId: string },
    emit: (event: CodexSessionStreamEvent) => void,
    signal: AbortSignal
  ): Promise<void>;
}

export interface CodexSessionsMachineScope {
  machineId: string;
  userId: string;
}

interface SessionScope extends CodexSessionsMachineScope {
  threadId: string;
}

type ScopedOperation = CodexStoredOperationInput;

interface StreamSubscriber {
  emit(event: CodexSessionStreamEvent, sequence?: number): void;
  queued: Array<{ event: CodexSessionStreamEvent; sequence?: number }>;
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
  monotonicNow?: () => number;
  now?: () => Date;
  store: Pick<
    CodexSessionsStore,
    | 'appendEvent'
    | 'completeOperation'
    | 'latestEventSequence'
    | 'listEvents'
    | 'listInventory'
    | 'markOperationAmbiguous'
    | 'reconcileOperation'
    | 'reserveOperation'
    | 'saveInventory'
  >;
  transport: CodexSessionsTransport;
}) {
  const now = options.now ?? (() => new Date());
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const activeOperations = new Map<string, Promise<CodexSessionOperationResult>>();
  const subscribers = new Map<string, Set<StreamSubscriber>>();

  async function scope(
    actor: CodexSessionsActor,
    machineId: string
  ): Promise<CodexSessionsMachineScope> {
    const userId = required(actor.userId, 'userId');
    const normalizedMachineId = required(machineId, 'machineId');
    await options.authorize({ userId }, normalizedMachineId);
    return { machineId: normalizedMachineId, userId };
  }

  async function list(actor: CodexSessionsActor, request: CodexSessionListRequest) {
    const machineScope = await scope(actor, request.machineId);
    try {
      const startedAt = monotonicNow();
      const returned = await options.transport.list(machineScope);
      const receivedAt = monotonicNow();
      const localized = localizeCodexSessionInventoryWindow(returned, {
        elapsedMs: receivedAt - startedAt,
        machineId: machineScope.machineId,
        publishedAt: now().toISOString()
      });
      if (!localized || localized.ageMs > CODEX_SESSION_LIST_DEADLINE_MS) {
        throw new CodexTransportUncertainError('The Codex task inventory expired before it could be verified.');
      }
      const inventory = asLiveCodexSessionInventory(localized.inventory);
      await options.store.saveInventory({
        ...machineScope,
        checkedAt: inventory.checkedAt,
        completeInventory: true,
        sessions: inventory.sessions
      });
      return filterCodexSessionInventory(inventory, request);
    } catch (error) {
      if (!(error instanceof CodexTransportUnavailableError)) throw error;
      const machine = await offlineMachine(options.transport, machineScope);
      const sessions = await options.store.listInventory(machineScope.userId, machineScope.machineId);
      return filterCodexSessionInventory(
        asOfflineCodexSessionInventory(machine, sessions, now),
        request
      );
    }
  }

  async function read(actor: CodexSessionsActor, request: CodexSessionReadRequest) {
    const sessionScope = { ...(await scope(actor, request.machineId)), threadId: required(request.threadId, 'threadId') };
    try {
      const result = validateRead(
        await options.transport.read({ ...request, userId: sessionScope.userId }),
        sessionScope
      );
      return withStreamCursor(result, await options.store.latestEventSequence(sessionScope));
    } catch (error) {
      if (error instanceof CodexThreadMissingError) {
        return withStreamCursor(
          missingRead(await storedRecord(options.store, sessionScope), sessionScope),
          await options.store.latestEventSequence(sessionScope)
        );
      }
      if (!(error instanceof CodexTransportUnavailableError)) throw error;
      return withStreamCursor(
        missingRead(await storedRecord(options.store, sessionScope), sessionScope, 'offline'),
        await options.store.latestEventSequence(sessionScope)
      );
    }
  }

  async function browser(actor: CodexSessionsActor, request: CodexSessionBrowserRequest) {
    const sessionScope = {
      ...(await scope(actor, request.machineId)),
      threadId: required(request.threadId, 'threadId')
    };
    if (!options.transport.browser) return unavailableBrowser(sessionScope, now());
    return sanitizeBrowserResult(
      await options.transport.browser({
        afterImageRevision: request.afterImageRevision,
        machineId: sessionScope.machineId,
        threadId: sessionScope.threadId,
        userId: sessionScope.userId
      }),
      sessionScope,
      request.afterImageRevision
    );
  }

  async function inspect(actor: CodexSessionsActor, request: CodexSessionInspectRequest) {
    const sessionScope = {
      ...(await scope(actor, request.machineId)),
      threadId: required(request.threadId, 'threadId')
    };
    try {
      const startedAt = monotonicNow();
      const returned = await options.transport.inspect({
        ...request,
        userId: sessionScope.userId
      });
      const receivedAt = monotonicNow();
      if (
        !Number.isFinite(startedAt)
        || !Number.isFinite(receivedAt)
        || receivedAt < startedAt
        || receivedAt - startedAt > 30_000
      ) {
        throw new CodexTransportUncertainError(
          'The Codex task inspection expired before it could be verified.'
        );
      }
      return withCodexSessionWriteCapability(
        validateInspect(returned, sessionScope),
        now()
      );
    } catch (error) {
      if (error instanceof CodexThreadMissingError) {
        throw new CodexTransportUnavailableError('The Codex task no longer exists.');
      }
      throw error;
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
    const operation = await operationFor(actor, kind, request);
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

  async function operationFor(
    actor: CodexSessionsActor,
    kind: 'approval' | 'continue' | 'input' | 'interrupt',
    request: CodexSessionApprovalRequest | CodexSessionContinueRequest | CodexSessionInterruptRequest | CodexSessionUserInputResponse
  ) {
    const machineScope = await scope(actor, request.machineId);
    const threadId = required(request.threadId, 'threadId');
    const operationId = required(request.operationId, 'operationId');
    const fingerprintRequest: Record<string, unknown> = { ...request };
    delete fingerprintRequest.connectorGeneration;
    delete fingerprintRequest.operationId;
    return {
      ...machineScope,
      fingerprint: { kind, request: fingerprintRequest, threadId },
      operation: operationName(kind),
      operationId,
      threadId
    } satisfies ScopedOperation;
  }

  async function reconcileContinue(
    actor: CodexSessionsActor,
    request: CodexSessionContinueRequest
  ) {
    const operation = await operationFor(actor, 'continue', request);
    const reserved = await options.store.reserveOperation(operation);
    if (reserved.kind === 'conflict') {
      throw new CodexSessionsConflictError('The operation id was reused for different input.');
    }
    if (reserved.kind === 'replayed') return { ...reserved.result, replayed: true };
    if (reserved.kind !== 'ambiguous') return ambiguousResult(operation, true);
    try {
      const response = await options.transport.mutate({
        kind: 'continue',
        machineId: operation.machineId,
        request,
        threadId: operation.threadId,
        userId: operation.userId
      });
      if (
        response.machineId !== operation.machineId || response.threadId !== operation.threadId ||
        response.result.threadId !== operation.threadId ||
        response.result.operationId !== operation.operationId
      ) return ambiguousResult(operation, true);
      const result = { ...response.result, replayed: true };
      if (result.status !== 'ambiguous') {
        await options.store.reconcileOperation(operation, result);
      }
      return result;
    } catch {
      return ambiguousResult(operation, true);
    }
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
        threadId: operation.threadId,
        userId: operation.userId
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
          reason: 'unavailable',
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
    const sequence = await options.store.appendEvent({ ...sessionScope, event });
    for (const subscriber of subscribers.get(sessionKey(sessionScope)) ?? []) {
      deliver(subscriber, event, sequence);
    }
    return true;
  }

  async function stream(
    actor: CodexSessionsActor,
    request: CodexSessionStreamRequest,
    emit: (event: CodexSessionStreamEvent, sequence?: number) => void,
    signal: AbortSignal,
    onReady?: () => void
  ) {
    const sessionScope = { ...(await scope(actor, request.machineId)), threadId: required(request.threadId, 'threadId') };
    const key = sessionKey(sessionScope);
    const subscriber: StreamSubscriber = { emit, queued: [], ready: false, seen: new Set() };
    const group = subscribers.get(key) ?? new Set<StreamSubscriber>();
    group.add(subscriber);
    subscribers.set(key, group);
    try {
      let afterSequence = request.afterSequence ?? 0;
      while (true) {
        const page = await options.store.listEvents({ ...sessionScope, afterSequence });
        for (const { event, sequence } of page) deliver(subscriber, event, sequence, true);
        if (page.length < 500) break;
        const nextSequence = page.at(-1)?.sequence ?? afterSequence;
        if (nextSequence <= afterSequence) break;
        afterSequence = nextSequence;
      }
      subscriber.ready = true;
      subscriber.queued.splice(0).forEach(({ event, sequence }) => (
        deliver(subscriber, event, sequence, true)
      ));
      onReady?.();
      if (signal.aborted) return;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    } finally {
      group.delete(subscriber);
      if (group.size === 0) subscribers.delete(key);
    }
  }

  async function transportStream(
    actor: CodexSessionsActor,
    request: CodexSessionStreamRequest,
    signal: AbortSignal
  ) {
    if (!options.transport.stream) return;
    const sessionScope = {
      ...(await scope(actor, request.machineId)),
      threadId: required(request.threadId, 'threadId')
    };
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abort, { once: true });
    let delivery = Promise.resolve();
    let deliveryError: unknown;
    const deliverLiveEvent = (event: CodexSessionStreamEvent) => {
      delivery = delivery.then(async () => {
        required(event.eventId, 'eventId');
        const sequence = await options.store.appendEvent({ ...sessionScope, event });
        for (const subscriber of subscribers.get(sessionKey(sessionScope)) ?? []) {
          deliver(subscriber, event, sequence);
        }
      }).catch((error) => {
        deliveryError = error;
        controller.abort();
      });
    };
    try {
      await options.transport.stream(
        { ...request, userId: sessionScope.userId },
        deliverLiveEvent,
        controller.signal
      );
      await delivery;
      if (deliveryError) throw deliveryError;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  return {
    approve: (actor: CodexSessionsActor, request: CodexSessionApprovalRequest) => mutate(actor, 'approval', request),
    browser,
    continue: (actor: CodexSessionsActor, request: CodexSessionContinueRequest) => mutate(actor, 'continue', request),
    inspect,
    interrupt: (actor: CodexSessionsActor, request: CodexSessionInterruptRequest) => mutate(actor, 'interrupt', request),
    list,
    publishEvent,
    read,
    reconcileContinue,
    respondToUserInput: (actor: CodexSessionsActor, request: CodexSessionUserInputResponse) => mutate(actor, 'input', request),
    stream,
    transportStream
  };
}

function validateRead(result: CodexSessionReadResult, scope: SessionScope) {
  if (result.openedReadOnly !== true || result.session.machineId !== scope.machineId || result.session.id !== scope.threadId) {
    throw new CodexTransportUncertainError('The connector returned history for a different session.');
  }
  const { browser: _unexpectedBrowser, ...publicResult } = result as CodexSessionReadResult & {
    browser?: unknown;
  };
  return publicResult;
}

function sanitizeBrowserResult(
  result: CodexSessionBrowserResult,
  scope: SessionScope,
  requestedImageRevision?: string
) {
  if (!isRecord(result) || result.machineId !== scope.machineId || result.threadId !== scope.threadId ||
    !validTimestamp(result.checkedAt) || !['never-used', 'loading', 'live', 'ended', 'unavailable'].includes(result.state)) {
    throw new CodexTransportUncertainError('The connector returned a browser frame for a different session.');
  }
  const common = {
    checkedAt: result.checkedAt,
    ...(validImageRevision(result.imageRevision) ? { imageRevision: result.imageRevision } : {}),
    machineId: scope.machineId,
    ...(validTimestamp(result.observedAt) ? { observedAt: result.observedAt } : {}),
    threadId: scope.threadId,
    ...(validIdentifier(result.turnId) ? { turnId: result.turnId } : {})
  };
  if (result.state === 'live') {
    const unchanged = result.imageUnchanged === true && result.imageRevision === requestedImageRevision
      && validImageRevision(result.imageRevision)
      && result.imageDataUrl === undefined;
    if (!unchanged && (!validImageDataUrl(result.imageDataUrl) || !validImageRevision(result.imageRevision))) {
      throw new CodexTransportUncertainError('The connector returned an invalid browser frame.');
    }
    const pageUrl = result.pageUrl === undefined ? undefined : pageOrigin(result.pageUrl);
    if (result.pageUrl !== undefined && !pageUrl) {
      throw new CodexTransportUncertainError('The connector returned an invalid browser origin.');
    }
    return {
      ...common,
      ...(unchanged ? { imageUnchanged: true as const } : { imageDataUrl: result.imageDataUrl! }),
      ...(pageUrl ? { pageUrl } : {}),
      state: 'live' as const
    };
  }
  if (result.state === 'ended') {
    const unchanged = result.imageUnchanged === true && result.imageRevision === requestedImageRevision
      && validImageRevision(result.imageRevision)
      && result.imageDataUrl === undefined;
    if (!unchanged && result.imageDataUrl !== undefined &&
      (!validImageDataUrl(result.imageDataUrl) || !validImageRevision(result.imageRevision))) {
      throw new CodexTransportUncertainError('The connector returned an invalid browser frame.');
    }
    if (result.pageUrl !== undefined && result.imageDataUrl === undefined && !unchanged) {
      throw new CodexTransportUncertainError('The connector returned a browser origin without a frame.');
    }
    const pageUrl = result.pageUrl === undefined ? undefined : pageOrigin(result.pageUrl);
    if (result.pageUrl !== undefined && !pageUrl) {
      throw new CodexTransportUncertainError('The connector returned an invalid browser origin.');
    }
    const reason = typeof result.reason === 'string' && result.reason.length <= 512
      ? result.reason
      : undefined;
    return {
      ...common,
      ...(unchanged ? { imageUnchanged: true as const } : {}),
      ...(result.imageDataUrl ? { imageDataUrl: result.imageDataUrl } : {}),
      ...(pageUrl ? { pageUrl } : {}),
      ...(reason ? { reason } : {}),
      state: 'ended' as const
    };
  }
  const reason = typeof result.reason === 'string' && result.reason.length <= 512
    ? result.reason
    : undefined;
  return { ...common, ...(reason ? { reason } : {}), state: result.state };
}

function unavailableBrowser(scope: SessionScope, now: Date): CodexSessionBrowserResult {
  return {
    checkedAt: now.toISOString(),
    machineId: scope.machineId,
    reason: 'The owning machine is offline or the browser mirror is unavailable.',
    state: 'unavailable',
    threadId: scope.threadId
  };
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validImageRevision(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function validImageDataUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2_100_000) return false;
  const match = value.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[2]!.length % 4 !== 0) return false;
  const padding = match[2]!.endsWith('==') ? 2 : match[2]!.endsWith('=') ? 1 : 0;
  const bytes = match[2]!.length * 3 / 4 - padding;
  return Number.isSafeInteger(bytes) && bytes > 0 &&
    bytes <= CODEX_BROWSER_MAXIMUM_IMAGE_BYTES;
}

function pageOrigin(value: string) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== value) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateInspect(result: CodexSessionInspectResult, scope: SessionScope) {
  if (!codexSessionInspectionMatchesScope(result, scope)) {
    throw new CodexTransportUncertainError('The connector returned evidence for a different session.');
  }
  return result;
}

function withStreamCursor(result: CodexSessionReadResult, streamCursor: number) {
  return { ...result, streamCursor };
}

async function offlineMachine(
  transport: CodexSessionsTransport,
  scope: CodexSessionsMachineScope
) {
  try {
    const machine = await transport.describeMachine(scope);
    if (machine.id !== scope.machineId) throw new Error();
    return { ...machine, online: false, statusMessage: 'The connector is offline.' };
  } catch {
    return {
      id: scope.machineId,
      name: scope.machineId,
      online: false,
      statusMessage: 'The connector is offline.'
    };
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

function deliver(
  subscriber: StreamSubscriber,
  event: CodexSessionStreamEvent,
  sequence?: number,
  force = false
) {
  if (subscriber.seen.has(event.eventId)) return;
  if (!subscriber.ready && !force) {
    subscriber.queued.push({ event, sequence });
    return;
  }
  subscriber.seen.add(event.eventId);
  subscriber.emit(event, sequence);
}

function required(value: string, label: string) {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) throw new TypeError(`${label} is invalid.`);
  return normalized;
}

function operationKey(scope: ScopedOperation) {
  const inputHash = createHash('sha256').update(canonicalJson(scope.fingerprint)).digest('hex');
  return `${scope.userId}\0${scope.machineId}\0${scope.threadId}\0${scope.operationId}\0${inputHash}`;
}

function sessionKey(scope: SessionScope) {
  return `${scope.userId}\0${scope.machineId}\0${scope.threadId}`;
}

function operationName(
  kind: 'approval' | 'continue' | 'input' | 'interrupt'
): CodexStoredOperationName {
  return kind;
}
