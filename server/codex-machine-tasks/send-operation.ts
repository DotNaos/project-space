import { createHash } from 'node:crypto';

import type {
  CodexMachineTaskSendRequest,
  CodexMachineTaskSendResult,
  CodexMachineTaskTarget
} from '../../src/shared/codex-machine-tasks-api';
import { canonicalJson } from '../codex-sessions/canonical-json';
import type { CodexMachineTaskSendOperation } from './contracts';

export function operationFor(
  options: { durableGenerationFor?(connectorId: string, generation: number): boolean },
  userId: string,
  selected: CodexMachineTaskTarget,
  request: CodexMachineTaskSendRequest,
  mode: 'auto' | 'queue' | 'steer'
): CodexMachineTaskSendOperation {
  const operationRequest = {
    ...(request.expectedTurnId ? { expectedTurnId: request.expectedTurnId } : {}),
    message: request.message,
    mode,
    target: {
      ...(selected.environment ? { environmentId: selected.environment.id } : {}),
      physicalMachineId: selected.physicalMachine.id
    }
  };
  return {
    connectorId: selected.connector.id,
    dispatchAttempt: 0,
    durableOperations: options.durableGenerationFor?.(
      selected.connector.id,
      selected.connector.generation
    ) ?? false,
    fingerprint: createHash('sha256').update(canonicalJson({
      connectorId: selected.connector.id,
      request: operationRequest,
      threadId: request.threadId,
      userId
    })).digest('hex'),
    generation: selected.connector.generation,
    operationId: request.operationId,
    request: operationRequest,
    threadId: request.threadId,
    userId
  };
}

export function isQueueRetryable(
  operation: CodexMachineTaskSendOperation,
  result: CodexMachineTaskSendResult
) {
  return operation.request.mode === 'queue' && result.state === 'blocked' &&
    (result.reason === 'thread_active' || result.reason === 'offline');
}

export function dispatchOperationId(operation: CodexMachineTaskSendOperation) {
  if (operation.request.mode !== 'queue' || !operation.dispatchAttempt) {
    return operation.operationId;
  }
  const digest = createHash('sha256')
    .update(`${operation.operationId}\0${operation.dispatchAttempt}`)
    .digest('hex')
    .slice(0, 32);
  return `queue-dispatch:${digest}`;
}

export function queueKey(
  operation: Pick<CodexMachineTaskSendOperation, 'connectorId' | 'threadId' | 'userId'>
) {
  return `${operation.userId}\0${operation.connectorId}\0${operation.threadId}`;
}

export function requestForOperation(
  operation: CodexMachineTaskSendOperation
): CodexMachineTaskSendRequest {
  return {
    ...selectorForOperation(operation),
    ...(operation.request.expectedTurnId ? { expectedTurnId: operation.request.expectedTurnId } : {}),
    message: operation.request.message,
    mode: operation.request.mode,
    operationId: operation.operationId,
    threadId: operation.threadId
  };
}

export function retryDelay(milliseconds = 5_000) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

export function selectorForOperation(operation: CodexMachineTaskSendOperation) {
  return {
    connectorId: operation.connectorId,
    ...(operation.request.target.environmentId
      ? { environmentId: operation.request.target.environmentId }
      : { physicalMachineId: operation.request.target.physicalMachineId })
  };
}
