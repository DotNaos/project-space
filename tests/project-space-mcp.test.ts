import { createHash } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';

import { afterEach, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type { AgentRuntimeService } from '../server/agent-authorization/service';
import type { ConfiguredCodexMachineTasksRuntime } from '../server/codex-machine-tasks/configured-runtime';
import { computeInventoryFromConnectors } from '../server/compute-inventory';
import type {
  ExecutionEnvironmentLifecycleService
} from '../server/execution-environment-lifecycle/service';
import { observeHttpRequest } from '../server/http-observability';
import {
  createProjectSpaceLogger,
  type ProjectSpaceLogger,
  type ProjectSpaceLogRecord
} from '../server/observability';
import { createProjectSpaceMcpHandler } from '../server/project-space-mcp';
import type { LoadMcpComputeInventory } from '../server/project-space-mcp/compute-environments';
import { MemoryProjectSpaceMcpOAuthStore } from '../server/project-space-mcp-oauth-store';
import type { TaskExecutionService } from '../server/task-execution/service';
import type { WorkspaceCommandService } from '../server/workspace-command/service';

const originalAuthDisabled = process.env.PROJECT_SPACE_AUTH_DISABLED;
const originalPublishableKey = process.env.CLERK_PUBLISHABLE_KEY;
const originalSecretKey = process.env.CLERK_SECRET_KEY;
const originalNodeEnv = process.env.NODE_ENV;
const servers: HttpServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  restoreEnvironment('PROJECT_SPACE_AUTH_DISABLED', originalAuthDisabled);
  restoreEnvironment('CLERK_PUBLISHABLE_KEY', originalPublishableKey);
  restoreEnvironment('CLERK_SECRET_KEY', originalSecretKey);
  restoreEnvironment('NODE_ENV', originalNodeEnv);
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
            daemon: {
              authenticated: true,
              checkedAt: '2026-08-07T00:00:00.000Z',
              cliVersion: '0.1.0',
              compatible: true,
              installed: true,
              paired: false,
              reachable: true,
              remoteControlEnabled: false,
              remoteControlState: 'disabled' as const,
              running: true,
              state: 'ready' as const
            },
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
    async getGitHubRepositoryDetails() {
      return {
        branches: [{
          commitSha: 'abc123',
          isDefault: false,
          linkedIssueNumbers: [480],
          name: 'task/480',
          url: 'https://github.com/DotNaos/project-space/tree/task/480'
        }],
        checkedAt: '2026-08-07T00:00:00.000Z',
        issues: [{
          author: 'oli',
          body: 'Build the MCP task discovery flow.',
          id: 9001,
          labels: ['enhancement'],
          number: 480,
          state: 'open' as const,
          title: 'Add GitHub task discovery',
          updatedAt: '2026-08-07T12:00:00.000Z',
          url: 'https://github.com/DotNaos/project-space/issues/480'
        }, {
          author: 'oli',
          body: 'Already completed.',
          id: 9002,
          labels: [],
          number: 479,
          state: 'closed' as const,
          title: 'Old task',
          updatedAt: '2026-08-06T12:00:00.000Z',
          url: 'https://github.com/DotNaos/project-space/issues/479'
        }],
        pullRequests: [{
          author: { login: 'oli' },
          baseBranch: 'main',
          checksStatus: 'passing' as const,
          headBranch: 'task/480',
          headSha: 'abc123',
          isDraft: true,
          linkedIssueNumbers: [480],
          number: 482,
          state: 'open' as const,
          title: 'Task 480 implementation',
          url: 'https://github.com/DotNaos/project-space/pull/482'
        }],
        status: 'connected' as const
      };
    },
    async getGitHubPipelineStatus() {
      return {
        checkedAt: '2026-08-07T13:30:00.000Z',
        pagination: { hasNext: false, page: 1, perPage: 20 },
        runs: [{
          branch: 'task/480',
          conclusion: 'success' as const,
          createdAt: '2026-08-07T13:20:00.000Z',
          displayTitle: 'Task 480 implementation',
          headSha: 'abc123',
          id: 8001,
          kind: 'ci' as const,
          name: 'CI',
          status: 'completed' as const,
          updatedAt: '2026-08-07T13:30:00.000Z',
          url: 'https://github.com/DotNaos/project-space/actions/runs/8001'
        }],
        status: 'connected' as const
      };
    },
    async createGitHubIssue(request: { body?: string; fullName: string; labels?: string[]; operationId: string; title: string }) {
      return {
        creationState: 'complete' as const,
        issue: {
          author: 'oli',
          body: request.body,
          labels: request.labels ?? [],
          number: 481,
          state: 'open' as const,
          title: request.title,
          url: `https://github.com/${request.fullName}/issues/481`
        },
        status: 'connected' as const
      };
    },
    async updateGitHubIssue(request: { body?: string; fullName: string; labels?: string[]; number: number; state?: 'open' | 'closed'; title?: string }) {
      return {
        issue: {
          author: 'oli',
          body: request.body,
          labels: request.labels ?? [],
          number: request.number,
          state: request.state ?? 'open',
          title: request.title ?? 'Updated task',
          url: `https://github.com/${request.fullName}/issues/${request.number}`
        },
        status: 'connected' as const
      };
    },
    async getGitHubIssueComments() {
      return {
        comments: [{
          author: 'oli',
          body: 'Looks good.',
          createdAt: '2026-08-07T13:00:00.000Z',
          id: 7001,
          url: 'https://github.com/DotNaos/project-space/issues/480#issuecomment-7001'
        }],
        status: 'connected' as const
      };
    },
    async createGitHubIssueComment(request: { body: string; fullName: string; number: number }) {
      return {
        comment: {
          author: 'oli',
          body: request.body,
          createdAt: '2026-08-07T14:00:00.000Z',
          id: 7002,
          url: `https://github.com/${request.fullName}/issues/${request.number}#issuecomment-7002`
        },
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
        if ((request as { dryRun?: boolean }).dryRun) {
          return { apiVersion: 1, operationId: 'start-test', state: 'ready' };
        }
        return {
          apiVersion: 1,
          operationId: 'start-test-confirmed',
          state: 'confirmed',
          task: {
            canonicalTaskUrl: 'https://projects.os-home.net/tasks/test',
            issue: { number: 480, url: 'https://github.com/DotNaos/project-space/issues/480' },
            repository: { id: '480', nameWithOwner: 'DotNaos/project-space' },
            threadId: '019f6d33-6aad-7302-a45e-bb7a33fc399c',
            worktree: { branch: 'task/480', id: 'worktree-480' }
          }
        };
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

function environmentLifecycle(
  calls: Array<{ kind: string; request: unknown; userId: string }>
): ExecutionEnvironmentLifecycleService {
  const result = (action: 'delete' | 'provision' | 'start' | 'status' | 'stop', operationId: string) => ({
    action,
    apiVersion: 1 as const,
    lifecycle: {
      normalized: action === 'delete' ? 'deleted' as const : 'running' as const,
      observedAt: '2026-08-07T00:00:00.000Z'
    },
    message: 'Lifecycle test result.',
    operationId,
    provider: { kind: 'github_codespaces' as const },
    reconciliation: { checkedAt: '2026-08-07T00:00:00.000Z', state: 'confirmed' as const }
  });
  return {
    async delete(actor, request) {
      calls.push({ kind: 'environment-delete', request, userId: actor.userId });
      return result('delete', request.operationId);
    },
    async list() { return []; },
    async provision(actor, request) {
      calls.push({ kind: 'environment-provision', request, userId: actor.userId });
      return result('provision', request.operationId);
    },
    async start(actor, request) {
      calls.push({ kind: 'environment-start', request, userId: actor.userId });
      return result('start', request.operationId);
    },
    async status(_actor, _environmentId) { return result('status', 'status:test'); },
    async stop(actor, request) {
      calls.push({ kind: 'environment-stop', request, userId: actor.userId });
      return result('stop', request.operationId);
    }
  };
}

function agentRuntime(
  calls: Array<{ kind: string; request: unknown; userId: string }>
): AgentRuntimeService {
  return {
    async authorize(action, actor, request) {
      calls.push({ kind: `agent-${action}`, request, userId: actor.userId });
      return {
        action,
        agent: request.agent,
        apiVersion: 1,
        checkedAt: '2026-08-07T00:00:00.000Z',
        environmentId: request.environmentId,
        message: 'Agent authorization test result.',
        operationId: request.operationId,
        state: action === 'start' ? 'pending' : action === 'cancel' ? 'cancelled' : 'ready'
      };
    },
    async status(actor, request) {
      calls.push({ kind: 'agent-status', request, userId: actor.userId });
      return {
        agent: request.agent,
        apiVersion: 1,
        environmentId: request.environmentId,
        message: 'Agent status test result.',
        runtime: {
          authorization: { state: 'ready' },
          capabilities: ['codex.runtime.v1'],
          checkedAt: '2026-08-07T00:00:00.000Z',
          state: 'ready'
        }
      };
    }
  };
}

function taskExecutionRuntime(
  calls: Array<{ kind: string; request: unknown; userId: string }>
): TaskExecutionService {
  const handoff = {
    acceptanceCriteria: ['The implementation matches the approved design.'],
    artifacts: [],
    constraints: ['Do not depend on a local filesystem path.'],
    context: 'The design was produced by another orchestrator.',
    createdAt: '2026-08-09T00:00:00.000Z',
    createdBy: { id: 'mcp:test-client', kind: 'orchestrator' as const },
    decisions: ['Transfer the complete design through Project Space.'],
    handoffId: '33333333-3333-4333-8333-333333333333',
    objective: 'Implement the verified cross-machine design.',
    requestedMode: 'implement' as const,
    requestedPermissions: {
      delivery: 'pull_request' as const,
      network: 'restricted' as const,
      repository: 'write' as const,
      task: 'write' as const,
      workspace: 'write' as const
    },
    revision: 1,
    taskId: 'github:DotNaos/project-space:548'
  };
  const execution = {
    agent: 'codex' as const,
    createdAt: '2026-08-09T00:00:00.000Z',
    environmentId: '11111111-1111-4111-8111-111111111111',
    executor: { externalId: '22222222-2222-4222-8222-222222222222' },
    handoff: { id: '33333333-3333-4333-8333-333333333333', revision: 1 },
    id: '44444444-4444-4444-8444-444444444444',
    source: {
      branch: 'issue-548-task-execution', commit: 'a'.repeat(40), provider: 'github' as const,
      providerTaskId: '548', repositoryId: '480',
      taskId: 'github:DotNaos/project-space:548'
    },
    state: 'running' as const,
    updatedAt: '2026-08-09T00:00:00.000Z',
    version: 4
  };
  const result = (operationId?: string) => ({
    apiVersion: 1 as const,
    events: [],
    execution,
    message: 'Task Execution is running.',
    ...(operationId ? { operationId } : {})
  });
  const record = (kind: string, actor: { userId: string }, request: unknown) => {
    calls.push({ kind, request, userId: actor.userId });
    return result((request as { operationId?: string }).operationId);
  };
  return {
    archive: async (actor, request) => record('execution-archive', actor, request),
    cancel: async (actor, request) => record('execution-cancel', actor, request),
    createHandoff: async (actor, request) => {
      calls.push({ kind: 'handoff-create', request, userId: actor.userId });
      return {
        apiVersion: 1,
        handoff,
        message: 'Task Handoff revision created.',
        operationId: request.operationId
      };
    },
    get: async (actor, request) => record('execution-get', actor, request),
    getHandoff: async (actor, request) => {
      calls.push({ kind: 'handoff-get', request, userId: actor.userId });
      return { apiVersion: 1, handoff, message: 'Task Handoff revision loaded.' };
    },
    list: async (actor, request) => {
      calls.push({ kind: 'execution-list', request, userId: actor.userId });
      return { apiVersion: 1, executions: [execution] };
    },
    readByExecutor: async (actor, _agent, externalId, afterCursor, limit) => {
      calls.push({
        kind: 'execution-read-by-executor',
        request: { afterCursor, externalId, limit },
        userId: actor.userId
      });
      return externalId === execution.executor.externalId ? result() : undefined;
    },
    respondApproval: async (actor, request) => record('execution-approval', actor, request),
    respondInput: async (actor, request) => record('execution-input', actor, request),
    send: async (actor, request) => record('execution-send', actor, request),
    start: async (actor, request) => record('execution-start', actor, request),
    updateHandoff: async (actor, request) => {
      calls.push({ kind: 'handoff-update', request, userId: actor.userId });
      return {
        apiVersion: 1,
        execution,
        message: 'Task Execution Handoff updated.',
        operationId: request.operationId,
        state: 'updated'
      };
    },
    wait: async (actor, request) => {
      calls.push({ kind: 'execution-wait', request, userId: actor.userId });
      return { apiVersion: 1, executions: [result()], timedOut: false };
    }
  };
}

async function startMcp(
  calls: Array<{ kind: string; request: unknown; userId: string }>,
  options: Parameters<typeof createProjectSpaceMcpHandler>[0]['oauth'] = {},
  dependencies: {
    backend?: ReturnType<typeof backend>;
    agentRuntime?: AgentRuntimeService;
    environmentLifecycle?: ExecutionEnvironmentLifecycleService;
    loadComputeInventory?: LoadMcpComputeInventory;
    logger?: ProjectSpaceLogger;
    taskExecutions?: TaskExecutionService;
    workspaceCommands?: WorkspaceCommandService;
  } = {}
) {
  const logger = dependencies.logger ?? createProjectSpaceLogger({
    environment: { NODE_ENV: 'test' },
    sink: { write() {} }
  });
  const selectedBackend = dependencies.backend ?? backend();
  const handler = createProjectSpaceMcpHandler({
    backend: selectedBackend,
    createAgentRuntime: async () => dependencies.agentRuntime ?? agentRuntime(calls),
    createEnvironmentLifecycle: async () => (
      dependencies.environmentLifecycle ?? environmentLifecycle(calls)
    ),
    ...(dependencies.taskExecutions ? {
      createTaskExecutions: async () => dependencies.taskExecutions!
    } : {}),
    createWorkspaceCommands: async () => dependencies.workspaceCommands ?? {
      cancelRecovery: async (actor, request) => workspaceResult(calls, 'workspace-cancel-recovery', actor, request),
      cancelWorkspace: async (actor, request) => workspaceResult(calls, 'workspace-cancel', actor, request),
      get: async (actor, request) => workspaceResult(calls, 'workspace-get', actor, request),
      startRecovery: async (actor, request, approve) => {
        if (!await approve()) throw new Error('Recovery command was not approved.');
        return workspaceResult(calls, 'workspace-start-recovery', actor, request);
      },
      startWorkspace: async (actor, request) => workspaceResult(calls, 'workspace-start', actor, request)
    },
    createRuntime: async () => runtime(calls),
    loadComputeInventory: dependencies.loadComputeInventory ?? (async () => {
      const overview = await selectedBackend.getConnectorOverview();
      return {
        checkedAt: '2026-08-07T00:00:00.000Z',
        connectors: overview.machines,
        generations: new Map([['connector-wsl', 1]]),
        snapshot: computeInventoryFromConnectors({
          connectors: overview.machines,
          physicalMachines: overview.physicalMachines
        })
      };
    }),
    logger,
    oauth: options
  });
  const server = createServer((request, response) => {
    void observeHttpRequest(request, response, async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (!await handler(request, response, url)) response.writeHead(404).end();
    }, logger);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address.');
  return `http://127.0.0.1:${address.port}`;
}

function workspaceResult(
  calls: Array<{ kind: string; request: unknown; userId: string }>,
  kind: string,
  actor: { userId: string },
  request: unknown
) {
  calls.push({ kind, request, userId: actor.userId });
  const input = request as { commandId?: string; environmentId?: string; executionId?: string };
  return {
    apiVersion: 1 as const,
    auditId: '55555555-5555-4555-8555-555555555555',
    checkedAt: '2026-08-09T00:00:00.000Z',
    commandId: input.commandId ?? '66666666-6666-4666-8666-666666666666',
    environmentId: input.environmentId ?? '11111111-1111-4111-8111-111111111111',
    ...(input.executionId ? { executionId: input.executionId } : {}),
    message: 'The workspace command is running.', nextCursor: 0, output: [],
    scope: kind.includes('recovery') ? 'environment_recovery' as const : 'workspace' as const,
    state: 'running' as const,
    target: { kind: kind.includes('recovery')
      ? 'github_codespace_recovery' as const : 'connector_workspace' as const },
    truncated: false
  };
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
      scopes_supported: [
        'project-space:read',
        'project-space:write',
        'project-space:agent.authorize',
        'project-space:execution.approve',
        'project-space:execution.write',
        'project-space:task.write',
        'project-space:shell.workspace',
        'project-space:shell.recovery',
        'project-space:environment.manage',
        'project-space:environment.delete'
      ]
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

  test('registers Codex loopback OAuth callbacks in production', async () => {
    delete process.env.PROJECT_SPACE_AUTH_DISABLED;
    process.env.NODE_ENV = 'production';
    const origin = await startMcp([], {
      getStore: async () => new MemoryProjectSpaceMcpOAuthStore()
    });

    for (const redirectUri of [
      'http://127.0.0.1:43821/callback',
      'http://localhost:43821/callback',
      'http://[::1]:43821/callback'
    ]) {
      const registration = await fetch(`${origin}/register`, {
        body: JSON.stringify({
          client_name: 'Codex',
          grant_types: ['authorization_code', 'refresh_token'],
          redirect_uris: [redirectUri],
          response_types: ['code'],
          token_endpoint_auth_method: 'none'
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST'
      });

      expect(registration.status).toBe(201);
    }

    const unsafeRegistration = await fetch(`${origin}/register`, {
      body: JSON.stringify({
        redirect_uris: ['https://127.0.0.1.attacker.example/callback'],
        token_endpoint_auth_method: 'none'
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
    expect(unsafeRegistration.status).toBe(400);
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
      'list_tasks',
      'get_task',
      'get_task_status',
      'create_task',
      'update_task',
      'list_task_comments',
      'add_task_comment',
      'list_execution_environments',
      'get_execution_environment',
      'get_agent_status',
      'start_agent_authorization',
      'get_agent_authorization',
      'cancel_agent_authorization',
      'provision_execution_environment',
      'start_execution_environment',
      'stop_execution_environment',
      'delete_execution_environment',
      'create_task_handoff',
      'get_task_handoff',
      'update_task_execution_handoff',
      'start_task_execution',
      'list_task_executions',
      'get_task_execution',
      'wait_task_execution',
      'send_task_execution_message',
      'respond_task_execution_approval',
      'respond_task_execution_input',
      'cancel_task_execution',
      'archive_task_execution',
      'start_workspace_command',
      'get_workspace_command',
      'cancel_workspace_command',
      'start_environment_recovery_command',
      'cancel_environment_recovery_command',
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

    const workspaceCommand = await client.callTool({
      name: 'start_workspace_command',
      arguments: {
        command: 'git status --short',
        executionId: '44444444-4444-4444-8444-444444444444',
        operationId: 'workspace:start:integration'
      }
    });
    expect(workspaceCommand.structuredContent).toMatchObject({
      result: { scope: 'workspace', state: 'running' }
    });
    expect(calls).toContainEqual({
      kind: 'workspace-start',
      request: {
        command: 'git status --short',
        executionId: '44444444-4444-4444-8444-444444444444',
        operationId: 'workspace:start:integration'
      },
      userId: 'local-development-user'
    });

    const projects = await client.callTool({ name: 'list_projects', arguments: {} });
    expect(projects.structuredContent).toMatchObject({
      result: { projects: [{ id: 'project-space', machineId: 'connector-wsl' }] }
    });
    expect(JSON.stringify(projects)).not.toContain('/not-exposed');

    const environmentInventory = await client.callTool({
      name: 'list_execution_environments',
      arguments: { capability: 'codex.machine-tasks.v1', kind: 'native_linux', platform: 'local' }
    });
    expect(environmentInventory.structuredContent).toMatchObject({
      result: {
        environments: [{
          agentRuntimes: [{
            authorization: { state: 'ready' },
            kind: 'codex',
            state: 'ready'
          }],
          capacity: { state: 'unknown' },
          hostAssociation: { host: { name: 'Remote PC' }, resolution: 'manual' },
          kind: 'native_linux',
          name: 'WSL',
          platform: { kind: 'local' },
          providerLifecycle: { state: 'unmanaged' },
          readiness: {
            pendingEvidence: ['workspace', 'capacity'],
            selectedConnectorId: 'connector-wsl',
            state: 'checking'
          }
        }],
        inventoryState: 'ready'
      }
    });
    expect(JSON.stringify(environmentInventory)).not.toContain('/not-exposed');
    const environmentId = (
      environmentInventory.structuredContent as { result: { environments: Array<{ id: string }> } }
    ).result.environments[0]!.id;
    const exactEnvironment = await client.callTool({
      name: 'get_execution_environment',
      arguments: { environmentId }
    });
    expect(exactEnvironment.structuredContent).toMatchObject({
      result: { environment: { id: environmentId, kind: 'native_linux' } }
    });
    const agentStatus = await client.callTool({
      name: 'get_agent_status',
      arguments: { agent: 'codex', environmentId }
    });
    expect(agentStatus.structuredContent).toMatchObject({
      result: { agent: 'codex', environmentId, runtime: { authorization: { state: 'ready' } } }
    });
    const authorization = await client.callTool({
      name: 'start_agent_authorization',
      arguments: { agent: 'codex', environmentId, operationId: 'agent:authorization:test' }
    });
    expect(authorization.structuredContent).toMatchObject({
      result: { action: 'start', environmentId, operationId: 'agent:authorization:test', state: 'pending' }
    });
    const missingEnvironment = await client.callTool({
      name: 'get_execution_environment',
      arguments: { environmentId: 'missing-environment' }
    });
    expect(missingEnvironment.isError).toBe(true);

    const provisionedEnvironment = await client.callTool({
      name: 'provision_execution_environment',
      arguments: {
        branch: 'task/480',
        operationId: 'mcp:environment:provision:480',
        provider: 'github_codespaces',
        repositoryId: '480',
        task: 480
      }
    });
    expect(provisionedEnvironment.structuredContent).toMatchObject({
      result: { action: 'provision', lifecycle: { normalized: 'running' } }
    });

    const tasks = await client.callTool({
      name: 'list_tasks',
      arguments: { repositoryId: '480' }
    });
    expect(tasks.structuredContent).toMatchObject({
      result: {
        status: 'connected',
        tasks: [{
          id: 'github:DotNaos/project-space:480',
          provider: 'github',
          repository: 'DotNaos/project-space',
          state: 'open',
          title: 'Add GitHub task discovery'
        }]
      }
    });

    const allTasks = await client.callTool({
      name: 'list_tasks',
      arguments: { limit: 1, repositoryId: '480', state: 'all' }
    });
    expect(allTasks.structuredContent).toMatchObject({
      result: { tasks: [{ number: 480 }], truncated: true }
    });

    const searchedTasks = await client.callTool({
      name: 'list_tasks',
      arguments: { repositoryId: '480', search: 'completed', state: 'all' }
    });
    expect(searchedTasks.structuredContent).toMatchObject({
      result: { tasks: [{ number: 479, state: 'closed' }] }
    });

    const unknownRepository = await client.callTool({
      name: 'list_tasks',
      arguments: { repositoryId: 'unknown/repository' }
    });
    expect(unknownRepository.structuredContent).toMatchObject({
      result: { catalogStatus: 'connected', repositoryId: 'unknown/repository' }
    });

    const task = await client.callTool({
      name: 'get_task',
      arguments: { repositoryId: 'DotNaos/project-space', task: 480 }
    });
    expect(task.structuredContent).toMatchObject({
      result: { task: { number: 480, title: 'Add GitHub task discovery' } }
    });

    const taskStatus = await client.callTool({
      name: 'get_task_status',
      arguments: { repositoryId: '480', task: 480 }
    });
    expect(taskStatus.structuredContent).toMatchObject({
      result: {
        branches: [{ name: 'task/480' }],
        pipeline: { runs: [{ id: 8001, branch: 'task/480' }] },
        pullRequests: [{ number: 482, state: 'open' }]
      }
    });

    const createdTask = await client.callTool({
      name: 'create_task',
      arguments: {
        body: 'New task body',
        labels: ['enhancement'],
        operationId: '019f6d33-6aad-4302-a45e-bb7a33fc399c',
        repositoryId: '480',
        title: 'New task'
      }
    });
    expect(createdTask.structuredContent).toMatchObject({
      result: { creationState: 'complete', task: { number: 481, provider: 'github', title: 'New task' } }
    });
    expect(JSON.stringify(createdTask)).not.toContain('"issue"');

    const updatedTask = await client.callTool({
      name: 'update_task',
      arguments: { repositoryId: 'DotNaos/project-space', state: 'closed', task: 480, title: 'Updated task' }
    });
    expect(updatedTask.structuredContent).toMatchObject({
      result: { status: 'connected', task: { number: 480, state: 'closed', title: 'Updated task' } }
    });

    const comments = await client.callTool({
      name: 'list_task_comments',
      arguments: { repositoryId: '480', task: 480 }
    });
    expect(comments.structuredContent).toMatchObject({
      result: { comments: [{ id: 7001, body: 'Looks good.' }], task: 480 }
    });

    const addedComment = await client.callTool({
      name: 'add_task_comment',
      arguments: { body: 'Ship it.', repositoryId: '480', task: 480 }
    });
    expect(addedComment.structuredContent).toMatchObject({
      result: { comment: { id: 7002, body: 'Ship it.' }, task: 480 }
    });

    const missingTask = await client.callTool({
      name: 'get_task',
      arguments: { repositoryId: '480', task: 404 }
    });
    expect(missingTask.isError).toBe(true);

    const missingTaskUpdate = await client.callTool({
      name: 'update_task',
      arguments: { repositoryId: '480', state: 'closed', task: 404 }
    });
    expect(missingTaskUpdate.isError).toBe(true);

    const missingOperationId = await client.callTool({
      name: 'create_task',
      arguments: { repositoryId: '480', title: 'Unsafe retry' }
    });
    expect(missingOperationId.isError).toBe(true);

    await client.callTool({ name: 'list_codex_tasks', arguments: {} });
    const started = await client.callTool({
      name: 'start_codex_task',
      arguments: { dryRun: true, environmentId, task: 480, repositoryId: '480' }
    });
    expect(started.isError).not.toBe(true);
    const codexCalls = calls.filter(({ kind }) => ['list', 'start'].includes(kind));
    expect(codexCalls).toMatchObject([
      { kind: 'list', userId: 'local-development-user' },
      {
        kind: 'start',
        request: { dryRun: true, environmentId, issue: 480, repositoryId: '480' },
        userId: 'local-development-user'
      }
    ]);
    expect((codexCalls[1]?.request as { operationId?: string }).operationId).toMatch(/^mcp:start:/);

    const confirmed = await client.callTool({
      name: 'start_codex_task',
      arguments: { repositoryId: '480', task: 480 }
    });
    expect(confirmed.structuredContent).toMatchObject({
      result: { state: 'confirmed', task: { source: { number: 480, provider: 'github' } } }
    });
    expect(JSON.stringify(confirmed)).not.toContain('"issue"');

    const invalidDryRun = await client.callTool({
      name: 'start_codex_task',
      arguments: { dryRun: true, repositoryId: '480', task: 404 }
    });
    expect(invalidDryRun.isError).toBe(true);
    expect(calls.filter((call) => call.kind === 'start')).toHaveLength(2);

    const invalidUpdate = await client.callTool({
      name: 'update_task',
      arguments: { repositoryId: '480', task: 480 }
    });
    expect(invalidUpdate.isError).toBe(true);
  });

  test('requires MCP client confirmation before a recovery command starts', async () => {
    process.env.PROJECT_SPACE_AUTH_DISABLED = '1';
    const calls: Array<{ kind: string; request: unknown; userId: string }> = [];
    const origin = await startMcp(calls);
    const client = new Client(
      { name: 'project-space-elicitation-test', version: '1.0.0' },
      { capabilities: { elicitation: {} } }
    );
    let prompt: unknown;
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      prompt = request.params;
      return { action: 'accept', content: { approved: true } };
    });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));

    const result = await client.callTool({
      name: 'start_environment_recovery_command',
      arguments: {
        command: 'project doctor --repair',
        environmentId: '11111111-1111-4111-8111-111111111111',
        operationId: 'recovery:start:integration'
      }
    });

    expect(prompt).toMatchObject({
      mode: 'form', requestedSchema: { required: ['approved'] }
    });
    expect(result.structuredContent).toMatchObject({
      result: { scope: 'environment_recovery', state: 'running' }
    });
    expect(calls).toContainEqual({
      kind: 'workspace-start-recovery',
      request: {
        command: 'project doctor --repair',
        environmentId: '11111111-1111-4111-8111-111111111111',
        operationId: 'recovery:start:integration'
      },
      userId: 'local-development-user'
    });

    const declining = new Client(
      { name: 'project-space-decline-test', version: '1.0.0' },
      { capabilities: { elicitation: {} } }
    );
    declining.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'decline' }));
    clients.push(declining);
    await declining.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));
    const declined = await declining.callTool({
      name: 'start_environment_recovery_command',
      arguments: {
        command: 'project doctor --repair',
        environmentId: '11111111-1111-4111-8111-111111111111',
        operationId: 'recovery:start:declined'
      }
    });
    expect(declined.isError).toBe(true);
    expect(calls.filter(({ kind }) => kind === 'workspace-start-recovery')).toHaveLength(1);
  });

  test('runs provider-neutral executions and maps known Codex aliases to them', async () => {
    process.env.PROJECT_SPACE_AUTH_DISABLED = '1';
    const calls: Array<{ kind: string; request: unknown; userId: string }> = [];
    const taskExecutions = taskExecutionRuntime(calls);
    const origin = await startMcp(calls, {}, { taskExecutions });
    const client = new Client({ name: 'task-execution-test', version: '1.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));

    const listedTools = await client.listTools();
    const startDefinition = listedTools.tools.find(({ name }) => name === 'start_task_execution');
    expect(startDefinition).toMatchObject({
      _meta: { securitySchemes: [{
        scopes: ['project-space:read', 'project-space:write', 'project-space:execution.write'],
        type: 'oauth2'
      }] },
      annotations: { idempotentHint: true, openWorldHint: true, readOnlyHint: false },
      outputSchema: { properties: { result: expect.any(Object) }, required: ['result'] }
    });

    const createdHandoff = await client.callTool({
      arguments: {
        objective: 'Implement the verified cross-machine design.',
        operationId: 'task-handoff:create:001',
        requestedMode: 'implement',
        requestedPermissions: {
          delivery: 'pull_request', network: 'restricted', repository: 'write',
          task: 'write', workspace: 'write'
        },
        task: { number: 548, provider: 'github', repositoryId: '480' }
      },
      name: 'create_task_handoff'
    });
    expect(createdHandoff.structuredContent).toMatchObject({
      result: {
        handoff: { handoffId: '33333333-3333-4333-8333-333333333333', revision: 1 },
        operationId: 'task-handoff:create:001'
      }
    });
    const loadedHandoff = await client.callTool({
      arguments: { handoffId: '33333333-3333-4333-8333-333333333333', revision: 1 },
      name: 'get_task_handoff'
    });
    expect(loadedHandoff.structuredContent).toMatchObject({
      result: { handoff: { objective: 'Implement the verified cross-machine design.' } }
    });
    const updatedHandoff = await client.callTool({
      arguments: {
        executionId: '44444444-4444-4444-8444-444444444444',
        handoffId: '33333333-3333-4333-8333-333333333333',
        operationId: 'task-handoff:update:001',
        revision: 1
      },
      name: 'update_task_execution_handoff'
    });
    expect(updatedHandoff.structuredContent).toMatchObject({
      result: { operationId: 'task-handoff:update:001', state: 'updated' }
    });

    const started = await client.callTool({
      arguments: {
        environmentId: '11111111-1111-4111-8111-111111111111',
        operationId: 'task-execution:start:001',
        task: { number: 548, provider: 'github', repositoryId: '480' }
      },
      name: 'start_task_execution'
    });
    expect(started.structuredContent).toMatchObject({
      result: {
        apiVersion: 1,
        execution: { id: '44444444-4444-4444-8444-444444444444', state: 'running' },
        operationId: 'task-execution:start:001'
      }
    });

    const aliasStart = await client.callTool({
      arguments: {
        environmentId: '11111111-1111-4111-8111-111111111111',
        operationId: 'task-execution:alias:start',
        repositoryId: '480',
        task: 548
      },
      name: 'start_codex_task'
    });
    expect(aliasStart.structuredContent).toMatchObject({
      result: { execution: { id: '44444444-4444-4444-8444-444444444444' } }
    });

    const aliasList = await client.callTool({ name: 'list_codex_tasks', arguments: {} });
    expect(aliasList.structuredContent).toMatchObject({
      result: {
        executions: [{ id: '44444444-4444-4444-8444-444444444444' }],
        results: [{ sessions: [{ id: '019f6d33-6aad-7302-a45e-bb7a33fc399c' }] }]
      }
    });
    const searchedAliasList = await client.callTool({
      name: 'list_codex_tasks', arguments: { search: 'issue-548' }
    });
    expect(searchedAliasList.structuredContent).toMatchObject({
      result: { executions: [{ id: '44444444-4444-4444-8444-444444444444' }] }
    });
    const unmatchedAliasList = await client.callTool({
      name: 'list_codex_tasks', arguments: { search: 'not-present' }
    });
    expect(unmatchedAliasList.structuredContent).toMatchObject({
      result: { executions: [] }
    });
    const aliasRead = await client.callTool({
      arguments: { threadId: '22222222-2222-4222-8222-222222222222' },
      name: 'read_codex_task'
    });
    expect(aliasRead.structuredContent).toMatchObject({
      result: { execution: { id: '44444444-4444-4444-8444-444444444444' } }
    });
    await client.callTool({
      arguments: {
        message: 'Continue.', operationId: 'task-execution:alias:send',
        threadId: '22222222-2222-4222-8222-222222222222'
      },
      name: 'send_codex_message'
    });

    expect(calls.filter(({ kind }) => kind.startsWith('execution-'))).toMatchObject([
      { kind: 'execution-start', userId: 'local-development-user' },
      { kind: 'execution-start', userId: 'local-development-user' },
      { kind: 'execution-list', userId: 'local-development-user' },
      { kind: 'execution-list', userId: 'local-development-user' },
      { kind: 'execution-list', userId: 'local-development-user' },
      { kind: 'execution-read-by-executor', userId: 'local-development-user' },
      { kind: 'execution-read-by-executor', userId: 'local-development-user' },
      { kind: 'execution-send', userId: 'local-development-user' }
    ]);
    expect(calls.filter(({ kind }) => kind.startsWith('handoff-'))).toMatchObject([
      { kind: 'handoff-create', userId: 'local-development-user' },
      { kind: 'handoff-get', userId: 'local-development-user' },
      { kind: 'handoff-update', userId: 'local-development-user' }
    ]);
  });

  test('logs MCP tool failures with a client-visible request ID', async () => {
    process.env.PROJECT_SPACE_AUTH_DISABLED = '1';
    const records: ProjectSpaceLogRecord[] = [];
    const logger = createProjectSpaceLogger({
      environment: { NODE_ENV: 'test' },
      sink: { write: (record) => records.push(record) }
    });
    const failingBackend: ReturnType<typeof backend> = {
      ...backend(),
      async loadProjectDiscovery() {
        throw new Error('Project discovery exploded');
      }
    };
    const origin = await startMcp([], {}, { backend: failingBackend, logger });
    const client = new Client({ name: 'project-space-error-test', version: '1.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));

    const result = await client.callTool({ name: 'list_projects', arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringMatching(/Request ID: [A-Za-z0-9._:-]+$/) })
    ]);
    expect(records.find((record) => record.event === 'mcp.tool.failed')).toMatchObject({
      error: { message: 'Project discovery exploded', name: 'Error' },
      tool: 'list_projects'
    });
    expect(records.find((record) => record.event === 'mcp.tool.failed')?.requestId).toBeTruthy();
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
      arguments: { dryRun: true, task: 480, repositoryId: '480' },
      name: 'start_codex_task'
    });
    expect(rejectedWrite.isError).toBe(true);
    expect(rejectedWrite._meta).toMatchObject({ 'mcp/www_authenticate': [expect.stringContaining('project-space:write')] });
    const rejectedTaskWrite = await readOnlyClient.callTool({
      arguments: {
        operationId: '019f6d33-6aad-4302-a45e-bb7a33fc399d',
        repositoryId: '480',
        title: 'Nope'
      },
      name: 'create_task'
    });
    expect(rejectedTaskWrite.isError).toBe(true);
    expect(rejectedTaskWrite._meta).toMatchObject({ 'mcp/www_authenticate': [expect.stringContaining('project-space:write')] });
    const rejectedLifecycleWrite = await readOnlyClient.callTool({
      arguments: {
        branch: 'task/480',
        operationId: 'mcp:environment:provision:480',
        provider: 'github_codespaces',
        repositoryId: '480',
        task: 480
      },
      name: 'provision_execution_environment'
    });
    expect(rejectedLifecycleWrite._meta).toMatchObject({
      'mcp/www_authenticate': [expect.stringContaining('project-space:environment.manage')]
    });
    expect(JSON.stringify(rejectedLifecycleWrite._meta)).not.toContain('project-space:environment.delete');
    const rejectedAgentAuthorization = await readOnlyClient.callTool({
      arguments: {
        agent: 'codex',
        environmentId: '11111111-1111-4111-8111-111111111111',
        operationId: 'agent:authorization:test'
      },
      name: 'start_agent_authorization'
    });
    expect(rejectedAgentAuthorization._meta).toEqual({
      'mcp/www_authenticate': [
        `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", ` +
        'scope="project-space:read project-space:write project-space:agent.authorize"'
      ]
    });
    const rejectedExecutionWrite = await readOnlyClient.callTool({
      arguments: {
        environmentId: '11111111-1111-4111-8111-111111111111',
        operationId: 'task-execution:start:001',
        task: { number: 548, provider: 'github', repositoryId: '480' }
      },
      name: 'start_task_execution'
    });
    expect(rejectedExecutionWrite._meta).toEqual({
      'mcp/www_authenticate': [
        `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", ` +
        'scope="project-space:read project-space:write project-space:execution.write"'
      ]
    });
    const rejectedHandoffWrite = await readOnlyClient.callTool({
      arguments: {
        objective: 'Create a verified design Handoff.',
        operationId: 'task-handoff:create:oauth',
        requestedMode: 'implement',
        requestedPermissions: {
          delivery: 'pull_request', network: 'restricted', repository: 'write',
          task: 'write', workspace: 'write'
        },
        task: { number: 548, provider: 'github', repositoryId: '480' }
      },
      name: 'create_task_handoff'
    });
    expect(rejectedHandoffWrite._meta).toEqual({
      'mcp/www_authenticate': [
        `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", ` +
        'scope="project-space:read project-space:write project-space:task.write"'
      ]
    });
    const rejectedExecutionApproval = await readOnlyClient.callTool({
      arguments: {
        decision: 'allow-once',
        executionId: '11111111-1111-4111-8111-111111111111',
        operationId: 'task-execution:approval:001',
        requestId: 'request-1',
        turnId: 'turn-1'
      },
      name: 'respond_task_execution_approval'
    });
    expect(rejectedExecutionApproval._meta).toEqual({
      'mcp/www_authenticate': [
        `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", ` +
        'scope="project-space:read project-space:write project-space:execution.approve"'
      ]
    });

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

    const widenedRefresh = await fetch(`${origin}/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        grant_type: 'refresh_token',
        refresh_token: refreshed.refresh_token,
        resource: `${origin}/mcp`,
        scope: 'project-space:read project-space:execution.write'
      }),
      method: 'POST'
    });
    expect(widenedRefresh.status).toBe(400);
  });
});

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
