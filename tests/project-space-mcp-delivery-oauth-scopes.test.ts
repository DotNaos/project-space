import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';

import { createProjectSpaceMcpOAuth } from '../server/project-space-mcp-oauth';
import {
  MemoryProjectSpaceMcpOAuthStore,
  projectSpaceMcpDefaultScopes,
  projectSpaceMcpDeliveryMergeScope,
  projectSpaceMcpDeliveryWriteScope,
  projectSpaceMcpSupportedScopes
} from '../server/project-space-mcp-oauth-store';

const servers: Server[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => (
  new Promise<void>((resolve) => server.close(() => resolve()))
))));

async function startOAuthServer() {
  const oauth = createProjectSpaceMcpOAuth({
    getStore: async () => new MemoryProjectSpaceMcpOAuthStore()
  });
  const server = createServer((request, response) => {
    const origin = `http://${request.headers.host}`;
    void oauth.handle(request, response, new URL(request.url ?? '/', origin))
      .then((handled) => { if (!handled) response.writeHead(404).end(); })
      .catch(() => response.writeHead(500).end());
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address.');
  return `http://127.0.0.1:${address.port}`;
}

function registration(scope?: string) {
  return {
    client_name: 'Delivery scope test client',
    grant_types: ['authorization_code', 'refresh_token'],
    redirect_uris: ['http://127.0.0.1:43123/callback'], response_types: ['code'],
    ...(scope ? { scope } : {}), token_endpoint_auth_method: 'none'
  };
}

describe('Project Space MCP Task Delivery OAuth scopes', () => {
  test('advertises delivery scopes without granting them by default', async () => {
    const origin = await startOAuthServer();
    const metadata = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
    expect(await metadata.json()).toMatchObject({
      scopes_supported: [...projectSpaceMcpSupportedScopes]
    });
    expect(projectSpaceMcpSupportedScopes).toContain(projectSpaceMcpDeliveryWriteScope);
    expect(projectSpaceMcpSupportedScopes).toContain(projectSpaceMcpDeliveryMergeScope);
    expect(projectSpaceMcpDefaultScopes).not.toContain(projectSpaceMcpDeliveryWriteScope);
    expect(projectSpaceMcpDefaultScopes).not.toContain(projectSpaceMcpDeliveryMergeScope);
  });

  test('allows both delivery scopes only when explicitly requested', async () => {
    const origin = await startOAuthServer();
    const requested = [
      projectSpaceMcpDefaultScopes[0], projectSpaceMcpDeliveryWriteScope,
      projectSpaceMcpDeliveryMergeScope
    ].join(' ');
    const registered = await fetch(`${origin}/register`, {
      body: JSON.stringify(registration(requested)),
      headers: { 'Content-Type': 'application/json' }, method: 'POST'
    });
    expect(registered.status).toBe(201);
    expect(await registered.json()).toMatchObject({ scope: requested });
  });
});
