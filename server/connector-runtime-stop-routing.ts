import { randomUUID, type KeyLike } from 'node:crypto';

import { WebSocket } from 'ws';

import { connectorDevServerSigningKey } from './connector-dev-server-routing';
import {
  connectorHasCapability,
  connectorSessionGeneration,
  connectorSocket
} from './connector-command-session-registry';
import {
  ConnectorRuntimeStopContractError,
  ConnectorRuntimeStopReplayProtection,
  connectorRuntimeStopBinding,
  createConnectorRuntimeStopWireRequest,
  isConnectorRuntimeStopAcceptedResult,
  isConnectorRuntimeStopWireRequest,
  verifyConnectorRuntimeStopWireRequest,
  type ConnectorRuntimeStopAcceptedResult,
  type ConnectorRuntimeStopBinding,
  type ConnectorRuntimeStopIdentity,
  type ConnectorRuntimeStopPlan,
  type ConnectorRuntimeStopWireRequest
} from './connector-runtime-stop-contract';
import type { ConnectorRuntimeReleaseTarget } from './connector-runtime-maintenance-contract';

type CompatibilityUseRecorder = (ownerUserId: string, surface: string) => Promise<unknown>;

export type ConnectorRuntimeStopMachineMessage = {
  id: string;
  payload: ConnectorRuntimeStopWireRequest;
  type: 'runtime.stop';
};

export type ConnectorRuntimeStopHubMessage = {
  id: string;
  payload: ConnectorRuntimeStopAcceptedResult;
  type: 'runtime.stop.result';
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function bounded(value: unknown, maximum: number) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

export function isConnectorRuntimeStopMachineMessage(
  value: unknown
): value is ConnectorRuntimeStopMachineMessage {
  return isRecord(value) && hasExactKeys(value, ['id', 'payload', 'type']) &&
    value.type === 'runtime.stop' && bounded(value.id, 128) &&
    isConnectorRuntimeStopWireRequest(value.payload);
}

export function isConnectorRuntimeStopHubMessage(
  value: unknown
): value is ConnectorRuntimeStopHubMessage {
  return isRecord(value) && hasExactKeys(value, ['id', 'payload', 'type']) &&
    value.type === 'runtime.stop.result' && bounded(value.id, 128) &&
    isConnectorRuntimeStopAcceptedResult(value.payload);
}

function bindingsEqual(left: ConnectorRuntimeStopBinding, right: ConnectorRuntimeStopBinding) {
  return left.generation === right.generation && left.instanceId === right.instanceId &&
    left.machineId === right.machineId && left.operationId === right.operationId &&
    left.planSha256 === right.planSha256;
}

interface PendingRuntimeStop {
  binding: ConnectorRuntimeStopBinding;
  machineId: string;
  ownerUserId: string;
  reject(error: Error): void;
  resolve(result: ConnectorRuntimeStopAcceptedResult): void;
  timeout: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingRuntimeStop>();
const defaultTimeoutMs = 15_000;

export class ConnectorRuntimeStopUnavailableError extends Error {
  constructor() {
    super('The selected connector does not provide source runtime stop.');
    this.name = 'ConnectorRuntimeStopUnavailableError';
  }
}

export class ConnectorRuntimeStopOutcomeUnknownError extends Error {
  constructor() {
    super('The connector runtime stop outcome is unknown.');
    this.name = 'ConnectorRuntimeStopOutcomeUnknownError';
  }
}

export function requestConnectorRuntimeStop(
  plan: ConnectorRuntimeStopPlan,
  userId: string,
  options: {
    grantTtlMs?: number;
    nonce?: string;
    now?: number;
    signingKey?: KeyLike;
    timeoutMs?: number;
  } = {}
) {
  const socket = connectorSocket(plan.machineId);
  const generation = connectorSessionGeneration(plan.machineId);
  if (!socket || socket.readyState !== WebSocket.OPEN || generation === undefined ||
      !connectorHasCapability(plan.machineId, 'runtime.stop')) {
    throw new ConnectorRuntimeStopUnavailableError();
  }
  const request = createConnectorRuntimeStopWireRequest(
    { generation, plan, userId },
    connectorDevServerSigningKey({ signingKey: options.signingKey }),
    { nonce: options.nonce, now: options.now, ttlMs: options.grantTtlMs }
  );
  const id = randomUUID();
  const binding = connectorRuntimeStopBinding(request);
  const result = new Promise<ConnectorRuntimeStopAcceptedResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new ConnectorRuntimeStopOutcomeUnknownError());
    }, options.timeoutMs ?? defaultTimeoutMs);
    pending.set(id, {
      binding,
      machineId: plan.machineId,
      ownerUserId: userId,
      reject,
      resolve,
      timeout
    });
  });
  const message: ConnectorRuntimeStopMachineMessage = {
    id,
    payload: request,
    type: 'runtime.stop'
  };
  try {
    socket.send(JSON.stringify(message));
  } catch (error) {
    finishPending(id, error instanceof Error ? error : new ConnectorRuntimeStopOutcomeUnknownError());
  }
  return result;
}

export function handleConnectorRuntimeStopMessage(
  machineId: string,
  message: ConnectorRuntimeStopHubMessage,
  options: {
    recordCompatibilityUse?: CompatibilityUseRecorder;
  } = {}
) {
  const current = pending.get(message.id);
  if (!current) return true;
  if (current.machineId !== machineId || !bindingsEqual(current.binding, message.payload.binding)) {
    finishPending(message.id, new ConnectorRuntimeStopOutcomeUnknownError());
    return true;
  }
  finishPending(message.id, undefined, message.payload);
  void options.recordCompatibilityUse?.(
    current.ownerUserId,
    'connector.runtime-stop.websocket.v1'
  );
  return true;
}

export function failConnectorRuntimeStopsForMachine(machineId: string) {
  for (const [id, current] of pending) {
    if (current.machineId === machineId) {
      finishPending(id, new ConnectorRuntimeStopOutcomeUnknownError());
    }
  }
}

function finishPending(
  id: string,
  error?: Error,
  result?: ConnectorRuntimeStopAcceptedResult
) {
  const current = pending.get(id);
  if (!current) return;
  pending.delete(id);
  clearTimeout(current.timeout);
  if (error) current.reject(error);
  else if (result) current.resolve(result);
}

export interface ConnectorRuntimeStopDispatcherOptions {
  commandVerificationKey: KeyLike;
  expectedMachineId: string;
  expectedRuntime: ConnectorRuntimeStopIdentity;
  expectedTarget: ConnectorRuntimeReleaseTarget;
  now?(): number;
  shutdown(): Promise<void> | void;
}

export class ConnectorRuntimeStopDispatcher {
  private expectedGeneration?: number;
  private readonly replay = new ConnectorRuntimeStopReplayProtection();

  constructor(private readonly options: ConnectorRuntimeStopDispatcherOptions) {}

  setExpectedGeneration(generation?: number) {
    this.expectedGeneration = generation;
  }

  async dispatch(
    id: string,
    request: ConnectorRuntimeStopWireRequest,
    send: (message: ConnectorRuntimeStopHubMessage) => Promise<void> | void,
    rejectAuthorization: () => void
  ) {
    const generation = this.expectedGeneration;
    if (generation === undefined) {
      rejectAuthorization();
      return;
    }
    let binding: ConnectorRuntimeStopBinding;
    try {
      verifyConnectorRuntimeStopWireRequest(request, this.options.commandVerificationKey, {
        expectedGeneration: generation,
        expectedMachineId: this.options.expectedMachineId,
        expectedRuntime: this.options.expectedRuntime,
        expectedTarget: this.options.expectedTarget,
        now: this.options.now?.(),
        replayProtection: this.replay
      });
      binding = connectorRuntimeStopBinding(request);
    } catch (error) {
      if (error instanceof ConnectorRuntimeStopContractError) {
        rejectAuthorization();
        return;
      }
      throw error;
    }
    await send({ id, payload: { binding, status: 'accepted' }, type: 'runtime.stop.result' });
    await this.options.shutdown();
  }
}
