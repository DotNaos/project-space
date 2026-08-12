import type {
  CanonicalRuntimeControlOutput,
  CanonicalRuntimeControlRequest,
  CanonicalRuntimeControlResult
} from '../../src/shared/canonical-runtime-control-api';
import {
  runtimeControlInput,
  type WorkspaceRuntimeControlCommand,
  type WorkspaceRuntimeControlMessage
} from '../../src/shared/workspace-runtime-control-api';
import type { WorkspaceRuntimeSessionService } from '../workspace-runtime-session/service';
import { CanonicalRuntimeControlError, type CanonicalRuntimeControlDispatcher } from './contracts';
import type {
  CanonicalRuntimeControlOperationIdentity,
  CanonicalRuntimeControlOperationRecord,
  CanonicalRuntimeControlOperationStore
} from './operation-store-contracts';

interface PendingControl {
  reject(error: Error): void;
  resolve(value: CanonicalRuntimeControlResult): void;
  timeout: ReturnType<typeof setTimeout>;
}

const reservationLeaseMs = 10_000;
const dispatchLeaseMs = 30_000;

export function createWorkspaceRuntimeControlDispatcher(
  sessions: WorkspaceRuntimeSessionService,
  operations: CanonicalRuntimeControlOperationStore,
  options: { now?: () => Date; timeoutMs?: number } = {}
): CanonicalRuntimeControlDispatcher & { close(): void } {
  const now = options.now ?? (() => new Date());
  const pending = new Map<string, PendingControl>();
  const removeListener = sessions.onControlMessage(handleMessage);
  const removeRegistrationListener = sessions.onControlRegistration(async (registration) => {
    const unresolved = await operations.unresolved(
      registration.ownerUserId,
      registration.workspaceId,
      registration.generation
    );
    for (const record of unresolved) {
      if (!record.command) throw new Error('Canonical Runtime recovery command is missing.');
      const rebound = await operations.rebindSession({
        command: record.command,
        fingerprint: record.fingerprint,
        identity: record.identity,
        sessionId: registration.sessionId
      });
      sessions.dispatchControl(
        registration.ownerUserId,
        createStoredCommand(rebound.identity, record.command.commandSequence)
      );
    }
  });

  async function handleMessage(message: WorkspaceRuntimeControlMessage) {
    const record = await operations.read(message.actorUserId, message.operationId);
    if (!record?.command || !matchesRecord(record, message)) {
      throw new Error('Workspace Runtime control response binding changed.');
    }
    const command = record.command;
    const observedAt = now().toISOString();
    if (message.type === 'runtime.control.command-accepted') {
      await operations.accept({
        acceptedAt: observedAt,
        acceptedCommandSequence: message.acceptedCommandSequence,
        command,
        eventSequence: message.eventSequence,
        fingerprint: record.fingerprint,
        identity: record.identity
      });
      sessions.acknowledgeControl(record.identity.ownerUserId, message);
      return;
    }

    let result: CanonicalRuntimeControlResult;
    if (message.type === 'runtime.control.result') {
      result = publicResult(
        record.identity,
        message.state,
        message.state === 'completed' ? message.output : undefined
      );
      const terminal = {
        command,
        completedAt: observedAt,
        ...(message.state === 'failed' ? { failureCode: 'runtime_failed' as const } : {}),
        fingerprint: record.fingerprint,
        identity: record.identity,
        result,
        resultEventSequence: message.eventSequence
      };
      if (record.state === 'uncertain') await operations.reconcile(terminal);
      else await operations.complete(terminal);
    } else if (message.code === 'uncertain') {
      await operations.markUncertain({
        command,
        completedAt: observedAt,
        fingerprint: record.fingerprint,
        identity: record.identity,
        resultEventSequence: message.eventSequence
      });
      result = publicResult(record.identity, 'uncertain');
    } else {
      result = publicResult(record.identity, 'failed');
      const terminal = {
        command,
        completedAt: observedAt,
        failureCode: message.code === 'runtime_stopping'
          ? 'runtime_stopping' as const
          : message.code === 'unavailable'
            ? 'unavailable' as const
            : 'invalid_request' as const,
        fingerprint: record.fingerprint,
        identity: record.identity,
        result,
        resultEventSequence: message.eventSequence
      };
      if (record.state === 'uncertain') await operations.reconcile(terminal);
      else await operations.complete(terminal);
    }
    sessions.acknowledgeControl(record.identity.ownerUserId, message);
    settle(record.identity.ownerUserId, record.identity.operationId, result);
  }

  return {
    close() {
      removeListener();
      removeRegistrationListener();
      for (const current of pending.values()) {
        clearTimeout(current.timeout);
        current.reject(new Error('Workspace Runtime control dispatcher closed.'));
      }
      pending.clear();
    },
    async replay({ actor, fingerprint, request }) {
      const record = await operations.read(actor.ownerUserId, request.operationId);
      if (!record) return undefined;
      if (record.fingerprint !== fingerprint || record.identity.actorId !== actor.actorId ||
          record.identity.actorKind !== actor.actorKind ||
          record.identity.actorUserId !== actor.ownerUserId ||
          record.identity.operation !== request.operation ||
          record.identity.diffStaged !== (request.operation === 'git.diff' ? request.staged : undefined)) {
        return 'conflict';
      }
      return record.result ? { ...record.result, replayed: true } : 'in_progress';
    },
    async dispatch({ actor, fingerprint, freshTarget, request, target }) {
      const identity: CanonicalRuntimeControlOperationIdentity = {
        actorId: actor.actorId,
        actorKind: actor.actorKind,
        actorUserId: actor.ownerUserId,
        compatibilityAlias: false,
        ...(request.operation === 'git.diff' ? { diffStaged: request.staged } : {}),
        environmentId: target.environmentId,
        generation: target.generation,
        operation: request.operation,
        operationId: request.operationId,
        ownerUserId: actor.ownerUserId,
        sessionId: target.sessionId,
        targetIdentityRevision: target.targetIdentityRevision,
        workspaceId: target.workspaceId
      };
      const reservedAt = now();
      const reservation = await operations.reserve({
        fingerprint,
        identity,
        reservedAt: reservedAt.toISOString(),
        reservedUntil: new Date(reservedAt.getTime() + reservationLeaseMs).toISOString()
      });
      if (reservation.kind === 'conflict') conflict();
      if (reservation.kind === 'in_progress') inProgress();
      if (reservation.kind === 'replayed') {
        if (reservation.record.result) return { ...reservation.record.result, replayed: true };
        inProgress();
      }

      const dispatchedAt = now();
      const marked = await operations.markDispatchAttempted({
        commandId: request.operationId,
        dispatchedAt: dispatchedAt.toISOString(),
        dispatchedUntil: new Date(dispatchedAt.getTime() + dispatchLeaseMs).toISOString(),
        fingerprint,
        identity
      });
      if (!marked.command) throw new Error('Canonical Runtime command reservation is incomplete.');
      const command = createCommand(identity, request, marked.command.commandSequence);
      const pendingKey = key(identity.ownerUserId, identity.operationId);
      if (pending.has(pendingKey)) inProgress();
      const response = new Promise<CanonicalRuntimeControlResult>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(pendingKey);
          void operations.markUncertain({
            command: marked.command!,
            completedAt: now().toISOString(),
            fingerprint,
            identity
          }).then(() => resolve(publicResult(identity, 'uncertain')), reject);
        }, options.timeoutMs ?? 15_000);
        pending.set(pendingKey, { reject, resolve, timeout });
      });
      try {
        const verified = await freshTarget();
        if (JSON.stringify(verified) !== JSON.stringify(target)) {
          throw new Error('Canonical Runtime target changed before send.');
        }
        sessions.dispatchControl(identity.ownerUserId, command);
      } catch {
        const current = pending.get(pendingKey);
        if (current) clearTimeout(current.timeout);
        pending.delete(pendingKey);
        await operations.markUncertain({
          command: marked.command,
          completedAt: now().toISOString(),
          fingerprint,
          identity
        });
        return publicResult(identity, 'uncertain');
      }
      return response;
    }
  };

  function settle(ownerUserId: string, operationId: string, result: CanonicalRuntimeControlResult) {
    const current = pending.get(key(ownerUserId, operationId));
    if (!current) return;
    clearTimeout(current.timeout);
    pending.delete(key(ownerUserId, operationId));
    current.resolve(result);
  }
}

function createCommand(
  identity: CanonicalRuntimeControlOperationIdentity,
  request: CanonicalRuntimeControlRequest,
  commandSequence: number
): WorkspaceRuntimeControlCommand {
  return {
    actorId: identity.actorId,
    actorKind: identity.actorKind,
    actorUserId: identity.actorUserId,
    commandId: identity.operationId,
    commandSequence,
    environmentId: identity.environmentId,
    generation: identity.generation,
    operationId: identity.operationId,
    ...runtimeControlInput(request),
    schemaVersion: 1,
    sessionId: identity.sessionId,
    targetIdentityRevision: identity.targetIdentityRevision,
    type: 'runtime.control.command',
    workspaceId: identity.workspaceId
  };
}

function createStoredCommand(
  identity: CanonicalRuntimeControlOperationIdentity,
  commandSequence: number
): WorkspaceRuntimeControlCommand {
  const input = identity.operation === 'git.diff'
    ? { operation: identity.operation, staged: identity.diffStaged! }
    : { operation: identity.operation };
  return {
    actorId: identity.actorId,
    actorKind: identity.actorKind,
    actorUserId: identity.actorUserId,
    commandId: identity.operationId,
    commandSequence,
    environmentId: identity.environmentId,
    generation: identity.generation,
    operationId: identity.operationId,
    ...input,
    schemaVersion: 1,
    sessionId: identity.sessionId,
    targetIdentityRevision: identity.targetIdentityRevision,
    type: 'runtime.control.command',
    workspaceId: identity.workspaceId
  } as WorkspaceRuntimeControlCommand;
}

function publicResult(
  identity: CanonicalRuntimeControlOperationIdentity,
  state: 'completed' | 'failed' | 'uncertain',
  output?: CanonicalRuntimeControlOutput
): CanonicalRuntimeControlResult {
  const binding = {
    apiVersion: 1 as const,
    compatibilityAlias: false,
    environmentId: identity.environmentId,
    generation: identity.generation,
    operation: identity.operation,
    operationId: identity.operationId,
    replayed: false,
    targetIdentityRevision: identity.targetIdentityRevision,
    workspaceId: identity.workspaceId
  };
  return (state === 'completed'
    ? { ...binding, output, state }
    : { ...binding, state }) as CanonicalRuntimeControlResult;
}

function matchesRecord(
  record: CanonicalRuntimeControlOperationRecord,
  message: WorkspaceRuntimeControlMessage
) {
  const identity = record.identity;
  return message.actorId === identity.actorId && message.actorKind === identity.actorKind &&
    message.actorUserId === identity.actorUserId && message.commandId === record.command?.commandId &&
    message.commandSequence === record.command.commandSequence &&
    message.environmentId === identity.environmentId && message.generation === identity.generation &&
    message.operation === identity.operation && message.operationId === identity.operationId &&
    message.sessionId === identity.sessionId &&
    message.targetIdentityRevision === identity.targetIdentityRevision &&
    message.workspaceId === identity.workspaceId &&
    (identity.operation !== 'git.diff' || message.type !== 'runtime.control.result' ||
      message.state !== 'completed' || message.operation !== 'git.diff' ||
      message.output.staged === identity.diffStaged);
}

function key(ownerUserId: string, operationId: string) {
  return `${ownerUserId}\0${operationId}`;
}

function conflict(): never {
  throw new CanonicalRuntimeControlError(
    'operation_conflict', 'The operation ID belongs to different canonical input.'
  );
}

function inProgress(): never {
  throw new CanonicalRuntimeControlError(
    'operation_in_progress', 'The canonical operation is already in progress or needs reconciliation.'
  );
}
