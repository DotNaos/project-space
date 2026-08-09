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

import type { ProjectSpaceBackend } from '../src/shared/project-space-api';
import type { AgentRuntimeService } from './agent-authorization/service';
import { requestPublicOrigin } from './connector-installation';
import type { ConfiguredCodexMachineTasksRuntime } from './codex-machine-tasks/configured-runtime';
import { loadConfiguredComputeInventory } from './configured-compute-inventory';
import type {
  ExecutionEnvironmentLifecycleService
} from './execution-environment-lifecycle/service';
import {
  runWithAuthSession
} from './local-auth-store';
import {
  createProjectSpaceMcpOAuth,
  type ProjectSpaceMcpOAuthOptions
} from './project-space-mcp-oauth';
import {
  callComputeEnvironmentTool,
  type LoadMcpComputeInventory
} from './project-space-mcp/compute-environments';
import { callExecutionEnvironmentLifecycleTool } from './project-space-mcp/execution-environment-lifecycle';
import {
  resolveGitHubRepository,
  resolveGitHubTask
} from './project-space-mcp/github-resolver';
import {
  applyMcpCors,
  headerValue,
  methodNotAllowed,
  requiredUserId,
  writeJson
} from './project-space-mcp/http';
import {
  authenticateProjectSpaceMcpRequest,
  projectSpaceMcpAuthChallenge,
  projectSpaceMcpAuthenticationError,
  projectSpaceMcpAuthenticationScopes
} from './project-space-mcp/authentication';
import {
  callAgentRuntimeTool,
  isAgentRuntimeTool
} from './project-space-mcp/agent-runtime';
import {
  sanitizeCodexTaskStartResult,
  sanitizeGitHubBranch,
  sanitizeGitHubComment,
  sanitizeGitHubIssueMutation,
  sanitizeGitHubPullRequest,
  sanitizeGitHubTask,
  sanitizeGitHubWorkflowRun,
  sanitizeRepository,
  sanitizeSession,
  sanitizeTaskRead,
  toolError,
  toolResult
} from './project-space-mcp/results';
import { scopesForTool, tools, toolSchemas } from './project-space-mcp/tool-catalog';
import {
  currentRequestId,
  projectSpaceLogger,
  recordMcpTool,
  recordObservedError,
  withProjectSpaceSpan,
  type ProjectSpaceLogger
} from './observability';

const mcpPath = '/mcp';
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
  createAgentRuntime?(): Promise<AgentRuntimeService>;
  createEnvironmentLifecycle?(): Promise<ExecutionEnvironmentLifecycleService>;
  createRuntime(): Promise<ConfiguredCodexMachineTasksRuntime>;
  loadComputeInventory?: LoadMcpComputeInventory;
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

export function createProjectSpaceMcpHandler(options: ProjectSpaceMcpOptions) {
  const sessions = new Map<string, McpSession>();
  const oauth = createProjectSpaceMcpOAuth(options.oauth);
  const logger = (options.logger ?? projectSpaceLogger).child({ component: 'mcp' });
  let runtime: Promise<ConfiguredCodexMachineTasksRuntime> | undefined;
  const getRuntime = () => (runtime ??= options.createRuntime().catch((error) => {
    runtime = undefined;
    throw error;
  }));
  let agentRuntime: Promise<AgentRuntimeService> | undefined;
  const getAgentRuntime = () => (
    agentRuntime ??= options.createAgentRuntime?.().catch((error) => {
      agentRuntime = undefined;
      throw error;
    })
  );
  let environmentLifecycle: Promise<ExecutionEnvironmentLifecycleService> | undefined;
  const getEnvironmentLifecycle = () => (
    environmentLifecycle ??= options.createEnvironmentLifecycle?.().catch((error) => {
      environmentLifecycle = undefined;
      throw error;
    })
  );
  const loadComputeInventory = options.loadComputeInventory ?? ((userId) => (
    loadConfiguredComputeInventory({ backend: options.backend, userId })
  ));

  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    let stage = 'oauth';
    const requestedSessionId = headerValue(request.headers[sessionHeader]);
    try {
      if (await oauth.handle(request, response, url)) return true;
      if (!isMcpPath(url.pathname)) return false;
      applyMcpCors(response);
      if (request.method === 'OPTIONS') {
        response.writeHead(204).end();
        return true;
      }

      if (!['GET', 'POST', 'DELETE'].includes(request.method ?? '')) {
        return methodNotAllowed(response, 'GET, POST, DELETE, OPTIONS');
      }

      stage = 'authentication';
      const publicOrigin = requestPublicOrigin(request);
      const challenge = projectSpaceMcpAuthChallenge(
        publicOrigin,
        projectSpaceMcpAuthenticationScopes
      );
      let authInfo: AuthInfo | undefined;
      try {
        authInfo = await authenticateProjectSpaceMcpRequest(request, oauth.verifyAccessToken);
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
        const server = createMcpServer(
          options.backend,
          getAgentRuntime,
          getEnvironmentLifecycle,
          getRuntime,
          loadComputeInventory,
          publicOrigin,
          logger
        );
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
  agentRuntime: () => Promise<AgentRuntimeService> | undefined,
  environmentLifecycle: () => Promise<ExecutionEnvironmentLifecycleService> | undefined,
  runtime: () => Promise<ConfiguredCodexMachineTasksRuntime>,
  loadComputeInventory: LoadMcpComputeInventory,
  publicOrigin: string,
  logger: ProjectSpaceLogger
) {
  const server = new Server(
    { name: 'project-space', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions: 'Use read-only task and execution Environment discovery before starting a Codex task. Starting a task and sending a message are consequential actions.'
    }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools } as { tools: Tool[] }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const toolName = request.params.name;
    const startedAt = performance.now();
    const userId = extra.authInfo?.extra?.userId;
    if (typeof userId !== 'string' || !userId) {
      return projectSpaceMcpAuthenticationError(projectSpaceMcpAuthChallenge(
        publicOrigin,
        projectSpaceMcpAuthenticationScopes
      ));
    }
    const requiredToolScopes = scopesForTool(toolName);
    if (!requiredToolScopes.every((scope) => extra.authInfo?.scopes.includes(scope))) {
      return projectSpaceMcpAuthenticationError(
        projectSpaceMcpAuthChallenge(publicOrigin, requiredToolScopes)
      );
    }
    try {
      const result = await withProjectSpaceSpan(`mcp.tool.${toolName}`, {
        'mcp.tool.name': toolName
      }, () => runWithAuthSession(
        { login: 'project-space-mcp', role: 'user', userId },
        () => callTool(
          backend,
          agentRuntime,
          environmentLifecycle,
          runtime,
          loadComputeInventory,
          userId,
          toolName,
          request.params.arguments ?? {},
          logger
        )
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
  agentRuntime: () => Promise<AgentRuntimeService> | undefined,
  environmentLifecycle: () => Promise<ExecutionEnvironmentLifecycleService> | undefined,
  runtime: () => Promise<ConfiguredCodexMachineTasksRuntime>,
  loadComputeInventory: LoadMcpComputeInventory,
  userId: string,
  name: string,
  rawArguments: Record<string, unknown>,
  logger: ProjectSpaceLogger
): Promise<CallToolResult> {
  if (isAgentRuntimeTool(name)) {
    const service = agentRuntime();
    if (!service) return toolError('Agent runtime is unavailable.', currentRequestId());
    const result = await callAgentRuntimeTool({
      name,
      rawArguments,
      service: await service,
      userId
    });
    if (result) return result;
  }
  const lifecycle = environmentLifecycle();
  if (lifecycle) {
    const lifecycleResult = await callExecutionEnvironmentLifecycleTool({
      name,
      rawArguments,
      service: await lifecycle,
      userId
    });
    if (lifecycleResult) return lifecycleResult;
  }
  const computeResult = await callComputeEnvironmentTool({
    ...(lifecycle ? { lifecycle: await lifecycle } : {}),
    loadInventory: loadComputeInventory,
    name,
    rawArguments,
    userId
  });
  if (computeResult) return computeResult;
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

function isMcpPath(pathname: string) {
  return pathname === mcpPath;
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
