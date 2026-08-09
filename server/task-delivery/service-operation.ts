import type { TaskExecutionOperationRecord } from '../../src/shared/task-execution-api';
import type { TaskExecutionOperationStore } from '../task-execution/contracts';

export interface TaskDeliveryOperationIdentity {
  action: string;
  executionId: string;
  fingerprint: string;
  operationId: string;
  ownerUserId: string;
  scopeKey: string;
}

export type TaskDeliveryOperationStart =
  | { kind: 'conflict'; replayed: false }
  | { kind: 'dispatch'; replayed: boolean }
  | { kind: 'in_progress'; operation: TaskExecutionOperationRecord; replayed: true }
  | { kind: 'reconcile'; operation: TaskExecutionOperationRecord; replayed: true }
  | { kind: 'replayed'; operation: TaskExecutionOperationRecord; replayed: true };

export async function beginTaskDeliveryOperation(
  operations: TaskExecutionOperationStore,
  identity: TaskDeliveryOperationIdentity
): Promise<TaskDeliveryOperationStart> {
  const reservation = await operations.reserve(identity);
  if (reservation.kind === 'conflict') return { ...reservation, replayed: false };
  if (reservation.kind === 'replayed') return { ...reservation, replayed: true };
  if (reservation.kind === 'in_progress') {
    if (['uncertain', 'confirmed'].includes(reservation.operation.state)) {
      return { kind: 'reconcile', operation: reservation.operation, replayed: true };
    }
    if (reservation.operation.state === 'reserved') {
      const claimed = await operations.claimDispatch(identity);
      return claimed === 'claimed'
        ? { kind: 'dispatch', replayed: true }
        : claimed === 'conflict'
          ? { kind: 'conflict', replayed: false }
          : { ...reservation, replayed: true };
    }
    return { ...reservation, replayed: true };
  }
  const claimed = await operations.claimDispatch(identity);
  return claimed === 'claimed'
    ? { kind: 'dispatch', replayed: false }
    : claimed === 'conflict'
      ? { kind: 'conflict', replayed: false }
      : { kind: 'in_progress', operation: reservation.operation, replayed: true };
}

export function transitionTaskDeliveryOperation(
  operations: TaskExecutionOperationStore,
  identity: TaskDeliveryOperationIdentity,
  state: 'blocked' | 'completed' | 'confirmed' | 'uncertain',
  result?: Record<string, unknown>
) {
  return operations.transition({ ...identity, state, ...(result ? { result } : {}) });
}

export function compactTaskDeliveryOperationResult(input: {
  blockedReason?: string;
  deliveryId: string;
  evidenceRevision?: number;
  message: string;
  outcome: 'blocked' | 'completed';
  taskState?: 'completed' | 'open';
}) {
  return {
    ...(input.blockedReason ? { blockedReason: input.blockedReason } : {}),
    deliveryId: input.deliveryId,
    ...(input.evidenceRevision ? { evidenceRevision: input.evidenceRevision } : {}),
    message: input.message.slice(0, 500),
    outcome: input.outcome,
    ...(input.taskState ? { taskState: input.taskState } : {})
  };
}
