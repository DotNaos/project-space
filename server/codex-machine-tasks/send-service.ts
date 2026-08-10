import type {
  CodexMachineTaskSendDelivery,
  CodexMachineTaskSendRequest,
  CodexMachineTaskSendResult,
  CodexMachineTaskTarget
} from '../../src/shared/codex-machine-tasks-api';
import type { CodexSessionOperationResult, CodexSessionStreamEvent } from '../../src/shared/codex-sessions-api';
import type {
  CodexMachineTaskSendOperation,
  CodexMachineTasksServiceOptions
} from './contracts';
import {
  blocked,
  sendResult,
  sessionSendResult,
  targetAtGeneration,
  uncertain
} from './results';
import { CodexMachineTaskTargetError } from './target-resolver';
import {
  dispatchOperationId,
  isQueueRetryable,
  operationFor,
  queueKey,
  requestForOperation,
  retryDelay,
  selectorForOperation
} from './send-operation';

type Sessions = CodexMachineTasksServiceOptions['sessions'];
type Store = CodexMachineTasksServiceOptions['store'];

export function createCodexMachineTaskSendService(options: {
  conflict(): never;
  durableGenerationFor?(connectorId: string, generation: number): boolean;
  sessions: Sessions;
  store: Store;
  target(
    userId: string,
    selector: Pick<
      CodexMachineTaskSendRequest,
      'connectorId' | 'environmentId' | 'physicalMachineId' | 'physicalMachineName'
    >
  ): Promise<CodexMachineTaskTarget>;
}) {
  const workers = new Map<string, Promise<void>>();
  const recoveryWorkers = new Map<string, Promise<void>>();

  async function send(
    actor: { userId: string },
    request: CodexMachineTaskSendRequest
  ): Promise<CodexMachineTaskSendResult> {
    let selected: CodexMachineTaskTarget;
    try {
      selected = await options.target(actor.userId, request);
    } catch (error) {
      if (!(error instanceof CodexMachineTaskTargetError)) throw error;
      return blocked(request.operationId, error.reason, error.message);
    }
    const mode = request.mode ?? 'auto';
    const operation = operationFor(options, actor.userId, selected, request, mode);
    const reservation = await options.store.reserveSend(operation);
    if (reservation.kind === 'conflict') return options.conflict();
    if (reservation.kind === 'replayed') {
      if (reservation.result.state === 'queued') schedule(operation);
      return { ...reservation.result, operationId: request.operationId };
    }
    if (reservation.kind === 'fenced') {
      return blocked(
        request.operationId,
        'send_in_progress',
        'Another message is currently being dispatched to this Codex thread.',
        selected
      );
    }
    const executionGeneration = 'generation' in reservation
      ? reservation.generation
      : operation.generation;
    const durableOperations = 'durableOperations' in reservation
      ? reservation.durableOperations
      : operation.durableOperations;
    operation.generation = executionGeneration;
    if ('dispatchAttempt' in reservation) operation.dispatchAttempt = reservation.dispatchAttempt;
    if (reservation.kind === 'pending' || reservation.kind === 'uncertain') {
      return reconcileReserved(
        operation,
        selected,
        request,
        reservation.kind,
        executionGeneration,
        durableOperations
      );
    }
    if (mode === 'queue') {
      try {
        const earlier = await options.store.nextQueuedSend(operation);
        if (earlier) {
          const queued = sendResult('queued', selected, request);
          await options.store.markSendQueued(operation, queued);
          schedule(earlier);
          return queued;
        }
      } catch {
        await options.store.releaseSend(operation);
        return blocked(
          request.operationId,
          'offline',
          'The message queue could not be checked before dispatch.',
          selected
        );
      }
    }
    let inspected: Awaited<ReturnType<Sessions['inspect']>>;
    try {
      inspected = await options.sessions.inspect({
        connectorId: selected.connector.id,
        generation: executionGeneration,
        threadId: request.threadId,
        userId: actor.userId
      });
    } catch {
      await options.store.releaseSend(operation);
      return blocked(
        request.operationId,
        'offline',
        'The selected connector could not verify the Codex thread.',
        selected
      );
    }
    const activeTurnId = inspected.activeTurnId;
    if (mode === 'steer') {
      if (!request.expectedTurnId) {
        return completeBlocked(
          operation,
          request,
          selected,
          'turn_required',
          'Steering requires the exact active turn ID returned by read_codex_task.'
        );
      }
      if (!activeTurnId || activeTurnId !== request.expectedTurnId) {
        return completeBlocked(
          operation,
          request,
          selected,
          'turn_changed',
          'The verified active Codex turn changed before it could be steered.'
        );
      }
      return dispatch(operation, selected, request, 'steered', 'steer', activeTurnId, {
        releaseIfNotAttempted: true
      });
    }
    if (activeTurnId && mode === 'auto') {
      return completeBlocked(
        operation,
        request,
        selected,
        'thread_active',
        'The Codex thread has an active turn. Choose steer or queue explicitly.'
      );
    }
    if (activeTurnId) {
      const queued = sendResult('queued', selected, request);
      await options.store.markSendQueued(operation, queued);
      schedule(operation);
      return queued;
    }
    if (inspected.session.status !== 'idle') {
      return completeBlocked(
        operation,
        request,
        selected,
        'offline',
        'The Codex thread is not ready to accept a message.'
      );
    }
    return dispatch(operation, selected, request, 'sent', 'new-turn', undefined, {
      releaseIfNotAttempted: true,
      retryQueueRejection: mode === 'queue'
    });
  }

  async function reconcileReserved(
    operation: CodexMachineTaskSendOperation,
    selected: CodexMachineTaskTarget,
    request: CodexMachineTaskSendRequest,
    reservation: 'pending' | 'uncertain',
    generation: number,
    durableOperations: boolean
  ) {
    if (reservation === 'pending' && selected.connector.generation === generation) {
      const delivery = operation.request.mode === 'steer' ? 'steered' : 'sent';
      const sessionDelivery = operation.request.mode === 'steer' ? 'steer' : 'new-turn';
      const result = await dispatch(
        operation,
        targetAtGeneration(selected, generation),
        request,
        delivery,
        sessionDelivery,
        operation.request.expectedTurnId,
        { retryQueueRejection: operation.request.mode === 'queue' }
      );
      return requeueRetryable(operation, selected, request, result);
    }
    let reconciliation: Awaited<ReturnType<NonNullable<Sessions['reconcileSend']>>> | undefined;
    try {
      reconciliation = await options.sessions.reconcileSend?.({
        connectorId: selected.connector.id,
        delivery: operation.request.mode === 'steer' ? 'steer' : 'new-turn',
        durableOperations,
        ...(operation.request.expectedTurnId
          ? { expectedTurnId: operation.request.expectedTurnId }
          : {}),
        generation,
        message: request.message,
        operationId: dispatchOperationId(operation),
        threadId: request.threadId,
        userId: operation.userId
      });
    } catch {
      reconciliation = undefined;
    }
    if (!reconciliation || reconciliation.result.status === 'ambiguous') {
      await options.store.markSendUncertain(operation);
      return uncertain(request.operationId, targetAtGeneration(selected, generation));
    }
    const delivery = operation.request.mode === 'steer' ? 'steered' : 'sent';
    const final = sessionSendResult(
      targetAtGeneration(selected, reconciliation.generation),
      request,
      reconciliation.result,
      delivery
    );
    if (isQueueRetryable(operation, final)) {
      return requeueRetryable(operation, selected, request, final, reconciliation.generation);
    }
    await options.store.completeSend(operation, final, reconciliation.generation);
    return final;
  }

  async function dispatch(
    operation: CodexMachineTaskSendOperation,
    selected: CodexMachineTaskTarget,
    request: CodexMachineTaskSendRequest,
    delivery: Exclude<CodexMachineTaskSendDelivery, 'queued'>,
    sessionDelivery: 'new-turn' | 'steer',
    expectedTurnId?: string,
    behavior: { releaseIfNotAttempted?: boolean; retryQueueRejection?: boolean } = {}
  ): Promise<CodexMachineTaskSendResult> {
    let attempted = false;
    let result: CodexSessionOperationResult;
    let resultTarget = selected;
    let settledGeneration = operation.generation;
    let terminal: { event?: CodexSessionStreamEvent; sequence?: number } | undefined;
    try {
      const start = () => {
        attempted = true;
        return options.sessions.send({
          connectorId: selected.connector.id,
          delivery: sessionDelivery,
          ...(expectedTurnId ? { expectedTurnId } : {}),
          generation: operation.generation,
          message: request.message,
          operationId: dispatchOperationId(operation),
          threadId: request.threadId,
          userId: operation.userId
        });
      };
      if (request.wait) {
        const before = await options.sessions.read({
          connectorId: selected.connector.id,
          generation: operation.generation,
          threadId: request.threadId,
          userId: operation.userId
        });
        const waited = await options.sessions.wait({
          afterSequence: before.streamCursor,
          connectorId: selected.connector.id,
          generation: operation.generation,
          start,
          threadId: request.threadId,
          userId: operation.userId
        });
        result = waited.result;
        terminal = waited;
      } else {
        result = await start();
      }
      if (result.status === 'ambiguous') {
        const reconciliation = await options.sessions.reconcileSend?.({
          connectorId: selected.connector.id,
          delivery: sessionDelivery,
          durableOperations: operation.durableOperations,
          ...(expectedTurnId ? { expectedTurnId } : {}),
          generation: operation.generation,
          message: request.message,
          operationId: dispatchOperationId(operation),
          threadId: request.threadId,
          userId: operation.userId
        });
        if (!reconciliation || reconciliation.result.status === 'ambiguous') {
          await options.store.markSendUncertain(operation);
          return uncertain(request.operationId, selected);
        }
        settledGeneration = reconciliation.generation;
        resultTarget = targetAtGeneration(selected, reconciliation.generation);
        result = reconciliation.result;
      }
      if (!result.turnId && result.status !== 'rejected') {
        await options.store.markSendUncertain(operation, settledGeneration);
        return uncertain(request.operationId, resultTarget);
      }
      let final = sessionSendResult(resultTarget, request, result, delivery);
      if (behavior.retryQueueRejection && result.status === 'rejected' &&
        (result.reason === 'thread_active' || result.reason === 'unavailable')) {
        return requeueRetryable(operation, resultTarget, request, final, settledGeneration);
      }
      if (request.wait && result.status !== 'rejected') {
        if (!terminal?.event) {
          await options.store.markSendUncertain(operation, settledGeneration);
          return uncertain(request.operationId, resultTarget);
        }
        if (terminal.event.type === 'approval-requested') {
          final = blocked(
            request.operationId,
            'approval_required',
            'Codex requires approval.',
            resultTarget
          );
        } else if (terminal.event.type === 'user-input-requested') {
          final = blocked(
            request.operationId,
            'input_required',
            'Codex requires user input.',
            resultTarget
          );
        } else {
          const finalRead = await options.sessions.read({
            connectorId: selected.connector.id,
            generation: settledGeneration,
            threadId: request.threadId,
            userId: operation.userId
          });
          final = sendResult(delivery, resultTarget, request, result.turnId!, true, finalRead);
        }
      }
      await options.store.completeSend(operation, final, settledGeneration);
      return final;
    } catch {
      if (!attempted && behavior.releaseIfNotAttempted) {
        await options.store.releaseSend(operation);
        return blocked(
          request.operationId,
          'offline',
          'The Codex thread could not be observed before dispatch.',
          resultTarget
        );
      }
      await options.store.markSendUncertain(operation, settledGeneration);
      return uncertain(request.operationId, resultTarget);
    }
  }

  async function requeueRetryable(
    operation: CodexMachineTaskSendOperation,
    selected: CodexMachineTaskTarget,
    request: CodexMachineTaskSendRequest,
    result: CodexMachineTaskSendResult,
    nextGeneration = operation.generation
  ) {
    if (!isQueueRetryable(operation, result)) return result;
    const queued = sendResult('queued', selected, request);
    await options.store.markSendQueued(operation, queued, nextGeneration);
    operation.generation = nextGeneration;
    schedule(operation);
    return queued;
  }

  async function completeBlocked(
    operation: CodexMachineTaskSendOperation,
    request: CodexMachineTaskSendRequest,
    selected: CodexMachineTaskTarget,
    reason: 'offline' | 'thread_active' | 'turn_changed' | 'turn_required',
    message: string
  ) {
    const result = blocked(request.operationId, reason, message, selected);
    await options.store.completeSend(operation, result);
    return result;
  }

  function schedule(operation: CodexMachineTaskSendOperation) {
    const key = queueKey(operation);
    if (workers.has(key)) return;
    const worker = runQueue(operation)
      .catch(() => retryDelay())
      .finally(async () => {
        if (workers.get(key) !== worker) return;
        workers.delete(key);
        try {
          const next = await options.store.nextQueuedSend(operation);
          if (next) schedule(next);
        } catch {
          const timer = setTimeout(() => schedule(operation), 5_000);
          timer.unref?.();
        }
      });
    workers.set(key, worker);
  }

  async function runQueue(seed: CodexMachineTaskSendOperation) {
    while (true) {
      const operation = await options.store.nextQueuedSend(seed);
      if (!operation) return;
      let selected: CodexMachineTaskTarget;
      try {
        selected = await options.target(operation.userId, {
          connectorId: operation.connectorId,
          ...(operation.request.target.environmentId
            ? { environmentId: operation.request.target.environmentId }
            : { physicalMachineId: operation.request.target.physicalMachineId })
        });
        operation.generation = selected.connector.generation;
        const inspected = await options.sessions.inspect({
          connectorId: operation.connectorId,
          generation: operation.generation,
          threadId: operation.threadId,
          userId: operation.userId
        });
        if (inspected.activeTurnId) {
          await options.sessions.waitUntilIdle({
            connectorId: operation.connectorId,
            generation: operation.generation,
            threadId: operation.threadId,
            turnId: inspected.activeTurnId,
            userId: operation.userId
          });
          continue;
        }
        if (inspected.session.status !== 'idle') {
          await retryDelay();
          continue;
        }
      } catch (error) {
        if (error instanceof CodexMachineTaskTargetError && error.reason === 'unauthorized') {
          const attempt = await options.store.claimQueuedSend(operation);
          if (attempt !== undefined) {
            operation.dispatchAttempt = attempt;
            await options.store.completeSend(
              operation,
              blocked(operation.operationId, error.reason, error.message)
            );
          } else {
            await retryDelay(50);
          }
          continue;
        }
        await retryDelay();
        continue;
      }
      const attempt = await options.store.claimQueuedSend(operation);
      if (attempt === undefined) {
        await retryDelay(50);
        continue;
      }
      operation.dispatchAttempt = attempt;
      const request = requestForOperation(operation);
      const result = await dispatch(operation, selected!, request, 'sent', 'new-turn', undefined, {
        retryQueueRejection: true
      });
      if (isQueueRetryable(operation, result)) {
        await options.store.markSendQueued(
          operation,
          sendResult('queued', selected!, request)
        );
      }
    }
  }

  async function resumeQueued() {
    for (const operation of await options.store.listPendingSends()) scheduleRecovery(operation);
    for (const operation of await options.store.listQueuedSends()) schedule(operation);
  }

  function scheduleRecovery(operation: CodexMachineTaskSendOperation) {
    const key = queueKey(operation);
    if (recoveryWorkers.has(key)) return;
    let retry = false;
    const worker = recoverPending(operation)
      .catch(async () => {
        retry = true;
        await retryDelay();
      })
      .finally(() => {
        if (recoveryWorkers.get(key) !== worker) return;
        recoveryWorkers.delete(key);
        if (retry) scheduleRecovery(operation);
      });
    recoveryWorkers.set(key, worker);
  }

  async function recoverPending(operation: CodexMachineTaskSendOperation) {
    while (true) {
      let selected: CodexMachineTaskTarget;
      try {
        selected = await options.target(operation.userId, selectorForOperation(operation));
      } catch (error) {
        if (error instanceof CodexMachineTaskTargetError && error.reason === 'unauthorized') {
          await options.store.completeSend(
            operation,
            blocked(operation.operationId, error.reason, error.message)
          );
          return;
        }
        await retryDelay();
        continue;
      }
      if (operation.request.mode === 'queue' && !operation.dispatchAttempt) {
        const earlier = await options.store.nextQueuedSend(operation);
        if (earlier) {
          const request = requestForOperation(operation);
          await options.store.markSendQueued(operation, sendResult('queued', selected, request));
          schedule(earlier);
          return;
        }
      }
      await reconcileReserved(
        operation,
        selected,
        requestForOperation(operation),
        'pending',
        operation.generation,
        operation.durableOperations
      );
      return;
    }
  }

  return { resumeQueued, send };
}
