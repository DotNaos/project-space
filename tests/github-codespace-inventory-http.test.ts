import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, test } from 'bun:test';

import { createGitHubCodespaceRunnerHttpHandler } from '../server/github-codespace-runner/http';
import {
  GitHubCodespaceInventoryUnavailableError,
  GitHubCodespaceRunnerAuthenticationError,
  type ConfiguredGitHubCodespaceRuntime
} from '../server/github-codespace-runner/configured-runtime';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))
  ));
});

async function start(runtime: ConfiguredGitHubCodespaceRuntime) {
  const api = createGitHubCodespaceRunnerHttpHandler({ runtime });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!await api(request, response, url)) response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server address unavailable.');
  return `http://127.0.0.1:${address.port}`;
}

function runtime(
  listInventory: ConfiguredGitHubCodespaceRuntime['listInventory']
): ConfiguredGitHubCodespaceRuntime {
  return {
    listInventory,
    run: async (request) => ({
      apiVersion: 1,
      message: 'Unused runner response.',
      operationId: request.operationId,
      state: 'failed'
    })
  };
}

describe('GitHub Codespace inventory HTTP boundary', () => {
  test('serves a private no-store read-only inventory without query parameters', async () => {
    const origin = await start(runtime(async () => ({
      apiVersion: 1,
      checkedAt: '2026-08-16T09:00:00.000Z',
      codespaces: [],
      provider: { connectionState: 'connected', source: 'github_api' }
    })));
    const route = `${origin}/api/compute/github/codespaces`;

    const response = await fetch(route);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual(expect.objectContaining({
      provider: { connectionState: 'connected', source: 'github_api' }
    }));
    expect((await fetch(`${route}?repository=DotNaos/project-space`)).status).toBe(400);
    expect((await fetch(route, { method: 'POST' })).status).toBe(405);
  });

  test('sanitizes authentication and provider failures', async () => {
    const denied = await start(runtime(async () => {
      throw new GitHubCodespaceRunnerAuthenticationError('secret login detail');
    }));
    const unavailable = await start(runtime(async () => {
      throw new GitHubCodespaceInventoryUnavailableError('sensitive GitHub response');
    }));

    const deniedResponse = await fetch(`${denied}/api/compute/github/codespaces`);
    expect(deniedResponse.status).toBe(401);
    expect(await deniedResponse.json()).toEqual({
      error: { code: 'authentication_failed', message: 'Authentication failed.' }
    });

    const unavailableResponse = await fetch(`${unavailable}/api/compute/github/codespaces`);
    expect(unavailableResponse.status).toBe(503);
    expect(await unavailableResponse.json()).toEqual({
      error: {
        code: 'github_codespace_inventory_unavailable',
        message: 'GitHub Codespaces inventory is temporarily unavailable.'
      }
    });
  });

  test('does not claim unrelated routes', async () => {
    const origin = await start(runtime(async () => {
      throw new Error('Inventory must not be called.');
    }));

    const response = await fetch(`${origin}/api/not-codespaces`);
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBeNull();
  });
});
