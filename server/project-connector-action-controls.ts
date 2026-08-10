import type { KeyLike } from 'node:crypto';
import type { ConnectorWorktreeActionAdapter } from './connector-worktree-action-contract';
import { ConnectorWorktreeActionExecutor } from './connector-worktree-action-executor';
import type { ConnectorHubMessage, ConnectorMachineMessage } from './connector-command-protocol';
import { sendConnectorJson } from './project-connector-websocket-utils';
import { WorkspaceCommandConnectorExecutor } from './workspace-command/connector-executor';
import { createLocalWorkspaceCommandAdapter } from './workspace-command/local-adapter';

export function createProjectConnectorActionControls(options: {
  backend: Partial<ConnectorWorktreeActionAdapter>;
  machineId?: string;
  verificationKey?: KeyLike;
}) {
  const worktrees = options.verificationKey &&
    typeof options.backend.runWorktreeAction === 'function'
    ? new ConnectorWorktreeActionExecutor(
        options.backend as ConnectorWorktreeActionAdapter,
        options.verificationKey,
        options.machineId
      )
    : undefined;
  const workspace = options.verificationKey
    ? new WorkspaceCommandConnectorExecutor(
        createLocalWorkspaceCommandAdapter(), options.verificationKey, options.machineId
      )
    : undefined;

  return {
    handle(message: ConnectorMachineMessage, socket?: WebSocket) {
      if (message.type === 'worktree.action') {
        if (!worktrees) {
          socket?.close(1008, 'Worktree actions are not configured.');
          return true;
        }
        void worktrees.execute(message.payload.operation, message.payload)
          .then((result) => {
            if (socket) sendConnectorJson(socket, {
              id: message.id, payload: result, type: 'worktree.action.result'
            } satisfies ConnectorHubMessage);
          })
          .catch(() => socket?.close(1008, 'Worktree action authorization failed.'));
        return true;
      }
      if (message.type !== 'workspace.command') return false;
      if (!workspace) {
        socket?.close(1008, 'Workspace commands are not configured.');
        return true;
      }
      void workspace.execute(message.payload.operation, message.payload)
        .then((result) => {
          if (socket) sendConnectorJson(socket, {
            id: message.id, payload: result, type: 'workspace.command.result'
          } satisfies ConnectorHubMessage);
        })
        .catch(() => socket?.close(1008, 'Workspace command authorization failed.'));
      return true;
    },
    setExpectedGeneration(generation?: number) {
      workspace?.setExpectedGeneration(generation);
    }
  };
}
