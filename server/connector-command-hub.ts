import { timingSafeEqual } from 'node:crypto';
import type { Duplex } from 'node:stream';
import type { IncomingMessage } from 'node:http';

import { WebSocket, WebSocketServer } from 'ws';

import { registerConnectorProjectRegistry } from './connector-hub';
import {
  isConnectorHubMessage,
  parseConnectorMessage,
  type ConnectorHubMessage,
  type ConnectorMachineMessage
} from './connector-command-protocol';
import type {
  CodexChatRequest,
  CodexChatStreamEvent,
  CodexModelCatalogueRequest,
  CodexModelCatalogueResult
} from '../src/shared/project-space-api';

interface PendingCommand {
  kind: 'chat' | 'models';
  machineId: string;
  onChatEvent?: (event: CodexChatStreamEvent) => void;
  reject(error: Error): void;
  resolve(value?: CodexModelCatalogueResult): void;
  timeout: ReturnType<typeof setTimeout>;
}

const connectorSocketPath = '/api/connectors/socket';
const commandTimeoutMs = 10 * 60_000;
const sockets = new Map<string, WebSocket>();
const pendingCommands = new Map<string, PendingCommand>();

function sendJson(socket: WebSocket, payload: ConnectorMachineMessage) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function isValidRegistrationToken(actual: string) {
  const expected = process.env.PROJECT_CONNECTOR_REGISTRATION_TOKEN ?? '';
  if (!expected || !actual) {
    return false;
  }

  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function commandId() {
  return globalThis.crypto?.randomUUID?.() ?? `connector-${Date.now()}-${Math.random()}`;
}

function unavailableError(machineId: string) {
  return new Error(
    `${machineId} is registered, but its live command channel is not connected yet. Restart or update the Project Space connector on that machine.`
  );
}

function socketForMachine(machineId: string) {
  const socket = sockets.get(machineId);
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    throw unavailableError(machineId);
  }
  return socket;
}

function finishPending(id: string, value?: CodexModelCatalogueResult) {
  const pending = pendingCommands.get(id);
  if (!pending) {
    return;
  }
  pendingCommands.delete(id);
  clearTimeout(pending.timeout);
  pending.resolve(value);
}

function failPending(id: string, error: Error) {
  const pending = pendingCommands.get(id);
  if (!pending) {
    return;
  }
  pendingCommands.delete(id);
  clearTimeout(pending.timeout);
  if (pending.kind === 'chat') {
    const socket = sockets.get(pending.machineId);
    if (socket?.readyState === WebSocket.OPEN) {
      sendJson(socket, { id, type: 'connector.command.cancel' });
    }
  }
  pending.reject(error);
}

function createPendingCommand(
  id: string,
  machineId: string,
  kind: PendingCommand['kind'],
  onChatEvent?: (event: CodexChatStreamEvent) => void
) {
  return new Promise<CodexModelCatalogueResult | undefined>((resolve, reject) => {
    const timeout = setTimeout(() => {
      failPending(id, new Error(`The connector command on ${machineId} timed out.`));
    }, commandTimeoutMs);

    pendingCommands.set(id, {
      kind,
      machineId,
      onChatEvent,
      reject,
      resolve,
      timeout
    });
  });
}

function refreshCommandTimeout(id: string) {
  const pending = pendingCommands.get(id);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timeout);
  pending.timeout = setTimeout(() => {
    failPending(id, new Error(`The connector command on ${pending.machineId} timed out.`));
  }, commandTimeoutMs);
}

function failCommandsForMachine(machineId: string) {
  for (const [id, pending] of pendingCommands.entries()) {
    if (pending.machineId === machineId) {
      failPending(id, unavailableError(machineId));
    }
  }
}

function handleConnectorResult(machineId: string, message: ConnectorHubMessage) {
  if ('id' in message) {
    const pending = pendingCommands.get(message.id);
    if (pending && pending.machineId !== machineId) {
      return;
    }
  }

  if (message.type === 'codex.models.result') {
    finishPending(message.id, message.payload);
    return;
  }

  if (message.type === 'codex.chat.complete') {
    finishPending(message.id);
    return;
  }

  if (message.type === 'codex.chat.event') {
    const pending = pendingCommands.get(message.id);
    refreshCommandTimeout(message.id);
    pending?.onChatEvent?.(message.payload);
    if (message.payload.type === 'done' || message.payload.type === 'error') {
      finishPending(message.id);
    }
  }
}

export function isConnectorCommandChannelAvailable(machineId: string) {
  return sockets.get(machineId)?.readyState === WebSocket.OPEN;
}

export async function requestConnectorModels(
  request: CodexModelCatalogueRequest
): Promise<CodexModelCatalogueResult> {
  const socket = socketForMachine(request.machineId);
  const id = commandId();
  const result = createPendingCommand(id, request.machineId, 'models');
  sendJson(socket, { id, payload: request, type: 'codex.models' });
  return (await result) ?? {
    message: 'The connector returned no model catalogue.',
    models: [],
    status: 'error'
  };
}

export async function streamConnectorCodexChat(
  request: CodexChatRequest,
  emit: (event: CodexChatStreamEvent) => void
) {
  const socket = socketForMachine(request.machineId);
  const id = commandId();
  const result = createPendingCommand(id, request.machineId, 'chat', emit);
  sendJson(socket, { id, payload: request, type: 'codex.chat' });
  await result;
}

export function createConnectorCommandUpgradeHandler() {
  const webSocketServer = new WebSocketServer({
    maxPayload: 512 * 1024,
    noServer: true
  });

  webSocketServer.on('connection', (socket) => {
    let machineId = '';
    const registrationTimeout = setTimeout(() => {
      if (!machineId) {
        socket.close(1008, 'Connector registration timed out.');
      }
    }, 10_000);

    socket.on('message', (data) => {
      const message = parseConnectorMessage(data);
      if (!isConnectorHubMessage(message)) {
        return;
      }

      if (message.type === 'connector.register') {
        if (!isValidRegistrationToken(message.token)) {
          socket.close(1008, 'Connector registration failed.');
          return;
        }

        registerConnectorProjectRegistry(message.payload);
        machineId = message.payload.connector.machineId;
        const previous = sockets.get(machineId);
        if (previous && previous !== socket) {
          failCommandsForMachine(machineId);
        }
        sockets.set(machineId, socket);
        if (previous && previous !== socket) {
          previous.close(1012, 'Connector replaced.');
        }
        clearTimeout(registrationTimeout);
        sendJson(socket, { type: 'connector.registered' });
        return;
      }

      if (!machineId) {
        socket.close(1008, 'Connector must register first.');
        return;
      }

      if (message.type === 'connector.registry') {
        if (message.payload.connector.machineId !== machineId) {
          socket.close(1008, 'Connector machine changed.');
          return;
        }
        registerConnectorProjectRegistry(message.payload);
        return;
      }

      handleConnectorResult(machineId, message);
    });

    socket.on('close', () => {
      clearTimeout(registrationTimeout);
      if (machineId && sockets.get(machineId) === socket) {
        sockets.delete(machineId);
        failCommandsForMachine(machineId);
      }
    });
  });

  return {
    async close() {
      const clientClosures = [...webSocketServer.clients].map(
        (socket) =>
          new Promise<void>((resolveClient) => {
            if (socket.readyState === WebSocket.CLOSED) {
              resolveClient();
              return;
            }
            socket.once('close', () => resolveClient());
            socket.terminate();
          })
      );
      await Promise.all(clientClosures);
      await new Promise<void>((resolveClose) => {
        webSocketServer.close(() => resolveClose());
      });
    },
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== connectorSocketPath) {
        return false;
      }

      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit('connection', webSocket, request);
      });
      return true;
    }
  };
}
