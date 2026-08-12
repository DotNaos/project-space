import type { KeyLike } from 'node:crypto';
import type {
  ConnectorWorktreeActionAdapter,
  ConnectorWorktreeActionResult,
  ConnectorWorktreeActionWireRequest
} from './connector-worktree-action-contract';
import { ConnectorWorktreeActionExecutor } from './connector-worktree-action-executor';
import type { ConnectorHubMessage, ConnectorMachineMessage } from './connector-command-protocol';
import { sendConnectorJson } from './project-connector-websocket-utils';
import { WorkspaceCommandConnectorExecutor } from './workspace-command/connector-executor';
import type {
  WorkspaceCommandConnectorAdapter,
  WorkspaceCommandConnectorResult,
  WorkspaceCommandConnectorWireRequest
} from './workspace-command/connector-contract';
import { createLocalWorkspaceCommandAdapter } from './workspace-command/local-adapter';
import {
  ConnectorRuntimeMaintenanceBusyError,
  type ConnectorRuntimeMaintenanceAdmission,
  type ConnectorRuntimeMaintenanceBlocker
} from './connector-runtime-maintenance-safety';

const maintenanceMessage = 'Connector runtime maintenance is in progress.';

function worktreeMaintenanceResult(
  request: ConnectorWorktreeActionWireRequest
): ConnectorWorktreeActionResult {
  const base = {
    checkedAt: new Date().toISOString(),
    generation: request.grant.generation,
    lastError: maintenanceMessage,
    machineId: request.machineId,
    operation: request.operation,
    projectId: request.projectId
  };
  return request.operation === 'materialize'
    ? {
        ...base, branchName: request.branchName, commitSha: request.commitSha,
        operation: request.operation, state: 'error'
      }
    : {
        ...base, capability: 'unavailable', operation: request.operation,
        steps: [], worktreeId: request.worktreeId
      };
}

function workspaceMaintenanceResult(
  request: WorkspaceCommandConnectorWireRequest
): WorkspaceCommandConnectorResult {
  return {
    checkedAt: new Date().toISOString(),
    commandId: request.commandId,
    environmentId: request.environmentId,
    executionId: request.executionId,
    generation: request.grant.generation,
    machineId: request.machineId,
    operation: request.operation,
    state: 'failed',
    stderr: maintenanceMessage,
    stdout: '',
    truncated: false,
    workspaceId: request.workspaceId
  };
}

export function createProjectConnectorActionControls(options: {
  backend: Partial<ConnectorWorktreeActionAdapter>;
  maintenanceAdmission?: ConnectorRuntimeMaintenanceAdmission;
  machineId?: string;
  verificationKey?: KeyLike;
  workspaceAdapter?: WorkspaceCommandConnectorAdapter;
}) {
  let workspaceMutations = 0;
  let worktreeMutations = 0;
  const worktrees = options.verificationKey &&
    typeof options.backend.runWorktreeAction === 'function'
    ? new ConnectorWorktreeActionExecutor(
        options.backend as ConnectorWorktreeActionAdapter,
        options.verificationKey,
        options.machineId,
        options.maintenanceAdmission
      )
    : undefined;
  const workspace = options.verificationKey
    ? new WorkspaceCommandConnectorExecutor(
        options.workspaceAdapter ?? createLocalWorkspaceCommandAdapter(),
        options.verificationKey,
        options.machineId,
        options.maintenanceAdmission
      )
    : undefined;

  function executeTracked<Result>(
    scope: 'workspace' | 'worktree',
    mutation: boolean,
    action: () => Promise<Result>
  ) {
    if (!mutation) return action();
    if (scope === 'workspace') workspaceMutations += 1;
    else worktreeMutations += 1;
    try {
      return action().finally(() => {
        if (scope === 'workspace') workspaceMutations -= 1;
        else worktreeMutations -= 1;
      });
    } catch (error) {
      if (scope === 'workspace') workspaceMutations -= 1;
      else worktreeMutations -= 1;
      throw error;
    }
  }

  return {
    handle(message: ConnectorMachineMessage, socket?: WebSocket) {
      if (message.type === 'worktree.action') {
        if (!worktrees) {
          socket?.close(1008, 'Worktree actions are not configured.');
          return true;
        }
        void executeTracked(
          'worktree', message.payload.operation !== 'setup.inspect',
          () => worktrees.execute(message.payload.operation, message.payload)
        )
          .then((result) => {
            if (socket) sendConnectorJson(socket, {
              id: message.id, payload: result, type: 'worktree.action.result'
            } satisfies ConnectorHubMessage);
          })
          .catch((error) => {
            if (error instanceof ConnectorRuntimeMaintenanceBusyError && socket) {
              sendConnectorJson(socket, {
                id: message.id,
                payload: worktreeMaintenanceResult(message.payload),
                type: 'worktree.action.result'
              } satisfies ConnectorHubMessage);
            } else socket?.close(1008, 'Worktree action authorization failed.');
          });
        return true;
      }
      if (message.type !== 'workspace.command') return false;
      if (!workspace) {
        socket?.close(1008, 'Workspace commands are not configured.');
        return true;
      }
      void executeTracked(
        'workspace', message.payload.operation !== 'status',
        () => workspace.execute(message.payload.operation, message.payload)
      )
        .then((result) => {
          if (socket) sendConnectorJson(socket, {
            id: message.id, payload: result, type: 'workspace.command.result'
          } satisfies ConnectorHubMessage);
        })
        .catch((error) => {
          if (error instanceof ConnectorRuntimeMaintenanceBusyError && socket) {
            sendConnectorJson(socket, {
              id: message.id,
              payload: workspaceMaintenanceResult(message.payload),
              type: 'workspace.command.result'
            } satisfies ConnectorHubMessage);
          } else socket?.close(1008, 'Workspace command authorization failed.');
        });
      return true;
    },
    maintenanceBlockers(): ConnectorRuntimeMaintenanceBlocker[] {
      return [
        ...(worktreeMutations > 0 ? [{
          count: worktreeMutations,
          kind: 'connector-mutation' as const,
          scope: 'worktree' as const
        }] : []),
        ...(workspaceMutations > 0 ? [{
          count: workspaceMutations,
          kind: 'connector-mutation' as const,
          scope: 'workspace' as const
        }] : [])
      ];
    },
    setExpectedGeneration(generation?: number) {
      workspace?.setExpectedGeneration(generation);
    }
  };
}
