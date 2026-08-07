import { createHash } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';

import { afterEach, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { ConfiguredCodexMachineTasksRuntime } from '../server/codex-machine-tasks/configured-runtime';
import { createProjectSpaceMcpHandler } from '../server/project-space-mcp';
import { MemoryProjectSpaceMcpOAuthStore } from '../server/project-space-mcp-oauth-store';

const originalAuthDisabled = process.env.PROJECT_SPACE_AUTH_DISABLED;
const originalPublishableKey = process.env.CLERK_PUBLISHABLE_KEY;
const originalSecretKey = process.env.CLERK_SECRET_KEY;
const servers: HttpServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  restoreEnvironment('PROJECT_SPACE_AUTH_DISABLED', originalAuthDisabled);
  restoreEnvironment('CLERK_PUBLISHABLE_KEY', originalPublishableKey);
  restoreEnvironment('CLERK_SECRET_KEY', originalSecretKey);
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

function backend() {
  return {
    async getConnectorOverview() {
      return {
        machines: [{
          connector: {
            capabilities: ['codex.machine-tasks.v1'],
            installCommand: '',
            status: 'online' as const
          },
          environment: { kind: 'linux' as const, label: 'WSL' },
          id: 'connector-wsl',
          kind: 'connector',
          name: 'Remote PC',
          roles: ['codex'],
          sourcePath: '/not-exposed',
          network: {}
        }],
        machinesRepo: { exists: true, path: '/not-exposed' },
        physicalMachines: [{ connectorIds: ['connector-wsl'], id: 'physical-pc', name: 'Remote PC' }],
        tailscale: { connected: true, installed: true, ips: [], peersOnline: 0, serveOrigins: [] }
      };
    },
    async getGitHubCatalog() {
      return {
        checkedAt: '2026-08-07T00:00:00.000Z',
        repositories: [{
          defaultBranch: 'main',
          fullName: 'DotNaos/project-space',
          id: 480,
          isPrivate: true,
          name: 'project-space',
          owner: 'DotNaos',
          projectConfig: { projectYaml: true, status: 'complete' as const, templateLock: true },
          url: 'https://github.com/DotNaos/project-space'
        }],
        status: 'connected' as const
      };
    },
    async loadProjectDiscovery() {
      return {
        groups: [],
        projects: [{
          gitStatus: {
            branchName: 'main', changed: 0, hasUnstagedChanges: false, staged: 0, unstaged: 0, untracked: 0
          },
          id: 'project-space',
          kind: 'standalone' as const,
          machineId: 'connector-wsl',
          name: 'project-space',
          rootPath: '/not-exposed'
        }],
        rootItems: [],
        rootPath: '/not-exposed',
        structureViolations: []
      };
    }
  };
}

function runtime(calls: Array<{ kind: string; request: unknown; userId: string }>) {
  return {
    service: {
      async read(actor: { userId: string }, request: unknown) {
        calls.push({ kind: 'read', request, userId: actor.userId });
        return { apiVersion: 1, state: 'blocked', reason: 'offline', message: 'offline' };
      },
      async send(actor: { userId: string }, request: unknown) {
        calls.push({ kind: 'send', request, userId: actor.userId });
        return { apiVersion: 1, operationId: 'send-test', state: 'blocked', reason: 'offline', message: 'offline' };
      },
      async start(actor: { userId: string }, request: unknown) {
        calls.push({ kind: 'start', request, userId: actor.userId });
        return { apiVersion: 1, operationId: 'start-test', state: 'ready' };
      }
    },
    sessions: {
      service: {
        async list(actor: { userId: string }, request: { machineId: string }) {
          calls.push({ kind: 'list', request, userId: actor.userId });
          return {
            checkedAt: '2026-08-07T00:00:00.000Z',
            inventoryState: 'live',
            machine: { id: request.machineId, name: 'Remote PC', online: true },
            sessions: [{
              archived: false,
              cwd: '/not-exposed',
              id: '019f6d33-6aad-7302-a45e-bb7a33fc399c',
              lastActivityAt: '2026-08-07T00:00:00.000Z',
              loadedByProjectSpace: true,
              machineId: request.machineId,
              machineName: 'Remote PC',
              status: 'idle',
              title: 'MCP task'
            }]
          };
        }
      }
    }
  } as unknown as ConfiguredCodexMachineTasksRuntime;
}

async function startMcp(
  calls: Array<{ kind: string; request: unknown; userId: string }>,
  options: Parameters<typeof createProjectSpaceMcpHandler>[0]['oauth'] = {}
) {
  const handler = createProjectSpaceMcpHandler({
    backend: backend(),
    createRuntime: async () => runtime(calls),
    oauth: options
  });
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

describe('Project Space remote MCP server', () => {
  test('publishes Project Space OAuth metadata and a Bearer challenge', async () => {
    delete process.env.PROJECT_SPACE_AUTH_DISABLED;
    const origin = await startMcp([]);

    const metadataResponse = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
    expect(metadataResponse.status).toBe(200);
    expect(await metadataResponse.json()).toMatchObject({
      authorization_servers: [`${origin}/`],
      resource: `${origin}/mcp`,
      scopes_supported: ['project-space:read', 'project-space:write']
    });

    const authorizationMetadata = await fetch(`${origin}/.well-known/oauth-authorization-server`);
    expect(await authorizationMetadata.json()).toMatchObject({
      authorization_endpoint: `${origin}/authorize`,
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      registration_endpoint: `${origin}/register`,
      token_endpoint: `${origin}/token`
    });

    const mcpResponse = await fetch(`${origin}/mcp`);
    expect(mcpResponse.status).toBe(401);
    expect(mcpResponse.headers.get('www-authenticate')).toContain(
      `resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`
    );
  });

  test('serves OAuth-declared tools and routes calls through the signed-in actor', async () => {
    process.env.PROJECT_SPACE_AUTH_DISABLED = '1';
    const calls: Array<{ kind: string; request: unknown; userId: string }> = [];
    const origin = await startMcp(calls);
    const client = new Client({ name: 'project-space-test', version: '1.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));

    const listed = await client.listTools();
    expect(listed.tools.map((entry) => entry.name)).toEqual([
      'list_projects',
      'list_machines',
      'list_codex_tasks',
      'read_codex_task',
      'start_codex_task',
      'send_codex_message'
    ]);
    expect(listed.tools[0]).toMatchObject({
      _meta: {
        securitySchemes: [{ scopes: ['project-space:read'], type: 'oauth2' }]
      },
      annotations: { readOnlyHint: true },
    });

    const projects = await client.callTool({ name: 'list_projects', arguments: {} });
    expect(projects.structuredContent).toMatchObject({
      result: { projects: [{ id: 'project-space', machineId: 'connector-wsl' }] }
    });
    expect(JSON.stringify(projects)).not.toContain('/not-exposed');

    await client.callTool({ name: 'list_codex_tasks', arguments: {} });
    const started = await client.callTool({
      name: 'start_codex_task',
      arguments: { dryRun: true, issue: 480, repositoryId: '480' }
    });
    expect(started.isError).not.toBe(true);
    expect(calls).toMatchObject([
      { kind: 'list', userId: 'local-development-user' },
      {
        kind: 'start',
        request: { dryRun: true, issue: 480, repositoryId: '480' },
        userId: 'local-development-user'
      }
    ]);
    expect((calls[1]?.request as { operationId?: string }).operationId).toMatch(/^mcp:start:/);
  });

  test('registers a public ChatGPT client and completes PKCE with rotating refresh tokens', async () => {
    delete process.env.PROJECT_SPACE_AUTH_DISABLED;
    const store = new MemoryProjectSpaceMcpOAuthStore();
    const calls: Array<{ kind: string; request: unknown; userId: string }> = [];
    const origin = await startMcp(calls, {
      getStore: async () => store,
      readSession: async (request) => request.headers.authorization === 'Bearer browser-session'
        ? { email: 'user@example.com', login: 'user@example.com', role: 'user', userId: 'user-1' }
        : null
    });
    const redirectUri = 'https://chatgpt.com/connector/oauth/test-callback';
    const registration = await fetch(`${origin}/register`, {
      body: JSON.stringify({
        client_name: 'ChatGPT',
        grant_types: ['authorization_code', 'refresh_token'],
        redirect_uris: [redirectUri],
        response_types: ['code'],
        token_endpoint_auth_method: 'none'
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
    expect(registration.status).toBe(201);
    const client = await registration.json() as { client_id: string; client_secret?: string };
    expect(client.client_id).toBeTruthy();
    expect(client.client_secret).toBeUndefined();

    const readOnlyToken = await store.createCredential({
      clientId: client.client_id,
      kind: 'access_token',
      resource: `${origin}/mcp`,
      scopes: ['project-space:read'],
      userEmail: 'user@example.com',
      userId: 'user-1'
    });
    const readOnlyClient = new Client({ name: 'read-only-test', version: '1.0.0' });
    clients.push(readOnlyClient);
    await readOnlyClient.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${readOnlyToken}` } }
    }));
    const rejectedWrite = await readOnlyClient.callTool({
      arguments: { dryRun: true, issue: 480, repositoryId: '480' },
      name: 'start_codex_task'
    });
    expect(rejectedWrite.isError).toBe(true);
    expect(rejectedWrite._meta).toMatchObject({ 'mcp/www_authenticate': [expect.stringContaining('project-space:write')] });

    const unsafeRegistration = await fetch(`${origin}/register`, {
      body: JSON.stringify({
        redirect_uris: ['https://attacker.example/callback'],
        token_endpoint_auth_method: 'none'
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
    expect(unsafeRegistration.status).toBe(400);

    const verifier = 'project-space-pkce-verifier-0123456789-abcdefghijklmnopqrstuvwxyz';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorize = new URL('/authorize', origin);
    authorize.search = new URLSearchParams({
      client_id: client.client_id,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      redirect_uri: redirectUri,
      resource: `${origin}/mcp`,
      response_type: 'code',
      scope: 'project-space:read project-space:write',
      state: 'test-state'
    }).toString();
    const authorizationResponse = await fetch(authorize, { redirect: 'manual' });
    expect(authorizationResponse.status).toBe(302);
    const approvalUrl = new URL(authorizationResponse.headers.get('location')!);
    const requestId = approvalUrl.searchParams.get('request')!;

    const approvalDetails = await fetch(`${origin}/api/mcp/oauth/authorization?request=${requestId}`, {
      headers: { Authorization: 'Bearer browser-session' }
    });
    expect(await approvalDetails.json()).toMatchObject({
      clientName: 'ChatGPT',
      scopes: ['project-space:read', 'project-space:write']
    });
    const approval = await fetch(`${origin}/api/mcp/oauth/authorization`, {
      body: JSON.stringify({ decision: 'approve', requestId }),
      headers: { Authorization: 'Bearer browser-session', 'Content-Type': 'application/json' },
      method: 'POST'
    });
    const approvalResult = await approval.json() as { redirectUrl: string };
    const authorizationCode = new URL(approvalResult.redirectUrl).searchParams.get('code')!;

    const token = await fetch(`${origin}/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        code: authorizationCode,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        resource: `${origin}/mcp`
      }),
      method: 'POST'
    });
    expect(token.status).toBe(200);
    const tokens = await token.json() as { access_token: string; refresh_token: string };

    const refresh = await fetch(`${origin}/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        resource: `${origin}/mcp`
      }),
      method: 'POST'
    });
    expect(refresh.status).toBe(200);
    const refreshed = await refresh.json() as { access_token: string; refresh_token: string };
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);
    const replay = await fetch(`${origin}/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token
      }),
      method: 'POST'
    });
    expect(replay.status).toBe(400);

    const mcpClient = new Client({ name: 'oauth-test', version: '1.0.0' });
    clients.push(mcpClient);
    await mcpClient.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${refreshed.access_token}` } }
    }));
    const projects = await mcpClient.callTool({ name: 'list_projects', arguments: {} });
    expect(projects.isError).not.toBe(true);
  });
});

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
