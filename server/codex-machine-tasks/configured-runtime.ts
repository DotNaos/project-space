import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ProjectSpaceBackend } from '../../src/shared/project-space-api';
import type { ComputeInventorySnapshot } from '../../src/shared/compute-environment-api';
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
import {
  getCodexSessionsDatabaseClient,
  isDatabaseConfigured,
} from '../local-database-store';
import { ProjectSpaceDatabaseRepository } from '../database/repository';
import { createConfiguredCodexSessionsRuntime } from '../codex-sessions/configured-runtime';
import { createWorkspaceRuntimeCodexBridge } from './workspace-runtime';
import type { WorkspaceRuntimeSessionService } from '../workspace-runtime-session/service';
import { PostgresTaskExecutionStore } from '../task-execution/execution-store';
import type { CodexMachineTasksServiceOptions } from './contracts';
import type { WorkspaceRuntimeCodexBridge } from './workspace-runtime';
import type { TransactionalDatabaseQueryClient } from '../machine-connection-database-store';

export interface ConfiguredCodexMachineTasksOptions {
  attachLeases?: CodexAttachLeaseStore;
  backend: Pick<
    ProjectSpaceBackend,
    'createGitHubBranch' | 'getConnectorOverview' | 'getGitHubCatalog' |
    'getGitHubRepositoryDetails' | 'getMachineRuntime'
  >;
  machineConnection?: Pick<MachineConnectionRuntime, 'resolveMachineCredentialIdentity'>;
  /** Test seam for the already-authorized database boundary. */
  database?: TransactionalDatabaseQueryClient;
  /** Test seam for the canonical compute inventory boundary. */
  inventory?: (userId: string) => Promise<ComputeInventorySnapshot>;
  taskStore?: CodexMachineTasksServiceOptions['store'];
  workspaceBindingStore?: Pick<PostgresTaskExecutionStore, 'list' | 'readWorkspace'>;
  sessionsRuntime?: Promise<CodexSessionsRuntime>;
  runtimeSessions?: WorkspaceRuntimeSessionService;
}

export interface ConfiguredCodexMachineTasksRuntime {
  service: ReturnType<typeof createCodexMachineTasksService>;
  sessions: CodexSessionsRuntime;
}

/**
 * Compose the production task service from the canonical Workspace Runtime
 * bridge. Keeping this seam explicit makes it impossible to omit durable
 * generation evidence when another configured entry point is added.
 */
export function createConfiguredCodexMachineTasksService(input: {
  bridge: WorkspaceRuntimeCodexBridge;
  issue: CodexMachineTasksServiceOptions['issue'];
  store: CodexMachineTasksServiceOptions['store'];
  taskUrl: NonNullable<CodexMachineTasksServiceOptions['taskUrl']>;
}) {
  return createCodexMachineTasksService({
    durableGenerationFor: input.bridge.durableGenerationFor,
    generationFor: input.bridge.generationFor,
    inventory: input.bridge.inventory,
    issue: input.issue,
    plan: input.bridge.plan,
    sessions: input.bridge.sessions,
    start: input.bridge.start,
    store: input.store,
    taskUrl: input.taskUrl,
    requireReportingTaskBinding: true
  });
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
  if (!options.runtimeSessions) throw new CodexMachineTasksRetiredError();
  const database = options.database ?? await getCodexSessionsDatabaseClient();
  const inventoryRepository = new ProjectSpaceDatabaseRepository(database);
  const taskExecutions = options.workspaceBindingStore ?? new PostgresTaskExecutionStore(database);
  const bridge = createWorkspaceRuntimeCodexBridge({
    loadInventory: async (userId) => {
      if (options.inventory) return options.inventory(userId);
      if (!options.database && !isDatabaseConfigured()) {
        return { connectors: [], environmentDefinitions: [], environments: [], hosts: [], platforms: [], violations: [] };
      }
      // The configured Codex boundary intentionally lists only the requesting
      // user's repository scope. The broader deployment inventory is reserved
      // for non-Codex presentation paths.
      return inventoryRepository.listComputeInventory(userId);
    },
    sessions: options.runtimeSessions,
    resolveWorkspaceBinding: async ({ branch, commit, environmentId, ownerUserId, workspaceId }) => {
      const candidates = await taskExecutions.list({
        agent: 'codex',
        environmentId,
        includeArchived: false,
        limit: 100,
        ownerUserId
      });
      for (const execution of candidates) {
        const workspace = await taskExecutions.readWorkspace(ownerUserId, execution.id);
        if (workspace?.id !== workspaceId || workspace.state !== 'ready' ||
            workspace.branch !== branch || workspace.commit?.toLowerCase() !== commit.toLowerCase() ||
            workspace.target?.kind !== 'project_worktree' || !workspace.target.reference) continue;
        return {
          branch: workspace.branch,
          commit: workspace.commit,
          id: workspace.id,
          worktree: { branch: workspace.branch, id: workspace.target.reference }
        };
      }
      return undefined;
    }
  });
  // The canonical Environment/Workspace Runtime start path must not depend on
  // the deferred Chat sessions compatibility runtime. Keep that runtime lazy:
  // a rejected or never-settling compatibility promise must not delay service
  // construction, while downstream compatibility callers still get the real
  // runtime if it eventually becomes available.
  const compatibility = Promise.resolve(
    options.sessionsRuntime ?? createConfiguredCodexSessionsRuntime()
  ).catch(() => unavailableCodexSessionsRuntime());
  void compatibility.catch(() => undefined);
  const sessions = createLazyCodexSessionsRuntime(compatibility);
  const service = createConfiguredCodexMachineTasksService({
    bridge,
    issue: createCodexMachineTaskIssueProvider(options.backend),
    store: options.taskStore ?? new PostgresCodexMachineTasksStore(database),
    taskUrl: (machineId, threadId) => {
      const origin = (process.env.PROJECT_SPACE_PUBLIC_URL ?? 'https://projects.os-home.net').replace(/\/$/, '');
      return `${origin}/codex/machines/${encodeURIComponent(machineId)}/threads/${encodeURIComponent(threadId)}`;
    }
  });
  return { service, sessions };
}

function unavailableCodexSessionsRuntime(): CodexSessionsRuntime {
  const unavailable = async () => {
    throw new Error('The deferred Codex Chat sessions runtime is unavailable.');
  };
  return {
    handleRequest: async () => false,
    service: new Proxy({}, { get: () => unavailable }) as CodexSessionsRuntime['service']
  };
}

export function createLazyCodexSessionsRuntime(
  compatibility: Promise<CodexSessionsRuntime>
): CodexSessionsRuntime {
  const service = new Proxy({}, {
    get(_target, property: string) {
      return (...args: unknown[]) => compatibility.then((runtime) => {
        const method = Reflect.get(runtime.service, property);
        if (typeof method !== 'function') {
          throw new Error('The deferred Codex Chat sessions runtime is unavailable.');
        }
        return Reflect.apply(method, runtime.service, args);
      });
    }
  }) as CodexSessionsRuntime['service'];
  return {
    handleRequest: async (...args) => (await compatibility).handleRequest(...args),
    service
  };
}
