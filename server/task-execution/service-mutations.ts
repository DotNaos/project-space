import type { CodexSessionOperationResult } from '../../src/shared/codex-sessions-api';
import type {
  ArchiveTaskExecutionRequest,
  CancelTaskExecutionRequest,
  RespondTaskExecutionApprovalRequest,
  RespondTaskExecutionInputRequest,
  SendTaskExecutionMessageRequest,
  TaskExecutionMutationRequest,
  TaskExecutionResult
} from '../../src/shared/task-execution-mcp-api';
import type { StoredTaskExecution } from './contracts';
import type {
  TaskExecutionActor,
  TaskExecutionServiceDependencies
} from './service-contracts';
import {
  TaskExecutionConflictError,
  TaskExecutionNotFoundError
} from './service-contracts';
import {
  compactOperationResult,
  nestedOperationId,
  taskExecutionFingerprint
} from './service-identity';
import { transitionTaskExecution } from './service-state';

type MutationAction =
  | 'archive_task_execution'
  | 'cancel_task_execution'
  | 'respond_task_execution_approval'
  | 'respond_task_execution_input'
  | 'send_task_execution_message';

export function createTaskExecutionMutations(
  dependencies: TaskExecutionServiceDependencies,
  readResult: (
    actor: TaskExecutionActor,
    executionId: string,
    operationId: string,
    replayed?: boolean
  ) => Promise<TaskExecutionResult>
) {
  const now = dependencies.now ?? (() => new Date());

  async function send(actor: TaskExecutionActor, request: SendTaskExecutionMessageRequest) {
    return mutate(actor, 'send_task_execution_message', request, async (execution, binding) => {
      if (!['running', 'waiting_for_approval', 'waiting_for_input'].includes(execution.state)) {
        return withMessageOutcome(
          unchangedBlocked(execution, `A ${execution.state} Task Execution cannot accept messages.`),
          { state: 'blocked' }
        );
      }
      if (!binding) return withMessageOutcome(
        await blocked(execution, 'agent_runtime_missing',
          'The Task Execution has no executor binding.'),
        { reason: 'connector_required', state: 'blocked' }
      );
      const result = await dependencies.codex.service.send(actor, {
        connectorId: execution.connectorBinding?.connectorId,
        environmentId: execution.environmentId,
        ...(request.expectedTurnId ? { expectedTurnId: request.expectedTurnId } : {}),
        message: request.message,
        mode: request.mode,
        operationId: nestedOperationId(request.operationId, 'codex-message'),
        threadId: binding.externalId,
        wait: request.wait ?? false
      });
      if (result.state === 'uncertain') {
        return withMessageOutcome(
          await uncertain(execution, result.message),
          { state: 'uncertain' }
        );
      }
      if (result.state === 'blocked') {
        if (result.reason === 'approval_required') {
          return withMessageOutcome(
            await state(execution, 'waiting_for_approval', result.message),
            { reason: result.reason, state: 'blocked' }
          );
        }
        if (result.reason === 'input_required') {
          return withMessageOutcome(
            await state(execution, 'waiting_for_input', result.message),
            { reason: result.reason, state: 'blocked' }
          );
        }
        if (['send_in_progress', 'thread_active', 'turn_changed', 'turn_required'].includes(
          result.reason
        )) return withMessageOutcome(
          unchangedBlocked(execution, result.message),
          { reason: result.reason, state: 'blocked' }
        );
        return withMessageOutcome(
          await blocked(execution, 'connector_stale', result.message),
          { reason: result.reason, state: 'blocked' }
        );
      }
      if (result.turnId) {
        await dependencies.store.updateExecutorTurn({
          executionId: execution.id, expectedVersion: binding.version,
          ownerUserId: actor.userId, turnId: result.turnId, updatedAt: now().toISOString()
        });
      }
      return withMessageOutcome(await state(
        execution,
        'running',
        result.delivery === 'queued'
          ? 'The message was queued for the executor.'
          : 'The message was accepted by the executor.',
        result.delivery
      ), { state: result.state });
    });
  }

  async function respondApproval(
    actor: TaskExecutionActor,
    request: RespondTaskExecutionApprovalRequest
  ) {
    return mutate(actor, 'respond_task_execution_approval', request, async (
      execution, binding, reconciling
    ) => {
      if (execution.state !== 'waiting_for_approval') {
        return unchangedBlocked(execution, 'The Task Execution has no current approval request.');
      }
      if (!binding || !execution.connectorBinding) {
        return blocked(execution, 'connector_required', 'The exact executor is unavailable.');
      }
      const approvalRequest = {
        approvalId: request.approvalId,
        connectorGeneration: execution.connectorBinding.generation,
        decision: request.decision,
        itemId: request.itemId,
        machineId: execution.connectorBinding.connectorId,
        operationId: nestedOperationId(request.operationId, 'codex-approval'),
        requestId: request.requestId,
        threadId: binding.externalId,
        turnId: request.turnId
      };
      const result = reconciling
        ? await dependencies.codex.sessions.service.reconcileApproval(actor, approvalRequest)
        : await dependencies.codex.sessions.service.approve(actor, approvalRequest);
      return fromSessionMutation(execution, result, 'approval');
    });
  }

  async function respondInput(
    actor: TaskExecutionActor,
    request: RespondTaskExecutionInputRequest
  ) {
    return mutate(actor, 'respond_task_execution_input', request, async (
      execution, binding, reconciling
    ) => {
      if (execution.state !== 'waiting_for_input') {
        return unchangedBlocked(execution, 'The Task Execution has no current input request.');
      }
      if (!binding || !execution.connectorBinding) {
        return blocked(execution, 'connector_required', 'The exact executor is unavailable.');
      }
      const inputRequest = {
        answers: request.answers,
        connectorGeneration: execution.connectorBinding.generation,
        machineId: execution.connectorBinding.connectorId,
        operationId: nestedOperationId(request.operationId, 'codex-input'),
        requestId: request.requestId,
        threadId: binding.externalId,
        turnId: request.turnId
      };
      const result = reconciling
        ? await dependencies.codex.sessions.service.reconcileUserInput(actor, inputRequest)
        : await dependencies.codex.sessions.service.respondToUserInput(actor, inputRequest);
      return fromSessionMutation(execution, result, 'input');
    });
  }

  async function cancel(actor: TaskExecutionActor, request: CancelTaskExecutionRequest) {
    const result = await mutate(actor, 'cancel_task_execution', request, async (
      execution, binding, reconciling
    ) => {
      if (['cancelled', 'completed', 'failed'].includes(execution.state)) return {
        execution,
        message: `Task Execution is already ${execution.state}.`,
        terminal: true as const
      };
      if (binding && !execution.connectorBinding) {
        return uncertain(execution, 'The exact executor connector cannot be confirmed.');
      }
      if (!binding && [
        'starting_agent', 'running', 'waiting_for_approval', 'waiting_for_input',
        'verifying', 'delivering', 'uncertain'
      ].includes(execution.state)) {
        return uncertain(execution, 'The executor state cannot be confirmed for cancellation.');
      }
      if (binding && execution.connectorBinding) {
        let activeTurnId: string | undefined;
        try {
          const inspected = await dependencies.codex.sessions.service.inspect(actor, {
            connectorGeneration: execution.connectorBinding.generation,
            machineId: execution.connectorBinding.connectorId,
            threadId: binding.externalId
          });
          activeTurnId = inspected.activeTurnId;
        } catch {
          return uncertain(execution, 'The active executor turn could not be confirmed.');
        }
        if (activeTurnId) {
          const interruptRequest = {
            connectorGeneration: execution.connectorBinding.generation,
            machineId: execution.connectorBinding.connectorId,
            operationId: nestedOperationId(request.operationId, 'codex-cancel'),
            threadId: binding.externalId,
            turnId: activeTurnId
          };
          const interrupted = reconciling
            ? await dependencies.codex.sessions.service.reconcileInterrupt(actor, interruptRequest)
            : await dependencies.codex.sessions.service.interrupt(actor, interruptRequest);
          if (interrupted.status === 'ambiguous' || interrupted.status === 'rejected') {
            return uncertain(execution, 'The cancellation outcome could not be confirmed.');
          }
        }
      }
      const cancelled = await transitionTaskExecution({
        execution, message: request.reason ?? 'Task Execution was cancelled.',
        now: now(), state: 'cancelled', store: dependencies.store
      });
      return { execution: cancelled, message: 'Task Execution was cancelled.', terminal: true as const };
    });
    if (result.execution.state === 'cancelled') {
      await releaseCapacity(actor, result.execution);
    }
    return result;
  }

  async function archive(actor: TaskExecutionActor, request: ArchiveTaskExecutionRequest) {
    return mutate(actor, 'archive_task_execution', request, async (execution) => {
      if (execution.state === 'archived') return {
        execution, message: 'Task Execution is already archived.', terminal: true as const
      };
      const archived = await dependencies.store.archive(
        actor.userId, execution.id, execution.version, now().toISOString()
      );
      if (archived.kind === 'conflict') {
        return {
          execution,
          kind: 'blocked' as const,
          message: 'Only a completed, failed, or cancelled Task Execution can be archived.'
        };
      }
      await dependencies.store.appendEvent({
        actor: { id: actor.userId, kind: 'orchestrator' }, createdAt: now().toISOString(),
        executionId: execution.id, message: 'Task Execution was archived.',
        ownerUserId: actor.userId, state: 'archived', type: 'state_changed'
      });
      return { execution: archived.execution, message: 'Task Execution was archived.', terminal: true as const };
    });
  }

  async function mutate(
    actor: TaskExecutionActor,
    action: MutationAction,
    request: TaskExecutionMutationRequest,
    operation: (
      execution: StoredTaskExecution,
      binding: Awaited<ReturnType<TaskExecutionServiceDependencies['store']['readExecutorBinding']>>,
      reconciling: boolean
    ) => Promise<MutationOutcome>
  ) {
    let execution = await dependencies.store.read(actor.userId, request.executionId);
    if (!execution) throw new TaskExecutionNotFoundError();
    const fingerprint = taskExecutionFingerprint({ action, request });
    const reservation = await dependencies.operations.reserve({
      action, executionId: execution.id, fingerprint,
      operationId: request.operationId, ownerUserId: actor.userId
    });
    if (reservation.kind === 'conflict') throw new TaskExecutionConflictError();
    if (reservation.kind === 'replayed') {
      return readResult(actor, execution.id, request.operationId, true);
    }
    let reconciling = false;
    if (reservation.kind === 'in_progress' && reservation.operation.state === 'uncertain') {
      const reconcileState = reservation.operation.result?.reconcileState;
      if (!isReconcileState(reconcileState) ||
          ![reconcileState, 'uncertain'].includes(execution.state)) {
        return readResult(actor, execution.id, request.operationId);
      }
      if (execution.state === 'uncertain') {
        execution = await transitionTaskExecution({
          execution, message: 'Reconciling the exact previous mutation.', now: now(),
          state: reconcileState, store: dependencies.store
        });
      }
      await dependencies.operations.transition({
        action, executionId: execution.id, fingerprint,
        operationId: request.operationId, ownerUserId: actor.userId, state: 'confirmed'
      });
      reconciling = true;
    }
    const claim = await dependencies.operations.claimDispatch({
      action, executionId: execution.id, fingerprint,
      operationId: request.operationId, ownerUserId: actor.userId
    });
    if (claim === 'conflict') throw new TaskExecutionConflictError();
    if (claim === 'in_progress') return readResult(actor, execution.id, request.operationId);
    let outcome: MutationOutcome;
    try {
      outcome = await operation(
        execution,
        await dependencies.store.readExecutorBinding(actor.userId, execution.id),
        reconciling
      );
    } catch {
      const uncertainExecution = await transitionTaskExecution({
        execution, message: 'The executor outcome requires reconciliation.', now: now(),
        state: 'uncertain', store: dependencies.store
      });
      await dependencies.operations.transition({
        action, executionId: execution.id, fingerprint,
        operationId: request.operationId, ownerUserId: actor.userId,
        result: compactOperationResult({
          executionId: execution.id, message: 'The mutation requires reconciliation.',
          ...(action === 'send_task_execution_message'
            ? { messageOutcome: { state: 'uncertain' as const } }
            : {}),
          reconcileState: execution.state, state: 'uncertain', version: uncertainExecution.version
        }),
        state: 'uncertain'
      });
      return readResult(actor, uncertainExecution.id, request.operationId);
    }
    const operationState = outcome.kind === 'uncertain'
      ? 'uncertain' as const
      : outcome.kind === 'blocked'
        ? 'blocked' as const
        : 'completed' as const;
    await dependencies.operations.transition({
      action, executionId: execution.id, fingerprint,
      operationId: request.operationId, ownerUserId: actor.userId,
      result: compactOperationResult({
        ...(outcome.delivery ? { delivery: outcome.delivery } : {}),
        executionId: outcome.execution.id, message: outcome.message,
        ...(outcome.messageOutcome ? { messageOutcome: outcome.messageOutcome } : {}),
        ...(operationState === 'uncertain' && outcome.reconcileState
          ? { reconcileState: outcome.reconcileState }
          : {}),
        state: outcome.execution.state, version: outcome.execution.version
      }),
      state: operationState
    });
    return readResult(actor, outcome.execution.id, request.operationId);
  }

  function fromSessionMutation(
    execution: StoredTaskExecution,
    result: CodexSessionOperationResult,
    kind: 'approval' | 'input'
  ): Promise<MutationOutcome> {
    if (result.status === 'ambiguous') {
      return uncertain(execution, `The ${kind} response outcome could not be confirmed.`);
    }
    if (result.status === 'rejected') {
      return blocked(execution, kind === 'approval' ? 'approval_required' : 'input_required',
        `The pending ${kind} request changed or disappeared.`);
    }
    return state(execution, 'running', `The ${kind} response was accepted.`);
  }

  async function state(
    execution: StoredTaskExecution,
    next: StoredTaskExecution['state'],
    message: string,
    delivery?: 'queued' | 'sent' | 'steered'
  ): Promise<MutationOutcome> {
    return {
      execution: await transitionTaskExecution({
        execution, message, now: now(), state: next, store: dependencies.store
      }),
      ...(delivery ? { delivery } : {}), kind: 'completed', message
    };
  }

  async function blocked(
    execution: StoredTaskExecution,
    reason: NonNullable<StoredTaskExecution['blockedReason']>,
    message: string
  ): Promise<MutationOutcome> {
    return {
      execution: await transitionTaskExecution({
        execution, message, now: now(), reason, state: 'blocked', store: dependencies.store
      }),
      kind: 'blocked', message
    };
  }

  function unchangedBlocked(
    execution: StoredTaskExecution,
    message: string
  ): MutationOutcome {
    return { execution, kind: 'blocked', message };
  }

  async function uncertain(execution: StoredTaskExecution, message: string): Promise<MutationOutcome> {
    return {
      execution: await transitionTaskExecution({
        execution, message, now: now(), state: 'uncertain', store: dependencies.store
      }),
      kind: 'uncertain', message, reconcileState: execution.state
    };
  }

  async function releaseCapacity(
    actor: TaskExecutionActor,
    execution: Pick<StoredTaskExecution, 'environmentId' | 'id'>
  ) {
    const lease = await dependencies.capacity.read(actor.userId, execution.environmentId);
    if (lease?.executionId === execution.id && lease.state === 'active') {
      await dependencies.capacity.release(actor.userId, lease.id, execution.id);
    }
  }

  return { archive, cancel, respondApproval, respondInput, send };
}

function withMessageOutcome(
  outcome: MutationOutcome,
  messageOutcome: NonNullable<TaskExecutionResult['messageOutcome']>
): MutationOutcome {
  return { ...outcome, messageOutcome };
}

type MutationOutcome = {
  delivery?: 'queued' | 'sent' | 'steered';
  execution: StoredTaskExecution;
  kind?: 'blocked' | 'completed' | 'uncertain';
  message: string;
  messageOutcome?: TaskExecutionResult['messageOutcome'];
  reconcileState?: StoredTaskExecution['state'];
  terminal?: true;
};

function isReconcileState(value: unknown): value is StoredTaskExecution['state'] {
  return typeof value === 'string' && ![
    'archived', 'cancelled', 'completed', 'failed', 'uncertain'
  ].includes(value);
}
