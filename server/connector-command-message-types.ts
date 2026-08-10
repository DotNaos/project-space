import type {
  CodexChatRequest,
  CodexChatStreamEvent,
  CodexModelCatalogueRequest,
  CodexModelCatalogueResult,
  ConnectorProjectRegistryResult,
  MachineDirectoryCreateRequest,
  MachineDirectoryDeleteRequest,
  MachineDirectoryMutationResult,
  MachineDirectoryRenameRequest,
  MachineFileSystemDirectoryRequest,
  MachineFileSystemDirectoryResult,
  MachineFileSystemFileRequest,
  MachineFileSystemFileResult,
  MachineFileSystemRequest,
  MachineFileSystemRootResult,
  MachineProjectWorktreesRequest,
  MachineTerminalCommandRequest,
  ProjectCliCommandRequest,
  ProjectCliCommandResult,
  ProjectWorktreeRecord,
  TerminalCommandResult
} from '../src/shared/project-space-api';
import type {
  ConnectorDevServerListResult,
  ConnectorDevServerListWireRequest,
  ConnectorDevServerResult,
  ConnectorDevServerWireRequest
} from './connector-dev-server-contract';
import type {
  ConnectorWorktreeActionResult,
  ConnectorWorktreeActionWireRequest
} from './connector-worktree-action-contract';
import type {
  ConnectorCodexHubMessage,
  ConnectorCodexMachineMessage
} from './connector-command-codex-protocol';
import type {
  ConnectorRuntimeHubCommandMessage,
  ConnectorRuntimeMachineCommandMessage
} from './connector-runtime-command-routing';
import type {
  ConnectorRuntimeStopHubMessage,
  ConnectorRuntimeStopMachineMessage
} from './connector-runtime-stop-routing';
import type { ConnectorRuntimeMaintenanceDecision } from './connector-runtime-registration-decision';
import type {
  WorkspaceCommandHubMessage,
  WorkspaceCommandMachineMessage
} from './workspace-command/connector-protocol';

export type ConnectorHubMessage =
  | ConnectorRuntimeHubCommandMessage
  | ConnectorRuntimeStopHubMessage
  | ConnectorCodexHubMessage
  | WorkspaceCommandHubMessage
  | { payload: ConnectorProjectRegistryResult; token: string; type: 'connector.register' }
  | { payload: ConnectorProjectRegistryResult; type: 'connector.registry' }
  | { id: string; payload: CodexModelCatalogueResult; type: 'codex.models.result' }
  | { id: string; payload: CodexChatStreamEvent; type: 'codex.chat.event' }
  | { id: string; type: 'codex.chat.complete' }
  | { id: string; payload: ProjectCliCommandResult; type: 'project-cli.result' }
  | { id: string; payload: ConnectorDevServerResult; type: 'dev-server.inspect.result' }
  | { id: string; payload: ConnectorDevServerListResult; type: 'dev-server.list.result' }
  | { id: string; payload: ConnectorDevServerResult; type: 'dev-server.start.result' }
  | { id: string; payload: ConnectorDevServerResult; type: 'dev-server.stop.result' }
  | { id: string; payload: ConnectorWorktreeActionResult; type: 'worktree.action.result' }
  | { id: string; payload: TerminalCommandResult; type: 'terminal.result' }
  | { id: string; payload: ProjectWorktreeRecord[]; type: 'worktrees.result' }
  | { id: string; payload: { message: string }; type: 'worktrees.error' }
  | { id: string; payload: MachineFileSystemRootResult; type: 'filesystem.root.result' }
  | { id: string; payload: MachineFileSystemDirectoryResult; type: 'filesystem.directory.result' }
  | { id: string; payload: MachineFileSystemFileResult; type: 'filesystem.file.result' }
  | {
      id: string;
      payload: MachineDirectoryMutationResult;
      type: 'filesystem.folder.create.result' | 'filesystem.folder.rename.result' |
        'filesystem.folder.delete.result';
    };

export type ConnectorMachineMessage =
  | {
      generation: number;
      maintenance?: ConnectorRuntimeMaintenanceDecision;
      type: 'connector.registered';
    }
  | ConnectorRuntimeMachineCommandMessage
  | ConnectorRuntimeStopMachineMessage
  | ConnectorCodexMachineMessage
  | WorkspaceCommandMachineMessage
  | { id: string; type: 'connector.command.cancel' }
  | { id: string; payload: CodexModelCatalogueRequest; type: 'codex.models' }
  | { id: string; payload: CodexChatRequest; type: 'codex.chat' }
  | { id: string; payload: ProjectCliCommandRequest; type: 'project-cli.run' }
  | { id: string; payload: ConnectorDevServerWireRequest; type: 'dev-server.inspect' }
  | { id: string; payload: ConnectorDevServerListWireRequest; type: 'dev-server.list' }
  | { id: string; payload: ConnectorDevServerWireRequest; type: 'dev-server.start' }
  | { id: string; payload: ConnectorDevServerWireRequest; type: 'dev-server.stop' }
  | { id: string; payload: ConnectorWorktreeActionWireRequest; type: 'worktree.action' }
  | { id: string; payload: MachineTerminalCommandRequest; type: 'terminal.run' }
  | { id: string; payload: MachineProjectWorktreesRequest; type: 'worktrees.list' }
  | { id: string; payload: MachineFileSystemRequest; type: 'filesystem.root' }
  | { id: string; payload: MachineFileSystemDirectoryRequest; type: 'filesystem.directory' }
  | { id: string; payload: MachineFileSystemFileRequest; type: 'filesystem.file' }
  | { id: string; payload: MachineDirectoryCreateRequest; type: 'filesystem.folder.create' }
  | { id: string; payload: MachineDirectoryRenameRequest; type: 'filesystem.folder.rename' }
  | { id: string; payload: MachineDirectoryDeleteRequest; type: 'filesystem.folder.delete' };
