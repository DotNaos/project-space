import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, test } from 'bun:test';

import { getCurrentAuthSession } from '../server/local-auth-store';
import {
  createProjectCatalogCliHttpApi,
  type ProjectCatalogCliHttpService
} from '../server/project-catalog/project-catalog-cli-http';
import { createConfiguredProjectCatalogCliHandler } from '../server/project-catalog/project-catalog-cli-runtime';
import type { ProjectCliCatalogResult } from '../src/shared/project-catalog-api';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

function result(): ProjectCliCatalogResult {
  return {
    account: { login: 'owner' },
    catalog: {
      cacheState: 'fresh',
      checkedAt: '2026-07-28T00:00:00.000Z',
      status: 'connected'
    },
    projects: [],
    schemaVersion: 1
  };
}

async function start(handler: ReturnType<typeof createProjectCatalogCliHttpApi>) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!await handler(request, response, url)) response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address.');
  return `http://127.0.0.1:${address.port}`;
}

describe('project catalog CLI HTTP boundary', () => {
  test('returns a private no-store catalog for the authenticated caller', async () => {
    const calls: unknown[] = [];
    const service: ProjectCatalogCliHttpService = {
      async list(actor) {
        calls.push(actor);
        return result();
      }
    };
    const origin = await start(createProjectCatalogCliHttpApi(
      service,
      async () => ({ callerMachineId: 'caller-mac', userId: 'owner-user' })
    ));
    const response = await fetch(`${origin}/api/projects/catalog`);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual(result());
    expect(calls).toEqual([{ callerMachineId: 'caller-mac', userId: 'owner-user' }]);
  });

  test('rejects unsupported methods and query parameters before dispatch', async () => {
    let calls = 0;
    const service: ProjectCatalogCliHttpService = {
      async list() {
        calls += 1;
        return result();
      }
    };
    const origin = await start(createProjectCatalogCliHttpApi(
      service,
      async () => ({ callerMachineId: 'caller-mac', userId: 'owner-user' })
    ));
    for (const [path, method] of [
      ['/api/projects/catalog?other=1', 'GET'],
      ['/api/projects/catalog', 'POST']
    ]) {
      const response = await fetch(`${origin}${path}`, { method });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: 'invalid_request' }
      });
    }
    expect(calls).toBe(0);
  });

  test('binds the machine credential to its account and caller machine only', async () => {
    let sessionUser = '';
    let discoveryUser = '';
    const handler = createConfiguredProjectCatalogCliHandler({
      backend: {
        async getGitHubCatalog() {
          sessionUser = getCurrentAuthSession()?.userId ?? '';
          return {
            checkedAt: '2026-07-28T00:00:00.000Z',
            repositories: [],
            status: 'connected'
          };
        },
        async loadProjectDiscovery() {
          discoveryUser = getCurrentAuthSession()?.userId ?? '';
          return {
            groups: [],
            projects: [],
            rootItems: [],
            rootPath: '',
            structureViolations: []
          };
        }
      },
      machineConnection: {
        async resolveMachineCredentialIdentity(token, machineId) {
          return token === 'machine-token' && machineId === 'caller-mac'
            ? { machineId, userId: 'owner-user' }
            : null;
        }
      }
    });
    const origin = await start(handler);
    const response = await fetch(`${origin}/api/projects/catalog`, {
      headers: {
        Authorization: 'Bearer machine-token',
        'X-Project-Machine-ID': 'caller-mac'
      }
    });

    expect(response.status).toBe(200);
    expect(sessionUser).toBe('owner-user');
    expect(discoveryUser).toBe('owner-user');
  });

  test('returns a structured authentication error without dispatch', async () => {
    const origin = await start(createConfiguredProjectCatalogCliHandler({
      backend: {
        async getGitHubCatalog() { throw new Error('must not run'); },
        async loadProjectDiscovery() { throw new Error('must not run'); }
      },
      machineConnection: {
        async resolveMachineCredentialIdentity() { return null; }
      }
    }));
    const response = await fetch(`${origin}/api/projects/catalog`, {
      headers: {
        Authorization: 'Bearer wrong',
        'X-Project-Machine-ID': 'caller-mac'
      }
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: 'authentication_failed',
        message: 'Project Space machine authentication failed.'
      }
    });
  });
});
