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
  CodexModelCatalogueResult,
  MachineFileSystemDirectoryRequest,
  MachineFileSystemDirectoryResult,
  MachineFileSystemFileRequest,
  MachineFileSystemFileResult,
  MachineFileSystemRequest,
  MachineFileSystemRootResult,
  MachineDirectoryCreateRequest,
  MachineDirectoryDeleteRequest,
  MachineDirectoryMutationResult,
  MachineDirectoryRenameRequest,
  MachineProjectWorktreesRequest,
  MachineTerminalCommandRequest,
  ProjectWorktreeRecord,
  TerminalCommandResult
} from '../src/shared/project-space-api';

type ConnectorCommandResult =
  | CodexModelCatalogueResult
  | MachineFileSystemDirectoryResult
  | MachineFileSystemFileResult
  | MachineFileSystemRootResult
  | MachineDirectoryMutationResult
  | ProjectWorktreeRecord[]
  | TerminalCommandResult;

interface PendingCommand {
  kind: 'chat' | 'filesystem-directory' | 'filesystem-file' | 'filesystem-root' | 'folder-create' | 'folder-delete' | 'folder-rename' | 'models' | 'terminal' | 'worktrees';
  machineId: string;
  onChatEvent?: (event: CodexChatStreamEvent) => void;
  reject(error: Error): void;
  resolve(value?: ConnectorCommandResult): void;
  timeout: ReturnType<typeof setTimeout>;
}

const connectorSocketPath = '/api/connectors/socket';
const commandTimeoutMs = 10 * 60_000;
const sockets = new Map<string, WebSocket>();
const socketCapabilities = new Map<string, Set<string>>();
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

function socketForMachine(machineId: string, capability?: string) {
  const socket = sockets.get(machineId);
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    throw unavailableError(machineId);
  }
  if (capability && !socketCapabilities.get(machineId)?.has(capability)) {
    throw new Error(
      `The connector on ${machineId} does not support this action yet. Update or restart the Project Space connector on that machine.`
    );
  }
  return socket;
}

function finishPending(id: string, value?: ConnectorCommandResult) {
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
  return new Promise<ConnectorCommandResult | undefined>((resolve, reject) => {
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
    if (pendingCommands.get(message.id)?.kind === 'models') {
      finishPending(message.id, message.payload);
    }
    return;
  }

  if (message.type === 'terminal.result') {
    if (pendingCommands.get(message.id)?.kind === 'terminal') {
      finishPending(message.id, message.payload);
    }
    return;
  }
  if (message.type === 'worktrees.result') {
    if (pendingCommands.get(message.id)?.kind === 'worktrees') {
      finishPending(message.id, message.payload);
    }
    return;
  }
  if (message.type === 'filesystem.root.result') {
    if (pendingCommands.get(message.id)?.kind === 'filesystem-root') {
      finishPending(message.id, message.payload);
    }
    return;
  }
  if (message.type === 'filesystem.directory.result') {
    if (pendingCommands.get(message.id)?.kind === 'filesystem-directory') {
      finishPending(message.id, message.payload);
    }
    return;
  }
  if (message.type === 'filesystem.file.result') {
    if (pendingCommands.get(message.id)?.kind === 'filesystem-file') {
      finishPending(message.id, message.payload);
    }
    return;
  }
  if (message.type === 'filesystem.folder.create.result') {
    if (pendingCommands.get(message.id)?.kind === 'folder-create') {
      finishPending(message.id, message.payload);
    }
    return;
  }
  if (message.type === 'filesystem.folder.rename.result') {
    if (pendingCommands.get(message.id)?.kind === 'folder-rename') {
      finishPending(message.id, message.payload);
    }
    return;
  }
  if (message.type === 'filesystem.folder.delete.result') {
    if (pendingCommands.get(message.id)?.kind === 'folder-delete') {
      finishPending(message.id, message.payload);
    }
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
  return ((await result) as CodexModelCatalogueResult | undefined) ?? {
    message: 'The connector returned no model catalogue.',
    models: [],
    status: 'error'
  };
}

export async function requestConnectorTerminalCommand(
  request: MachineTerminalCommandRequest
): Promise<TerminalCommandResult> {
  const socket = socketForMachine(request.machineId, 'terminal.run');
  const id = commandId();
  const result = createPendingCommand(id, request.machineId, 'terminal');
  sendJson(socket, { id, payload: request, type: 'terminal.run' });
  return (await result) as TerminalCommandResult;
}

export async function requestConnectorProjectWorktrees(
  request: MachineProjectWorktreesRequest
): Promise<ProjectWorktreeRecord[]> {
  const socket = socketForMachine(request.machineId, 'worktrees.list');
  const id = commandId();
  const result = createPendingCommand(id, request.machineId, 'worktrees');
  sendJson(socket, { id, payload: request, type: 'worktrees.list' });
  return (await result) as ProjectWorktreeRecord[];
}

export async function requestConnectorFileSystemRoot(
  request: MachineFileSystemRequest
): Promise<MachineFileSystemRootResult> {
  const socket = socketForMachine(request.machineId, 'filesystem.root');
  const id = commandId();
  const result = createPendingCommand(id, request.machineId, 'filesystem-root');
  sendJson(socket, { id, payload: request, type: 'filesystem.root' });
  return (await result) as MachineFileSystemRootResult;
}

export async function requestConnectorDirectory(
  request: MachineFileSystemDirectoryRequest
): Promise<MachineFileSystemDirectoryResult> {
  const socket = socketForMachine(request.machineId, 'filesystem.directory');
  const id = commandId();
  const result = createPendingCommand(id, request.machineId, 'filesystem-directory');
  sendJson(socket, { id, payload: request, type: 'filesystem.directory' });
  return (await result) as MachineFileSystemDirectoryResult;
}

export async function requestConnectorFile(
  request: MachineFileSystemFileRequest
): Promise<MachineFileSystemFileResult> {
  const socket = socketForMachine(request.machineId, 'filesystem.file');
  const id = commandId();
  const result = createPendingCommand(id, request.machineId, 'filesystem-file');
  sendJson(socket, { id, payload: request, type: 'filesystem.file' });
  return (await result) as MachineFileSystemFileResult;
}

export async function requestConnectorFolderCreate(
  request: MachineDirectoryCreateRequest
): Promise<MachineDirectoryMutationResult> {
  const socket = socketForMachine(request.machineId, 'filesystem.folder.create');
  const id = commandId();
  const result = createPendingCommand(id, request.machineId, 'folder-create');
  sendJson(socket, { id, payload: request, type: 'filesystem.folder.create' });
  return (await result) as MachineDirectoryMutationResult;
}

export async function requestConnectorFolderRename(
  request: MachineDirectoryRenameRequest
): Promise<MachineDirectoryMutationResult> {
  const socket = socketForMachine(request.machineId, 'filesystem.folder.rename');
  const id = commandId();
  const result = createPendingCommand(id, request.machineId, 'folder-rename');
  sendJson(socket, { id, payload: request, type: 'filesystem.folder.rename' });
  return (await result) as MachineDirectoryMutationResult;
}

export async function requestConnectorFolderDelete(
  request: MachineDirectoryDeleteRequest
): Promise<MachineDirectoryMutationResult> {
  const socket = socketForMachine(request.machineId, 'filesystem.folder.delete');
  const id = commandId();
  const result = createPendingCommand(id, request.machineId, 'folder-delete');
  sendJson(socket, { id, payload: request, type: 'filesystem.folder.delete' });
  return (await result) as MachineDirectoryMutationResult;
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
    maxPayload: 2 * 1024 * 1024,
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
        socketCapabilities.set(
          machineId,
          new Set(message.payload.connector.capabilities ?? [])
        );
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
        socketCapabilities.set(
          machineId,
          new Set(message.payload.connector.capabilities ?? [])
        );
        return;
      }

      handleConnectorResult(machineId, message);
    });

    socket.on('close', () => {
      clearTimeout(registrationTimeout);
      if (machineId && sockets.get(machineId) === socket) {
        sockets.delete(machineId);
        socketCapabilities.delete(machineId);
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
