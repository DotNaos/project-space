import { WebSocket } from 'ws';
import {
  type ConnectorDevServerActor,
  type ConnectorDevServerAnyTrustedRequest,
  type ConnectorDevServerListResult,
  type ConnectorDevServerListTrustedRequest,
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
import type {
  ConnectorWorktreeActionActor,
  ConnectorWorktreeActionOperation,
  ConnectorWorktreeActionResult,
  ConnectorWorktreeActionTrustedRequest
} from './connector-worktree-action-contract';
import {
  createConnectorWorktreeActionWireRequest,
  localConnectorWorktreeAction,
  registerLocalConnectorWorktreeActionExecutor,
  worktreeActionSigningKey,
  type WorktreeActionRequestOptions
} from './connector-worktree-action-routing';
import {
  type ConnectorHubMessage,
  type ConnectorMachineMessage
} from './connector-command-protocol';
import {
  authenticateConnectorCredential,
  createConnectorCommandUpgradeHandlerCore,
  type AuthenticateConnectorCredential,
  type ConnectorCommandUpgradeHandlerOptions
} from './connector-command-upgrade-handler';
import {
  connectorHasCapability,
  connectorSocket,
  disconnectConnectorSession,
  sendConnectorJson
} from './connector-command-session-registry';
import {
  failCodexSessionCommandsForMachine,
  handleCodexSessionsConnectorMessage
} from './codex-sessions/connector-hub';
export {
  requestConnectorCodexSessions,
  streamConnectorCodexSessions
} from './codex-sessions/connector-hub';
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
  | ConnectorDevServerListResult
  | ConnectorWorktreeActionResult
  | TerminalCommandResult;

interface PendingCommand {
  worktreeActionTarget?: {
    generation: number;
    operation: ConnectorWorktreeActionOperation;
    projectId: string;
  };
  devServerTarget?: {
    generation: number;
    projectId: string;
    runTarget: string;
    serverId: string;
    worktreeId: string;
  };
  kind:
    | 'chat'
    | 'dev-server-inspect'
    | 'dev-server-list'
    | 'dev-server-start'
    | 'dev-server-stop'
    | 'worktree-action'
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

const commandTimeoutMs = 10 * 60_000;
const pendingCommands = new Map<string, PendingCommand>();

export { registerLocalConnectorDevServerExecutor };
export { registerLocalConnectorWorktreeActionExecutor };
export type { ConnectorDevServerRequestOptions };

export { authenticateConnectorCredential };
export type { AuthenticateConnectorCredential };

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
    worktreeActionTarget?: PendingCommand['worktreeActionTarget'];
  } = {}
) {
  return new Promise<ConnectorCommandResult | undefined>((resolve, reject) => {
    const timeout = setTimeout(() => {
      failPending(id, new Error(`The connector command on ${machineId} timed out.`));
    }, options.timeoutMs ?? commandTimeoutMs);

    pendingCommands.set(id, {
      devServerTarget: options.devServerTarget,
      worktreeActionTarget: options.worktreeActionTarget,
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
  failCodexSessionCommandsForMachine(machineId);
}

function handleConnectorResult(machineId: string, message: ConnectorHubMessage) {
  if (handleCodexSessionsConnectorMessage(machineId, message)) return;
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
      message.payload.serverId !== target.serverId ||
      message.payload.runTarget !== target.runTarget ||
      message.payload.generation !== target.generation
    ) {
      failPending(
        message.id,
        new Error('The connector returned dev-server state for a different target.')
      );
      return;
    }
    finishPending(message.id, message.payload);
    return;
  }

  if (message.type === 'dev-server.list.result') {
    const pending = pendingCommands.get(message.id);
    const target = pending?.devServerTarget;
    if (!pending || pending.kind !== 'dev-server-list' || !target) {
      return;
    }
    if (
      message.payload.machineId !== pending.machineId ||
      message.payload.projectId !== target.projectId ||
      message.payload.worktreeId !== target.worktreeId ||
      message.payload.generation !== target.generation
    ) {
      failPending(
        message.id,
        new Error('The connector returned dev-server inventory for a different target.')
      );
      return;
    }
    finishPending(message.id, message.payload);
    return;
  }

  if (message.type === 'worktree.action.result') {
    const pending = pendingCommands.get(message.id);
    const target = pending?.worktreeActionTarget;
    if (!pending || pending.kind !== 'worktree-action' || !target) return;
    if (
      message.payload.machineId !== pending.machineId ||
      message.payload.projectId !== target.projectId ||
      message.payload.operation !== target.operation ||
      message.payload.generation !== target.generation
    ) {
      failPending(
        message.id,
        new Error('The connector returned worktree action state for a different target.')
      );
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
  if (message.type === 'worktrees.error') {
    if (pendingCommands.get(message.id)?.kind === 'worktrees') {
      failPending(message.id, new Error(message.payload.message || 'Git worktree discovery failed.'));
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
  request: ConnectorDevServerAnyTrustedRequest,
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
    const result = createPendingCommand(
      id,
      request.machineId,
      devServerPendingKind(operation),
      undefined,
      {
        devServerTarget: {
          generation: actor.generation,
          projectId: request.projectId,
          runTarget: 'runTarget' in request ? request.runTarget : 'list',
          serverId: 'serverId' in request ? request.serverId : 'list',
          worktreeId: request.worktreeId
        },
        timeoutMs: options.timeoutMs
      }
    );
    const message: ConnectorMachineMessage = {
      id,
      payload: wireRequest,
      type: devServerMessageType(operation)
    } as ConnectorMachineMessage;
    sendConnectorJson(socket, message);
    return (await result) as ConnectorDevServerResult | ConnectorDevServerListResult;
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
  return requestConnectorDevServerCommand(
    'inspect',
    request,
    actor,
    options
  ) as Promise<ConnectorDevServerResult>;
}

export function requestConnectorDevServerList(
  request: ConnectorDevServerListTrustedRequest,
  actor: ConnectorDevServerActor,
  options?: ConnectorDevServerRequestOptions
) {
  return requestConnectorDevServerCommand(
    'list',
    request,
    actor,
    options
  ) as Promise<ConnectorDevServerListResult>;
}

export function requestConnectorDevServerStart(
  request: ConnectorDevServerTrustedRequest,
  actor: ConnectorDevServerActor,
  options?: ConnectorDevServerRequestOptions
) {
  return requestConnectorDevServerCommand(
    'start',
    request,
    actor,
    options
  ) as Promise<ConnectorDevServerResult>;
}

export function requestConnectorDevServerStop(
  request: ConnectorDevServerTrustedRequest,
  actor: ConnectorDevServerActor,
  options?: ConnectorDevServerRequestOptions
) {
  return requestConnectorDevServerCommand(
    'stop',
    request,
    actor,
    options
  ) as Promise<ConnectorDevServerResult>;
}

export async function requestConnectorWorktreeAction(
  operation: ConnectorWorktreeActionOperation,
  request: ConnectorWorktreeActionTrustedRequest,
  actor: ConnectorWorktreeActionActor,
  options: WorktreeActionRequestOptions = {}
) {
  const openSocket = connectorSocket(request.machineId);
  if (openSocket?.readyState === WebSocket.OPEN) {
    const socket = socketForMachine(request.machineId, `worktree.${operation}`);
    const id = commandId();
    const result = createPendingCommand(id, request.machineId, 'worktree-action', undefined, {
      timeoutMs: options.timeoutMs,
      worktreeActionTarget: {
        generation: actor.generation,
        operation,
        projectId: request.projectId
      }
    });
    sendConnectorJson(socket, {
      id,
      payload: createConnectorWorktreeActionWireRequest(
        operation,
        request,
        actor,
        worktreeActionSigningKey(options),
        options
      ),
      type: 'worktree.action'
    });
    return (await result) as ConnectorWorktreeActionResult;
  }
  const local = localConnectorWorktreeAction(operation, request, actor, options);
  if (local) return local;
  throw unavailableError(request.machineId);
}

export async function requestConnectorModels(
  request: CodexModelCatalogueRequest
): Promise<CodexModelCatalogueResult> {
  const socket = socketForMachine(request.machineId);
  const id = commandId();
  const result = createPendingCommand(id, request.machineId, 'models');
  sendConnectorJson(socket, { id, payload: request, type: 'codex.models' });
  return (
    ((await result) as CodexModelCatalogueResult | undefined) ?? {
      message: 'The connector returned no model catalogue.',
      models: [],
      status: 'error'
    }
  );
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
  const socket = socketForMachine(request.machineId, 'worktrees.list.v2');
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
  sendConnectorJson(socket, {
    id,
    payload: request,
    type: 'filesystem.directory'
  });
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
  sendConnectorJson(socket, {
    id,
    payload: request,
    type: 'filesystem.folder.create'
  });
  return (await result) as MachineDirectoryMutationResult;
}

export async function requestConnectorFolderRename(
  request: MachineDirectoryRenameRequest
): Promise<MachineDirectoryMutationResult> {
  const socket = socketForMachine(request.machineId, 'filesystem.folder.rename');
  const id = commandId();
  const result = createPendingCommand(id, request.machineId, 'folder-rename');
  sendConnectorJson(socket, {
    id,
    payload: request,
    type: 'filesystem.folder.rename'
  });
  return (await result) as MachineDirectoryMutationResult;
}

export async function requestConnectorFolderDelete(
  request: MachineDirectoryDeleteRequest
): Promise<MachineDirectoryMutationResult> {
  const socket = socketForMachine(request.machineId, 'filesystem.folder.delete');
  const id = commandId();
  const result = createPendingCommand(id, request.machineId, 'folder-delete');
  sendConnectorJson(socket, {
    id,
    payload: request,
    type: 'filesystem.folder.delete'
  });
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
  return createConnectorCommandUpgradeHandlerCore(
    { failCommandsForMachine, handleConnectorResult },
    options
  );
}
