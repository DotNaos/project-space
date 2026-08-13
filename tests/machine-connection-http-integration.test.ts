import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, test } from 'bun:test';

import type { MachineConnectionRuntime } from '../server/machine-connection-runtime';
import type { ProjectChatRuntime } from '../server/project-chat/runtime';
import { createProjectSpaceServer } from '../server/project-space-http';

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
  identityCalls: Array<{ machineId: string; token: string }> = [];
  requestCalls: string[] = [];
  starts = 0;
  stops = 0;

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

  test('retires the permanent Connector before machine authentication', async () => {
    const machineRuntime = new TestMachineConnectionRuntime();
    const server = await createProjectSpaceServer({
      host: '127.0.0.1',
      machineConnectionRuntime: machineRuntime,
      port: 0,
      projectChatRuntime: new TestProjectChatRuntime()
    });
    try {
      const response = await fetch(`${server.origin}/api/connectors/project-registry`, {
        headers: {
          Authorization: 'Bearer machine-secret',
          'X-Project-Machine-Id': 'machine-runtime'
        },
        method: 'POST'
      });
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({ code: 'canonical_runtime_required' });
      expect(machineRuntime.identityCalls).toEqual([]);
    } finally {
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
