import type { ConnectorCodexMachineMessage } from './connector-command-codex-protocol';
import { CodexSessionsConnectorDispatcher } from './codex-sessions/connector-dispatch';
import { CodexSessionManager } from './codex-sessions/manager';
import { createCodexOperationSnapshotPersistence } from './codex-sessions/operation-snapshot-store';
import { sendConnectorJson } from './project-connector-websocket-utils';

const codexAttachMaximumBufferedBytes = 8 * 1024 * 1024;

export function createProjectConnectorCodexSessionManager(
  environment: NodeJS.ProcessEnv,
  machineId?: string
) {
  const operationPersistence = createCodexOperationSnapshotPersistence(environment, machineId);
  return new CodexSessionManager({
    operationSnapshot: operationPersistence.snapshot,
    persistOperationSnapshot: operationPersistence.persist
  });
}

export function sendProjectConnectorCodexResult(
  socket: WebSocket,
  result: unknown,
  isCurrentConnection: () => boolean = () => true
) {
  if (!isCurrentConnection()) return;
  if (socket.bufferedAmount > codexAttachMaximumBufferedBytes) {
    socket.close(1009, 'Codex connector output exceeded its buffer.');
    return;
  }
  sendConnectorJson(socket, result);
}

export function handleProjectConnectorCodexMessage(options: {
  dispatcher?: CodexSessionsConnectorDispatcher;
  isCurrentConnection(): boolean;
  message: ConnectorCodexMachineMessage;
  socket: WebSocket;
}) {
  const { dispatcher, isCurrentConnection, message, socket } = options;
  if (!dispatcher) {
    const reason = message.type === 'codex.attach.input'
      ? 'Codex attach verification is not configured.'
      : 'Codex session verification is not configured.';
    socket.close(1008, reason);
    return;
  }
  if (message.type === 'codex.attach.input') {
    dispatcher.acceptAttachInput(message.id, message.payload);
    return;
  }
  dispatcher.dispatch(
    message.id,
    message.payload,
    (result) => sendProjectConnectorCodexResult(socket, result, isCurrentConnection),
    () => socket.close(1008, 'Codex session authorization failed.')
  );
}
