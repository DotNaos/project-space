import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { ProjectSpaceBackend } from '../src/shared/project-space-api';
import { requestPublicOrigin } from './connector-installation';
import type { ConfiguredCodexMachineTasksRuntime } from './codex-machine-tasks/configured-runtime';
import {
  isProjectSpaceAuthRequired,
  runWithAuthSession
} from './local-auth-store';
import {
  createProjectSpaceMcpOAuth,
  type ProjectSpaceMcpOAuthOptions
} from './project-space-mcp-oauth';
import {
  projectSpaceMcpReadScope,
  projectSpaceMcpScopes,
  projectSpaceMcpWriteScope
} from './project-space-mcp-oauth-store';
import {
  currentRequestId,
  projectSpaceLogger,
  recordMcpTool,
  recordObservedError,
  withProjectSpaceSpan,
  type ProjectSpaceLogger
} from './observability';

const mcpPath = '/mcp';
const protectedResourcePath = '/.well-known/oauth-protected-resource/mcp';
const requiredScopes = projectSpaceMcpScopes;
const sessionHeader = 'mcp-session-id';
const sessionLifetimeMs = 60 * 60_000;
const maximumSessions = 100;

type McpBackend = Pick<
  ProjectSpaceBackend,
  | 'createGitHubIssue'
  | 'createGitHubIssueComment'
  | 'getConnectorOverview'
  | 'getGitHubCatalog'
  | 'getGitHubIssueComments'
  | 'getGitHubPipelineStatus'
  | 'getGitHubRepositoryDetails'
  | 'loadProjectDiscovery'
  | 'updateGitHubIssue'
>;

export interface ProjectSpaceMcpOptions {
  backend: McpBackend;
  createRuntime(): Promise<ConfiguredCodexMachineTasksRuntime>;
  logger?: ProjectSpaceLogger;
  oauth?: ProjectSpaceMcpOAuthOptions;
}

interface McpSession {
  clientId: string;
  lastSeenAt: number;
  server: Server;
  transport: StreamableHTTPServerTransport;
  userId: string;
}

type OAuthTool = Tool & {
  securitySchemes: Array<{
    scopes: string[];
    type: 'oauth2';
  }>;
};

const selectorSchema = z.object({
  connectorId: z.string().trim().min(1).optional(),
  physicalMachineId: z.string().trim().min(1).optional(),
  physicalMachineName: z.string().trim().min(1).optional()
});

const toolSchemas = {
  list_projects: z.object({ search: z.string().trim().max(200).optional() }),
  list_tasks: z.object({
    limit: z.number().int().min(1).max(100).optional(),
    repositoryId: z.string().trim().min(1),
    search: z.string().trim().max(200).optional(),
    state: z.enum(['open', 'closed', 'all']).optional()
  }),
  get_task: z.object({
    repositoryId: z.string().trim().min(1),
    task: z.number().int().positive()
  }),
  get_task_status: z.object({
    repositoryId: z.string().trim().min(1),
    task: z.number().int().positive()
  }),
  create_task: z.object({
    body: z.string().trim().max(100_000).optional(),
    labels: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
    operationId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
    repositoryId: z.string().trim().min(1),
    title: z.string().trim().min(1).max(1_000)
  }),
  update_task: z.object({
    body: z.string().trim().max(100_000).optional(),
    labels: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
    repositoryId: z.string().trim().min(1),
    state: z.enum(['open', 'closed']).optional(),
    task: z.number().int().positive(),
    title: z.string().trim().min(1).max(1_000).optional()
  }),
  list_task_comments: z.object({
    repositoryId: z.string().trim().min(1),
    task: z.number().int().positive()
  }),
  add_task_comment: z.object({
    body: z.string().trim().min(1).max(100_000),
    repositoryId: z.string().trim().min(1),
    task: z.number().int().positive()
  }),
  list_machines: z.object({}),
  list_codex_tasks: z.object({
    connectorId: z.string().trim().min(1).optional(),
    includeArchived: z.boolean().optional(),
    search: z.string().trim().max(200).optional()
  }),
  read_codex_task: selectorSchema.extend({
    last: z.number().int().min(1).max(100).optional(),
    threadId: z.string().uuid()
  }),
  start_codex_task: selectorSchema.extend({
    dryRun: z.boolean().optional(),
    operationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/).optional(),
    repositoryId: z.string().trim().min(1),
    task: z.number().int().positive()
  }),
  send_codex_message: selectorSchema.extend({
    last: z.number().int().min(1).max(100).optional(),
    message: z.string().trim().min(1).max(100_000),
    operationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/).optional(),
    threadId: z.string().uuid(),
    wait: z.boolean().optional()
  })
};

const tools: OAuthTool[] = [
  tool('list_projects', 'List projects', 'List the Project Space projects and GitHub repositories available to the signed-in user.', {
    type: 'object', properties: { search: { type: 'string', description: 'Optional case-insensitive name filter.' } }, additionalProperties: false
  }, { readOnlyHint: true, openWorldHint: false }),
  tool('list_tasks', 'List tasks', 'List GitHub tasks in an authorized repository. Use list_projects first to select the repository.', {
    type: 'object', required: ['repositoryId'], properties: {
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      repositoryId: { type: 'string', description: 'Repository id or full name, for example DotNaos/project-space.' },
      search: { type: 'string', description: 'Optional case-insensitive search across task title, body, and labels.' },
      state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Defaults to open.' }
    }, additionalProperties: false
  }, { readOnlyHint: true, openWorldHint: true }),
  tool('get_task', 'Get task', 'Read one GitHub task from an authorized repository.', {
    type: 'object', required: ['repositoryId', 'task'], properties: {
      repositoryId: { type: 'string', description: 'Repository id or full name.' },
      task: { type: 'integer', minimum: 1, description: 'GitHub task number.' }
    }, additionalProperties: false
  }, { readOnlyHint: true, openWorldHint: true }),
  tool('get_task_status', 'Get task status', 'Read the linked GitHub branches, pull requests, and workflow runs for a task.', {
    type: 'object', required: ['repositoryId', 'task'], properties: {
      repositoryId: { type: 'string', description: 'Repository id or full name.' },
      task: { type: 'integer', minimum: 1, description: 'GitHub task number.' }
    }, additionalProperties: false
  }, { readOnlyHint: true, openWorldHint: true }),
  tool('create_task', 'Create task', 'Create a GitHub task in an authorized repository. Reuse operationId only for the same task draft.', {
    type: 'object', required: ['operationId', 'repositoryId', 'title'], properties: {
      body: { type: 'string' },
      labels: { type: 'array', items: { type: 'string' }, maxItems: 50 },
      operationId: { type: 'string', format: 'uuid', description: 'Idempotency key. Reuse it only for the same task draft.' },
      repositoryId: { type: 'string', description: 'Repository id or full name.' },
      title: { type: 'string', description: 'Task title.' }
    }, additionalProperties: false
  }, { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: false }),
  tool('update_task', 'Update task', 'Update the title, body, labels, or open/closed state of a GitHub task.', {
    type: 'object', required: ['repositoryId', 'task'], properties: {
      body: { type: 'string' },
      labels: { type: 'array', items: { type: 'string' }, maxItems: 50 },
      repositoryId: { type: 'string', description: 'Repository id or full name.' },
      state: { type: 'string', enum: ['open', 'closed'] },
      task: { type: 'integer', minimum: 1, description: 'GitHub task number.' },
      title: { type: 'string' }
    }, additionalProperties: false
  }, { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: false }),
  tool('list_task_comments', 'List task comments', 'Read comments on one GitHub task.', {
    type: 'object', required: ['repositoryId', 'task'], properties: {
      repositoryId: { type: 'string', description: 'Repository id or full name.' },
      task: { type: 'integer', minimum: 1, description: 'GitHub task number.' }
    }, additionalProperties: false
  }, { readOnlyHint: true, openWorldHint: true }),
  tool('add_task_comment', 'Add task comment', 'Add a comment to a GitHub task.', {
    type: 'object', required: ['body', 'repositoryId', 'task'], properties: {
      body: { type: 'string' },
      repositoryId: { type: 'string', description: 'Repository id or full name.' },
      task: { type: 'integer', minimum: 1, description: 'GitHub task number.' }
    }, additionalProperties: false
  }, { destructiveHint: false, idempotentHint: false, openWorldHint: true, readOnlyHint: false }),
  tool('list_machines', 'List machines', 'List the Project Space connector machines available to the signed-in user.', {
    type: 'object', properties: {}, additionalProperties: false
  }, { readOnlyHint: true, openWorldHint: false }),
  tool('list_codex_tasks', 'List Codex tasks', 'List Codex tasks on one or all available connector machines.', {
    type: 'object', properties: {
      connectorId: { type: 'string' }, includeArchived: { type: 'boolean' }, search: { type: 'string' }
    }, additionalProperties: false
  }, { readOnlyHint: true, openWorldHint: false }),
  tool('read_codex_task', 'Read Codex task', 'Read the latest conversation turns from a Codex task.', {
    type: 'object', required: ['threadId'], properties: {
      connectorId: { type: 'string' }, physicalMachineId: { type: 'string' }, physicalMachineName: { type: 'string' },
      last: { type: 'integer', minimum: 1, maximum: 100 }, threadId: { type: 'string', format: 'uuid' }
    }, additionalProperties: false
  }, { readOnlyHint: true, openWorldHint: false }),
  tool('start_codex_task', 'Start Codex task', 'Start a Codex task from a GitHub task. This creates a Project-managed worktree and starts Codex on the selected machine.', {
    type: 'object', required: ['repositoryId', 'task'], properties: {
      connectorId: { type: 'string' }, physicalMachineId: { type: 'string' }, physicalMachineName: { type: 'string' },
      dryRun: { type: 'boolean', description: 'Validate and resolve the target without starting Codex.' },
      operationId: { type: 'string' }, repositoryId: { type: 'string' }, task: { type: 'integer', minimum: 1, description: 'GitHub task number.' }
    }, additionalProperties: false
  }, { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: false }),
  tool('send_codex_message', 'Send Codex message', 'Send a follow-up message to an existing Codex task.', {
    type: 'object', required: ['message', 'threadId'], properties: {
      connectorId: { type: 'string' }, physicalMachineId: { type: 'string' }, physicalMachineName: { type: 'string' },
      last: { type: 'integer', minimum: 1, maximum: 100 }, message: { type: 'string' },
      operationId: { type: 'string' }, threadId: { type: 'string', format: 'uuid' }, wait: { type: 'boolean' }
    }, additionalProperties: false
  }, { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: false })
];

export function createProjectSpaceMcpHandler(options: ProjectSpaceMcpOptions) {
  const sessions = new Map<string, McpSession>();
  const oauth = createProjectSpaceMcpOAuth(options.oauth);
  const logger = (options.logger ?? projectSpaceLogger).child({ component: 'mcp' });
  let runtime: Promise<ConfiguredCodexMachineTasksRuntime> | undefined;
  const getRuntime = () => (runtime ??= options.createRuntime().catch((error) => {
    runtime = undefined;
    throw error;
  }));

  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    let stage = 'oauth';
    const requestedSessionId = headerValue(request.headers[sessionHeader]);
    try {
      if (await oauth.handle(request, response, url)) return true;
      if (!isMcpPath(url.pathname)) return false;
      applyCors(response, url.pathname === mcpPath);
      if (request.method === 'OPTIONS') {
        response.writeHead(204).end();
        return true;
      }

      if (!['GET', 'POST', 'DELETE'].includes(request.method ?? '')) {
        return methodNotAllowed(response, 'GET, POST, DELETE, OPTIONS');
      }

      stage = 'authentication';
      const challenge = authChallenge(requestPublicOrigin(request));
      let authInfo: AuthInfo | undefined;
      try {
        authInfo = await authenticateMcpRequest(request, oauth.verifyAccessToken);
      } catch (error) {
        logger.warn('mcp.authentication.failed', { method: request.method, route: url.pathname }, error);
      }
      if (!authInfo) {
        response.setHeader('WWW-Authenticate', challenge);
        writeJson(response, 401, { error: 'Unauthorized' });
        return true;
      }

      stage = 'session_lookup';
      pruneSessions(sessions, logger);
      let session = requestedSessionId ? sessions.get(requestedSessionId) : undefined;
      if (requestedSessionId && (
        !session ||
        session.userId !== authInfo.extra?.userId ||
        session.clientId !== authInfo.clientId
      )) {
        writeJson(response, 404, { error: 'MCP session not found.' });
        return true;
      }
      if (!session) {
        if (request.method !== 'POST') {
          writeJson(response, 400, { error: 'Initialize an MCP session with POST first.' });
          return true;
        }
        if (sessions.size >= maximumSessions) {
          writeJson(response, 503, { error: 'The MCP session limit has been reached.' });
          return true;
        }
        const userId = requiredUserId(authInfo);
        const server = createMcpServer(options.backend, getRuntime, challenge, logger);
        const transport = new StreamableHTTPServerTransport({
          enableJsonResponse: true,
          sessionIdGenerator: randomUUID,
          onsessionclosed(sessionId) {
            sessions.delete(sessionId);
            logger.info('mcp.session.closed', { mcpSessionId: sessionId });
          },
          onsessioninitialized(sessionId) {
            sessions.set(sessionId, {
              clientId: authInfo.clientId,
              lastSeenAt: Date.now(),
              server,
              transport,
              userId
            });
            logger.info('mcp.session.initialized', { mcpSessionId: sessionId });
          }
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        stage = 'server_connect';
        await server.connect(transport);
        session = {
          clientId: authInfo.clientId,
          lastSeenAt: Date.now(),
          server,
          transport,
          userId
        };
      }
      session.lastSeenAt = Date.now();
      (request as IncomingMessage & { auth?: AuthInfo }).auth = authInfo;
      stage = 'transport_handle_request';
      await session.transport.handleRequest(request, response);
      return true;
    } catch (error) {
      recordObservedError('mcp.protocol', stage);
      logger.error('mcp.request.failed', {
        mcpSessionId: requestedSessionId,
        method: request.method,
        route: url.pathname,
        stage
      }, error);
      throw error;
    }
  };
}

function createMcpServer(
  backend: McpBackend,
  runtime: () => Promise<ConfiguredCodexMachineTasksRuntime>,
  challenge: string,
  logger: ProjectSpaceLogger
) {
  const server = new Server(
    { name: 'project-space', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions: 'Use read-only discovery tools before selecting a machine or starting a Codex task. Starting a task and sending a message are consequential actions.'
    }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools } as { tools: Tool[] }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const toolName = request.params.name;
    const startedAt = performance.now();
    const userId = extra.authInfo?.extra?.userId;
    if (typeof userId !== 'string' || !userId) return authenticationError(challenge);
    const requiredToolScopes = scopesForTool(toolName);
    if (!requiredToolScopes.every((scope) => extra.authInfo?.scopes.includes(scope))) {
      return authenticationError(challenge);
    }
    try {
      const result = await withProjectSpaceSpan(`mcp.tool.${toolName}`, {
        'mcp.tool.name': toolName
      }, () => runWithAuthSession(
        { login: 'project-space-mcp', role: 'user', userId },
        () => callTool(backend, runtime, userId, toolName, request.params.arguments ?? {}, logger)
      ));
      const durationMs = performance.now() - startedAt;
      recordMcpTool(toolName, false, durationMs);
      logger.info('mcp.tool.completed', { durationMs, tool: toolName });
      return result;
    } catch (error) {
      const durationMs = performance.now() - startedAt;
      recordMcpTool(toolName, true, durationMs);
      logger.error('mcp.tool.failed', { durationMs, tool: toolName }, error);
      return toolError(
        'The Project Space operation failed.',
        currentRequestId()
      );
    }
  });
  return server;
}

async function callTool(
  backend: McpBackend,
  runtime: () => Promise<ConfiguredCodexMachineTasksRuntime>,
  userId: string,
  name: string,
  rawArguments: Record<string, unknown>,
  logger: ProjectSpaceLogger
): Promise<CallToolResult> {
  switch (name) {
    case 'list_projects': {
      const input = toolSchemas.list_projects.parse(rawArguments);
      const [discovery, catalog] = await Promise.all([
        backend.loadProjectDiscovery(),
        backend.getGitHubCatalog().catch((error) => {
          logger.warn('mcp.github_catalog.unavailable', { tool: name }, error);
          return undefined;
        })
      ]);
      const search = input.search?.toLowerCase();
      const projects = discovery.projects
        .filter((project) => !search || [project.name, project.github?.fullName].some((value) => value?.toLowerCase().includes(search)))
        .map((project) => ({
          branch: project.gitStatus?.branchName,
          changedFiles: project.gitStatus?.changed,
          github: project.github ? sanitizeRepository(project.github) : undefined,
          id: project.id,
          kind: project.kind,
          machineId: project.machineId,
          name: project.name
        }));
      const repositories = (catalog?.repositories ?? [])
        .filter((repository) => !search || repository.fullName.toLowerCase().includes(search))
        .map(sanitizeRepository);
      return toolResult({ catalogStatus: catalog?.status, projects, repositories });
    }
    case 'list_machines': {
      toolSchemas.list_machines.parse(rawArguments);
      const overview = await backend.getConnectorOverview();
      return toolResult({
        machines: overview.machines.map((machine) => ({
          capabilities: machine.connector.capabilities ?? [],
          environment: machine.environment,
          id: machine.id,
          kind: machine.kind,
          lastSeen: machine.connector.lastSeen,
          name: machine.name,
          roles: machine.roles,
          status: machine.connector.status
        })),
        physicalMachines: overview.physicalMachines ?? []
      });
    }
    case 'list_tasks': {
      const input = toolSchemas.list_tasks.parse(rawArguments);
      const { catalog, repository } = await resolveGitHubRepository(backend, input.repositoryId);
      if (!repository) {
        return toolResult({
          catalogStatus: catalog.status,
          message: catalog.message ?? 'The GitHub repository is not available.',
          repositoryId: input.repositoryId,
          tasks: undefined
        });
      }
      const details = await backend.getGitHubRepositoryDetails(repository.fullName);
      if (details.status !== 'connected') {
        return toolResult({
          checkedAt: details.checkedAt,
          message: details.message ?? 'GitHub task details are unavailable.',
          repository: sanitizeRepository(repository),
          status: details.status,
          tasks: undefined
        });
      }
      const state = input.state ?? 'open';
      const search = input.search?.toLowerCase();
      const matchingTasks = details.issues
        .filter((task) => state === 'all' || task.state === state)
        .filter((task) => !search || [task.title, task.body, ...task.labels]
          .some((value) => value?.toLowerCase().includes(search)))
        .sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''));
      const limit = input.limit ?? 50;
      return toolResult({
        checkedAt: details.checkedAt,
        repository: sanitizeRepository(repository),
        status: details.status,
        tasks: matchingTasks.slice(0, limit).map((task) => sanitizeGitHubTask(task, repository)),
        truncated: matchingTasks.length > limit
      });
    }
    case 'get_task': {
      const input = toolSchemas.get_task.parse(rawArguments);
      const { catalog, repository } = await resolveGitHubRepository(backend, input.repositoryId);
      if (!repository) {
        return toolResult({
          catalogStatus: catalog.status,
          message: catalog.message ?? 'The GitHub repository is not available.',
          repositoryId: input.repositoryId,
          task: undefined
        });
      }
      const details = await backend.getGitHubRepositoryDetails(repository.fullName);
      if (details.status !== 'connected') {
        return toolResult({
          checkedAt: details.checkedAt,
          message: details.message ?? 'GitHub task details are unavailable.',
          repository: sanitizeRepository(repository),
          status: details.status,
          task: undefined
        });
      }
      const task = details.issues.find((candidate) => candidate.number === input.task);
      if (!task) return toolError('The GitHub task was not found.', currentRequestId());
      return toolResult({
        checkedAt: details.checkedAt,
        repository: sanitizeRepository(repository),
        status: details.status,
        task: sanitizeGitHubTask(task, repository)
      });
    }
    case 'get_task_status': {
      const input = toolSchemas.get_task_status.parse(rawArguments);
      const { catalog, details, repository, task } = await resolveGitHubTask(backend, input.repositoryId, input.task);
      if (!repository) {
        return toolError(catalog.message ?? 'The GitHub repository is not available.', currentRequestId());
      }
      if (details?.status !== 'connected') {
        return toolError(details?.message ?? 'GitHub task details are unavailable.', currentRequestId());
      }
      if (!task) return toolError('The GitHub task was not found.', currentRequestId());
      const linkedBranches = details.branches.filter((branch) => branch.linkedIssueNumbers?.includes(input.task));
      const linkedPullRequests = details.pullRequests.filter((pullRequest) => pullRequest.linkedIssueNumbers?.includes(input.task));
      const branchNames = new Set(linkedBranches.map((branch) => branch.name));
      for (const pullRequest of linkedPullRequests) {
        if (pullRequest.headBranch) branchNames.add(pullRequest.headBranch);
      }
      const pipeline = await backend.getGitHubPipelineStatus(repository.fullName, { page: 1, perPage: 20 });
      return toolResult({
        branches: linkedBranches.map(sanitizeGitHubBranch),
        checkedAt: details.checkedAt,
        pipeline: {
          checkedAt: pipeline.checkedAt,
          pagination: pipeline.pagination,
          runs: pipeline.runs
            .filter((run) => (run.branch ? branchNames.has(run.branch) : false))
            .map(sanitizeGitHubWorkflowRun),
          status: pipeline.status
        },
        pullRequests: linkedPullRequests.map(sanitizeGitHubPullRequest),
        repository: sanitizeRepository(repository),
        status: details.status,
        task: sanitizeGitHubTask(task, repository)
      }, pipeline.status !== 'connected');
    }
    case 'create_task': {
      const input = toolSchemas.create_task.parse(rawArguments);
      const { catalog, repository } = await resolveGitHubRepository(backend, input.repositoryId);
      if (!repository) {
        return toolError(
          catalog.message ?? 'The GitHub repository is not available.',
          currentRequestId()
        );
      }
      const result = await backend.createGitHubIssue({
        body: input.body,
        fullName: repository.fullName,
        labels: input.labels,
        operationId: input.operationId,
        title: input.title
      });
      return toolResult(
        sanitizeGitHubIssueMutation(result, repository),
        result.status !== 'connected' || result.creationState === 'uncertain'
      );
    }
    case 'update_task': {
      const input = toolSchemas.update_task.parse(rawArguments);
      if (input.title === undefined && input.body === undefined && input.labels === undefined && input.state === undefined) {
        return toolError('At least one task field must be provided for an update.', currentRequestId());
      }
      const { catalog, details, repository, task: sourceTask } = await resolveGitHubTask(backend, input.repositoryId, input.task);
      if (!repository) {
        return toolError(
          catalog.message ?? 'The GitHub repository is not available.',
          currentRequestId()
        );
      }
      if (details?.status !== 'connected') {
        return toolError(details?.message ?? 'GitHub task details are unavailable.', currentRequestId());
      }
      if (!sourceTask) return toolError('The GitHub task was not found.', currentRequestId());
      const result = await backend.updateGitHubIssue({
        body: input.body,
        fullName: repository.fullName,
        labels: input.labels,
        number: input.task,
        state: input.state,
        title: input.title
      });
      return toolResult(sanitizeGitHubIssueMutation(result, repository), result.status !== 'connected');
    }
    case 'list_task_comments': {
      const input = toolSchemas.list_task_comments.parse(rawArguments);
      const { catalog, details, repository, task: sourceTask } = await resolveGitHubTask(backend, input.repositoryId, input.task);
      if (!repository) {
        return toolError(
          catalog.message ?? 'The GitHub repository is not available.',
          currentRequestId()
        );
      }
      if (details?.status !== 'connected') {
        return toolError(details?.message ?? 'GitHub task details are unavailable.', currentRequestId());
      }
      if (!sourceTask) return toolError('The GitHub task was not found.', currentRequestId());
      const result = await backend.getGitHubIssueComments(repository.fullName, input.task);
      return toolResult({
        comments: result.comments.map(sanitizeGitHubComment),
        message: result.message,
        repository: sanitizeRepository(repository),
        status: result.status,
        task: input.task
      }, result.status !== 'connected');
    }
    case 'add_task_comment': {
      const input = toolSchemas.add_task_comment.parse(rawArguments);
      const { catalog, details, repository, task: sourceTask } = await resolveGitHubTask(backend, input.repositoryId, input.task);
      if (!repository) {
        return toolError(
          catalog.message ?? 'The GitHub repository is not available.',
          currentRequestId()
        );
      }
      if (details?.status !== 'connected') {
        return toolError(details?.message ?? 'GitHub task details are unavailable.', currentRequestId());
      }
      if (!sourceTask) return toolError('The GitHub task was not found.', currentRequestId());
      const result = await backend.createGitHubIssueComment({
        body: input.body,
        fullName: repository.fullName,
        number: input.task
      });
      return toolResult({
        comment: result.comment ? sanitizeGitHubComment(result.comment) : undefined,
        message: result.message,
        repository: sanitizeRepository(repository),
        status: result.status,
        task: input.task
      }, result.status !== 'connected');
    }
    case 'list_codex_tasks': {
      const input = toolSchemas.list_codex_tasks.parse(rawArguments);
      const configured = await runtime();
      const connectorIds = input.connectorId
        ? [input.connectorId]
        : (await backend.getConnectorOverview()).machines.map((machine) => machine.id);
      const results = await Promise.all(connectorIds.map(async (connectorId) => {
        try {
          const result = await configured.sessions.service.list({ userId }, {
            includeArchived: input.includeArchived ?? false,
            machineId: connectorId,
            search: input.search
          });
          return {
            checkedAt: result.checkedAt,
            inventoryState: result.inventoryState,
            machine: result.machine,
            sessions: result.sessions.map(sanitizeSession)
          };
        } catch (error) {
          logger.warn('mcp.task_inventory.unavailable', { connectorId, tool: name }, error);
          return { connectorId, error: error instanceof Error ? error.message : 'Task inventory unavailable.' };
        }
      }));
      return toolResult({ results });
    }
    case 'read_codex_task': {
      const input = toolSchemas.read_codex_task.parse(rawArguments);
      const result = await (await runtime()).service.read({ userId }, input);
      return toolResult(sanitizeTaskRead(result));
    }
    case 'start_codex_task': {
      const input = toolSchemas.start_codex_task.parse({
        ...rawArguments,
        task: rawArguments.task ?? rawArguments.issue
      });
      const { task, ...request } = input;
      if (input.dryRun) {
        const { catalog, repository } = await resolveGitHubRepository(backend, input.repositoryId);
        if (!repository) {
          return toolError(
            catalog.message ?? 'The GitHub repository is not available.',
            currentRequestId()
          );
        }
        const details = await backend.getGitHubRepositoryDetails(repository.fullName);
        if (details.status !== 'connected') {
          return toolError(
            details.message ?? 'GitHub task details are unavailable.',
            currentRequestId()
          );
        }
        const sourceTask = details.issues.find((candidate) => candidate.number === task);
        if (!sourceTask) return toolError('The GitHub task was not found.', currentRequestId());
        if (sourceTask.state !== 'open') {
          return toolError('Only open GitHub tasks can be started.', currentRequestId());
        }
      }
      const result = await (await runtime()).service.start({ userId }, {
        ...request,
        issue: task,
        dryRun: input.dryRun ?? false,
        operationId: input.operationId ?? `mcp:start:${randomUUID()}`
      });
      return toolResult(sanitizeCodexTaskStartResult(result));
    }
    case 'send_codex_message': {
      const input = toolSchemas.send_codex_message.parse(rawArguments);
      const result = await (await runtime()).service.send({ userId }, {
        ...input,
        operationId: input.operationId ?? `mcp:send:${randomUUID()}`,
        wait: input.wait ?? false
      });
      return toolResult(sanitizeTaskRead(result));
    }
    default:
      return toolError(`Unknown tool: ${name}`, currentRequestId());
  }
}

async function resolveGitHubRepository(backend: McpBackend, repositoryId: string) {
  const catalog = await backend.getGitHubCatalog();
  const repository = catalog.status === 'connected'
    ? catalog.repositories.find((candidate) => (
      String(candidate.id) === repositoryId || candidate.fullName === repositoryId
    ))
    : undefined;
  return { catalog, repository };
}

async function resolveGitHubTask(
  backend: McpBackend,
  repositoryId: string,
  taskNumber: number
) {
  const { catalog, repository } = await resolveGitHubRepository(backend, repositoryId);
  if (!repository) return { catalog, details: undefined, repository, task: undefined };
  const details = await backend.getGitHubRepositoryDetails(repository.fullName);
  const task = details.status === 'connected'
    ? details.issues.find((candidate) => candidate.number === taskNumber)
    : undefined;
  return { catalog, details, repository, task };
}

async function authenticateMcpRequest(
  request: IncomingMessage,
  verifyAccessToken: (request: IncomingMessage, token: string) => Promise<AuthInfo>
): Promise<AuthInfo | undefined> {
  if (!isProjectSpaceAuthRequired()) {
    return {
      clientId: 'project-space-local-development',
      extra: { userId: 'local-development-user' },
      scopes: [...requiredScopes],
      token: 'local-development'
    };
  }
  const token = bearerToken(request);
  if (!token) return undefined;
  const authInfo = await verifyAccessToken(request, token);
  return authInfo.scopes.includes(projectSpaceMcpReadScope) ? authInfo : undefined;
}

function tool(
  name: string,
  title: string,
  description: string,
  inputSchema: Tool['inputSchema'],
  annotations: NonNullable<Tool['annotations']>
): OAuthTool {
  const scopes = annotations.readOnlyHint
    ? [projectSpaceMcpReadScope]
    : [projectSpaceMcpReadScope, projectSpaceMcpWriteScope];
  const oauthSecuritySchemes = [{ type: 'oauth2' as const, scopes }];
  return {
    name,
    title,
    description,
    inputSchema,
    annotations,
    securitySchemes: oauthSecuritySchemes,
    _meta: { securitySchemes: oauthSecuritySchemes }
  } as OAuthTool;
}

function toolResult(value: unknown, isError = false): CallToolResult {
  const result = { result: value } as Record<string, unknown>;
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
    structuredContent: result
  };
}

function toolError(message: string, requestId?: string): CallToolResult {
  const suffix = requestId ? ` Request ID: ${requestId}` : '';
  return { content: [{ type: 'text', text: `${message}${suffix}` }], isError: true };
}

function authenticationError(challenge: string): CallToolResult {
  return {
    ...toolError('Authentication required.', currentRequestId()),
    _meta: { 'mcp/www_authenticate': [challenge] }
  };
}

function sanitizeRepository(repository: {
  defaultBranch?: string;
  fullName: string;
  id: number;
  isPrivate: boolean;
  projectConfig: unknown;
  url: string;
}) {
  return {
    defaultBranch: repository.defaultBranch,
    fullName: repository.fullName,
    id: repository.id,
    isPrivate: repository.isPrivate,
    projectConfig: repository.projectConfig,
    url: repository.url
  };
}

function sanitizeGitHubTask(
  task: {
    author?: string;
    body?: string;
    labels: string[];
    number: number;
    state: 'open' | 'closed';
    title: string;
    updatedAt?: string;
    url: string;
  },
  repository: { fullName: string }
) {
  return {
    author: task.author,
    body: task.body,
    id: `github:${repository.fullName}:${task.number}`,
    labels: task.labels,
    number: task.number,
    provider: 'github',
    repository: repository.fullName,
    state: task.state,
    title: task.title,
    updatedAt: task.updatedAt,
    url: task.url
  };
}

function sanitizeGitHubIssueMutation(
  result: {
    creationState?: string;
    issue?: Parameters<typeof sanitizeGitHubTask>[0];
    message?: string;
    replayed?: boolean;
    status: string;
  },
  repository: { fullName: string }
) {
  return {
    creationState: result.creationState,
    message: result.message,
    replayed: result.replayed,
    repository: { fullName: repository.fullName },
    status: result.status,
    task: result.issue ? sanitizeGitHubTask(result.issue, repository) : undefined
  };
}

function sanitizeGitHubComment(comment: {
  author?: string;
  body: string;
  createdAt?: string;
  id: number;
  updatedAt?: string;
  url: string;
}) {
  return {
    author: comment.author,
    body: comment.body,
    createdAt: comment.createdAt,
    id: comment.id,
    updatedAt: comment.updatedAt,
    url: comment.url
  };
}

function sanitizeGitHubBranch(branch: {
  commitSha?: string;
  isDefault: boolean;
  name: string;
  linkedIssueNumbers?: number[];
  url?: string;
}) {
  return {
    commitSha: branch.commitSha,
    isDefault: branch.isDefault,
    name: branch.name,
    url: branch.url
  };
}

function sanitizeGitHubPullRequest(pullRequest: {
  author?: { avatarUrl?: string; login: string };
  baseBranch?: string;
  checksStatus?: string;
  headBranch?: string;
  headSha?: string;
  isDraft?: boolean;
  number: number;
  state: string;
  title: string;
  updatedAt?: string;
  url: string;
}) {
  return {
    author: pullRequest.author,
    baseBranch: pullRequest.baseBranch,
    checksStatus: pullRequest.checksStatus,
    headBranch: pullRequest.headBranch,
    headSha: pullRequest.headSha,
    isDraft: pullRequest.isDraft,
    number: pullRequest.number,
    state: pullRequest.state,
    title: pullRequest.title,
    updatedAt: pullRequest.updatedAt,
    url: pullRequest.url
  };
}

function sanitizeGitHubWorkflowRun(run: {
  branch?: string;
  conclusion?: string;
  createdAt?: string;
  displayTitle?: string;
  event?: string;
  headSha?: string;
  id: number;
  kind: string;
  name?: string;
  runNumber?: number;
  runStartedAt?: string;
  status: string;
  updatedAt?: string;
  url?: string;
}) {
  return {
    branch: run.branch,
    conclusion: run.conclusion,
    createdAt: run.createdAt,
    displayTitle: run.displayTitle,
    event: run.event,
    headSha: run.headSha,
    id: run.id,
    kind: run.kind,
    name: run.name,
    runNumber: run.runNumber,
    runStartedAt: run.runStartedAt,
    status: run.status,
    updatedAt: run.updatedAt,
    url: run.url
  };
}

function sanitizeCodexTaskStartResult(result: unknown) {
  if (!result || typeof result !== 'object' || !('state' in result) || result.state !== 'confirmed') {
    return result;
  }
  const confirmed = result as { task?: Record<string, unknown> };
  const sourceTask = confirmed.task?.issue;
  if (!sourceTask || typeof sourceTask !== 'object') return result;
  const { issue: _issue, ...task } = confirmed.task!;
  const source = sourceTask as { number?: unknown; url?: unknown };
  return {
    ...result,
    task: {
      ...task,
      source: {
        number: source.number,
        provider: 'github',
        url: source.url
      }
    }
  };
}

function sanitizeSession(session: {
  attention?: string;
  archived: boolean;
  id: string;
  lastActivityAt: string;
  machineId: string;
  machineName: string;
  model?: string;
  project?: string;
  status: string;
  title: string;
}) {
  return {
    attention: session.attention,
    archived: session.archived,
    id: session.id,
    lastActivityAt: session.lastActivityAt,
    machineId: session.machineId,
    machineName: session.machineName,
    model: session.model,
    project: session.project,
    status: session.status,
    title: session.title
  };
}

function sanitizeTaskRead<Result>(result: Result): Result {
  const copy = structuredClone(result) as Result & {
    result?: { session?: Parameters<typeof sanitizeSession>[0]; turns?: Array<{ items: Array<{ images?: Array<{ id: string; mediaType: string }> }> }> };
  };
  if (copy.result?.session) copy.result.session = sanitizeSession(copy.result.session) as typeof copy.result.session;
  for (const turn of copy.result?.turns ?? []) {
    for (const item of turn.items) {
      if (item.images) item.images = item.images.map(({ id, mediaType }) => ({ id, mediaType }));
    }
  }
  return copy;
}

function authChallenge(origin: string, scopes: readonly string[] = requiredScopes) {
  return `Bearer resource_metadata="${new URL(protectedResourcePath, origin)}", scope="${scopes.join(' ')}"`;
}

function scopesForTool(name: string) {
  return [
    'start_codex_task',
    'send_codex_message',
    'create_task',
    'update_task',
    'add_task_comment'
  ].includes(name)
    ? [projectSpaceMcpReadScope, projectSpaceMcpWriteScope]
    : [projectSpaceMcpReadScope];
}

function bearerToken(request: IncomingMessage) {
  const header = request.headers.authorization;
  return header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : undefined;
}

function requiredUserId(authInfo: AuthInfo) {
  const userId = authInfo.extra?.userId;
  if (typeof userId !== 'string' || !userId) throw new Error('The OAuth token has no Project Space user.');
  return userId;
}

function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function isMcpPath(pathname: string) {
  return pathname === mcpPath;
}

function applyCors(response: ServerResponse, mcp: boolean) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  if (mcp) {
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Last-Event-ID, MCP-Protocol-Version, MCP-Session-Id, X-Request-ID');
    response.setHeader('Access-Control-Expose-Headers', 'MCP-Session-Id, WWW-Authenticate, X-Request-ID');
  }
}

function pruneSessions(sessions: Map<string, McpSession>, logger: ProjectSpaceLogger) {
  const expiredBefore = Date.now() - sessionLifetimeMs;
  for (const [sessionId, session] of sessions) {
    if (session.lastSeenAt < expiredBefore) {
      sessions.delete(sessionId);
      void session.server.close().catch((error) => {
        logger.warn('mcp.session.close_failed', { mcpSessionId: sessionId }, error);
      });
    }
  }
}

function writeJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(value));
}

function methodNotAllowed(response: ServerResponse, allow: string) {
  response.setHeader('Allow', allow);
  writeJson(response, 405, { error: 'Method not allowed.' });
  return true;
}
