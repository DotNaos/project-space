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

const mcpPath = '/mcp';
const protectedResourcePath = '/.well-known/oauth-protected-resource/mcp';
const requiredScopes = projectSpaceMcpScopes;
const sessionHeader = 'mcp-session-id';
const sessionLifetimeMs = 60 * 60_000;
const maximumSessions = 100;

type McpBackend = Pick<
  ProjectSpaceBackend,
  'getConnectorOverview' | 'getGitHubCatalog' | 'loadProjectDiscovery'
>;

export interface ProjectSpaceMcpOptions {
  backend: McpBackend;
  createRuntime(): Promise<ConfiguredCodexMachineTasksRuntime>;
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
    issue: z.number().int().positive(),
    operationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/).optional(),
    repositoryId: z.string().trim().min(1).optional()
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
  tool('start_codex_task', 'Start Codex task', 'Start a Codex task from a GitHub issue. This creates a Project-managed worktree and starts Codex on the selected machine.', {
    type: 'object', required: ['issue'], properties: {
      connectorId: { type: 'string' }, physicalMachineId: { type: 'string' }, physicalMachineName: { type: 'string' },
      dryRun: { type: 'boolean', description: 'Validate and resolve the target without starting Codex.' },
      issue: { type: 'integer', minimum: 1 }, operationId: { type: 'string' }, repositoryId: { type: 'string' }
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
  let runtime: Promise<ConfiguredCodexMachineTasksRuntime> | undefined;
  const getRuntime = () => (runtime ??= options.createRuntime().catch((error) => {
    runtime = undefined;
    throw error;
  }));

  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
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

    const challenge = authChallenge(requestPublicOrigin(request));
    const authInfo = await authenticateMcpRequest(request, oauth.verifyAccessToken).catch(() => undefined);
    if (!authInfo) {
      response.setHeader('WWW-Authenticate', challenge);
      writeJson(response, 401, { error: 'Unauthorized' });
      return true;
    }

    pruneSessions(sessions);
    const requestedSessionId = headerValue(request.headers[sessionHeader]);
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
      const server = createMcpServer(options.backend, getRuntime, challenge);
      const transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
        sessionIdGenerator: randomUUID,
        onsessionclosed(sessionId) {
          sessions.delete(sessionId);
        },
        onsessioninitialized(sessionId) {
          sessions.set(sessionId, {
            clientId: authInfo.clientId,
            lastSeenAt: Date.now(),
            server,
            transport,
            userId
          });
        }
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
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
    await session.transport.handleRequest(request, response);
    return true;
  };
}

function createMcpServer(
  backend: McpBackend,
  runtime: () => Promise<ConfiguredCodexMachineTasksRuntime>,
  challenge: string
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
    const userId = extra.authInfo?.extra?.userId;
    if (typeof userId !== 'string' || !userId) return authenticationError(challenge);
    const requiredToolScopes = scopesForTool(request.params.name);
    if (!requiredToolScopes.every((scope) => extra.authInfo?.scopes.includes(scope))) {
      return authenticationError(challenge);
    }
    try {
      return await runWithAuthSession(
        { login: 'project-space-mcp', role: 'user', userId },
        () => callTool(backend, runtime, userId, request.params.name, request.params.arguments ?? {})
      );
    } catch (error) {
      return toolError(error instanceof Error ? error.message : 'The Project Space operation failed.');
    }
  });
  return server;
}

async function callTool(
  backend: McpBackend,
  runtime: () => Promise<ConfiguredCodexMachineTasksRuntime>,
  userId: string,
  name: string,
  rawArguments: Record<string, unknown>
): Promise<CallToolResult> {
  switch (name) {
    case 'list_projects': {
      const input = toolSchemas.list_projects.parse(rawArguments);
      const [discovery, catalog] = await Promise.all([
        backend.loadProjectDiscovery(),
        backend.getGitHubCatalog().catch(() => undefined)
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
      const input = toolSchemas.start_codex_task.parse(rawArguments);
      const result = await (await runtime()).service.start({ userId }, {
        ...input,
        dryRun: input.dryRun ?? false,
        operationId: input.operationId ?? `mcp:start:${randomUUID()}`
      });
      return toolResult(result);
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
      return toolError(`Unknown tool: ${name}`);
  }
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

function toolResult(value: unknown): CallToolResult {
  const result = { result: value } as Record<string, unknown>;
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: result
  };
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function authenticationError(challenge: string): CallToolResult {
  return {
    ...toolError('Authentication required.'),
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
  return name === 'start_codex_task' || name === 'send_codex_message'
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
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Last-Event-ID, MCP-Protocol-Version, MCP-Session-Id');
    response.setHeader('Access-Control-Expose-Headers', 'MCP-Session-Id, WWW-Authenticate');
  }
}

function pruneSessions(sessions: Map<string, McpSession>) {
  const expiredBefore = Date.now() - sessionLifetimeMs;
  for (const [sessionId, session] of sessions) {
    if (session.lastSeenAt < expiredBefore) {
      sessions.delete(sessionId);
      void session.server.close().catch(() => undefined);
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
