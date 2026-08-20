import { createHash } from 'node:crypto';
import {
  normalizeCodexMachineTaskWorker
} from '../../src/shared/codex-machine-tasks-api';
import type {
  CodexMachineTaskAttachRequest,
  CodexMachineTaskAttachResult,
  CodexMachineTaskIdentity,
  CodexMachineTaskExistingRequest,
  CodexMachineTaskExistingResult,
  CodexMachineTaskReadRequest,
  CodexMachineTaskReadResult,
  CodexMachineTaskSendRequest,
  CodexMachineTaskSendResult,
  CodexMachineTaskStartRecoveryResult,
  CodexMachineTaskStartRequest,
  CodexMachineTaskStartResult,
  CodexMachineTaskTarget,
  CodexMachineTaskReportingTask,
  CodexMachineTaskWorkerSelection
} from '../../src/shared/codex-machine-tasks-api';
import { CODEX_MACHINE_TASKS_API_VERSION } from '../../src/shared/codex-machine-tasks-api';
import type { CodexSessionOperationResult, CodexSessionStreamEvent } from '../../src/shared/codex-sessions-api';
import { canonicalJson } from '../codex-sessions/canonical-json';
import {
  CodexMachineTaskTargetError,
  resolveCodexMachineTaskServiceTarget,
  type CodexMachineTaskTargetSelector
} from './target-resolver';
import { CodexMachineTaskIssueError } from './issue-provider';
import {
  blocked,
  queuedSendResult,
  readBlocked,
  sendResult,
  sessionSendResult,
  targetAtGeneration,
  uncertain
} from './results';
import { createCodexMachineTaskQueueDispatcher } from './queue-dispatcher';
import {
  createMessageSendOperation,
  fingerprintMessageRequest,
  fingerprintMessageTarget,
  reconcileMessageSend,
  resolveMessageDelivery
} from './message-delivery';
import type {
  CodexMachineTasksServiceOptions,
  CodexMachineTaskStartPayload,
  CodexMachineTaskStartOperation
} from './contracts';
export type {
  CodexMachineTaskSendOperation,
  CodexMachineTaskSendReservation,
  CodexMachineTasksServiceOptions,
  CodexMachineTasksStore,
  CodexMachineTaskStartLookup,
  CodexMachineTaskStartOperation,
  CodexMachineTaskStartPayload,
  CodexMachineTaskStartReservation
} from './contracts';
export class CodexMachineTasksConflictError extends Error {
  constructor() {
    super('The operation ID was already used for different input.');
    this.name = 'CodexMachineTasksConflictError';
  }
}
export class CodexMachineTasksInputError extends Error {
  constructor() {
    super('The worker selection is invalid.');
    this.name = 'CodexMachineTasksInputError';
  }
}
export const codexAttachToken = Symbol('codexAttachToken');
type CodexMachineTaskActor = {
  callerMachineId?: string;
  reportingTask?: CodexMachineTaskReportingTask;
  userId: string;
};

export function createCodexMachineTasksService(options: CodexMachineTasksServiceOptions) {
  const queueDispatcher = createCodexMachineTaskQueueDispatcher(options);
  void queueDispatcher.start().catch(() => undefined);
  const target = (userId: string, selector: CodexMachineTaskTargetSelector, callerMachineId?: string) =>
    resolveCodexMachineTaskServiceTarget(options, userId, selector, callerMachineId);
  return {
    async existing(
      actor: { userId: string },
      request: CodexMachineTaskExistingRequest
    ): Promise<CodexMachineTaskExistingResult> {
      const found = await options.store.findStart?.({ ...request, userId: actor.userId })
        ?? { kind: 'missing' as const };
      if (found.kind === 'missing') {
        return { apiVersion: CODEX_MACHINE_TASKS_API_VERSION, state: 'missing' };
      }
      if (found.kind === 'pending' || found.kind === 'uncertain') {
        return {
          apiVersion: CODEX_MACHINE_TASKS_API_VERSION,
          message: found.kind === 'uncertain'
            ? 'The existing Codex task start needs recovery before another task can be created.'
            : 'The existing Codex task is still starting.',
          state: 'attention'
        };
      }
      if (found.kind === 'attention') {
        return {
          apiVersion: CODEX_MACHINE_TASKS_API_VERSION,
          message: found.message,
          state: 'attention'
        };
      }
      if (found.result.state !== 'confirmed') {
        return {
          apiVersion: CODEX_MACHINE_TASKS_API_VERSION,
          message: 'The existing Codex task needs attention.',
          state: 'attention'
        };
      }
      const task = found.result.task;
      try {
        const generation = options.generationFor(task.connector.id);
        if (!generation) throw new Error('The owning connector is not currently available.');
        const read = await options.sessions.read({
          connectorId: task.connector.id,
          generation,
          threadId: task.threadId,
          userId: actor.userId
        });
        const activity = read.session.activity;
        const action = activity?.conversationState === 'running'
          ? 'open-running' as const
          : activity?.currentTurnState === 'waiting-for-approval'
            || activity?.currentTurnState === 'waiting-for-user'
            || activity?.conversationState === 'failed'
            || activity?.freshness === 'stale'
            ? 'resolve' as const
            : 'continue' as const;
        return {
          action,
          apiVersion: CODEX_MACHINE_TASKS_API_VERSION,
          session: read.session,
          state: 'confirmed',
          task
        };
      } catch {
        return {
          action: 'resolve',
          apiVersion: CODEX_MACHINE_TASKS_API_VERSION,
          state: 'confirmed',
          task
        };
      }
    },

    async recoverStart(
      actor: CodexMachineTaskActor,
      request: CodexMachineTaskStartRequest
    ): Promise<CodexMachineTaskStartRecoveryResult> {
      const released = await options.store.releaseUncertainStart({
        fingerprint: fingerprint({
          request: normalizedStartRequest(request),
          reportingTask: actor.reportingTask,
          userId: actor.userId
        }),
        legacyFingerprint: fingerprint({ request: legacyStartRequest(request), userId: actor.userId }),
        operationId: request.operationId,
        userId: actor.userId
      });
      if (released === 'conflict' || released === 'not_uncertain') {
        throw new CodexMachineTasksConflictError();
      }
      return {
        apiVersion: CODEX_MACHINE_TASKS_API_VERSION,
        operationId: request.operationId,
        state: 'released'
      };
    },

    async start(
      actor: CodexMachineTaskActor,
      request: CodexMachineTaskStartRequest
    ): Promise<CodexMachineTaskStartResult> {
      const worker = workerSelection(request);
      const reportingTask = actor.reportingTask;
      const requestFingerprint = fingerprint({
        request: normalizedStartRequest(request), reportingTask, userId: actor.userId
      });
      const legacyFingerprint = fingerprint({ request: legacyStartRequest(request), userId: actor.userId });
      if (options.requireReportingTaskBinding && !reportingTask) {
        return blocked(
          request.operationId,
          'unauthorized',
          'An initiating Codex task binding is required for worker dispatch.'
        );
      }
      const lookup = request.dryRun
        ? { kind: 'missing' as const }
        : await options.store.lookupStart({
            fingerprint: requestFingerprint,
            legacyFingerprint,
            operationId: request.operationId,
            userId: actor.userId
          });
      if (lookup.kind === 'conflict') throw new CodexMachineTasksConflictError();
      if (lookup.kind === 'replayed') {
        return { ...lookup.result, operationId: request.operationId };
      }
      if (lookup.kind === 'legacy') {
        const message = 'This pre-upgrade Codex task has no proven worker or initiating-task binding and will not be redispatched automatically.';
        return lookup.state === 'completed'
          ? blocked(request.operationId, 'legacy_unbound', message)
          : uncertain(request.operationId, undefined, message);
      }
      let selected: CodexMachineTaskTarget;
      try {
        selected = await target(
          actor.userId,
          lookup.kind === 'reserved'
            ? {
                connectorId: lookup.connectorId,
                physicalMachineId: lookup.physicalMachineId
              }
            : request,
          actor.callerMachineId
        );
      } catch (error) {
        if (!(error instanceof CodexMachineTaskTargetError)) throw error;
        if (lookup.kind === 'reserved') return uncertain(request.operationId);
        return blocked(request.operationId, error.reason, error.message, undefined, error.unavailable);
      }
      let issue: CodexMachineTaskStartPayload;
      if (lookup.kind === 'reserved') {
        if (!lookup.startPayload) {
          return uncertain(
            request.operationId,
            targetAtGeneration(selected, lookup.generation)
          );
        }
        issue = lookup.startPayload;
      } else {
        try {
          issue = await options.issue({
            dryRun: request.dryRun,
            expectedBranch: request.expectedBranch,
            expectedCommit: request.expectedCommit,
            expectedPullRequestNumber: request.expectedPullRequestNumber,
            issue: request.issue,
            repositoryId: request.repositoryId,
            userId: actor.userId
          });
        } catch (error) {
          if (!(error instanceof CodexMachineTaskIssueError)) throw error;
          return blocked(request.operationId, error.reason, error.message, selected);
        }
      }
      issue = {
        ...issue,
        ...(reportingTask ? { reportingTask } : {}),
        worker
      };
      if (request.dryRun) {
        const planned = await options.plan?.({
          branch: issue.branch,
          commit: issue.commit,
          connectorId: selected.connector.id,
          generation: selected.connector.generation,
          issue: issue.issue,
          operationId: request.operationId,
          physicalMachineId: selected.physicalMachine.id,
          repository: issue.repository,
          ...(reportingTask ? { reportingTask } : {}),
          userId: actor.userId,
          worker
        });
        if (planned?.state === 'uncertain') {
          return uncertain(request.operationId, selected, planned.message);
        }
        if (!planned || planned.state !== 'ready' || !planned.plan?.workspace) {
          return blocked(
            request.operationId,
            'worktree_failure',
            planned?.message ?? 'The selected Environment has no verified managed workspace.',
            selected
          );
        }
        const environment = planned.plan.environment ?? selected.environment;
        const workspace = planned.plan.workspace;
        if (!environment || workspace.branch !== issue.branch || !workspace.id ||
            !/^[0-9a-f]{40,64}$/i.test(issue.commit) ||
            (planned.plan.worktree && planned.plan.worktree.branch !== issue.branch)) {
          return blocked(
            request.operationId,
            'worktree_failure',
            'The selected Environment workspace could not be verified for this issue revision.',
            selected
          );
        }
        return {
          apiVersion: CODEX_MACHINE_TASKS_API_VERSION,
          operationId: request.operationId,
          plan: {
            base: { branch: issue.branch, commit: issue.commit },
            environment,
            issue: issue.issue,
            operation: { id: request.operationId, state: 'ready' as const },
            repository: issue.repository,
            workspace,
            ...(reportingTask ? { reportingTask } : {}),
            worker,
            ...(planned.plan.worktree ? { worktree: planned.plan.worktree } : {})
          },
          state: 'ready' as const,
          target: selected
        };
      }
      let plannedWorkspace: {
        branch: string;
        commit?: string;
        id: string;
        path?: string;
        worktree?: { branch: string; id: string };
      } | undefined;
      if (options.plan) {
        const planned = await options.plan({
          branch: issue.branch,
          commit: issue.commit,
          connectorId: selected.connector.id,
          generation: selected.connector.generation,
          issue: issue.issue,
          operationId: request.operationId,
          physicalMachineId: selected.physicalMachine.id,
          repository: issue.repository,
          ...(reportingTask ? { reportingTask } : {}),
          userId: actor.userId,
          worker
        });
        if (planned.state === 'uncertain') {
          return uncertain(request.operationId, selected, planned.message);
        }
        if (planned.state !== 'ready' || !planned.plan?.workspace) {
          return blocked(
            request.operationId,
            'worktree_failure',
            planned.message ?? 'The selected Environment has no verified managed workspace.',
            selected
          );
        }
        if (!planned.plan.worktree) {
          return blocked(
            request.operationId,
            'worktree_failure',
            'The selected Environment has no verified Project-managed worktree binding.',
            selected
          );
        }
        plannedWorkspace = {
          ...planned.plan.workspace,
          worktree: planned.plan.worktree
        };
      }
      const operation: CodexMachineTaskStartOperation = {
        associationKey: fingerprint({
          connectorId: selected.connector.id,
          issue: issue.issue.number,
          physicalMachineId: selected.physicalMachine.id,
          repositoryId: issue.repository.id,
          userId: actor.userId
        }),
        connectorId: selected.connector.id,
        durableOperations: options.durableGenerationFor?.(
          selected.connector.id,
          selected.connector.generation
        ) ?? false,
        fingerprint: requestFingerprint,
        generation: selected.connector.generation,
        operationId: request.operationId,
        physicalMachineId: selected.physicalMachine.id,
        ...(reportingTask ? { reportingTask } : {}),
        startPayload: issue,
        state: 'pending',
        userId: actor.userId,
        worker
      };
      const reservation = await options.store.reserveStart(operation);
      if (reservation.kind === 'conflict') throw new CodexMachineTasksConflictError();
      if (reservation.kind === 'fenced') {
        return blocked(
          request.operationId,
          'machine_not_ready',
          'The selected Environment is stopping or being deleted.',
          selected
        );
      }
      if (reservation.kind === 'replayed') {
        return { ...reservation.result, operationId: request.operationId };
      }
      if (
        (reservation.kind === 'pending' && !reservation.sameOperation) ||
        (reservation.kind === 'uncertain' && !reservation.sameOperation)
      ) {
        if (!sameStartPayload(issue, reservation.startPayload)) {
          return uncertain(
            request.operationId,
            targetAtGeneration(selected, reservation.generation)
          );
        }
        operation.operationId = reservation.dispatchOperationId;
      }
      const executionGeneration = reservation.kind === 'new'
        ? operation.generation
        : reservation.generation;
      const durableOperations = reservation.kind === 'new'
        ? operation.durableOperations
        : reservation.durableOperations;
      operation.generation = executionGeneration;
      const start = await options.start({
        branch: issue.branch,
        commit: issue.commit,
        connectorId: selected.connector.id,
        generation: executionGeneration,
        durableOperations,
        issue: issue.issue,
        operationId: operation.operationId,
        physicalMachineId: selected.physicalMachine.id,
        reportingTask: reportingTask!,
        reconcile: reservation.kind !== 'new',
        repository: issue.repository,
        userId: actor.userId,
        worker
      });
      const started = start.result;
      const executionTarget = targetAtGeneration(selected, start.generation);
      if (started.state === 'uncertain') {
        await options.store.markStartUncertain(operation);
        return uncertain(request.operationId, executionTarget);
      }
      if (started.state === 'offline') {
        if (reservation.kind !== 'new') {
          await options.store.markStartUncertain(operation);
          return uncertain(request.operationId, executionTarget);
        }
        await options.store.releaseStart(operation);
        return blocked(
          request.operationId,
          'offline',
          'The selected connector went offline before the task was dispatched.',
          executionTarget
        );
      }
      if (started.state === 'worktree_failure') {
        const result = blocked(
          request.operationId,
          'worktree_failure',
          started.message,
          executionTarget
        );
        await options.store.releaseStart(operation);
        return result;
      }
      if (started.state === 'codex_failure') {
        const result = blocked(
          request.operationId,
          'codex_start_failed',
          started.message,
          executionTarget
        );
        await options.store.releaseStart(operation);
        return result;
      }
      const worktree = started.worktreeId
        ? { branch: issue.branch, id: started.worktreeId }
        : plannedWorkspace?.worktree;
      if (!worktree) {
        await options.store.markStartUncertain(operation);
        return uncertain(
          request.operationId,
          executionTarget,
          'Codex started, but the Project-managed worktree binding was not verified.'
        );
      }
      const workspace = started.workspace ?? plannedWorkspace ?? {
        branch: issue.branch,
        id: worktree.id
      };
      const task: CodexMachineTaskIdentity = {
        ...executionTarget,
        base: { branch: issue.branch, commit: issue.commit },
        canonicalTaskUrl: options.taskUrl(executionTarget.connector.id, started.threadId),
        issue: issue.issue,
        repository: issue.repository,
        ...(reportingTask ? { reportingTask } : {}),
        threadId: started.threadId,
        ...(started.handoff ? { handoff: started.handoff } : {}),
        worktree,
        worker,
        workspace: {
          branch: workspace.branch,
          ...(workspace.commit ? { commit: workspace.commit } : {}),
          id: workspace.id,
          ...(workspace.path ? { path: workspace.path } : {})
        }
      };
      const storedResult: CodexMachineTaskStartResult = {
        apiVersion: CODEX_MACHINE_TASKS_API_VERSION,
        operationId: operation.operationId,
        state: 'confirmed',
        task
      };
      await options.store.completeStart(operation, storedResult);
      return { ...storedResult, operationId: request.operationId };
    },

    async read(
      actor: { userId: string },
      request: CodexMachineTaskReadRequest
    ): Promise<CodexMachineTaskReadResult> {
      let selected: CodexMachineTaskTarget;
      try {
        selected = await target(actor.userId, request);
      } catch (error) {
        if (!(error instanceof CodexMachineTaskTargetError)) throw error;
        return readBlocked(error.reason, error.message);
      }
      const result = await options.sessions.read({
        connectorId: selected.connector.id,
        generation: selected.connector.generation,
        threadId: request.threadId,
        userId: actor.userId
      });
      const last = request.last;
      return {
        apiVersion: CODEX_MACHINE_TASKS_API_VERSION,
        result: last && result.turns.length > last
          ? { ...result, turns: result.turns.slice(-last) }
          : result,
        state: 'confirmed',
        target: selected
      };
    },

    async attach(
      actor: { callerMachineId?: string; userId: string },
      request: CodexMachineTaskAttachRequest
    ): Promise<CodexMachineTaskAttachResult> {
      let selected: CodexMachineTaskTarget;
      try {
        selected = await target(actor.userId, request);
      } catch (error) {
        if (!(error instanceof CodexMachineTaskTargetError)) throw error;
        return blocked(request.operationId, error.reason, error.message);
      }
      if (!actor.callerMachineId) {
        return blocked(
          request.operationId,
          'unauthorized',
          'Interactive attachment requires an authenticated caller machine.',
          selected
        );
      }
      await options.sessions.read({
        connectorId: selected.connector.id,
        generation: selected.connector.generation,
        threadId: request.threadId,
        userId: actor.userId
      });
      if (actor.callerMachineId !== selected.connector.id) {
        if (!options.attachments) {
          return blocked(
            request.operationId,
            'offline',
            'The secured remote attachment relay is unavailable.',
            selected
          );
        }
        const lease = options.attachments.issue({
          callerMachineId: actor.callerMachineId,
          connectorId: selected.connector.id,
          generation: selected.connector.generation,
          operationId: request.operationId,
          threadId: request.threadId,
          userId: actor.userId
        });
        return {
          apiVersion: CODEX_MACHINE_TASKS_API_VERSION,
          endpointPath: lease.endpointPath,
          expiresAt: lease.expiresAt,
          operationId: request.operationId,
          state: 'confirmed',
          target: selected,
          threadId: request.threadId,
          tokenEnvironmentVariable: 'PROJECT_CODEX_ATTACH_TOKEN',
          transport: 'websocket-tunnel',
          [codexAttachToken]: lease.token
        } as CodexMachineTaskAttachResult & { [codexAttachToken]: string };
      }
      return {
        apiVersion: CODEX_MACHINE_TASKS_API_VERSION,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        operationId: request.operationId,
        state: 'confirmed',
        target: selected,
        threadId: request.threadId,
        transport: 'local-unix'
      };
    },

    async send(
      actor: { userId: string },
      request: CodexMachineTaskSendRequest
    ): Promise<CodexMachineTaskSendResult> {
      const requestedDelivery = request.delivery ?? 'auto';
      const requestFingerprint = fingerprintMessageRequest(actor.userId, request);
      const earlyLookup = await options.store.lookupSendRequest({
        fingerprint: requestFingerprint,
        operationId: request.operationId,
        userId: actor.userId
      });
      if (earlyLookup.kind === 'conflict') throw new CodexMachineTasksConflictError();
      if (earlyLookup.kind === 'replayed') return earlyLookup.result;
      if (earlyLookup.kind === 'queued') {
        await queueDispatcher.resume();
        return earlyLookup.result;
      }
      let selected: CodexMachineTaskTarget;
      try {
        selected = await target(actor.userId, request);
      } catch (error) {
        if (!(error instanceof CodexMachineTaskTargetError)) throw error;
        if (earlyLookup.kind === 'reserved') return uncertain(request.operationId);
        return blocked(request.operationId, error.reason, error.message);
      }
      if (earlyLookup.kind === 'reserved' &&
          selected.connector.id !== earlyLookup.connectorId) return uncertain(request.operationId);
      const sendFingerprint = fingerprintMessageTarget(actor.userId, request, selected);
      const lookup = earlyLookup.kind === 'reserved'
        ? earlyLookup
        : await options.store.lookupSend({
            connectorId: selected.connector.id,
            fingerprint: sendFingerprint,
            operationId: request.operationId,
            threadId: request.threadId,
            userId: actor.userId
          });
      if (lookup.kind === 'conflict') throw new CodexMachineTasksConflictError();
      if (lookup.kind === 'replayed') return lookup.result;
      if (lookup.kind === 'queued') {
        await queueDispatcher.resume();
        return lookup.result;
      }
      const resolvedDelivery = lookup.kind === 'reserved' &&
        (requestedDelivery !== 'queue' || lookup.state === 'uncertain')
        ? {
            delivery: lookup.dispatchDelivery,
            expectedTurnId: lookup.expectedTurnId,
            sessionActive: false
          }
        : await resolveMessageDelivery({ actor, options, request, target: selected });
      if ('result' in resolvedDelivery) return resolvedDelivery.result;
      const { delivery, expectedTurnId, sessionActive } = resolvedDelivery;
      const queuedResult = requestedDelivery === 'queue'
        ? queuedSendResult(selected, request, new Date().toISOString())
        : undefined;
      const operation = createMessageSendOperation({
        delivery, expectedTurnId, fingerprint: sendFingerprint, lookup, options, request,
        queuedResult, requestFingerprint, target: selected, userId: actor.userId
      });
      const reservation = await options.store.reserveSend(operation);
      if (reservation.kind === 'conflict') throw new CodexMachineTasksConflictError();
      if (reservation.kind === 'replayed') {
        return { ...reservation.result, operationId: request.operationId };
      }
      if (reservation.kind === 'queued') {
        queueDispatcher.schedule({
          dispatchAttempt: reservation.dispatchAttempt,
          operation,
          result: reservation.result,
          state: reservation.state
        });
        return reservation.result;
      }
      if (reservation.kind === 'fenced') {
        return blocked(
          request.operationId,
          'thread_active',
          'A prior turn on this thread is still active or requires reconciliation.',
          selected
        );
      }
      if (requestedDelivery === 'queue' && sessionActive) {
        return queueDispatcher.enqueue(operation, queuedResult!);
      }
      const executionGeneration = reservation.kind === 'pending' || reservation.kind === 'uncertain'
        ? reservation.generation
        : operation.generation;
      const durableOperations = reservation.kind === 'pending' || reservation.kind === 'uncertain'
        ? reservation.durableOperations
        : operation.durableOperations;
      const executionDelivery = reservation.kind === 'pending' || reservation.kind === 'uncertain'
        ? reservation.dispatchDelivery
        : delivery;
      const executionExpectedTurnId = reservation.kind === 'pending' || reservation.kind === 'uncertain'
        ? reservation.expectedTurnId
        : expectedTurnId;
      const dispatchRequest = {
        ...request, delivery: executionDelivery, expectedTurnId: executionExpectedTurnId
      };
      const mustReconcile = reservation.kind === 'uncertain' ||
        reservation.kind === 'pending' && selected.connector.generation !== reservation.generation;
      let resultGeneration = executionGeneration;
      operation.generation = executionGeneration;
      let attempted = false;
      const reconcile = async () => {
        const reconciliation = await reconcileMessageSend({
          durableOperations,
          generation: executionGeneration,
          options,
          request: dispatchRequest,
          target: targetAtGeneration(selected, executionGeneration),
          userId: actor.userId
        });
        if (!reconciliation) return {
          operationId: request.operationId,
          replayed: true,
          status: 'ambiguous' as const,
          threadId: request.threadId
        };
        resultGeneration = reconciliation.generation;
        return reconciliation.result;
      };
      const send = () => {
        attempted = true;
        if (mustReconcile) return reconcile();
        return options.sessions.send({
          connectorId: selected.connector.id,
          delivery: executionDelivery,
          expectedTurnId: executionExpectedTurnId,
          generation: executionGeneration,
          message: request.message,
          operationId: request.operationId,
          threadId: request.threadId,
          userId: actor.userId
        });
      };
      try {
        let result: CodexSessionOperationResult;
        let terminal: { event?: CodexSessionStreamEvent; sequence?: number } | undefined;
        let waitedGeneration: number | undefined;
        if (request.wait && !mustReconcile) {
          const before = await options.sessions.read({
            connectorId: selected.connector.id,
            generation: executionGeneration,
            threadId: request.threadId,
            userId: actor.userId
          });
          const waited = await options.sessions.wait({
            afterSequence: before.streamCursor,
            connectorId: selected.connector.id,
            generation: executionGeneration,
            start: send,
            threadId: request.threadId,
            userId: actor.userId
          });
          result = waited.result;
          terminal = waited;
          waitedGeneration = executionGeneration;
        } else {
          result = await send();
        }
        if (result.status === 'ambiguous' && !mustReconcile) {
          result = await reconcile();
        }
        if (requestedDelivery === 'queue' && result.status === 'rejected' &&
            (result.reason === 'thread_active' || result.reason === 'unavailable')) {
          return queueDispatcher.enqueue(operation, queuedResult!);
        }
        if (
          request.wait &&
          waitedGeneration !== resultGeneration &&
          result.status !== 'ambiguous' &&
          result.status !== 'rejected' &&
          result.turnId
        ) {
          const waited = await options.sessions.wait({
            connectorId: selected.connector.id,
            generation: resultGeneration,
            start: async () => result,
            threadId: request.threadId,
            userId: actor.userId
          });
          result = waited.result;
          terminal = waited;
          waitedGeneration = resultGeneration;
        }
        const resultTarget = targetAtGeneration(selected, resultGeneration);
        if (result.status === 'ambiguous' || !result.turnId && result.status !== 'rejected') {
          await options.store.markSendUncertain(operation);
          return uncertain(request.operationId, resultTarget);
        }
        let final = sessionSendResult(resultTarget, request, result);
        if (request.wait && result.status !== 'rejected') {
          if (!terminal?.event) {
            await options.store.markSendUncertain(operation);
            return uncertain(request.operationId, resultTarget);
          }
          if (terminal.event.type === 'approval-requested') {
            final = blocked(
              request.operationId, 'approval_required', 'Codex requires approval.', resultTarget
            );
          } else if (terminal.event.type === 'user-input-requested') {
            final = blocked(
              request.operationId, 'input_required', 'Codex requires user input.', resultTarget
            );
          } else {
            const finalRead = await options.sessions.read({
              connectorId: selected.connector.id,
              generation: resultGeneration,
              threadId: request.threadId,
              userId: actor.userId
            });
            final = sendResult('completed', resultTarget, request, result.turnId!, finalRead);
          }
        }
        await options.store.completeSend(operation, final);
        return final;
      } catch {
        if (!attempted && reservation.kind === 'new') {
          await options.store.releaseSend(operation);
          return blocked(
            request.operationId,
            'offline',
            'The selected connector could not open the turn stream.',
            targetAtGeneration(selected, resultGeneration)
          );
        }
        if (!attempted) return uncertain(
          request.operationId,
          targetAtGeneration(selected, resultGeneration)
        );
        await options.store.markSendUncertain(operation);
        return uncertain(request.operationId, targetAtGeneration(selected, resultGeneration));
      }
    },

    async stream(
      actor: { userId: string },
      request: CodexMachineTaskReadRequest & { afterSequence?: number },
      emit: (event: CodexSessionStreamEvent, sequence?: number) => void,
      signal: AbortSignal,
      onReady?: () => void
    ) {
      if (!options.sessions.stream) throw new Error('Codex task streaming is unavailable.');
      const selected = await target(actor.userId, request);
      await options.sessions.stream({
        afterSequence: request.afterSequence,
        connectorId: selected.connector.id,
        generation: selected.connector.generation,
        emit,
        onReady,
        signal,
        threadId: request.threadId,
        userId: actor.userId
      });
    }
  };
}
function fingerprint(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
function sameStartPayload(
  left: CodexMachineTaskStartPayload,
  right: CodexMachineTaskStartPayload
) {
  return canonicalJson(left) === canonicalJson(right);
}

function workerSelection(request: CodexMachineTaskStartRequest): CodexMachineTaskWorkerSelection {
  const worker = normalizeCodexMachineTaskWorker(request);
  if (!worker) throw new CodexMachineTasksInputError();
  return worker;
}

function normalizedStartRequest(request: CodexMachineTaskStartRequest) {
  const worker = workerSelection(request);
  return {
    ...request,
    model: worker.model,
    reasoningEffort: worker.reasoningEffort
  };
}

/** The f0d7b422 request shape, before worker selection became part of start. */
function legacyStartRequest(request: CodexMachineTaskStartRequest) {
  const { model: _model, reasoningEffort: _reasoningEffort, ...legacy } = request;
  return legacy;
}
