import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, test } from 'bun:test';

import {
  isConnectorCommandChannelAuthenticated,
  isConnectorCommandChannelAvailable
} from '../server/connector-command-hub';
import type { MachineConnectionRuntime } from '../server/machine-connection-runtime';
import type { ProjectChatRuntime } from '../server/project-chat/runtime';
import { startProjectConnectorWebSocket } from '../server/project-connector-websocket';
import { createProjectSpaceServer } from '../server/project-space-http';
import type { ProjectSpaceBackend } from '../src/shared/project-space-api';

const originalAuthDisabled = process.env.PROJECT_SPACE_AUTH_DISABLED;

function restoreEnvironment() {
  if (originalAuthDisabled === undefined) {
    delete process.env.PROJECT_SPACE_AUTH_DISABLED;
  } else {
    process.env.PROJECT_SPACE_AUTH_DISABLED = originalAuthDisabled;
  }
}

afterEach(restoreEnvironment);

class TestMachineConnectionRuntime implements MachineConnectionRuntime {
  authenticationCalls: Array<{ machineId: string; token: string }> = [];
  identityCalls: Array<{ machineId: string; token: string }> = [];
  requestCalls: string[] = [];
  starts = 0;
  stops = 0;

  async authenticateConnectorCredential(token: string, machineId: string) {
    this.authenticationCalls.push({ machineId, token });
    return token === 'machine-secret' && machineId === 'machine-runtime';
  }

  async resolveMachineCredentialIdentity(token: string, machineId: string) {
    this.identityCalls.push({ machineId, token });
    return token === 'machine-secret' && machineId === 'machine-runtime'
      ? {
          hostId: 'runtime-host',
          machineId: 'machine-runtime',
          userId: 'runtime-user'
        }
      : null;
  }

  async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ) {
    this.requestCalls.push(url.pathname);
    if (request.method !== 'GET' || url.pathname !== '/api/machine-probe') {
      return false;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ authorization: request.headers.authorization }));
    return true;
  }

  async runMaintenance() {}

  start() {
    this.starts += 1;
  }

  async stop() {
    this.stops += 1;
  }
}

class TestProjectChatRuntime implements ProjectChatRuntime {
  starts = 0;
  stops = 0;

  async handleRequest() {
    return false;
  }

  start() {
    this.starts += 1;
  }

  stop() {
    this.stops += 1;
  }
}

function connectorBackend() {
  return {
    async getConnectorProjectRegistry() {
      return {
        checkedAt: new Date().toISOString(),
        connector: {
          machineId: 'machine-runtime',
          machineName: 'Runtime machine'
        },
        discovery: {
          groups: [],
          projects: [],
          rootItems: [],
          rootPath: '/tmp',
          structureViolations: []
        }
      };
    }
  } as unknown as ProjectSpaceBackend;
}

async function waitForChannel(machineId: string, available: boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (isConnectorCommandChannelAvailable(machineId) === available) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Connector channel did not become ${available ? 'available' : 'closed'}.`);
}

describe('machine connection HTTP integration', () => {
  test('routes machine bearer requests before the generic Clerk gate', async () => {
    delete process.env.PROJECT_SPACE_AUTH_DISABLED;
    const machineRuntime = new TestMachineConnectionRuntime();
    const server = await createProjectSpaceServer({
      host: '127.0.0.1',
      machineConnectionRuntime: machineRuntime,
      port: 0,
      projectChatRuntime: new TestProjectChatRuntime()
    });

    try {
      const machineResponse = await fetch(`${server.origin}/api/machine-probe`, {
        headers: { Authorization: 'Bearer machine-poll-secret' }
      });
      expect(machineResponse.status).toBe(200);
      expect(await machineResponse.json()).toEqual({
        authorization: 'Bearer machine-poll-secret'
      });

      const genericResponse = await fetch(`${server.origin}/api/not-a-machine-route`, {
        headers: { Authorization: 'Bearer machine-poll-secret' }
      });
      expect(genericResponse.status).toBe(401);
      expect(machineRuntime.requestCalls).toEqual([
        '/api/machine-probe',
        '/api/not-a-machine-route'
      ]);
    } finally {
      await server.close();
    }

    expect(machineRuntime.starts).toBe(1);
    expect(machineRuntime.stops).toBe(1);
  });

  test('authenticates the live connector through the machine runtime', async () => {
    const machineRuntime = new TestMachineConnectionRuntime();
    const server = await createProjectSpaceServer({
      host: '127.0.0.1',
      machineConnectionRuntime: machineRuntime,
      port: 0,
      projectChatRuntime: new TestProjectChatRuntime()
    });
    const bridge = startProjectConnectorWebSocket({
      backend: connectorBackend(),
      reconnectDelayMs: 10,
      registryIntervalMs: 1_000,
      runtimeCredential: {
        backendUrl: server.origin,
        credential: 'machine-secret',
        machineId: 'machine-runtime',
        version: 'project-space.connector-runtime/v1'
      }
    });

    try {
      await waitForChannel('machine-runtime', true);
      expect(machineRuntime.identityCalls).toEqual([
        { machineId: 'machine-runtime', token: 'machine-secret' }
      ]);
      expect(machineRuntime.authenticationCalls).toEqual([]);
      expect(
        isConnectorCommandChannelAuthenticated('machine-runtime', 'machine-secret')
      ).toBe(true);
      expect(
        isConnectorCommandChannelAuthenticated('machine-runtime', 'rotated-secret')
      ).toBe(false);
    } finally {
      bridge.close();
      await waitForChannel('machine-runtime', false);
      await server.close();
    }
  });

  test('stops both runtimes when the HTTP listener cannot start', async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    const port = (occupied.address() as AddressInfo).port;
    const machineRuntime = new TestMachineConnectionRuntime();
    const projectChatRuntime = new TestProjectChatRuntime();

    try {
      await expect(
        createProjectSpaceServer({
          host: '127.0.0.1',
          machineConnectionRuntime: machineRuntime,
          port,
          projectChatRuntime
        })
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }

    expect(machineRuntime.starts).toBe(1);
    expect(machineRuntime.stops).toBe(1);
    expect(projectChatRuntime.starts).toBe(1);
    expect(projectChatRuntime.stops).toBe(1);
  });
});
