import { createHash } from 'node:crypto';

import type { CodexMachineTaskSendRequest } from '../../src/shared/codex-machine-tasks-api';
import type {
  CodexMachineTaskQueuedSend,
  CodexMachineTasksServiceOptions
} from './contracts';
import { blocked, sessionSendResult, targetAtGeneration } from './results';

export function createCodexMachineTaskQueueDispatcher(
  options: Pick<
    CodexMachineTasksServiceOptions,
    'durableGenerationFor' | 'generationFor' | 'queueRetryDelay' | 'sessions' | 'store'
  >
) {
  const running = new Set<string>();

  function schedule(entry: CodexMachineTaskQueuedSend) {
    const key = `${entry.operation.userId}\0${entry.operation.operationId}`;
    if (running.has(key)) return;
    running.add(key);
    void dispatch(entry).then(
      () => running.delete(key),
      async () => {
        running.delete(key);
        await (options.queueRetryDelay?.() ?? retryDelay());
        await resume();
      }
    ).catch(() => undefined);
  }

  async function resume() {
    for (const entry of await options.store.listQueuedSends()) schedule(entry);
  }

  async function start() {
    while (true) {
      try {
        await resume();
        return;
      } catch {
        await (options.queueRetryDelay?.() ?? retryDelay());
      }
    }
  }

  async function enqueue(
    operation: CodexMachineTaskQueuedSend['operation'],
    result: CodexMachineTaskQueuedSend['result']
  ) {
    await options.store.queueSend(operation, result);
    schedule({ dispatchAttempt: 0, operation, result, state: 'queued' });
    return result;
  }

  async function dispatch(entry: CodexMachineTaskQueuedSend) {
    const { operation } = entry;
    let recovering = entry.state !== 'queued';
    const request: CodexMachineTaskSendRequest = {
      connectorId: operation.connectorId,
      delivery: 'queue',
      message: operation.message,
      operationId: operation.operationId,
      threadId: operation.threadId
    };
    while (true) {
      const currentGeneration = options.generationFor(operation.connectorId);
      if (currentGeneration === undefined) {
        await (options.queueRetryDelay?.() ?? retryDelay());
        continue;
      }
      if (recovering) {
        if (!options.sessions.reconcileSend) {
          await options.store.markSendUncertain(operation);
          return;
        }
        const reconciled = await options.sessions.reconcileSend({
          connectorId: operation.connectorId,
          delivery: 'new-turn',
          durableOperations: operation.durableOperations,
          generation: operation.generation,
          message: operation.message,
          operationId: entry.dispatchAttempt === 0
            ? operation.operationId
            : dispatchOperationId(operation.operationId, entry.dispatchAttempt),
          threadId: operation.threadId,
          userId: operation.userId
        });
        const result = reconciled.result;
        if (result.status === 'ambiguous') {
          await options.store.markSendUncertain(operation);
          return;
        }
        if (result.status === 'rejected' &&
            (result.reason === 'thread_active' || result.reason === 'unavailable')) {
          await options.store.queueSend(operation, entry.result);
          recovering = false;
          continue;
        }
        await options.store.completeSend(operation, sessionSendResult(
          targetAtGeneration(entry.result.target, reconciled.generation), request, result
        ));
        return;
      }
      if (currentGeneration !== operation.generation) {
        const canResume = operation.durableOperations &&
          options.durableGenerationFor?.(operation.connectorId, currentGeneration) === true;
        if (!canResume || !await options.store.rebindQueuedSend(operation, currentGeneration)) {
          await options.store.completeSend(operation, blocked(
            operation.operationId,
            'stale_connector',
            'The queued message was not sent to a stale connector generation.',
            targetAtGeneration(entry.result.target, operation.generation)
          ));
          return;
        }
        operation.generation = currentGeneration;
      }
      let snapshot;
      try {
        snapshot = await options.sessions.read({
          connectorId: operation.connectorId,
          generation: operation.generation,
          threadId: operation.threadId,
          userId: operation.userId
        });
      } catch {
        await (options.queueRetryDelay?.() ?? retryDelay());
        continue;
      }
      if (snapshot.session.status === 'active') {
        await (options.queueRetryDelay?.() ?? retryDelay());
        continue;
      }
      if (snapshot.session.status !== 'idle') {
        await (options.queueRetryDelay?.() ?? retryDelay());
        continue;
      }
      const attempt = await options.store.resumeQueuedSend(operation);
      if (attempt === undefined) return;
      try {
        const result = await options.sessions.send({
          connectorId: operation.connectorId,
          delivery: 'new-turn',
          generation: operation.generation,
          message: operation.message,
          operationId: dispatchOperationId(operation.operationId, attempt),
          threadId: operation.threadId,
          userId: operation.userId
        });
        if (result.status === 'rejected' &&
            (result.reason === 'thread_active' || result.reason === 'unavailable')) {
          await options.store.queueSend(operation, entry.result);
          await (options.queueRetryDelay?.() ?? retryDelay());
          continue;
        }
        if (result.status === 'ambiguous' || !result.turnId && result.status !== 'rejected') {
          await options.store.markSendUncertain(operation);
          return;
        }
        await options.store.completeSend(
          operation,
          sessionSendResult(targetAtGeneration(entry.result.target, operation.generation), request, result)
        );
        return;
      } catch {
        await options.store.markSendUncertain(operation);
        return;
      }
    }
  }

  return { enqueue, resume, schedule, start };
}

function dispatchOperationId(operationId: string, attempt: number) {
  const digest = createHash('sha256')
    .update(`queued-send\0${operationId}\0${attempt}`)
    .digest('hex')
    .slice(0, 32);
  return `queue:dispatch:${digest}`;
}

function retryDelay() {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 1_000);
    timer.unref?.();
  });
}
