import { createHash } from 'node:crypto';

import type {
  CodexMachineTaskSendRequest,
  CodexMachineTaskSendResult,
  CodexMachineTaskTarget
} from '../../src/shared/codex-machine-tasks-api';
import { canonicalJson } from '../codex-sessions/canonical-json';
import type {
  CodexMachineTaskSendLookup,
  CodexMachineTaskSendOperation,
  CodexMachineTasksServiceOptions
} from './contracts';
import { blocked } from './results';

export function fingerprintMessageRequest(
  userId: string,
  request: CodexMachineTaskSendRequest
) {
  return hash({
    connectorId: request.connectorId,
    delivery: request.delivery ?? 'auto',
    environmentId: request.environmentId,
    expectedTurnId: request.expectedTurnId,
    message: request.message,
    physicalMachineId: request.physicalMachineId,
    physicalMachineName: request.physicalMachineName,
    threadId: request.threadId,
    userId
  });
}

export function fingerprintMessageTarget(
  userId: string,
  request: CodexMachineTaskSendRequest,
  target: CodexMachineTaskTarget
) {
  const delivery = request.delivery ?? 'auto';
  return hash({
    connectorId: target.connector.id,
    ...(delivery === 'auto' ? {} : {
      delivery,
      ...(request.expectedTurnId ? { expectedTurnId: request.expectedTurnId } : {})
    }),
    message: request.message,
    threadId: request.threadId,
    userId
  });
}

export function createMessageSendOperation(input: {
  delivery: 'new-turn' | 'steer';
  expectedTurnId?: string;
  fingerprint: string;
  lookup: Extract<CodexMachineTaskSendLookup, { kind: 'missing' | 'reserved' }>;
  options: CodexMachineTasksServiceOptions;
  queuedResult?: Extract<CodexMachineTaskSendResult, { state: 'queued' }>;
  request: CodexMachineTaskSendRequest;
  requestFingerprint: string;
  target: CodexMachineTaskTarget;
  userId: string;
}): CodexMachineTaskSendOperation {
  return {
    connectorId: input.target.connector.id,
    delivery: input.request.delivery ?? 'auto',
    dispatchDelivery: input.delivery,
    durableOperations: input.lookup.kind === 'reserved'
      ? input.lookup.durableOperations
      : input.options.durableGenerationFor?.(
          input.target.connector.id, input.target.connector.generation
        ) ?? false,
    fingerprint: input.fingerprint,
    generation: input.lookup.kind === 'reserved'
      ? input.lookup.generation
      : input.target.connector.generation,
    ...(input.expectedTurnId ? { expectedTurnId: input.expectedTurnId } : {}),
    message: input.request.message,
    operationId: input.request.operationId,
    ...(input.queuedResult ? { queuedResult: input.queuedResult } : {}),
    requestFingerprint: input.requestFingerprint,
    threadId: input.request.threadId,
    userId: input.userId
  };
}

export async function resolveMessageDelivery(input: {
  actor: { userId: string };
  options: CodexMachineTasksServiceOptions;
  request: CodexMachineTaskSendRequest;
  target: CodexMachineTaskTarget;
}): Promise<
  | { result: CodexMachineTaskSendResult }
  | {
      delivery: 'new-turn' | 'steer';
      expectedTurnId?: string;
      sessionActive: boolean;
    }
> {
  const requested = input.request.delivery ?? 'auto';
  let delivery: 'new-turn' | 'steer' = requested === 'steer' ? 'steer' : 'new-turn';
  let expectedTurnId = input.request.expectedTurnId;
  if (requested !== 'auto' && requested !== 'queue') {
    return { delivery, expectedTurnId, sessionActive: requested === 'steer' };
  }
  let snapshot;
  try {
    snapshot = await input.options.sessions.read({
      connectorId: input.target.connector.id,
      generation: input.target.connector.generation,
      threadId: input.request.threadId,
      userId: input.actor.userId
    });
  } catch {
    return { result: blocked(
      input.request.operationId, 'offline', 'The selected connector is offline.', input.target
    ) };
  }
  const sessionActive = snapshot.session.status === 'active';
  if (requested === 'auto' && sessionActive) {
    expectedTurnId = snapshot.session.activity?.currentTurnId ??
      snapshot.turns.find((turn) => turn.status === 'in-progress')?.id;
    if (!expectedTurnId) return { result: blocked(
      input.request.operationId,
      'thread_active',
      'The active turn could not be identified exactly; no message was sent.',
      input.target
    ) };
    delivery = 'steer';
  }
  return { delivery, expectedTurnId, sessionActive };
}

export function reconcileMessageSend(input: {
  durableOperations: boolean;
  generation: number;
  options: CodexMachineTasksServiceOptions;
  request: CodexMachineTaskSendRequest;
  target: CodexMachineTaskTarget;
  userId: string;
}) {
  return input.options.sessions.reconcileSend?.({
    connectorId: input.target.connector.id,
    delivery: input.request.delivery === 'steer' ? 'steer' : 'new-turn',
    durableOperations: input.durableOperations,
    expectedTurnId: input.request.expectedTurnId,
    generation: input.generation,
    message: input.request.message,
    operationId: input.request.operationId,
    threadId: input.request.threadId,
    userId: input.userId
  });
}

function hash(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
