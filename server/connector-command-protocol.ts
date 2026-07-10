import type {
  CodexChatRequest,
  CodexChatStreamEvent,
  CodexModelCatalogueRequest,
  CodexModelCatalogueResult,
  ConnectorProjectRegistryResult,
  ProjectCliCommandRequest,
  ProjectCliCommandResult
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
    };

export type ConnectorMachineMessage =
  | { type: 'connector.registered' }
  | { id: string; type: 'connector.command.cancel' }
  | { id: string; payload: CodexModelCatalogueRequest; type: 'codex.models' }
  | { id: string; payload: CodexChatRequest; type: 'codex.chat' }
  | { id: string; payload: ProjectCliCommandRequest; type: 'project-cli.run' };

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
    Array.isArray(value.payload.discovery.groups) &&
    Array.isArray(value.payload.discovery.projects) &&
    Array.isArray(value.payload.discovery.rootItems) &&
    typeof value.payload.discovery.rootPath === 'string' &&
    Array.isArray(value.payload.discovery.structureViolations)
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
  return value.type === 'project-cli.result' && hasCommandId(value) && isRecord(value.payload);
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
  return value.type === 'project-cli.run';
}

export function parseConnectorMessage(data: unknown): unknown {
  try {
    const text = typeof data === 'string' ? data : String(data);
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
