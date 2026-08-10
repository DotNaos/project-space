import {
  isWorkspaceCommandConnectorResult,
  isWorkspaceCommandConnectorWireRequest,
  type WorkspaceCommandConnectorResult,
  type WorkspaceCommandConnectorWireRequest
} from './connector-contract';

export type WorkspaceCommandHubMessage = {
  id: string;
  payload: WorkspaceCommandConnectorResult;
  type: 'workspace.command.result';
};

export type WorkspaceCommandMachineMessage = {
  id: string;
  payload: WorkspaceCommandConnectorWireRequest;
  type: 'workspace.command';
};

function commandId(value: { id?: unknown }) {
  return typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 512;
}

export function isWorkspaceCommandHubMessage(
  value: Record<string, unknown>
): value is WorkspaceCommandHubMessage {
  return value.type === 'workspace.command.result' && commandId(value) &&
    isWorkspaceCommandConnectorResult(value.payload);
}

export function isWorkspaceCommandMachineMessage(
  value: Record<string, unknown>
): value is WorkspaceCommandMachineMessage {
  return value.type === 'workspace.command' && commandId(value) &&
    isWorkspaceCommandConnectorWireRequest(value.payload);
}
