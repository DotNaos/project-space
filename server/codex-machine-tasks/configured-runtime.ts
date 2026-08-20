import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ProjectSpaceBackend } from '../../src/shared/project-space-api';
import type { CodexSessionsRuntime } from '../codex-sessions/runtime';
import type { MachineConnectionRuntime } from '../machine-connection-runtime';
import { CodexAttachLeaseStore } from './attach-lease-store';
import type { CodexMachineTasksHttpHandler } from './http';
import { createCodexMachineTasksHttpApi } from './http';
import { createCodexMachineTaskIssueProvider } from './issue-provider';
import { createCodexMachineTasksService } from './service';
import { PostgresCodexMachineTasksStore } from './store';
import { createCodexMachineTasksAuthResolver } from './auth-context';
import { isProjectSpaceAuthRequired, readAuthSessionFromRequest } from '../local-auth-store';
import { getCodexSessionsDatabaseClient, isDatabaseConfigured, listComputeInventory } from '../local-database-store';
import { createConfiguredCodexSessionsRuntime } from '../codex-sessions/configured-runtime';
import { createWorkspaceRuntimeCodexBridge } from './workspace-runtime';
import type { WorkspaceRuntimeSessionService } from '../workspace-runtime-session/service';

export interface ConfiguredCodexMachineTasksOptions {
  attachLeases?: CodexAttachLeaseStore;
  backend: Pick<
    ProjectSpaceBackend,
    'createGitHubBranch' | 'getConnectorOverview' | 'getGitHubCatalog' |
    'getGitHubRepositoryDetails' | 'getMachineRuntime'
  >;
  machineConnection?: Pick<MachineConnectionRuntime, 'resolveMachineCredentialIdentity'>;
  sessionsRuntime?: Promise<CodexSessionsRuntime>;
  runtimeSessions?: WorkspaceRuntimeSessionService;
}

export interface ConfiguredCodexMachineTasksRuntime {
  service: ReturnType<typeof createCodexMachineTasksService>;
  sessions: CodexSessionsRuntime;
}

export class CodexMachineTasksRetiredError extends Error {
  constructor() {
    super('Codex machine tasks require the canonical Environment and Workspace Runtime.');
    this.name = 'CodexMachineTasksRetiredError';
  }
}

export function createConfiguredCodexMachineTasksHandler(
  options: ConfiguredCodexMachineTasksOptions
): CodexMachineTasksHttpHandler {
  let handler: Promise<CodexMachineTasksHttpHandler> | undefined;
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (!url.pathname.startsWith('/api/codex/tasks')) return false;
    if (!isDatabaseConfigured() || !options.runtimeSessions) {
      response.setHeader('Cache-Control', 'private, no-store');
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: {
        code: 'codex_machine_tasks_unavailable',
        message: 'Codex tasks require an online canonical Workspace Runtime.'
      }}));
      return true;
    }
    try {
      handler ??= createConfiguredCodexMachineTasksHandlerInner(options);
      return await (await handler)(request, response, url);
    } catch {
      handler = undefined;
      response.setHeader('Cache-Control', 'private, no-store');
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: {
        code: 'codex_machine_tasks_unavailable',
        message: 'Codex tasks are temporarily unavailable.'
      }}));
      return true;
    }
  };
}

async function createConfiguredCodexMachineTasksHandlerInner(
  options: ConfiguredCodexMachineTasksOptions
) {
  const runtime = await createConfiguredCodexMachineTasksRuntime(options);
  const resolveActor = createCodexMachineTasksAuthResolver({
    authenticateMachine: async ({ machineId, token }) => (
      options.machineConnection?.resolveMachineCredentialIdentity(token, machineId) ?? null
    ),
    authRequired: isProjectSpaceAuthRequired,
    readHuman: async (request) => {
      const session = await readAuthSessionFromRequest(request);
      return session ? { userId: session.userId } : null;
    }
  });
  return createCodexMachineTasksHttpApi(runtime.service, resolveActor);
}

export async function createConfiguredCodexMachineTasksRuntime(
  options: ConfiguredCodexMachineTasksOptions
): Promise<ConfiguredCodexMachineTasksRuntime> {
  const sessions = await (options.sessionsRuntime ?? createConfiguredCodexSessionsRuntime());
  if (!options.runtimeSessions) throw new CodexMachineTasksRetiredError();
  const bridge = createWorkspaceRuntimeCodexBridge({
    loadInventory: async (userId) => {
      if (!isDatabaseConfigured()) {
        return { connectors: [], environmentDefinitions: [], environments: [], hosts: [], platforms: [], violations: [] };
      }
      return listComputeInventory(userId);
    },
    sessions: options.runtimeSessions
  });
  const service = createCodexMachineTasksService({
    generationFor: bridge.generationFor,
    inventory: bridge.inventory,
    issue: createCodexMachineTaskIssueProvider(options.backend),
    sessions: bridge.sessions,
    start: bridge.start,
    store: new PostgresCodexMachineTasksStore(await getCodexSessionsDatabaseClient()),
    taskUrl: (machineId, threadId) => {
      const origin = (process.env.PROJECT_SPACE_PUBLIC_URL ?? 'https://projects.os-home.net').replace(/\/$/, '');
      return `${origin}/codex/machines/${encodeURIComponent(machineId)}/threads/${encodeURIComponent(threadId)}`;
    }
  });
  return { service, sessions };
}
