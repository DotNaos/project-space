import { createHash } from 'node:crypto';

import type {
  CodexMachineTaskAttachRequest,
  CodexMachineTaskAttachResult,
  CodexMachineTaskIdentity,
  CodexMachineTaskReadRequest,
  CodexMachineTaskReadResult,
  CodexMachineTaskSendRequest,
  CodexMachineTaskSendResult,
  CodexMachineTaskStartRequest,
  CodexMachineTaskStartResult,
  CodexMachineTaskTarget
} from '../../src/shared/codex-machine-tasks-api';
import { CODEX_MACHINE_TASKS_API_VERSION } from '../../src/shared/codex-machine-tasks-api';
import type {
  CodexSessionOperationResult,
  CodexSessionReadResult,
  CodexSessionStreamEvent
} from '../../src/shared/codex-sessions-api';
import type { MachineRecord, PhysicalMachineRecord } from '../../src/shared/project-space-api';
import { canonicalJson } from '../codex-sessions/canonical-json';
import {
  CodexMachineTaskTargetError,
  resolveCodexMachineTaskTarget
} from './target-resolver';
import { CodexMachineTaskIssueError } from './issue-provider';
import {
  blocked,
  readBlocked,
  sendResult,
  sessionSendResult,
  targetAtGeneration,
  uncertain
} from './results';

export interface CodexMachineTaskStartOperation {
  associationKey: string;
  connectorId: string;
  fingerprint: string;
  generation: number;
  operationId: string;
  physicalMachineId: string;
  result?: CodexMachineTaskStartResult;
  state: 'completed' | 'pending' | 'uncertain';
  userId: string;
}

export type CodexMachineTaskStartReservation =
  | { kind: 'new' }
  | { kind: 'conflict' }
  | { generation: number; kind: 'pending'; sameOperation: boolean }
  | { generation: number; kind: 'uncertain'; sameOperation: boolean }
  | { kind: 'replayed'; result: CodexMachineTaskStartResult };

export interface CodexMachineTaskSendOperation {
  connectorId: string;
  fingerprint: string;
  generation: number;
  operationId: string;
  threadId: string;
  userId: string;
}

export type CodexMachineTaskSendReservation =
  | { kind: 'new' }
  | { kind: 'conflict' }
  | { kind: 'fenced' }
  | { generation: number; kind: 'pending' }
  | { generation: number; kind: 'uncertain' }
  | { kind: 'replayed'; result: CodexMachineTaskSendResult };

export interface CodexMachineTasksStore {
  completeSend(
    operation: CodexMachineTaskSendOperation,
    result: CodexMachineTaskSendResult
  ): Promise<void>;
  completeStart(
    operation: CodexMachineTaskStartOperation,
    result: CodexMachineTaskStartResult
  ): Promise<void>;
  markStartUncertain(operation: CodexMachineTaskStartOperation): Promise<void>;
  markSendUncertain(operation: CodexMachineTaskSendOperation): Promise<void>;
  releaseSend(operation: CodexMachineTaskSendOperation): Promise<void>;
  releaseStart(operation: CodexMachineTaskStartOperation): Promise<void>;
  reserveStart(operation: CodexMachineTaskStartOperation): Promise<CodexMachineTaskStartReservation>;
  reserveSend(operation: CodexMachineTaskSendOperation): Promise<CodexMachineTaskSendReservation>;
}

export class CodexMachineTasksConflictError extends Error {
  constructor() {
    super('The operation ID was already used for different input.');
    this.name = 'CodexMachineTasksConflictError';
  }
}

export const codexAttachToken = Symbol('codexAttachToken');

export interface CodexMachineTasksServiceOptions {
  attachments?: {
    issue(input: {
      callerMachineId: string;
      connectorId: string;
      generation: number;
      operationId: string;
      threadId: string;
      userId: string;
    }): { endpointPath: string; expiresAt: string; token: string };
  };
  generationFor(connectorId: string): number | undefined;
  inventory(userId: string): Promise<{
    connectors: MachineRecord[];
    physicalMachines: PhysicalMachineRecord[];
  }>;
  issue(input: {
    issue: number;
    repositoryId?: string;
    userId: string;
  }): Promise<{
    branch: string;
    commit: string;
    issue: { number: number; url: string };
    repository: { id: string; nameWithOwner: string };
  }>;
  sessions: {
    read(input: {
      connectorId: string;
      generation: number;
      threadId: string;
      userId: string;
    }): Promise<CodexSessionReadResult>;
    reconcileSend?(input: {
      connectorId: string;
      generation: number;
      message: string;
      operationId: string;
      threadId: string;
      userId: string;
    }): Promise<{
      generation: number;
      result: CodexSessionOperationResult;
    }>;
    send(input: {
      connectorId: string;
      generation: number;
      message: string;
      operationId: string;
      threadId: string;
      userId: string;
    }): Promise<CodexSessionOperationResult>;
    wait(input: {
      afterSequence?: number;
      connectorId: string;
      generation: number;
      start(): Promise<CodexSessionOperationResult>;
      threadId: string;
      userId: string;
    }): Promise<{
      event?: CodexSessionStreamEvent;
      result: CodexSessionOperationResult;
      sequence?: number;
    }>;
    stream?(input: {
      afterSequence?: number;
      connectorId: string;
      generation: number;
      emit(event: CodexSessionStreamEvent, sequence?: number): void;
      onReady?(): void;
      signal: AbortSignal;
      threadId: string;
      userId: string;
    }): Promise<void>;
  };
  start(input: {
    branch: string;
    commit: string;
    connectorId: string;
    generation: number;
    issue: { number: number; url: string };
    operationId: string;
    physicalMachineId: string;
    reconcile: boolean;
    repository: { id: string; nameWithOwner: string };
    userId: string;
  }): Promise<{
    generation: number;
    result:
      | { state: 'confirmed'; threadId: string; worktreeId: string }
      | { state: 'offline' }
      | { message: string; state: 'worktree_failure' }
      | { state: 'uncertain' };
  }>;
  store: CodexMachineTasksStore;
  taskUrl(connectorId: string, threadId: string): string;
  userCanUseConnector?(userId: string, connectorId: string): boolean;
}

export function createCodexMachineTasksService(options: CodexMachineTasksServiceOptions) {
  async function target(
    userId: string,
    selector: Pick<
      CodexMachineTaskReadRequest,
      'connectorId' | 'physicalMachineId' | 'physicalMachineName'
    >,
    callerMachineId?: string
  ) {
    const inventory = await options.inventory(userId);
    const callerPhysicalMachine = !selector.physicalMachineId && !selector.physicalMachineName &&
      callerMachineId
      ? inventory.physicalMachines.find((machine) => machine.connectorIds.includes(callerMachineId))
      : undefined;
    return resolveCodexMachineTaskTarget({
      ...selector,
      connectorId: selector.connectorId ?? (callerPhysicalMachine ? callerMachineId : undefined),
      physicalMachineId: selector.physicalMachineId ?? callerPhysicalMachine?.id,
      ...inventory,
      generationFor: options.generationFor,
      userCanUseConnector: options.userCanUseConnector
        ? (connectorId) => options.userCanUseConnector!(userId, connectorId)
        : undefined
    });
  }

  function reconcileSend(
    generation: number,
    selected: CodexMachineTaskTarget,
    userId: string,
    request: CodexMachineTaskSendRequest
  ) {
    return options.sessions.reconcileSend?.({
      connectorId: selected.connector.id,
      generation,
      message: request.message,
      operationId: request.operationId,
      threadId: request.threadId,
      userId
    });
  }

  return {
    async start(
      actor: { callerMachineId?: string; userId: string },
      request: CodexMachineTaskStartRequest
    ): Promise<CodexMachineTaskStartResult> {
      let selected: CodexMachineTaskTarget;
      try {
        selected = await target(actor.userId, request, actor.callerMachineId);
      } catch (error) {
        if (!(error instanceof CodexMachineTaskTargetError)) throw error;
        return blocked(request.operationId, error.reason, error.message);
      }
      if (request.dryRun) {
        return {
          apiVersion: CODEX_MACHINE_TASKS_API_VERSION,
          operationId: request.operationId,
          state: 'ready',
          target: selected
        };
      }
      let issue: Awaited<ReturnType<CodexMachineTasksServiceOptions['issue']>>;
      try {
        issue = await options.issue({
          issue: request.issue,
          repositoryId: request.repositoryId,
          userId: actor.userId
        });
      } catch (error) {
        if (!(error instanceof CodexMachineTaskIssueError)) throw error;
        return blocked(request.operationId, error.reason, error.message, selected);
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
        fingerprint: fingerprint({
          issue,
          request,
          target: {
            connectorId: selected.connector.id,
            physicalMachineId: selected.physicalMachine.id
          }
        }),
        generation: selected.connector.generation,
        operationId: request.operationId,
        physicalMachineId: selected.physicalMachine.id,
        state: 'pending',
        userId: actor.userId
      };
      const reservation = await options.store.reserveStart(operation);
      if (reservation.kind === 'conflict') throw new CodexMachineTasksConflictError();
      if (reservation.kind === 'replayed') {
        return { ...reservation.result, operationId: request.operationId };
      }
      if (
        (reservation.kind === 'pending' && !reservation.sameOperation) ||
        (reservation.kind === 'uncertain' && !reservation.sameOperation)
      ) {
        return uncertain(
          request.operationId,
          targetAtGeneration(selected, reservation.generation)
        );
      }
      const executionGeneration = reservation.kind === 'new'
        ? operation.generation
        : reservation.generation;
      operation.generation = executionGeneration;
      const start = await options.start({
        branch: issue.branch,
        commit: issue.commit,
        connectorId: selected.connector.id,
        generation: executionGeneration,
        issue: issue.issue,
        operationId: request.operationId,
        physicalMachineId: selected.physicalMachine.id,
        reconcile: reservation.kind !== 'new',
        repository: issue.repository,
        userId: actor.userId
      });
      const started = start.result;
      const executionTarget = targetAtGeneration(selected, start.generation);
      if (started.state === 'uncertain') {
        await options.store.markStartUncertain(operation);
        return uncertain(request.operationId, executionTarget);
      }
      if (started.state === 'offline') {
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
      const task: CodexMachineTaskIdentity = {
        ...executionTarget,
        canonicalTaskUrl: options.taskUrl(executionTarget.connector.id, started.threadId),
        issue: issue.issue,
        repository: issue.repository,
        threadId: started.threadId,
        worktree: { branch: issue.branch, id: started.worktreeId }
      };
      const result: CodexMachineTaskStartResult = {
        apiVersion: CODEX_MACHINE_TASKS_API_VERSION,
        operationId: request.operationId,
        state: 'confirmed',
        task
      };
      await options.store.completeStart(operation, result);
      return result;
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
      let selected: CodexMachineTaskTarget;
      try {
        selected = await target(actor.userId, request);
      } catch (error) {
        if (!(error instanceof CodexMachineTaskTargetError)) throw error;
        return blocked(request.operationId, error.reason, error.message);
      }
      const operation: CodexMachineTaskSendOperation = {
        connectorId: selected.connector.id,
        fingerprint: fingerprint({
          connectorId: selected.connector.id,
          message: request.message,
          threadId: request.threadId,
          userId: actor.userId
        }),
        generation: selected.connector.generation,
        operationId: request.operationId,
        threadId: request.threadId,
        userId: actor.userId
      };
      const reservation = await options.store.reserveSend(operation);
      if (reservation.kind === 'conflict') throw new CodexMachineTasksConflictError();
      if (reservation.kind === 'replayed') {
        return { ...reservation.result, operationId: request.operationId };
      }
      if (reservation.kind === 'fenced') {
        return blocked(
          request.operationId,
          'thread_active',
          'A prior turn on this thread is still active or requires reconciliation.',
          selected
        );
      }
      const executionGeneration = reservation.kind === 'pending' || reservation.kind === 'uncertain'
        ? reservation.generation
        : operation.generation;
      let resultGeneration = executionGeneration;
      operation.generation = executionGeneration;
      let attempted = false;
      const reconcile = async () => {
        const reconciliation = await reconcileSend(
          executionGeneration,
          targetAtGeneration(selected, executionGeneration),
          actor.userId,
          request
        );
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
        if (reservation.kind === 'uncertain') return reconcile();
        return options.sessions.send({
          connectorId: selected.connector.id,
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
        if (request.wait && reservation.kind !== 'uncertain') {
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
        if (result.status === 'ambiguous' && reservation.kind !== 'uncertain') {
          result = await reconcile();
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
