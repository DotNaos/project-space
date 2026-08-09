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
  callTaskExecutionTool,
  isTaskExecutionTool
} from './project-space-mcp/task-executions';
import {
  callTaskDeliveryTool,
  isTaskDeliveryTool
} from './project-space-mcp/task-delivery';
import {
  callLegacyCodexTaskTool,
  isLegacyCodexTaskTool
} from './project-space-mcp/legacy-codex-task-tools';
import { callGitHubTaskTool } from './project-space-mcp/github-task-tools';
import type { TaskDeliveryService } from './task-delivery/service';
import type { TaskExecutionService } from './task-execution/service';
import type { WorkspaceCommandService } from './workspace-command/service';
import {
  callWorkspaceCommandTool,
  isWorkspaceCommandTool,
  recoveryApprovalAccepted,
  recoveryApprovalRequest
} from './project-space-mcp/workspace-commands';
import { toolError } from './project-space-mcp/results';
import { scopesForTool, tools } from './project-space-mcp/tool-catalog';
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
  createTaskDelivery?(): Promise<TaskDeliveryService>;
  createTaskExecutions?(): Promise<TaskExecutionService>;
  createWorkspaceCommands?(): Promise<WorkspaceCommandService>;
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
  let taskExecutions: Promise<TaskExecutionService> | undefined;
  const getTaskExecutions = () => (
    taskExecutions ??= options.createTaskExecutions?.().catch((error) => {
      taskExecutions = undefined;
      throw error;
    })
  );
  let taskDelivery: Promise<TaskDeliveryService> | undefined;
  const getTaskDelivery = () => (
    taskDelivery ??= options.createTaskDelivery?.().catch((error) => {
      taskDelivery = undefined;
      throw error;
    })
  );
  let workspaceCommands: Promise<WorkspaceCommandService> | undefined;
  const getWorkspaceCommands = () => (
    workspaceCommands ??= options.createWorkspaceCommands?.().catch((error) => {
      workspaceCommands = undefined;
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
          getTaskDelivery,
          getTaskExecutions,
          getWorkspaceCommands,
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
  taskDelivery: () => Promise<TaskDeliveryService> | undefined,
  taskExecutions: () => Promise<TaskExecutionService> | undefined,
  workspaceCommands: () => Promise<WorkspaceCommandService> | undefined,
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
          taskDelivery,
          taskExecutions,
          workspaceCommands,
          runtime,
          loadComputeInventory,
          extra.authInfo?.clientId,
          userId,
          toolName,
          request.params.arguments ?? {},
          logger,
          async (input) => recoveryApprovalAccepted(
            await server.elicitInput(recoveryApprovalRequest(input))
          )
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
  taskDelivery: () => Promise<TaskDeliveryService> | undefined,
  taskExecutions: () => Promise<TaskExecutionService> | undefined,
  workspaceCommands: () => Promise<WorkspaceCommandService> | undefined,
  runtime: () => Promise<ConfiguredCodexMachineTasksRuntime>,
  loadComputeInventory: LoadMcpComputeInventory,
  clientId: string | undefined,
  userId: string,
  name: string,
  rawArguments: Record<string, unknown>,
  logger: ProjectSpaceLogger,
  approveRecovery: (input: { command: string; environmentId: string }) => Promise<boolean>
): Promise<CallToolResult> {
  if (isTaskDeliveryTool(name)) {
    const service = taskDelivery();
    if (!service) return toolError('Task Delivery runtime is unavailable.', currentRequestId());
    const result = await callTaskDeliveryTool({
      clientId, name, rawArguments, service: await service, userId
    });
    if (result) return result;
  }
  if (isWorkspaceCommandTool(name)) {
    const service = workspaceCommands();
    if (!service) return toolError('Workspace command runtime is unavailable.', currentRequestId());
    const result = await callWorkspaceCommandTool({
      approveRecovery, name, rawArguments, service: await service, userId
    });
    if (result) return result;
  }
  if (isTaskExecutionTool(name)) {
    const service = taskExecutions();
    if (!service) return toolError('Task Execution runtime is unavailable.', currentRequestId());
    const result = await callTaskExecutionTool({
      name,
      rawArguments,
      service: await service,
      clientId,
      userId
    });
    if (result) return result;
  }
  if (isLegacyCodexTaskTool(name)) {
    return callLegacyCodexTaskTool({
      backend, logger, name, rawArguments, runtime, taskExecutions, userId
    });
  }
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
  const githubResult = await callGitHubTaskTool({ backend, logger, name, rawArguments });
  return githubResult ?? toolError(`Unknown tool: ${name}`, currentRequestId());
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
