import { WebSocket } from 'ws';
import type { ConnectorHubMessage } from '../connector-command-protocol';
import {
  connectorHasCapability,
  connectorSocket,
  sendConnectorJson
} from '../connector-command-session-registry';
import type {
  WorkspaceCommandConnectorActor,
  WorkspaceCommandConnectorOperation,
  WorkspaceCommandConnectorRequest,
  WorkspaceCommandConnectorResult
} from './connector-contract';
import {
  createWorkspaceCommandWireRequest,
  executeLocalWorkspaceCommand,
  registerLocalWorkspaceCommandExecutor,
  workspaceCommandSigningKey,
  type WorkspaceCommandRoutingOptions
} from './connector-routing';
import { successfulWorkspaceCompatibilityResult } from '../connector-retirement/command-classification';

interface PendingWorkspaceCommand {
  machineId: string;
  ownerUserId: string;
  reject(error: Error): void;
  resolve(result: WorkspaceCommandConnectorResult): void;
  target: {
    commandId: string;
    environmentId: string;
    generation: number;
    operation: WorkspaceCommandConnectorOperation;
    workspaceId: string;
  };
  timeout: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingWorkspaceCommand>();
const defaultTimeoutMs = 10 * 60_000;
type CompatibilityUseRecorder = (ownerUserId: string, surface: string) => Promise<unknown>;

function unavailable(machineId: string) {
  return new Error(
    `${machineId} is registered, but its live command channel is not connected yet. Restart or update the Project Space connector on that machine.`
  );
}

function fail(id: string, error: Error) {
  const command = pending.get(id);
  if (!command) return;
  pending.delete(id);
  clearTimeout(command.timeout);
  command.reject(error);
}

export function failWorkspaceCommandsForMachine(machineId: string) {
  for (const [id, command] of pending) {
    if (command.machineId === machineId) fail(id, unavailable(machineId));
  }
}

export function handleWorkspaceCommandHubMessage(
  machineId: string,
  message: ConnectorHubMessage,
  options: {
    recordCompatibilityUse?: CompatibilityUseRecorder;
  } = {}
) {
  if (message.type !== 'workspace.command.result') return false;
  const command = pending.get(message.id);
  if (!command || command.machineId !== machineId) return true;
  const { target } = command;
  if (message.payload.machineId !== machineId ||
      message.payload.commandId !== target.commandId ||
      message.payload.environmentId !== target.environmentId ||
      message.payload.workspaceId !== target.workspaceId ||
      message.payload.operation !== target.operation ||
      message.payload.generation !== target.generation) {
    fail(message.id, new Error('Connector returned command state for another target.'));
    return true;
  }
  pending.delete(message.id);
  clearTimeout(command.timeout);
  command.resolve(message.payload);
  if (successfulWorkspaceCompatibilityResult(message.payload)) {
    void options.recordCompatibilityUse?.(
      command.ownerUserId,
      'connector.workspace-command.websocket.v1'
    );
  }
  return true;
}

export async function requestConnectorWorkspaceCommand(
  operation: WorkspaceCommandConnectorOperation,
  request: WorkspaceCommandConnectorRequest,
  actor: WorkspaceCommandConnectorActor,
  options: WorkspaceCommandRoutingOptions = {}
) {
  const openSocket = connectorSocket(request.machineId);
  if (openSocket?.readyState === WebSocket.OPEN) {
    if (!connectorHasCapability(request.machineId, 'workspace.commands.v1')) {
      throw new Error(
        `The connector on ${request.machineId} does not support this action yet. Update or restart the Project Space connector on that machine.`
      );
    }
    const id = globalThis.crypto?.randomUUID?.() ?? `workspace-${Date.now()}-${Math.random()}`;
    const result = new Promise<WorkspaceCommandConnectorResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        fail(id, new Error(`The connector command on ${request.machineId} timed out.`));
      }, options.timeoutMs ?? defaultTimeoutMs);
      pending.set(id, {
        machineId: request.machineId, ownerUserId: actor.userId, reject, resolve,
        target: {
          commandId: request.commandId, environmentId: request.environmentId,
          generation: actor.generation, operation, workspaceId: request.workspaceId
        },
        timeout
      });
    });
    sendConnectorJson(openSocket, {
      id,
      payload: createWorkspaceCommandWireRequest(
        operation, request, actor, workspaceCommandSigningKey(options), options
      ),
      type: 'workspace.command'
    });
    return result;
  }
  const local = executeLocalWorkspaceCommand(operation, request, actor, options);
  if (local) return local;
  throw unavailable(request.machineId);
}

export { registerLocalWorkspaceCommandExecutor };
