import type { KeyLike } from 'node:crypto';

import { WebSocket } from 'ws';

import {
  CODEX_SESSIONS_BROWSER_CONNECTOR_CAPABILITY,
  CODEX_SESSIONS_CONNECTOR_CAPABILITY,
  CODEX_SESSIONS_INSPECT_CONNECTOR_CAPABILITY,
  CODEX_SESSIONS_MODEL_SELECTION_CONNECTOR_CAPABILITY,
  CODEX_SESSIONS_MODEL_SETTINGS_CONNECTOR_CAPABILITY,
  createCodexSessionsWireRequest,
  isCodexSessionsWireRequest,
  type CodexSessionsConnectorOperation,
  type CodexSessionsWireRequest,
  type CodexSessionsWireResult
} from '../codex-sessions-connector-contract';
import { connectorDevServerSigningKey } from '../connector-dev-server-routing';
import {
  connectorHasCapability,
  connectorSessionGeneration,
  connectorSocket,
  sendConnectorJson
} from '../connector-command-session-registry';
import type { ConnectorHubMessage, ConnectorMachineMessage } from '../connector-command-protocol';
import {
  bindingForCodexSessionsRequest,
  boundCodexSessionsResultMatchesRequest,
  codexSessionsBindingsEqual,
  type BoundCodexSessionsCompletion,
  type BoundCodexSessionsEvent,
  type BoundCodexSessionsError,
  type BoundCodexSessionsResult,
  type CodexSessionsCommandBinding
} from './connector-channel';

type CodexPayload = CodexSessionsWireRequest['payload'];

export interface CodexSessionsHubRequestOptions {
  generation?: number;
  grantTtlMs?: number;
  nonce?: string;
  now?: number;
  operationId?: string;
  signal?: AbortSignal;
  signingKey?: KeyLike;
  timeoutMs?: number;
  userId: string;
}

type PendingCodexCommand = {
  binding: CodexSessionsCommandBinding;
  emit?: (event: BoundCodexSessionsEvent['event']['event']) => void;
  machineId: string;
  reject(error: Error): void;
  request: CodexSessionsWireRequest;
  resolve(value?: CodexSessionsWireResult): void;
  signal?: AbortSignal;
  signalAbort?: () => void;
  timeout: ReturnType<typeof setTimeout>;
};

const pending = new Map<string, PendingCodexCommand>();
const defaultTimeoutMs = 10 * 60_000;

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
  operation: Exclude<CodexSessionsConnectorOperation, 'stream'>,
  payload: CodexPayload,
  options: CodexSessionsHubRequestOptions
) {
  return run(operation, payload, options) as Promise<CodexSessionsWireResult>;
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
      () => fail(id, new CodexConnectorOutcomeUnknownError()),
      options.timeoutMs ?? defaultTimeoutMs
    );
    const signalAbort = options.signal
      ? () => cancel(id, true)
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
  });
}

function requiredCapability(operation: CodexSessionsConnectorOperation, payload: CodexPayload) {
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
  message: ConnectorHubMessage
) {
  if (message.type === 'codex.sessions.result') {
    const current = pending.get(message.id);
    if (!current || current.machineId !== machineId ||
      !boundCodexSessionsResultMatchesRequest(message.payload, current.request)) return true;
    finish(message.id, message.payload.result);
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
}

function cancel(id: string, resolveOnly: boolean) {
  const current = pending.get(id);
  if (!current) return;
  const socket = connectorSocket(current.machineId);
  if (socket?.readyState === WebSocket.OPEN) {
    sendConnectorJson(socket, { id, type: 'connector.command.cancel' });
  }
  if (resolveOnly) finish(id);
  else fail(id, new Error('The Codex session stream was cancelled.'));
}

function finish(id: string, value?: CodexSessionsWireResult) {
  const current = take(id);
  current?.resolve(value);
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
