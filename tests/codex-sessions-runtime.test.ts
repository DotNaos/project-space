import { createServer, type Server } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';

import { afterEach, describe, expect, test } from 'bun:test';
import { WebSocket } from 'ws';

import {
  createConfiguredCodexSessionsHandler,
  type ConfiguredCodexSessionsRuntimeOptions
} from '../server/codex-sessions/configured-runtime';
import { CODEX_SESSIONS_INSPECT_CONNECTOR_CAPABILITY } from '../server/codex-sessions-connector-contract';
import { bindingForCodexSessionsRequest } from '../server/codex-sessions/connector-channel';
import { handleCodexSessionsConnectorMessage } from '../server/codex-sessions/connector-hub';
import {
  registerConnectorSession,
  removeConnectorSession
} from '../server/connector-command-session-registry';
import type { CodexSessionsStore } from '../server/codex-sessions-store';
import { runWithAuthSession } from '../server/local-auth-store';
import type { CodexSessionsTransport } from '../server/codex-sessions/service';

const machineId = 'machine-one';
const userId = 'user-owner';
const threadId = '019f5a78-3c4c-7082-bb45-5411be7d9b9a';
const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

function memoryStore() {
  const inventories: unknown[] = [];
  return {
    async appendEvent() { return 1; },
    async completeOperation() {},
    async listEvents() { return []; },
    async listInventory() { return inventories; },
    async markOperationAmbiguous() {},
    async reserveOperation() { return { kind: 'new' as const }; },
    async saveInventory(input: { sessions: unknown[] }) {
      inventories.splice(0, inventories.length, ...structuredClone(input.sessions));
    }
  } as unknown as CodexSessionsStore;
}

function transport(scopes: Array<{ machineId: string; userId: string }>): CodexSessionsTransport {
  return {
    async describeMachine({ machineId: selectedMachineId }) {
      return { id: selectedMachineId, name: 'MacBook', online: true };
    },
    async list(scope) {
      scopes.push(scope);
      return {
        checkedAt: '2026-07-13T12:00:00.000Z',
        machine: { id: scope.machineId, name: 'MacBook', online: true },
        sessions: [{
          archived: false,
          id: threadId,
          lastActivityAt: '2026-07-13T11:59:00.000Z',
          loadedByProjectSpace: false,
          machineId: scope.machineId,
          machineName: 'MacBook',
          status: 'idle',
          title: '#149 · Integrate Codex sessions'
        }]
      };
    },
    async inspect(input) {
      const sessionRevision = 'd'.repeat(64);
      return {
        checkedAt: '2026-07-13T12:00:00.000Z',
        openedReadOnly: true,
        session: {
          archived: false,
          id: input.threadId,
          lastActivityAt: '2026-07-13T11:59:00.000Z',
          loadedByProjectSpace: false,
          machineId: input.machineId,
          machineName: 'MacBook',
          status: 'idle',
          title: '#149 · Integrate Codex sessions'
        },
        sessionRevision,
        taskLocation: {
          canonicalCwd: '/projects/project-space',
          checkedAt: '2026-07-13T12:00:00.000Z',
          machineId: input.machineId,
          sessionRevision,
          source: 'connector-realpath',
          threadId: input.threadId,
          worktreeRoot: '/projects/project-space'
        }
      };
    },
    async mutate(input) {
      return {
        machineId: input.machineId,
        result: {
          operationId: input.request.operationId,
          replayed: false,
          status: 'accepted',
          threadId: input.threadId
        },
        threadId: input.threadId
      };
    },
    async read(input) {
      return {
        openedReadOnly: true,
        session: {
          archived: false,
          id: input.threadId,
          lastActivityAt: '2026-07-13T11:59:00.000Z',
          loadedByProjectSpace: false,
          machineId: input.machineId,
          machineName: 'MacBook',
          status: 'idle',
          title: '#149 · Integrate Codex sessions'
        },
        turns: []
      };
    }
  };
}

async function start(options: ConfiguredCodexSessionsRuntimeOptions) {
  const handler = createConfiguredCodexSessionsHandler(options);
  const session = { login: 'owner@example.test', role: 'user' as const, userId };
  const server = createServer((request, response) => runWithAuthSession(session, async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!await handler(request, response, url)) response.writeHead(404).end();
  }));
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address.');
  return `http://127.0.0.1:${address.port}`;
}

describe('configured Codex sessions runtime', () => {
  test('binds hosted requests to the signed-in user and selected machine', async () => {
    const scopes: Array<{ machineId: string; userId: string }> = [];
    const origin = await start({
      createStore: async () => memoryStore(),
      machineAccess: async (candidateUserId, candidateMachineId) => (
        candidateUserId === userId && candidateMachineId === machineId
      ),
      transport: transport(scopes)
    });

    const response = await fetch(`${origin}/api/codex/sessions?machineId=${machineId}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ machine: { id: machineId } });
    expect(scopes).toEqual([{ machineId, userId }]);
  });

  test('denies a machine outside the signed-in user membership', async () => {
    const scopes: Array<{ machineId: string; userId: string }> = [];
    const origin = await start({
      createStore: async () => memoryStore(),
      machineAccess: async () => false,
      transport: transport(scopes)
    });

    const response = await fetch(`${origin}/api/codex/sessions?machineId=${machineId}`);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: 'machine_access_denied',
        message: 'You do not have access to this machine.'
      }
    });
    expect(scopes).toHaveLength(0);
  });

  test('returns a safe unavailable response when runtime initialization fails', async () => {
    const origin = await start({
      createStore: async () => { throw new Error('database details must stay private'); }
    });

    const response = await fetch(`${origin}/api/codex/sessions?machineId=${machineId}`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: 'codex_sessions_unavailable',
        message: 'Codex sessions are temporarily unavailable.'
      }
    });
  });

  test('reports rejected connector identity proof as unverified instead of missing or offline', async () => {
    const originalSigningKey = process.env.PROJECT_CONNECTOR_COMMAND_SIGNING_PRIVATE_KEY;
    process.env.PROJECT_CONNECTOR_COMMAND_SIGNING_PRIVATE_KEY = generateKeyPairSync('ed25519')
      .privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const sent: unknown[] = [];
    const socket = {
      readyState: WebSocket.OPEN,
      send(value: string) {
        sent.push(JSON.parse(value));
      }
    } as unknown as WebSocket;
    registerConnectorSession(
      machineId,
      socket,
      'test-token',
      [CODEX_SESSIONS_INSPECT_CONNECTOR_CAPABILITY]
    );
    try {
      const origin = await start({
        createStore: async () => memoryStore(),
        machineAccess: async () => true
      });
      const pending = fetch(
        `${origin}/api/codex/sessions/${threadId}/inspect?machineId=${machineId}`
      );
      for (let attempts = 0; sent.length === 0 && attempts < 20; attempts += 1) {
        await Bun.sleep(1);
      }
      const command = sent[0] as {
        id: string;
        payload: Parameters<typeof bindingForCodexSessionsRequest>[0];
      };
      expect(command).toBeDefined();
      handleCodexSessionsConnectorMessage(machineId, {
        id: command.id,
        payload: {
          binding: bindingForCodexSessionsRequest(command.payload),
          error: { code: 'rejected' }
        },
        type: 'codex.sessions.error'
      });

      const response = await pending;
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: {
          code: 'task_identity_unverified',
          message: 'The current Codex task identity could not be verified.'
        }
      });
    } finally {
      removeConnectorSession(machineId, socket);
      if (originalSigningKey === undefined) {
        delete process.env.PROJECT_CONNECTOR_COMMAND_SIGNING_PRIVATE_KEY;
      } else {
        process.env.PROJECT_CONNECTOR_COMMAND_SIGNING_PRIVATE_KEY = originalSigningKey;
      }
    }
  });
});
