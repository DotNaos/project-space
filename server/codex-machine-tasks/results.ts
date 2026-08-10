import type {
  CodexMachineTaskBlockedReason,
  CodexMachineTaskReadResult,
  CodexMachineTaskSendRequest,
  CodexMachineTaskSendDelivery,
  CodexMachineTaskSendResult,
  CodexMachineTaskStartResult,
  CodexMachineTaskTarget
} from '../../src/shared/codex-machine-tasks-api';
import { CODEX_MACHINE_TASKS_API_VERSION } from '../../src/shared/codex-machine-tasks-api';
import type {
  CodexSessionOperationResult,
  CodexSessionReadResult
} from '../../src/shared/codex-sessions-api';

export function blocked(
  operationId: string,
  reason: CodexMachineTaskBlockedReason,
  message: string,
  target?: CodexMachineTaskTarget
): Extract<CodexMachineTaskStartResult, { state: 'blocked' }> {
  return {
    apiVersion: CODEX_MACHINE_TASKS_API_VERSION,
    message,
    operationId,
    reason,
    state: 'blocked',
    ...(target ? { target } : {})
  };
}

export function uncertain(operationId: string, target?: CodexMachineTaskTarget) {
  return {
    apiVersion: CODEX_MACHINE_TASKS_API_VERSION,
    message: 'The target may have applied the operation; reconcile before retrying.',
    operationId,
    reconcile: 'required' as const,
    state: 'uncertain' as const,
    ...(target ? { target } : {})
  };
}

export function readBlocked(
  reason: CodexMachineTaskBlockedReason,
  message: string
): CodexMachineTaskReadResult {
  return {
    apiVersion: CODEX_MACHINE_TASKS_API_VERSION,
    message,
    reason,
    state: 'blocked'
  };
}

export function sendResult(
  delivery: CodexMachineTaskSendDelivery,
  target: CodexMachineTaskTarget,
  request: CodexMachineTaskSendRequest,
  turnId?: string,
  completed = false,
  result?: CodexSessionReadResult
): CodexMachineTaskSendResult {
  return {
    apiVersion: CODEX_MACHINE_TASKS_API_VERSION,
    delivery,
    operationId: request.operationId,
    ...(result ? { result } : {}),
    state: completed ? 'completed' : delivery,
    target,
    threadId: request.threadId,
    ...(turnId ? { turnId } : {})
  };
}

export function sessionSendResult(
  target: CodexMachineTaskTarget,
  request: CodexMachineTaskSendRequest,
  result: CodexSessionOperationResult,
  delivery: Exclude<CodexMachineTaskSendDelivery, 'queued'>
): CodexMachineTaskSendResult {
  if (result.status === 'rejected') {
    return result.reason === 'unavailable'
      ? blocked(
          request.operationId,
          'offline',
          'The selected connector went offline before the turn was dispatched.',
          target
        )
      : blocked(
          request.operationId,
          delivery === 'steered' ? 'turn_changed' : 'thread_active',
          delivery === 'steered'
            ? 'The verified active Codex turn changed before it could be steered.'
            : 'The Codex thread already has an active turn.',
          target
        );
  }
  return result.turnId
    ? sendResult(delivery, target, request, result.turnId)
    : uncertain(request.operationId, target);
}

export function targetAtGeneration(target: CodexMachineTaskTarget, generation: number) {
  return {
    ...target,
    connector: { ...target.connector, generation }
  };
}
