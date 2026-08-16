import type { IncomingMessage, ServerResponse } from 'node:http';

import type {
  CodexSessionMachineRecord
} from '../../src/shared/codex-sessions-api';
import { CodexSessionsStore } from '../codex-sessions-store';
import type { CodexSessionsHttpHandler } from '../codex-sessions-http';
import {
  isDatabaseConfigured,
  getCodexSessionsDatabaseClient,
  readMachineMembership
} from '../local-database-store';
import { writeJson } from '../project-space-http-response';
import {
  CodexSessionsAccessError,
  CodexTransportUnavailableError,
  type CodexSessionsTransport
} from './service';
import { createCodexSessionsRuntime, type CodexSessionsRuntime } from './runtime';
import { retireCodexHttp } from './retirement';

const codexApiPrefix = '/api/codex/sessions';

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
    transport: options.transport ?? createRetiredCodexSessionsTransport()
  });
}

export function createConfiguredCodexSessionsHandler(
  options: ConfiguredCodexSessionsRuntimeOptions = {}
): CodexSessionsHttpHandler {
  if (!options.transport) {
    return async (_request, response, url) => {
      if (!url.pathname.startsWith(codexApiPrefix)) return false;
      retireCodexHttp(response);
      return true;
    };
  }
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

export function createRetiredCodexSessionsTransport(): CodexSessionsTransport {
  return {
    async describeMachine({ machineId }): Promise<CodexSessionMachineRecord> {
      return { id: machineId, name: 'Unavailable', online: false };
    },
    async list() { throw new CodexTransportUnavailableError(); },
    async inspect() { throw new CodexTransportUnavailableError(); },
    async mutate() { throw new CodexTransportUnavailableError(); },
    async read() { throw new CodexTransportUnavailableError(); },
    async start() { throw new CodexTransportUnavailableError(); },
    async stream() { throw new CodexTransportUnavailableError(); }
  };
}

function writeUnavailable(response: ServerResponse, message: string) {
  if (response.headersSent) return;
  response.setHeader('Cache-Control', 'private, no-store');
  writeJson(response, 503, {
    error: { code: 'codex_sessions_unavailable', message }
  });
}
