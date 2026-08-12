import type { KeyLike } from 'node:crypto';

import { WebSocket } from 'ws';
import { CODEX_DAEMON_CONNECTOR_CAPABILITY } from '../../src/shared/codex-daemon-api';

import {
  CODEX_SESSIONS_BROWSER_CONNECTOR_CAPABILITY,
  CODEX_SESSIONS_CONNECTOR_CAPABILITY,
  CODEX_SESSIONS_INSPECT_CONNECTOR_CAPABILITY,
  CODEX_SESSIONS_MODEL_SELECTION_CONNECTOR_CAPABILITY,
  CODEX_SESSIONS_MODEL_SETTINGS_CONNECTOR_CAPABILITY,
  CODEX_AUTHORIZATION_CONNECTOR_CAPABILITY,
  CODEX_MACHINE_TASKS_CONNECTOR_CAPABILITY,
  CODEX_MACHINE_TASKS_DURABLE_OPERATIONS_CAPABILITY,
  createCodexSessionsWireRequest,
  isCodexSessionsWireRequest,
  type CodexSessionAttachRequest,
  type CodexSessionsConnectorOperation,
  type CodexSessionsWireRequest,
  type CodexSessionsWireResult
} from '../codex-sessions-connector-contract';
import { connectorDevServerSigningKey } from '../connector-dev-server-routing';
import {
  addConnectorCapabilities,
  connectorHasCapability,
  connectorSessionGeneration,
  connectorSocket,
  removeConnectorCapabilities,
  sendConnectorJson
} from '../connector-command-session-registry';
import type { ConnectorHubMessage, ConnectorMachineMessage } from '../connector-command-protocol';
import {
  CodexAttachChunkAssembler,
  bindingForCodexSessionsRequest,
  boundCodexSessionsResultMatchesRequest,
  codexAttachMessageChunks,
  codexSessionsBindingsEqual,
  type BoundCodexAttachClosed,
  type BoundCodexSessionsCompletion,
  type BoundCodexSessionsEvent,
  type BoundCodexSessionsError,
  type BoundCodexSessionsResult,
  type CodexSessionsCommandBinding
} from './connector-channel';

type CompatibilityUseRecorder = (ownerUserId: string, surface: string) => Promise<unknown>;
const ignoreCompatibilityUse: CompatibilityUseRecorder = async () => undefined;

type CodexPayload = CodexSessionsWireRequest['payload'];

export interface CodexSessionsHubRequestOptions {
  generation?: number;
  grantTtlMs?: number;
  nonce?: string;
  now?: number;
  operationId?: string;
  onDispatched?: () => void;
  signal?: AbortSignal;
  signingKey?: KeyLike;
  timeoutMs?: number;
  userId: string;
}

type PendingCodexCommand = {
  binding: CodexSessionsCommandBinding;
  emit?: (event: BoundCodexSessionsEvent['event']['event']) => void;
  machineId: string;
  ownerUserId: string;
  reject(error: Error): void;
  request: CodexSessionsWireRequest;
  resolve(value?: CodexSessionsWireResult): void;
  signal?: AbortSignal;
  signalAbort?: () => void;
  timeout: ReturnType<typeof setTimeout>;
};

type PendingCodexAttach = {
  assembler: CodexAttachChunkAssembler;
  binding: CodexSessionsCommandBinding;
  machineId: string;
  ownerUserId: string;
  nextInputMessageId: number;
  onClose(code: BoundCodexAttachClosed['code']): void;
  onMessage(message: string): void;
  ready: boolean;
  reject(error: Error): void;
  request: CodexSessionsWireRequest;
  resolve(tunnel: CodexConnectorAttachTunnel): void;
  signal?: AbortSignal;
  signalAbort?: () => void;
  timeout: ReturnType<typeof setTimeout>;
};

const pending = new Map<string, PendingCodexCommand>();
const attachTunnels = new Map<string, PendingCodexAttach>();
const defaultTimeoutMs = 10 * 60_000;
const attachOpenTimeoutMs = 15_000;
const maximumConnectorBufferedBytes = 8 * 1024 * 1024;
const cancellableOperations = new Set<CodexSessionsConnectorOperation>([
  'browser', 'inspect', 'list', 'read'
]);

export interface CodexConnectorAttachTunnel {
  close(): void;
  send(message: string): void;
}

export interface CodexConnectorAttachOptions extends CodexSessionsHubRequestOptions {
  onClose(code: BoundCodexAttachClosed['code']): void;
  onMessage(message: string): void;
}

export class CodexConnectorRemoteError extends Error {
  constructor(readonly code: BoundCodexSessionsError['error']['code']) {
    super('The Codex session connector rejected the operation.');
    this.name = 'CodexConnectorRemoteError';
  }
}

export class CodexConnectorNotDispatchedError extends Error {
  constructor() {
    super('The selected machine does not provide Codex sessions.');
    this.name = 'CodexConnectorNotDispatchedError';
  }
}

export class CodexConnectorOutcomeUnknownError extends Error {
  constructor(message = 'The Codex session command outcome is unknown.') {
    super(message);
    this.name = 'CodexConnectorOutcomeUnknownError';
  }
}

export async function requestConnectorCodexSessions(
  operation: Exclude<CodexSessionsConnectorOperation, 'attach' | 'stream'>,
  payload: CodexPayload,
  options: CodexSessionsHubRequestOptions
) {
  return run(operation, payload, options) as Promise<CodexSessionsWireResult>;
}

export function openConnectorCodexAttach(
  input: Omit<CodexSessionAttachRequest, 'tunnelId'>,
  options: CodexConnectorAttachOptions
) {
  const socket = connectorSocket(input.machineId);
  if (!socket || socket.readyState !== WebSocket.OPEN ||
    !connectorHasCapability(input.machineId, CODEX_MACHINE_TASKS_CONNECTOR_CAPABILITY)) {
    throw new CodexConnectorNotDispatchedError();
  }
  const id = commandId();
  const payload: CodexSessionAttachRequest = { ...input, tunnelId: id };
  const request = createCodexSessionsWireRequest({
    generation: options.generation ?? requiredGeneration(input.machineId),
    operation: 'attach',
    operationId: input.operationId,
    payload,
    userId: options.userId
  }, connectorDevServerSigningKey({ signingKey: options.signingKey }), {
    nonce: options.nonce,
    now: options.now,
    ttlMs: options.grantTtlMs
  });
  if (!isCodexSessionsWireRequest(request) || request.grant.operation !== 'attach') {
    throw new Error('The trusted Codex attach request is invalid.');
  }
  const binding = bindingForCodexSessionsRequest(request);
  return new Promise<CodexConnectorAttachTunnel>((resolve, reject) => {
    const timeout = setTimeout(() => {
      failAttach(id, new CodexConnectorOutcomeUnknownError('The Codex attach tunnel did not open.'));
    }, options.timeoutMs ?? attachOpenTimeoutMs);
    const signalAbort = options.signal ? () => closeAttach(id, true) : undefined;
    if (options.signal?.aborted) {
      clearTimeout(timeout);
      reject(new Error('The Codex attach tunnel was cancelled.'));
      return;
    }
    if (signalAbort) options.signal?.addEventListener('abort', signalAbort, { once: true });
    attachTunnels.set(id, {
      assembler: new CodexAttachChunkAssembler(),
      binding,
      machineId: input.machineId,
      ownerUserId: options.userId,
      nextInputMessageId: 1,
      onClose: options.onClose,
      onMessage: options.onMessage,
      ready: false,
      reject,
      request,
      resolve,
      signal: options.signal,
      signalAbort,
      timeout
    });
    sendConnectorJson(socket, { id, payload: request, type: 'codex.sessions.command' });
    options.onDispatched?.();
  });
}

export async function streamConnectorCodexSessions(
  payload: CodexPayload,
  emit: (event: BoundCodexSessionsEvent['event']['event']) => void,
  options: CodexSessionsHubRequestOptions
) {
  await run('stream', payload, options, emit);
}

function run(
  operation: CodexSessionsConnectorOperation,
  payload: CodexPayload,
  options: CodexSessionsHubRequestOptions,
  emit?: PendingCodexCommand['emit']
) {
  const socket = connectorSocket(payload.machineId);
  if (!socket || socket.readyState !== WebSocket.OPEN ||
    !connectorHasCapability(payload.machineId, requiredCapability(operation, payload))) {
    throw new CodexConnectorNotDispatchedError();
  }
  const id = commandId();
  const operationId = 'operationId' in payload
    ? payload.operationId
    : options.operationId ?? `codex:${id}`;
  const request = createCodexSessionsWireRequest({
    generation: options.generation ?? requiredGeneration(payload.machineId),
    operation,
    operationId,
    payload,
    userId: options.userId
  }, connectorDevServerSigningKey({ signingKey: options.signingKey }), {
    nonce: options.nonce,
    now: options.now,
    ttlMs: options.grantTtlMs
  });
  if (!isCodexSessionsWireRequest(request) || request.grant.operation !== operation) {
    throw new Error('The trusted Codex session request is invalid.');
  }
  const binding = bindingForCodexSessionsRequest(request);
  return new Promise<CodexSessionsWireResult | undefined>((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        const error = new CodexConnectorOutcomeUnknownError();
        if (cancellableOperations.has(operation)) cancel(id, error);
        else fail(id, error);
      },
      options.timeoutMs ?? defaultTimeoutMs
    );
    const signalAbort = options.signal
      ? () => cancel(id)
      : undefined;
    if (options.signal?.aborted) {
      clearTimeout(timeout);
      resolve(undefined);
      return;
    }
    if (signalAbort) options.signal?.addEventListener('abort', signalAbort, { once: true });
    pending.set(id, {
      binding,
      emit,
      machineId: payload.machineId,
      ownerUserId: options.userId,
      reject,
      request,
      resolve,
      signal: options.signal,
      signalAbort,
      timeout
    });
    sendConnectorJson(socket, {
      id,
      payload: request,
      type: 'codex.sessions.command'
    } as ConnectorMachineMessage);
    options.onDispatched?.();
  });
}

function requiredCapability(operation: CodexSessionsConnectorOperation, payload: CodexPayload) {
  if (operation === 'daemon') return CODEX_DAEMON_CONNECTOR_CAPABILITY;
  if (operation === 'authorization') return CODEX_AUTHORIZATION_CONNECTOR_CAPABILITY;
  if (operation === 'start') return CODEX_MACHINE_TASKS_CONNECTOR_CAPABILITY;
  if (operation === 'browser') return CODEX_SESSIONS_BROWSER_CONNECTOR_CAPABILITY;
  if (operation === 'inspect') return CODEX_SESSIONS_INSPECT_CONNECTOR_CAPABILITY;
  if (operation === 'continue' && (
    ('effort' in payload && payload.effort !== undefined) ||
    ('serviceTier' in payload && payload.serviceTier !== undefined)
  )) {
    return CODEX_SESSIONS_MODEL_SETTINGS_CONNECTOR_CAPABILITY;
  }
  if (operation === 'continue' && 'model' in payload && payload.model !== undefined) {
    return CODEX_SESSIONS_MODEL_SELECTION_CONNECTOR_CAPABILITY;
  }
  return CODEX_SESSIONS_CONNECTOR_CAPABILITY;
}

export function handleCodexSessionsConnectorMessage(
  machineId: string,
  message: ConnectorHubMessage,
  options: {
    recordCompatibilityUse?: CompatibilityUseRecorder;
  } = {}
) {
  const recordCompatibilityUse = options.recordCompatibilityUse ?? ignoreCompatibilityUse;
  if (message.type === 'codex.attach.ready') {
    const current = attachTunnels.get(message.id);
    if (!current || current.machineId !== machineId || current.ready ||
      !codexSessionsBindingsEqual(message.payload.binding, current.binding)) return true;
    current.ready = true;
    clearTimeout(current.timeout);
    current.resolve(attachHandle(message.id));
    void recordCompatibilityUse(
      current.ownerUserId,
      'connector.codex-sessions-control.websocket.v1'
    );
    return true;
  }
  if (message.type === 'codex.attach.output') {
    const current = attachTunnels.get(message.id);
    if (!current || current.machineId !== machineId || !current.ready ||
      !codexSessionsBindingsEqual(message.payload.binding, current.binding)) return true;
    try {
      const completed = current.assembler.push(message.payload.chunk);
      if (completed !== undefined) current.onMessage(completed);
    } catch {
      failAttach(message.id, new Error('The Codex attach connector returned an invalid frame.'), 'protocol_error');
    }
    return true;
  }
  if (message.type === 'codex.attach.closed') {
    const current = attachTunnels.get(message.id);
    if (!current || current.machineId !== machineId ||
      !codexSessionsBindingsEqual(message.payload.binding, current.binding)) return true;
    closeAttachFromConnector(message.id, message.payload.code);
    return true;
  }
  if (message.type === 'codex.sessions.result') {
    const current = pending.get(message.id);
    if (!current || current.machineId !== machineId ||
      !boundCodexSessionsResultMatchesRequest(message.payload, current.request)) return true;
    if (message.payload.result.operation === 'daemon') {
      const daemonCapabilities = [
        CODEX_MACHINE_TASKS_CONNECTOR_CAPABILITY,
        CODEX_SESSIONS_BROWSER_CONNECTOR_CAPABILITY,
        CODEX_SESSIONS_CONNECTOR_CAPABILITY,
        CODEX_SESSIONS_INSPECT_CONNECTOR_CAPABILITY,
        CODEX_SESSIONS_MODEL_SELECTION_CONNECTOR_CAPABILITY,
        CODEX_SESSIONS_MODEL_SETTINGS_CONNECTOR_CAPABILITY
      ];
      if (message.payload.result.result.evidence.state === 'ready') {
        addConnectorCapabilities(machineId, daemonCapabilities);
      } else {
        removeConnectorCapabilities(machineId, [
          ...daemonCapabilities,
          CODEX_MACHINE_TASKS_DURABLE_OPERATIONS_CAPABILITY
        ]);
      }
    }
    finish(
      message.id,
      message.payload.result,
      successfulCodexCompatibilityResult(message.payload.result),
      recordCompatibilityUse
    );
    return true;
  }
  if (message.type === 'codex.sessions.event') {
    const current = pending.get(message.id);
    if (!current || current.machineId !== machineId || current.binding.operation !== 'stream' ||
      !codexSessionsBindingsEqual(message.payload.binding, current.binding)) return true;
    current.emit?.(message.payload.event.event);
    refresh(message.id);
    return true;
  }
  if (message.type === 'codex.sessions.complete') {
    const current = pending.get(message.id);
    if (!current || current.machineId !== machineId || current.binding.operation !== 'stream' ||
      !codexSessionsBindingsEqual(message.payload.binding, current.binding)) return true;
    finish(message.id);
    return true;
  }
  if (message.type === 'codex.sessions.error') {
    const attached = attachTunnels.get(message.id);
    if (attached && attached.machineId === machineId &&
      codexSessionsBindingsEqual(message.payload.binding, attached.binding)) {
      failAttach(message.id, new CodexConnectorRemoteError(message.payload.error.code), 'unavailable');
      return true;
    }
    const current = pending.get(message.id);
    if (!current || current.machineId !== machineId ||
      !codexSessionsBindingsEqual(message.payload.binding, current.binding)) return true;
    fail(message.id, new CodexConnectorRemoteError(message.payload.error.code));
    return true;
  }
  return false;
}

export function failCodexSessionCommandsForMachine(machineId: string) {
  for (const [id, current] of pending) {
    if (current.machineId === machineId) {
      fail(id, new CodexConnectorOutcomeUnknownError());
    }
  }
  for (const [id, current] of attachTunnels) {
    if (current.machineId === machineId) {
      failAttach(id, new CodexConnectorOutcomeUnknownError(), 'unavailable');
    }
  }
}

function attachHandle(id: string): CodexConnectorAttachTunnel {
  return {
    close: () => closeAttach(id, true),
    send: (message) => sendAttachInput(id, message)
  };
}

function sendAttachInput(id: string, message: string) {
  const current = attachTunnels.get(id);
  if (!current?.ready) throw new Error('The Codex attach tunnel is not open.');
  const socket = connectorSocket(current.machineId);
  if (!socket || socket.readyState !== WebSocket.OPEN ||
    socket.bufferedAmount > maximumConnectorBufferedBytes) {
    failAttach(id, new CodexConnectorOutcomeUnknownError(), 'unavailable');
    throw new CodexConnectorOutcomeUnknownError();
  }
  const messageId = current.nextInputMessageId;
  const chunks = codexAttachMessageChunks(message, messageId);
  current.nextInputMessageId += 1;
  for (const chunk of chunks) {
    if (socket.bufferedAmount > maximumConnectorBufferedBytes) {
      failAttach(id, new CodexConnectorOutcomeUnknownError(), 'unavailable');
      throw new CodexConnectorOutcomeUnknownError();
    }
    sendConnectorJson(socket, {
      id,
      payload: { binding: current.binding, chunk },
      type: 'codex.attach.input'
    });
  }
}

function closeAttach(id: string, sendCancel: boolean) {
  const current = takeAttach(id);
  if (!current) return;
  if (sendCancel) {
    const socket = connectorSocket(current.machineId);
    if (socket?.readyState === WebSocket.OPEN) {
      sendConnectorJson(socket, { id, type: 'connector.command.cancel' });
    }
  }
  if (!current.ready) current.reject(new Error('The Codex attach tunnel was cancelled.'));
}

function closeAttachFromConnector(id: string, code: BoundCodexAttachClosed['code']) {
  const current = takeAttach(id);
  if (!current) return;
  if (current.ready) current.onClose(code);
  else current.reject(new CodexConnectorRemoteError('unavailable'));
}

function failAttach(
  id: string,
  error: Error,
  code: BoundCodexAttachClosed['code'] = 'unavailable'
) {
  const active = attachTunnels.get(id);
  if (active) {
    const socket = connectorSocket(active.machineId);
    if (socket?.readyState === WebSocket.OPEN) {
      sendConnectorJson(socket, { id, type: 'connector.command.cancel' });
    }
  }
  const current = takeAttach(id);
  if (!current) return;
  if (current.ready) current.onClose(code);
  else current.reject(error);
}

function takeAttach(id: string) {
  const current = attachTunnels.get(id);
  if (!current) return undefined;
  attachTunnels.delete(id);
  clearTimeout(current.timeout);
  if (current.signalAbort) current.signal?.removeEventListener('abort', current.signalAbort);
  return current;
}

function cancel(id: string, error?: Error) {
  const current = pending.get(id);
  if (!current) return;
  const socket = connectorSocket(current.machineId);
  if (socket?.readyState === WebSocket.OPEN) {
    try {
      sendConnectorJson(socket, { id, type: 'connector.command.cancel' });
    } catch {
      // The hosted request must still settle if the socket closes during cancellation.
    }
  }
  if (error) fail(id, error);
  else finish(id, undefined, false);
}

function finish(
  id: string,
  value?: CodexSessionsWireResult,
  recordUsage = true,
  recordCompatibilityUse = ignoreCompatibilityUse
) {
  const current = take(id);
  current?.resolve(value);
  if (current && recordUsage) {
    void recordCompatibilityUse(
      current.ownerUserId,
      codexCompatibilitySurface(current.binding.operation)
    );
  }
}

export function codexCompatibilitySurface(operation: CodexSessionsConnectorOperation) {
  return operation === 'start' || operation === 'daemon' || operation === 'settings'
    ? 'connector.codex-sessions-launch.websocket.v1' as const
    : 'connector.codex-sessions-control.websocket.v1' as const;
}

export function successfulCodexCompatibilityResult(value: CodexSessionsWireResult) {
  if (value.operation === 'browser' || value.operation === 'inspect' ||
      value.operation === 'list' || value.operation === 'read') return true;
  if (value.operation === 'authorization') {
    return value.result.state === 'pending' || value.result.state === 'ready';
  }
  if (value.operation === 'daemon') return value.result.state === 'completed';
  if (value.operation === 'start') return value.result.state === 'confirmed';
  return !value.result.replayed &&
    (value.result.status === 'accepted' || value.result.status === 'completed');
}

function fail(id: string, error: Error) {
  const current = take(id);
  current?.reject(error);
}

function take(id: string) {
  const current = pending.get(id);
  if (!current) return undefined;
  pending.delete(id);
  clearTimeout(current.timeout);
  if (current.signalAbort) current.signal?.removeEventListener('abort', current.signalAbort);
  return current;
}

function refresh(id: string) {
  const current = pending.get(id);
  if (!current) return;
  clearTimeout(current.timeout);
  current.timeout = setTimeout(
    () => fail(id, new CodexConnectorOutcomeUnknownError()),
    defaultTimeoutMs
  );
}

function commandId() {
  return globalThis.crypto?.randomUUID?.() ?? `connector-${Date.now()}-${Math.random()}`;
}

function requiredGeneration(machineId: string) {
  const value = connectorSessionGeneration(machineId);
  if (value === undefined) throw new Error('The Codex session connector is not registered.');
  return value;
}

export type {
  BoundCodexSessionsCompletion,
  BoundCodexSessionsEvent,
  BoundCodexSessionsResult
};
