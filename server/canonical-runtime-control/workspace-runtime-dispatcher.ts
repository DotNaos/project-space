import type { CanonicalRuntimeControlDispatcher } from './contracts';
import type { WorkspaceRuntimeSessionService } from '../workspace-runtime-session/service';
import type {
  WorkspaceRuntimeControlCommand,
  WorkspaceRuntimeControlMessage
} from '../../src/shared/workspace-runtime-control-api';

export function createWorkspaceRuntimeControlDispatcher(
  sessions: WorkspaceRuntimeSessionService,
  options: { timeoutMs?: number } = {}
): CanonicalRuntimeControlDispatcher & { close(): void } {
  const pending = new Map<string, {
    reject(error: Error): void;
    resolve(value: { output?: Record<string, boolean | null | number | string>; state: 'completed' | 'failed' }): void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  const sequences = new Map<string, number>();
  const removeListener = sessions.onControlMessage(handleMessage);

  function handleMessage(message: WorkspaceRuntimeControlMessage) {
    if (message.type === 'runtime.control.command-accepted') return;
    const current = pending.get(message.commandId);
    if (!current) return;
    pending.delete(message.commandId);
    clearTimeout(current.timeout);
    if (message.type === 'runtime.control.error') {
      current.reject(new Error(message.message));
      return;
    }
    current.resolve({
      ...(message.output ? { output: message.output } : {}),
      state: message.state
    });
  }

  return {
    close() {
      removeListener();
      for (const current of pending.values()) {
        clearTimeout(current.timeout);
        current.reject(new Error('Workspace Runtime control dispatcher closed.'));
      }
      pending.clear();
    },
    dispatch({ actor, request, target }) {
      if (pending.has(request.operationId)) {
        return Promise.reject(new Error('Workspace Runtime control operation is already pending.'));
      }
      const sequenceKey = `${actor.ownerUserId}\0${target.workspaceId}\0${target.generation}`;
      const commandSequence = (sequences.get(sequenceKey) ?? 0) + 1;
      sequences.set(sequenceKey, commandSequence);
      const command: WorkspaceRuntimeControlCommand = {
        actorId: actor.actorId,
        actorKind: actor.actorKind,
        actorUserId: actor.ownerUserId,
        commandId: request.operationId,
        commandSequence,
        environmentId: target.environmentId,
        generation: target.generation,
        operation: request.operation,
        operationId: request.operationId,
        ...(request.payload ? { payload: request.payload } : {}),
        schemaVersion: 1,
        sessionId: target.sessionId,
        type: 'runtime.control.command',
        workspaceId: target.workspaceId
      };
      const result = new Promise<{ output?: Record<string, boolean | null | number | string>; state: 'completed' | 'failed' }>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(command.commandId);
          reject(new Error('Workspace Runtime control result timed out.'));
        }, options.timeoutMs ?? 15_000);
        pending.set(command.commandId, { reject, resolve, timeout });
      });
      try {
        sessions.dispatchControl(actor.ownerUserId, command);
      } catch (error) {
        const current = pending.get(command.commandId);
        if (current) clearTimeout(current.timeout);
        pending.delete(command.commandId);
        return Promise.reject(error);
      }
      return result;
    }
  };
}
