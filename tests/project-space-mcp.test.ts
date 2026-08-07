import { createServer, type Server as HttpServer } from 'node:http';

import { afterEach, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { ConfiguredCodexMachineTasksRuntime } from '../server/codex-machine-tasks/configured-runtime';
import { createProjectSpaceMcpHandler } from '../server/project-space-mcp';

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

async function startMcp(calls: Array<{ kind: string; request: unknown; userId: string }>) {
  const handler = createProjectSpaceMcpHandler({
    backend: backend(),
    createRuntime: async () => runtime(calls)
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
  test('publishes Clerk protected-resource metadata and a Bearer challenge', async () => {
    delete process.env.PROJECT_SPACE_AUTH_DISABLED;
    process.env.CLERK_PUBLISHABLE_KEY = `pk_test_${Buffer.from('clerk.example$').toString('base64url')}`;
    delete process.env.CLERK_SECRET_KEY;
    const origin = await startMcp([]);

    const metadataResponse = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
    expect(metadataResponse.status).toBe(200);
    expect(await metadataResponse.json()).toMatchObject({
      authorization_servers: ['https://clerk.example'],
      resource: `${origin}/mcp`,
      scopes_supported: ['openid', 'profile', 'email']
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
        securitySchemes: [{ scopes: ['openid', 'profile', 'email'], type: 'oauth2' }]
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
});

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
