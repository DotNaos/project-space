import type { WebSocket } from 'ws';

import type {
  MachineProjectWorktreesRequest,
  ProjectWorktreeRecord
} from '../src/shared/project-space-api';
import { sendConnectorJson } from './connector-command-session-registry';

export interface ConnectorProjectWorktreeRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface ConnectorProjectWorktreeRequesterDependencies {
  createCommand(
    id: string,
    machineId: string,
    timeoutMs?: number
  ): Promise<unknown>;
  createCommandId(): string;
  failCommand(id: string, error: Error): void;
  socketForMachine(machineId: string, capability: string): WebSocket;
}

export function createConnectorProjectWorktreeRequester(
  dependencies: ConnectorProjectWorktreeRequesterDependencies
) {
  return async function requestConnectorProjectWorktrees(
    request: MachineProjectWorktreesRequest,
    options: ConnectorProjectWorktreeRequestOptions = {}
  ): Promise<ProjectWorktreeRecord[]> {
    if (options.signal?.aborted) throw connectorAbortError(options.signal);
    const socket = dependencies.socketForMachine(request.machineId, 'worktrees.list.v2');
    const id = dependencies.createCommandId();
    const result = dependencies.createCommand(id, request.machineId, options.timeoutMs);
    const abort = () => dependencies.failCommand(id, connectorAbortError(options.signal!));
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      sendConnectorJson(socket, { id, payload: request, type: 'worktrees.list' });
      return (await result) as ProjectWorktreeRecord[];
    } finally {
      options.signal?.removeEventListener('abort', abort);
    }
  };
}

function connectorAbortError(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('The connector worktree request was cancelled.');
}
