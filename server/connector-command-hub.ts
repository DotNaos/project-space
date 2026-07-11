import { timingSafeEqual } from 'node:crypto';
import type { Duplex } from 'node:stream';
import type { IncomingMessage } from 'node:http';

import { WebSocket, WebSocketServer } from 'ws';

import { registerConnectorProjectRegistry } from './connector-hub';
import {
  type ConnectorDevServerActor,
  type ConnectorDevServerOperation,
  type ConnectorDevServerResult,
  type ConnectorDevServerTrustedRequest
} from './connector-dev-server-contract';
import {
  connectorDevServerSigningKey,
  createConnectorDevServerWireRequest,
  executeLocalConnectorDevServerCommand,
  registerLocalConnectorDevServerExecutor,
  type ConnectorDevServerRequestOptions
} from './connector-dev-server-routing';
import {
  isConnectorHubMessage,
  parseConnectorMessage,
  type ConnectorHubMessage,
  type ConnectorMachineMessage
} from './connector-command-protocol';
import {
  connectorHasCapability,
  connectorSocket,
  disconnectConnectorSession,
  registerConnectorSession,
  removeConnectorSession,
  sendConnectorJson,
  updateConnectorCapabilities
} from './connector-command-session-registry';
export {
  isConnectorCommandChannelAuthenticated,
  isConnectorCommandChannelAvailable
} from './connector-command-session-registry';
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
  | ConnectorDevServerResult
  | TerminalCommandResult;

interface PendingCommand {
  devServerTarget?: {
    generation: number;
    projectId: string;
    runTarget: string;
    worktreeId: string;
  };
  kind:
    | 'chat'
    | 'dev-server-inspect'
    | 'dev-server-start'
    | 'dev-server-stop'
    | 'filesystem-directory'
    | 'filesystem-file'
    | 'filesystem-root'
    | 'folder-create'
    | 'folder-delete'
    | 'folder-rename'
    | 'models'
    | 'terminal'
    | 'worktrees';
  machineId: string;
  onChatEvent?: (event: CodexChatStreamEvent) => void;
  reject(error: Error): void;
  resolve(value?: ConnectorCommandResult): void;
  timeout: ReturnType<typeof setTimeout>;
}

const connectorSocketPath = '/api/connectors/socket';
const commandTimeoutMs = 10 * 60_000;
const defaultCredentialRevalidationIntervalMs = 30_000;
const pendingCommands = new Map<string, PendingCommand>();

export { registerLocalConnectorDevServerExecutor };
export type { ConnectorDevServerRequestOptions };

export type AuthenticateConnectorCredential = (
  token: string,
  machineId: string
) => Promise<boolean>;

interface ConnectorCommandUpgradeHandlerOptions {
  authenticateConnectorCredential?: AuthenticateConnectorCredential;
  credentialRevalidationIntervalMs?: number;
}

export async function authenticateConnectorCredential(
  actual: string,
  _machineId: string
) {
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
  const socket = connectorSocket(machineId);
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    throw unavailableError(machineId);
  }
  if (capability && !connectorHasCapability(machineId, capability)) {
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
    const socket = connectorSocket(pending.machineId);
    if (socket?.readyState === WebSocket.OPEN) {
      sendConnectorJson(socket, { id, type: 'connector.command.cancel' });
    }
  }
  pending.reject(error);
}

function createPendingCommand(
  id: string,
  machineId: string,
  kind: PendingCommand['kind'],
  onChatEvent?: (event: CodexChatStreamEvent) => void,
  options: {
    devServerTarget?: PendingCommand['devServerTarget'];
    timeoutMs?: number;
  } = {}
) {
  return new Promise<ConnectorCommandResult | undefined>((resolve, reject) => {
    const timeout = setTimeout(() => {
      failPending(id, new Error(`The connector command on ${machineId} timed out.`));
    }, options.timeoutMs ?? commandTimeoutMs);

    pendingCommands.set(id, {
      devServerTarget: options.devServerTarget,
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

  if (
    message.type === 'dev-server.inspect.result' ||
    message.type === 'dev-server.start.result' ||
    message.type === 'dev-server.stop.result'
  ) {
    const pending = pendingCommands.get(message.id);
    const expectedKind = message.type.replace('.result', '').replace('.', '-') as
      | 'dev-server-inspect'
      | 'dev-server-start'
      | 'dev-server-stop';
    const target = pending?.devServerTarget;
    if (!pending || pending.kind !== expectedKind || !target) {
      return;
    }
    if (
      message.payload.machineId !== pending.machineId ||
      message.payload.projectId !== target.projectId ||
      message.payload.worktreeId !== target.worktreeId ||
      message.payload.runTarget !== target.runTarget ||
      message.payload.generation !== target.generation
    ) {
      failPending(message.id, new Error('The connector returned dev-server state for a different target.'));
      return;
    }
    finishPending(message.id, message.payload);
    return;
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

export function disconnectConnectorCommandChannel(machineId: string) {
  const socket = disconnectConnectorSession(machineId);
  if (!socket) {
    return false;
  }
  failCommandsForMachine(machineId);
  return true;
}

function devServerCapability(operation: ConnectorDevServerOperation) {
  return `dev-server.${operation}`;
}

function devServerPendingKind(operation: ConnectorDevServerOperation): PendingCommand['kind'] {
  return `dev-server-${operation}`;
}

function devServerMessageType(operation: ConnectorDevServerOperation) {
  return `dev-server.${operation}` as const;
}

async function requestConnectorDevServerCommand(
  operation: ConnectorDevServerOperation,
  request: ConnectorDevServerTrustedRequest,
  actor: ConnectorDevServerActor,
  options: ConnectorDevServerRequestOptions = {}
) {
  const openSocket = connectorSocket(request.machineId);
  if (openSocket?.readyState === WebSocket.OPEN) {
    const socket = socketForMachine(request.machineId, devServerCapability(operation));
    const wireRequest = createConnectorDevServerWireRequest(
      operation,
      request,
      actor,
      connectorDevServerSigningKey(options),
      options
    );
    const id = commandId();
    const result = createPendingCommand(id, request.machineId, devServerPendingKind(operation), undefined, {
      devServerTarget: {
        generation: actor.generation,
        projectId: request.projectId,
        runTarget: request.runTarget,
        worktreeId: request.worktreeId
      },
      timeoutMs: options.timeoutMs
    });
    const message: ConnectorMachineMessage = {
      id,
      payload: wireRequest,
      type: devServerMessageType(operation)
    } as ConnectorMachineMessage;
    sendConnectorJson(socket, message);
    return (await result) as ConnectorDevServerResult;
  }

  const localExecution = executeLocalConnectorDevServerCommand(
    operation,
    request,
    actor,
    options,
    commandTimeoutMs
  );
  if (localExecution) {
    return localExecution;
  }
  throw unavailableError(request.machineId);
}

export function requestConnectorDevServerInspect(
  request: ConnectorDevServerTrustedRequest,
  actor: ConnectorDevServerActor,
  options?: ConnectorDevServerRequestOptions
) {
  return requestConnectorDevServerCommand('inspect', request, actor, options);
}

export function requestConnectorDevServerStart(
  request: ConnectorDevServerTrustedRequest,
  actor: ConnectorDevServerActor,
  options?: ConnectorDevServerRequestOptions
) {
  return requestConnectorDevServerCommand('start', request, actor, options);
}

export function requestConnectorDevServerStop(
  request: ConnectorDevServerTrustedRequest,
  actor: ConnectorDevServerActor,
  options?: ConnectorDevServerRequestOptions
) {
  return requestConnectorDevServerCommand('stop', request, actor, options);
}

export async function requestConnectorModels(
  request: CodexModelCatalogueRequest
): Promise<CodexModelCatalogueResult> {
  const socket = socketForMachine(request.machineId);
  const id = commandId();
  const result = createPendingCommand(id, request.machineId, 'models');
  sendConnectorJson(socket, { id, payload: request, type: 'codex.models' });
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
  sendConnectorJson(socket, { id, payload: request, type: 'terminal.run' });
  return (await result) as TerminalCommandResult;
}

export async function requestConnectorProjectWorktrees(
  request: MachineProjectWorktreesRequest
): Promise<ProjectWorktreeRecord[]> {
  const socket = socketForMachine(request.machineId, 'worktrees.list');
  const id = commandId();
  const result = createPendingCommand(id, request.machineId, 'worktrees');
  sendConnectorJson(socket, { id, payload: request, type: 'worktrees.list' });
  return (await result) as ProjectWorktreeRecord[];
}

export async function requestConnectorFileSystemRoot(
  request: MachineFileSystemRequest
): Promise<MachineFileSystemRootResult> {
  const socket = socketForMachine(request.machineId, 'filesystem.root');
  const id = commandId();
  const result = createPendingCommand(id, request.machineId, 'filesystem-root');
  sendConnectorJson(socket, { id, payload: request, type: 'filesystem.root' });
  return (await result) as MachineFileSystemRootResult;
}

export async function requestConnectorDirectory(
  request: MachineFileSystemDirectoryRequest
): Promise<MachineFileSystemDirectoryResult> {
  const socket = socketForMachine(request.machineId, 'filesystem.directory');
  const id = commandId();
  const result = createPendingCommand(id, request.machineId, 'filesystem-directory');
  sendConnectorJson(socket, { id, payload: request, type: 'filesystem.directory' });
  return (await result) as MachineFileSystemDirectoryResult;
}

export async function requestConnectorFile(
  request: MachineFileSystemFileRequest
): Promise<MachineFileSystemFileResult> {
  const socket = socketForMachine(request.machineId, 'filesystem.file');
  const id = commandId();
  const result = createPendingCommand(id, request.machineId, 'filesystem-file');
  sendConnectorJson(socket, { id, payload: request, type: 'filesystem.file' });
  return (await result) as MachineFileSystemFileResult;
}

export async function requestConnectorFolderCreate(
  request: MachineDirectoryCreateRequest
): Promise<MachineDirectoryMutationResult> {
  const socket = socketForMachine(request.machineId, 'filesystem.folder.create');
  const id = commandId();
  const result = createPendingCommand(id, request.machineId, 'folder-create');
  sendConnectorJson(socket, { id, payload: request, type: 'filesystem.folder.create' });
  return (await result) as MachineDirectoryMutationResult;
}

export async function requestConnectorFolderRename(
  request: MachineDirectoryRenameRequest
): Promise<MachineDirectoryMutationResult> {
  const socket = socketForMachine(request.machineId, 'filesystem.folder.rename');
  const id = commandId();
  const result = createPendingCommand(id, request.machineId, 'folder-rename');
  sendConnectorJson(socket, { id, payload: request, type: 'filesystem.folder.rename' });
  return (await result) as MachineDirectoryMutationResult;
}

export async function requestConnectorFolderDelete(
  request: MachineDirectoryDeleteRequest
): Promise<MachineDirectoryMutationResult> {
  const socket = socketForMachine(request.machineId, 'filesystem.folder.delete');
  const id = commandId();
  const result = createPendingCommand(id, request.machineId, 'folder-delete');
  sendConnectorJson(socket, { id, payload: request, type: 'filesystem.folder.delete' });
  return (await result) as MachineDirectoryMutationResult;
}

export async function streamConnectorCodexChat(
  request: CodexChatRequest,
  emit: (event: CodexChatStreamEvent) => void
) {
  const socket = socketForMachine(request.machineId);
  const id = commandId();
  const result = createPendingCommand(id, request.machineId, 'chat', emit);
  sendConnectorJson(socket, { id, payload: request, type: 'codex.chat' });
  await result;
}

export function createConnectorCommandUpgradeHandler(
  options: ConnectorCommandUpgradeHandlerOptions = {}
) {
  const authenticate =
    options.authenticateConnectorCredential ?? authenticateConnectorCredential;
  const revalidationIntervalMs =
    options.credentialRevalidationIntervalMs ?? defaultCredentialRevalidationIntervalMs;
  if (!Number.isSafeInteger(revalidationIntervalMs) || revalidationIntervalMs <= 0) {
    throw new Error('credentialRevalidationIntervalMs must be a positive integer.');
  }
  const webSocketServer = new WebSocketServer({
    maxPayload: 2 * 1024 * 1024,
    noServer: true
  });

  webSocketServer.on('connection', (socket) => {
    let machineId = '';
    let registrationToken = '';
    let registrationPending = false;
    let credentialRevalidationTimer: ReturnType<typeof setInterval> | undefined;
    let credentialRevalidation: Promise<boolean> | undefined;
    const registrationTimeout = setTimeout(() => {
      if (!machineId) {
        socket.close(1008, 'Connector registration timed out.');
      }
    }, 10_000);

    async function revalidateCredential() {
      if (!machineId || !registrationToken || socket.readyState !== WebSocket.OPEN) {
        return false;
      }
      if (credentialRevalidation) {
        return credentialRevalidation;
      }

      const attempt = authenticate(registrationToken, machineId).catch(() => false);
      credentialRevalidation = attempt;
      const authenticated = await attempt;
      if (credentialRevalidation === attempt) {
        credentialRevalidation = undefined;
      }
      if (!authenticated && socket.readyState === WebSocket.OPEN) {
        socket.close(1008, 'Connector credential expired or was revoked.');
      }
      return authenticated;
    }

    socket.on('message', async (data) => {
      const message = parseConnectorMessage(data);
      if (!isConnectorHubMessage(message)) {
        return;
      }

      if (message.type === 'connector.register') {
        if (machineId || registrationPending) {
          socket.close(1008, 'Connector already registered.');
          return;
        }
        registrationPending = true;
        const requestedMachineId = message.payload.connector.machineId;
        const authenticated = await authenticate(message.token, requestedMachineId).catch(
          () => false
        );
        if (!authenticated) {
          socket.close(1008, 'Connector registration failed.');
          return;
        }
        if (socket.readyState !== WebSocket.OPEN) {
          return;
        }

        try {
          registerConnectorProjectRegistry(message.payload);
        } catch {
          socket.close(1008, 'Connector registration failed.');
          return;
        }
        machineId = requestedMachineId;
        registrationToken = message.token;
        registrationPending = false;
        const previous = connectorSocket(machineId);
        if (previous && previous !== socket) {
          failCommandsForMachine(machineId);
        }
        registerConnectorSession(
          machineId,
          socket,
          registrationToken,
          message.payload.connector.capabilities ?? []
        );
        if (previous && previous !== socket) {
          previous.close(1012, 'Connector replaced.');
        }
        clearTimeout(registrationTimeout);
        credentialRevalidationTimer = setInterval(() => {
          void revalidateCredential();
        }, revalidationIntervalMs);
        sendConnectorJson(socket, { type: 'connector.registered' });
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
        if (!(await revalidateCredential()) || socket.readyState !== WebSocket.OPEN) {
          return;
        }
        registerConnectorProjectRegistry(message.payload);
        updateConnectorCapabilities(machineId, message.payload.connector.capabilities ?? []);
        return;
      }

      handleConnectorResult(machineId, message);
    });

    socket.on('close', () => {
      clearTimeout(registrationTimeout);
      if (credentialRevalidationTimer) {
        clearInterval(credentialRevalidationTimer);
      }
      if (machineId && removeConnectorSession(machineId, socket)) {
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
