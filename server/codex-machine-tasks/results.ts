import type {
  CodexMachineTaskBlockedReason,
  CodexMachineTaskReadResult,
  CodexMachineTaskSendRequest,
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
  state: 'accepted' | 'completed',
  target: CodexMachineTaskTarget,
  request: CodexMachineTaskSendRequest,
  turnId: string,
  result?: CodexSessionReadResult
): CodexMachineTaskSendResult {
  return {
    apiVersion: CODEX_MACHINE_TASKS_API_VERSION,
    operationId: request.operationId,
    ...(result ? { result } : {}),
    state,
    target,
    threadId: request.threadId,
    turnId
  };
}

export function sessionSendResult(
  target: CodexMachineTaskTarget,
  request: CodexMachineTaskSendRequest,
  result: CodexSessionOperationResult
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
          'thread_active',
          'The Codex thread already has an active turn.',
          target
        );
  }
  return result.turnId
    ? sendResult('accepted', target, request, result.turnId)
    : uncertain(request.operationId, target);
}

export function targetAtGeneration(target: CodexMachineTaskTarget, generation: number) {
  return {
    ...target,
    connector: { ...target.connector, generation }
  };
}
