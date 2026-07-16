import type { IncomingMessage, ServerResponse } from 'node:http';

import type {
  CodexSessionApprovalRequest,
  CodexSessionBrowserRequest,
  CodexSessionContinueRequest,
  CodexSessionInspectRequest,
  CodexSessionInterruptRequest,
  CodexSessionReadRequest,
  CodexSessionUserInputResponse
} from '../../src/shared/codex-sessions-api';
import { CODEX_SESSION_LIST_DEADLINE_MS } from '../../src/shared/codex-session-inventory-window';
import { CodexSessionsStore } from '../codex-sessions-store';
import { CODEX_SESSIONS_MODEL_SELECTION_CONNECTOR_CAPABILITY } from '../codex-sessions-connector-contract';
import type { CodexSessionsHttpHandler } from '../codex-sessions-http';
import {
  isDatabaseConfigured,
  getCodexSessionsDatabaseClient,
  readMachineMembership
} from '../local-database-store';
import { getRegisteredConnectorMachines } from '../connector-hub';
import {
  isConnectorCommandChannelAvailable,
  requestConnectorCodexSessions,
  streamConnectorCodexSessions
} from '../connector-command-hub';
import {
  CodexConnectorNotDispatchedError,
  CodexConnectorRemoteError
} from './connector-hub';
import { writeJson } from '../project-space-http-response';
import {
  CodexSessionsAccessError,
  CodexThreadMissingError,
  CodexTransportUncertainError,
  CodexTransportUnavailableError,
  type CodexSessionsTransport
} from './service';
import { createCodexSessionsRuntime, type CodexSessionsRuntime } from './runtime';

const codexApiPrefix = '/api/codex/sessions';

type MutationRequest =
  | CodexSessionApprovalRequest
  | CodexSessionContinueRequest
  | CodexSessionInterruptRequest
  | CodexSessionUserInputResponse;

export interface ConfiguredCodexSessionsRuntimeOptions {
  createStore?: () => Promise<CodexSessionsStore>;
  machineAccess?: (userId: string, machineId: string) => Promise<boolean>;
  transport?: CodexSessionsTransport;
}

export async function createConfiguredCodexSessionsRuntime(
  options: ConfiguredCodexSessionsRuntimeOptions = {}
): Promise<CodexSessionsRuntime> {
  const store = options.createStore
    ? await options.createStore()
    : new CodexSessionsStore(await getCodexSessionsDatabaseClient());
  const machineAccess = options.machineAccess ?? (async (userId, machineId) => (
    Boolean(await readMachineMembership({ machineId, userId }))
  ));
  return createCodexSessionsRuntime({
    async authorize(actor, machineId) {
      if (!await machineAccess(actor.userId, machineId)) {
        throw new CodexSessionsAccessError('Machine access is required.');
      }
    },
    store,
    transport: options.transport ?? createConnectorCodexSessionsTransport()
  });
}

export function createConfiguredCodexSessionsHandler(
  options: ConfiguredCodexSessionsRuntimeOptions = {}
): CodexSessionsHttpHandler {
  let runtime: Promise<CodexSessionsRuntime> | undefined;
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (!url.pathname.startsWith(codexApiPrefix)) return false;
    if (!options.createStore && !isDatabaseConfigured()) {
      writeUnavailable(response, 'Codex sessions require the Project Space database.');
      return true;
    }
    try {
      runtime ??= createConfiguredCodexSessionsRuntime(options);
      return await (await runtime).handleRequest(request, response, url);
    } catch {
      runtime = undefined;
      writeUnavailable(response, 'Codex sessions are temporarily unavailable.');
      return true;
    }
  };
}

export function createConnectorCodexSessionsTransport(): CodexSessionsTransport {
  return {
    async browser({ afterImageRevision, machineId, threadId, userId }) {
      try {
        const result = await request('browser', {
          ...(afterImageRevision ? { afterImageRevision } : {}),
          machineId,
          threadId
        }, userId);
        if (result.operation !== 'browser') {
          throw new CodexTransportUncertainError();
        }
        return result.result;
      } catch (error) {
        if (error instanceof CodexConnectorRemoteError && error.code === 'rejected') {
          throw new CodexTransportUncertainError(
            'The connector could not prove the current Codex browser identity.'
          );
        }
        if (error instanceof CodexTransportUncertainError) throw error;
        throw new CodexTransportUnavailableError();
      }
    },
    async describeMachine({ machineId }) {
      const machine = (await getRegisteredConnectorMachines())
        .find((candidate) => candidate.id === machineId);
      return {
        id: machineId,
        name: machine?.name ?? machineId,
        online: machine?.connector.status === 'online' &&
          isConnectorCommandChannelAvailable(machineId),
        statusMessage: machine
          ? undefined
          : 'The owning machine is no longer registered.',
        supportsModelSelection: machine?.connector.capabilities?.includes(
          CODEX_SESSIONS_MODEL_SELECTION_CONNECTOR_CAPABILITY
        ) === true
      };
    },
    async list({ machineId, userId }) {
      const result = await request('list', { includeArchived: true, machineId }, userId);
      if (result.operation !== 'list') throw new CodexTransportUncertainError();
      const machine = (await getRegisteredConnectorMachines())
        .find((candidate) => candidate.id === machineId);
      return {
        ...result.result,
        machine: {
          ...result.result.machine,
          supportsModelSelection: machine?.connector.capabilities?.includes(
            CODEX_SESSIONS_MODEL_SELECTION_CONNECTOR_CAPABILITY
          ) === true
        }
      };
    },
    async inspect({ machineId, threadId, userId }) {
      try {
        const result = await request('inspect', { machineId, threadId }, userId);
        if (result.operation !== 'inspect') throw new CodexTransportUncertainError();
        return result.result;
      } catch (error) {
        if (error instanceof CodexConnectorRemoteError && error.code === 'rejected') {
          throw new CodexTransportUncertainError(
            'The connector could not prove the current Codex task identity.'
          );
        }
        if (error instanceof CodexConnectorRemoteError && error.code === 'unavailable') {
          throw new CodexTransportUnavailableError();
        }
        if (error instanceof CodexTransportUncertainError) throw error;
        throw new CodexTransportUnavailableError();
      }
    },
    async mutate({ kind, machineId, request: mutation, threadId, userId }) {
      const result = await mutate(kind, mutation, userId);
      if (result.operation !== kind) throw new CodexTransportUncertainError();
      return { machineId, result: result.result, threadId };
    },
    async read({ machineId, threadId, userId }) {
      try {
        const result = await request('read', { machineId, threadId }, userId);
        if (result.operation !== 'read') throw new CodexTransportUncertainError();
        return result.result;
      } catch (error) {
        if (error instanceof CodexConnectorRemoteError && error.code === 'rejected') {
          throw new CodexThreadMissingError();
        }
        if (error instanceof CodexConnectorRemoteError && error.code === 'unavailable') {
          throw new CodexTransportUnavailableError();
        }
        if (error instanceof CodexTransportUncertainError) throw error;
        throw new CodexTransportUnavailableError();
      }
    },
    async stream({ machineId, threadId, userId }, emit, signal) {
      try {
        await streamConnectorCodexSessions(
          { machineId, threadId },
          emit,
          { signal, userId }
        );
      } catch {
        throw new CodexTransportUnavailableError();
      }
    }
  };
}

async function request(
  operation: 'browser' | 'inspect' | 'list' | 'read',
  payload: {
    afterImageRevision?: string;
    includeArchived?: boolean;
    machineId: string;
    threadId?: string;
  },
  userId: string
) {
  try {
    return await requestConnectorCodexSessions(
      operation,
      payload as CodexSessionBrowserRequest | CodexSessionInspectRequest | CodexSessionReadRequest,
      {
        ...(operation === 'inspect'
          ? { timeoutMs: 30_000 }
          : operation === 'browser'
            ? { timeoutMs: 8_000 }
          : operation === 'list'
            ? { timeoutMs: CODEX_SESSION_LIST_DEADLINE_MS }
            : {}),
        userId
      }
    );
  } catch (error) {
    if ((operation === 'browser' || operation === 'inspect' || operation === 'read') &&
      error instanceof CodexConnectorRemoteError) throw error;
    throw new CodexTransportUnavailableError();
  }
}

async function mutate(
  operation: 'approval' | 'continue' | 'input' | 'interrupt',
  payload: MutationRequest,
  userId: string
) {
  try {
    return await requestConnectorCodexSessions(operation, payload, {
      operationId: payload.operationId,
      userId
    });
  } catch (error) {
    if (error instanceof CodexConnectorNotDispatchedError) {
      throw new CodexTransportUnavailableError();
    }
    throw new CodexTransportUncertainError(
      error instanceof Error ? error.message : 'The Codex session operation is uncertain.'
    );
  }
}

function writeUnavailable(response: ServerResponse, message: string) {
  if (response.headersSent) return;
  response.setHeader('Cache-Control', 'private, no-store');
  writeJson(response, 503, {
    error: { code: 'codex_sessions_unavailable', message }
  });
}
