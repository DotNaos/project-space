import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ProjectSpaceBackend } from '../../src/shared/project-space-api';
import type {
  CodexSessionOperationResult,
  CodexSessionStreamEvent
} from '../../src/shared/codex-sessions-api';
import { requestConnectorCodexSessions } from '../connector-command-hub';
import {
  connectorHasCapability,
  connectorSessionGeneration
} from '../connector-command-session-registry';
import { CODEX_MACHINE_TASKS_DURABLE_OPERATIONS_CAPABILITY } from '../codex-sessions-connector-contract';
import {
  createConfiguredCodexSessionsRuntime
} from '../codex-sessions/configured-runtime';
import type { CodexSessionsRuntime } from '../codex-sessions/runtime';
import {
  CodexConnectorNotDispatchedError,
  CodexConnectorOutcomeUnknownError,
  CodexConnectorRemoteError
} from '../codex-sessions/connector-hub';
import {
  getCodexSessionsDatabaseClient,
  isDatabaseConfigured,
  listComputeInventory,
  listPhysicalMachines,
  readMachineMembership
} from '../local-database-store';
import {
  isProjectSpaceAuthRequired,
  readAuthSessionFromRequest,
  runWithAuthSession
} from '../local-auth-store';
import type { MachineConnectionRuntime } from '../machine-connection-runtime';
import { writeJson } from '../project-space-http-response';
import { createCodexMachineTasksAuthResolver } from './auth-context';
import {
  createCodexMachineTasksHttpApi,
  type CodexMachineTasksHttpHandler
} from './http';
import { createCodexMachineTaskIssueProvider } from './issue-provider';
import { createCodexMachineTasksService } from './service';
import { PostgresCodexMachineTasksStore } from './store';
import { CodexAttachLeaseStore } from './attach-lease-store';

export interface ConfiguredCodexMachineTasksOptions {
  attachLeases?: CodexAttachLeaseStore;
  backend: Pick<
    ProjectSpaceBackend,
    'createGitHubBranch' | 'getConnectorOverview' | 'getGitHubCatalog' |
    'getGitHubRepositoryDetails' | 'getMachineRuntime'
  >;
  machineConnection?: Pick<MachineConnectionRuntime, 'resolveMachineCredentialIdentity'>;
  sessionsRuntime?: Promise<CodexSessionsRuntime>;
}

export interface ConfiguredCodexMachineTasksRuntime {
  service: ReturnType<typeof createCodexMachineTasksService>;
  sessions: CodexSessionsRuntime;
}

export function createConfiguredCodexMachineTasksHandler(
  options: ConfiguredCodexMachineTasksOptions
): CodexMachineTasksHttpHandler {
  let runtime: Promise<CodexMachineTasksHttpHandler> | undefined;
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (!url.pathname.startsWith('/api/codex/tasks')) return false;
    if (!isDatabaseConfigured()) {
      writeJson(response, 503, {
        error: {
          code: 'codex_machine_tasks_unavailable',
          message: 'Codex machine tasks require the Project Space database.'
        }
      });
      return true;
    }
    try {
      runtime ??= createHandler(options);
      return await (await runtime)(request, response, url);
    } catch {
      runtime = undefined;
      writeJson(response, 503, {
        error: {
          code: 'codex_machine_tasks_unavailable',
          message: 'Codex machine tasks are temporarily unavailable.'
        }
      });
      return true;
    }
  };
}

async function createHandler(options: ConfiguredCodexMachineTasksOptions) {
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
  const store = new PostgresCodexMachineTasksStore(await getCodexSessionsDatabaseClient());
  const service = createCodexMachineTasksService({
    attachments: options.attachLeases,
    generationFor: connectorSessionGeneration,
    durableGenerationFor: (connectorId, generation) => (
      connectorSessionGeneration(connectorId) === generation &&
      connectorHasCapability(connectorId, CODEX_MACHINE_TASKS_DURABLE_OPERATIONS_CAPABILITY)
    ),
    async inventory(userId) {
      return runWithAuthSession(machineSession(userId), async () => {
        const overview = await options.backend.getConnectorOverview();
        const runtimeEntries = await Promise.all(overview.machines.map(async (connector) => {
          try {
            return [
              connector.id,
              await options.backend.getMachineRuntime(connector.id)
            ] as const;
          } catch {
            return undefined;
          }
        }));
        return {
          computeInventory: await listComputeInventory(userId),
          connectors: overview.machines,
          physicalMachines: await listPhysicalMachines(userId),
          runtimeStatuses: new Map(runtimeEntries.filter(
            (entry): entry is NonNullable<typeof entry> => Boolean(entry)
          ))
        };
      });
    },
    issue: createCodexMachineTaskIssueProvider(options.backend),
    sessions: {
      read: ({ connectorId, generation, threadId, userId }) => sessions.service.read(
        { userId }, { connectorGeneration: generation, machineId: connectorId, threadId }
      ),
      reconcileSend: async (input) => {
        const generation = connectorReconciliationGeneration(
          input.connectorId,
          input.generation,
          input.durableOperations
        );
        if (generation === undefined) {
          return Promise.resolve({
            generation: input.generation,
            result: {
              operationId: input.operationId,
              replayed: true,
              status: 'ambiguous' as const,
              threadId: input.threadId
            }
          });
        }
        return {
          generation,
          result: await sessions.service.reconcileContinue({ userId: input.userId }, {
            connectorGeneration: generation,
            machineId: input.connectorId,
            message: input.message,
            operationId: input.operationId,
            threadId: input.threadId
          })
        };
      },
      send: ({ connectorId, generation, message, operationId, threadId, userId }) => sessions.service.continue(
        { userId }, {
          connectorGeneration: generation, machineId: connectorId, message, operationId, threadId
        }
      ),
      async stream(input) {
        let markLocalReady!: () => void;
        let markTransportReady!: () => void;
        const localReady = new Promise<void>((resolve) => { markLocalReady = resolve; });
        const transportReady = new Promise<void>((resolve) => { markTransportReady = resolve; });
        const running = Promise.all([
          sessions.service.stream(
            { userId: input.userId },
            {
              afterSequence: input.afterSequence,
              connectorGeneration: input.generation,
              machineId: input.connectorId,
              threadId: input.threadId
            },
            input.emit,
            input.signal,
            markLocalReady
          ),
          sessions.service.transportStream(
            { userId: input.userId },
            {
              connectorGeneration: input.generation,
              machineId: input.connectorId,
              onDispatched: markTransportReady,
              threadId: input.threadId
            },
            input.signal
          )
        ]);
        await Promise.race([
          Promise.all([localReady, transportReady]),
          running.then(() => { throw new Error('Codex task stream ended before it opened.'); })
        ]);
        input.onReady?.();
        await running;
      },
      wait: (input) => waitForTerminal(sessions, input)
    },
    async start(input) {
      const generation = input.reconcile
        ? connectorReconciliationGeneration(
            input.connectorId,
            input.generation,
            input.durableOperations
          )
        : input.generation;
      if (generation === undefined) {
        return { generation: input.generation, result: { state: 'uncertain' as const } };
      }
      try {
        const result = await requestConnectorCodexSessions('start', {
          branch: input.branch,
          commit: input.commit,
          initialPrompt: buildInitialPrompt(input.issue.url),
          issueNumber: input.issue.number,
          issueUrl: input.issue.url,
          machineId: input.connectorId,
          operationId: input.operationId,
          physicalMachineId: input.physicalMachineId,
          projectId: `github:${input.repository.id}`,
          repositoryId: input.repository.id,
          repositoryNameWithOwner: input.repository.nameWithOwner
        }, {
          generation,
          operationId: input.operationId,
          userId: input.userId
        });
        return {
          generation,
          result: result.operation === 'start' ? result.result : { state: 'uncertain' as const }
        };
      } catch (error) {
        if (error instanceof CodexConnectorNotDispatchedError) {
          return { generation, result: { state: 'offline' as const } };
        }
        if (error instanceof CodexConnectorOutcomeUnknownError) {
          return { generation, result: { state: 'uncertain' as const } };
        }
        if (error instanceof CodexConnectorRemoteError) {
          return {
            generation,
            result: error.code === 'unavailable'
              ? { state: 'uncertain' as const }
              : {
                  message: 'The connector could not start Codex on the prepared worktree.',
                  state: 'codex_failure' as const
                }
          };
        }
        return { generation, result: { state: 'uncertain' as const } };
      }
    },
    store,
    taskUrl: (connectorId, threadId) => {
      const origin = (process.env.PROJECT_SPACE_PUBLIC_URL ?? 'https://projects.os-home.net').replace(/\/$/, '');
      return `${origin}/codex/machines/${encodeURIComponent(connectorId)}/threads/${encodeURIComponent(threadId)}`;
    },
    userCanUseConnector: undefined
  });
  return { service, sessions };
}

export function connectorReconciliationGeneration(
  connectorId: string,
  originalGeneration: number,
  originalDurableOperations: boolean
) {
  const currentGeneration = connectorSessionGeneration(connectorId);
  if (currentGeneration === originalGeneration) return originalGeneration;
  return originalDurableOperations && currentGeneration !== undefined && connectorHasCapability(
    connectorId,
    CODEX_MACHINE_TASKS_DURABLE_OPERATIONS_CAPABILITY
  )
    ? currentGeneration
    : undefined;
}

export async function waitForTerminal(
  sessions: CodexSessionsRuntime,
  input: {
    afterSequence?: number;
    connectorId: string;
    generation: number;
    start(): Promise<CodexSessionOperationResult>;
    threadId: string;
    userId: string;
  }
) {
  const controller = new AbortController();
  let markLocalReady!: () => void;
  let markTransportReady!: () => void;
  const localReady = new Promise<void>((resolve) => { markLocalReady = resolve; });
  const transportReady = new Promise<void>((resolve) => { markTransportReady = resolve; });
  let turnId: string | undefined;
  let resolveTerminal!: (value: { event: CodexSessionStreamEvent; sequence?: number }) => void;
  const terminal = new Promise<{ event: CodexSessionStreamEvent; sequence?: number }>(
    (resolve) => { resolveTerminal = resolve; }
  );
  const observed: Array<{ event: CodexSessionStreamEvent; sequence?: number }> = [];
  const matches = (event: CodexSessionStreamEvent) => turnId !== undefined &&
    'turnId' in event && event.turnId === turnId && [
      'approval-requested', 'turn-completed', 'user-input-requested'
    ].includes(event.type);
  const emit = (event: CodexSessionStreamEvent, sequence?: number) => {
    observed.push({ event, sequence });
    if (observed.length > 500) observed.shift();
    if (matches(event)) resolveTerminal({ event, sequence });
  };
  const streaming = Promise.all([
    sessions.service.stream(
      { userId: input.userId },
      {
        afterSequence: input.afterSequence,
        connectorGeneration: input.generation,
        machineId: input.connectorId,
        threadId: input.threadId
      },
      emit,
      controller.signal,
      markLocalReady
    ),
    sessions.service.transportStream(
      { userId: input.userId },
      {
        connectorGeneration: input.generation,
        machineId: input.connectorId,
        onDispatched: markTransportReady,
        threadId: input.threadId
      },
      controller.signal
    )
  ]);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([localReady, transportReady]),
      streaming.then(() => { throw new Error('Codex turn stream ended before it opened.'); })
    ]);
    const result = await input.start();
    if (result.status !== 'accepted' || !result.turnId) return { result };
    turnId = result.turnId;
    const current = await sessions.service.read(
      { userId: input.userId },
      {
        connectorGeneration: input.generation,
        machineId: input.connectorId,
        threadId: input.threadId
      }
    );
    const currentTurn = current.turns.find((turn) => turn.id === turnId);
    if (currentTurn && currentTurn.status !== 'in-progress') {
      return {
        event: {
          eventId: `reconciled:${turnId}`,
          type: 'turn-completed' as const,
          turnId
        },
        result
      };
    }
    let replayedTerminal: { event: CodexSessionStreamEvent; sequence?: number } | undefined;
    for (let index = observed.length - 1; index >= 0; index -= 1) {
      if (matches(observed[index]!.event)) {
        replayedTerminal = observed[index];
        break;
      }
    }
    if (replayedTerminal) return { result, ...replayedTerminal };
    const expired = new Promise<'expired'>((resolve) => {
      timeout = setTimeout(() => resolve('expired'), 30 * 60_000);
    });
    const settled = await Promise.race([
      terminal.then((value) => ({ kind: 'terminal' as const, value })),
      streaming.then(
        () => ({ kind: 'ended' as const }),
        () => ({ kind: 'ended' as const })
      ),
      expired.then(() => ({ kind: 'ended' as const }))
    ]);
    return settled.kind === 'terminal'
      ? { result, ...settled.value }
      : { result };
  } finally {
    if (timeout) clearTimeout(timeout);
    controller.abort();
    await streaming.catch(() => undefined);
  }
}

export function buildInitialPrompt(issueUrl: string) {
  return [
    `Implement ${issueUrl} end to end in this Project-managed worktree.`,
    'Read and follow every repository AGENTS.md before making changes.',
    'Use the local Project CLI for worktree and parallel-task checks. Do not call Project Space MCP or app tools from this managed runner because they route back through the same active connector.',
    'Starting this task does not authorize merge, release, deploy, or unrelated external actions.'
  ].join('\n');
}

function machineSession(userId: string) {
  return { login: 'project-cli', role: 'user' as const, userId };
}
