import type {
  CodexChatRequest,
  CodexChatStreamEvent,
  CodexModelCatalogueRequest,
  CodexModelCatalogueResult,
  ConnectorProjectRegistryResult,
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
  ProjectCliCommandRequest,
  ProjectCliCommandResult,
  ProjectWorktreeRecord,
  TerminalCommandResult
} from '../src/shared/project-space-api';

export type ConnectorHubMessage =
  | {
      payload: ConnectorProjectRegistryResult;
      token: string;
      type: 'connector.register';
    }
  | {
      payload: ConnectorProjectRegistryResult;
      type: 'connector.registry';
    }
  | {
      id: string;
      payload: CodexModelCatalogueResult;
      type: 'codex.models.result';
    }
  | {
      id: string;
      payload: CodexChatStreamEvent;
      type: 'codex.chat.event';
    }
  | {
      id: string;
      type: 'codex.chat.complete';
    }
  | {
      id: string;
      payload: ProjectCliCommandResult;
      type: 'project-cli.result';
    }
  | {
      id: string;
      payload: TerminalCommandResult;
      type: 'terminal.result';
    }
  | {
      id: string;
      payload: ProjectWorktreeRecord[];
      type: 'worktrees.result';
    }
  | {
      id: string;
      payload: MachineFileSystemRootResult;
      type: 'filesystem.root.result';
    }
  | {
      id: string;
      payload: MachineFileSystemDirectoryResult;
      type: 'filesystem.directory.result';
    }
  | {
      id: string;
      payload: MachineFileSystemFileResult;
      type: 'filesystem.file.result';
    }
  | {
      id: string;
      payload: MachineDirectoryMutationResult;
      type:
        | 'filesystem.folder.create.result'
        | 'filesystem.folder.rename.result'
        | 'filesystem.folder.delete.result';
    };

export type ConnectorMachineMessage =
  | { type: 'connector.registered' }
  | { id: string; type: 'connector.command.cancel' }
  | { id: string; payload: CodexModelCatalogueRequest; type: 'codex.models' }
  | { id: string; payload: CodexChatRequest; type: 'codex.chat' }
  | { id: string; payload: ProjectCliCommandRequest; type: 'project-cli.run' }
  | { id: string; payload: MachineTerminalCommandRequest; type: 'terminal.run' }
  | { id: string; payload: MachineProjectWorktreesRequest; type: 'worktrees.list' }
  | { id: string; payload: MachineFileSystemRequest; type: 'filesystem.root' }
  | { id: string; payload: MachineFileSystemDirectoryRequest; type: 'filesystem.directory' }
  | { id: string; payload: MachineFileSystemFileRequest; type: 'filesystem.file' }
  | { id: string; payload: MachineDirectoryCreateRequest; type: 'filesystem.folder.create' }
  | { id: string; payload: MachineDirectoryRenameRequest; type: 'filesystem.folder.rename' }
  | { id: string; payload: MachineDirectoryDeleteRequest; type: 'filesystem.folder.delete' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function hasCommandId(value: Record<string, unknown>) {
  return typeof value.id === 'string' && value.id.length > 0;
}

function hasRegistryPayload(value: Record<string, unknown>) {
  if (
    !isRecord(value.payload) ||
    !isRecord(value.payload.connector) ||
    !isRecord(value.payload.discovery)
  ) {
    return false;
  }
  return (
    typeof value.payload.checkedAt === 'string' &&
    typeof value.payload.connector.machineId === 'string' &&
    value.payload.connector.machineId.length > 0 &&
    typeof value.payload.connector.machineName === 'string' &&
    (value.payload.connector.capabilities === undefined ||
      (Array.isArray(value.payload.connector.capabilities) &&
        value.payload.connector.capabilities.every((entry) => typeof entry === 'string'))) &&
    Array.isArray(value.payload.discovery.groups) &&
    Array.isArray(value.payload.discovery.projects) &&
    Array.isArray(value.payload.discovery.rootItems) &&
    typeof value.payload.discovery.rootPath === 'string' &&
    Array.isArray(value.payload.discovery.structureViolations)
  );
}

function hasStatus(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && (value.status === 'success' || value.status === 'error');
}

function hasTerminalResult(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.command === 'string' &&
    typeof value.cwd === 'string' &&
    (typeof value.exitCode === 'number' || value.exitCode === null) &&
    typeof value.durationMs === 'number' &&
    typeof value.stdout === 'string' &&
    typeof value.stderr === 'string'
  );
}

function hasFileSystemEntry(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.path === 'string' &&
    (value.isProject === undefined || typeof value.isProject === 'boolean') &&
    (value.kind === 'file' || value.kind === 'directory')
  );
}

function hasWorktree(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.path === 'string' &&
    typeof value.isBase === 'boolean' &&
    (value.status === 'ready' || value.status === 'broken')
  );
}

function hasFileResult(value: unknown) {
  if (
    !hasStatus(value) ||
    typeof value.path !== 'string' ||
    typeof value.name !== 'string'
  ) {
    return false;
  }
  if (value.status === 'success' && typeof value.content !== 'string') {
    return false;
  }
  return (
    (value.content === undefined || typeof value.content === 'string') &&
    (value.modifiedAt === undefined || typeof value.modifiedAt === 'string') &&
    (value.sizeBytes === undefined || typeof value.sizeBytes === 'number') &&
    (value.truncated === undefined || typeof value.truncated === 'boolean')
  );
}

function hasFolderMutationResult(value: unknown) {
  return (
    hasStatus(value) &&
    Array.isArray(value.affectedPaths) &&
    value.affectedPaths.every((path) => typeof path === 'string')
  );
}

export function isConnectorHubMessage(value: unknown): value is ConnectorHubMessage {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }

  if (value.type === 'connector.register') {
    return typeof value.token === 'string' && hasRegistryPayload(value);
  }
  if (value.type === 'connector.registry') {
    return hasRegistryPayload(value);
  }
  if (value.type === 'codex.chat.complete') {
    return hasCommandId(value);
  }
  if (value.type === 'codex.chat.event') {
    return (
      hasCommandId(value) &&
      isRecord(value.payload) &&
      (value.payload.type === 'delta' || value.payload.type === 'done' || value.payload.type === 'error')
    );
  }
  if (value.type === 'codex.models.result') {
    return (
      hasCommandId(value) &&
      isRecord(value.payload) &&
      Array.isArray(value.payload.models) &&
      (value.payload.status === 'success' || value.payload.status === 'error')
    );
  }
  if (value.type === 'project-cli.result') {
    return hasCommandId(value) && isRecord(value.payload);
  }
  if (value.type === 'terminal.result') {
    return hasCommandId(value) && hasTerminalResult(value.payload);
  }
  if (value.type === 'worktrees.result') {
    return hasCommandId(value) && Array.isArray(value.payload) && value.payload.every(hasWorktree);
  }
  if (value.type === 'filesystem.root.result') {
    return (
      hasCommandId(value) &&
      hasStatus(value.payload) &&
      typeof value.payload.homePath === 'string' &&
      typeof value.payload.defaultPath === 'string'
    );
  }
  if (value.type === 'filesystem.directory.result') {
    return (
      hasCommandId(value) &&
      hasStatus(value.payload) &&
      typeof value.payload.path === 'string' &&
      Array.isArray(value.payload.entries) &&
      value.payload.entries.every(hasFileSystemEntry)
    );
  }
  if (
    value.type === 'filesystem.folder.create.result' ||
    value.type === 'filesystem.folder.rename.result' ||
    value.type === 'filesystem.folder.delete.result'
  ) {
    return hasCommandId(value) && hasFolderMutationResult(value.payload);
  }
  return (
    value.type === 'filesystem.file.result' &&
    hasCommandId(value) &&
    hasFileResult(value.payload)
  );
}

export function isConnectorMachineMessage(value: unknown): value is ConnectorMachineMessage {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  if (value.type === 'connector.registered') {
    return true;
  }
  if (value.type === 'connector.command.cancel') {
    return hasCommandId(value);
  }
  if (!hasCommandId(value) || !isRecord(value.payload)) {
    return false;
  }
  if (value.type === 'codex.models') {
    return typeof value.payload.cwd === 'string' && typeof value.payload.machineId === 'string';
  }
  if (value.type === 'codex.chat') {
    return (
      typeof value.payload.cwd === 'string' &&
      typeof value.payload.machineId === 'string' &&
      typeof value.payload.prompt === 'string' &&
      Array.isArray(value.payload.messages)
    );
  }
  if (value.type === 'project-cli.run') {
    return true;
  }
  if (value.type === 'terminal.run') {
    return typeof value.payload.machineId === 'string' && typeof value.payload.command === 'string';
  }
  if (value.type === 'worktrees.list') {
    return (
      typeof value.payload.machineId === 'string' &&
      typeof value.payload.projectPath === 'string'
    );
  }
  if (value.type === 'filesystem.root') {
    return typeof value.payload.machineId === 'string';
  }
  if (value.type === 'filesystem.directory' || value.type === 'filesystem.file') {
    return typeof value.payload.machineId === 'string' && typeof value.payload.path === 'string';
  }
  if (value.type === 'filesystem.folder.create') {
    return (
      typeof value.payload.machineId === 'string' &&
      typeof value.payload.parentPath === 'string' &&
      typeof value.payload.name === 'string'
    );
  }
  if (value.type === 'filesystem.folder.rename') {
    return (
      typeof value.payload.machineId === 'string' &&
      typeof value.payload.path === 'string' &&
      typeof value.payload.name === 'string'
    );
  }
  if (value.type === 'filesystem.folder.delete') {
    return (
      typeof value.payload.machineId === 'string' &&
      Array.isArray(value.payload.paths) &&
      value.payload.paths.every((path) => typeof path === 'string')
    );
  }
  return false;
}

export function parseConnectorMessage(data: unknown): unknown {
  try {
    const text = typeof data === 'string' ? data : String(data);
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
