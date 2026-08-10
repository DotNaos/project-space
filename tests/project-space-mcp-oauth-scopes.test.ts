import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';

import { createProjectSpaceMcpOAuth } from '../server/project-space-mcp-oauth';
import {
  MemoryProjectSpaceMcpOAuthStore,
  projectSpaceMcpDefaultScopes,
  projectSpaceMcpEnvironmentDeleteScope,
  projectSpaceMcpEnvironmentManageScope,
  projectSpaceMcpSupportedScopes
} from '../server/project-space-mcp-oauth-store';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

async function startOAuthServer() {
  const store = new MemoryProjectSpaceMcpOAuthStore();
  const oauth = createProjectSpaceMcpOAuth({ getStore: async () => store });
  const server = createServer((request, response) => {
    const origin = `http://${request.headers.host}`;
    void oauth.handle(
      request,
      response,
      new URL(request.url ?? '/', origin)
    ).then((handled) => {
      if (!handled) response.writeHead(404).end();
    }).catch(() => response.writeHead(500).end());
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address.');
  return `http://127.0.0.1:${address.port}`;
}

function registration(scope?: string) {
  return {
    client_name: 'Lifecycle test client',
    grant_types: ['authorization_code', 'refresh_token'],
    redirect_uris: ['http://127.0.0.1:43123/callback'],
    response_types: ['code'],
    ...(scope ? { scope } : {}),
    token_endpoint_auth_method: 'none'
  };
}

describe('Project Space MCP lifecycle OAuth scopes', () => {
  test('advertises lifecycle scopes without granting them by default', async () => {
    const origin = await startOAuthServer();
    const metadata = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      scopes_supported: [...projectSpaceMcpSupportedScopes]
    });

    const registered = await fetch(`${origin}/register`, {
      body: JSON.stringify(registration()),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
    expect(registered.status).toBe(201);
    expect(await registered.json()).toMatchObject({
      scope: projectSpaceMcpDefaultScopes.join(' ')
    });
    expect(projectSpaceMcpDefaultScopes).not.toContain(
      projectSpaceMcpEnvironmentManageScope
    );
    expect(projectSpaceMcpDefaultScopes).not.toContain(
      projectSpaceMcpEnvironmentDeleteScope
    );
  });

  test('allows explicit lifecycle scope registration and rejects unknown scopes', async () => {
    const origin = await startOAuthServer();
    const requested = [
      projectSpaceMcpDefaultScopes[0],
      projectSpaceMcpEnvironmentManageScope
    ].join(' ');
    const registered = await fetch(`${origin}/register`, {
      body: JSON.stringify(registration(requested)),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
    expect(registered.status).toBe(201);
    expect(await registered.json()).toMatchObject({ scope: requested });

    const rejected = await fetch(`${origin}/register`, {
      body: JSON.stringify(registration('project-space:environment.root')),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
    expect(rejected.status).toBe(400);
  });
});
