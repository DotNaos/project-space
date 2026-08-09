import { randomUUID } from 'node:crypto';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { ProjectSpaceBackend } from '../../src/shared/project-space-api';
import type { ConfiguredCodexMachineTasksRuntime } from '../codex-machine-tasks/configured-runtime';
import type { ProjectSpaceLogger } from '../observability';
import type { TaskExecutionService } from '../task-execution/service';
import { currentRequestId } from '../observability';
import { resolveGitHubRepository } from './github-resolver';
import {
  sanitizeCodexTaskStartResult,
  sanitizeSession,
  sanitizeTaskRead,
  toolError,
  toolResult
} from './results';
import { toolSchemas } from './tool-catalog';

type LegacyCodexTaskBackend = Pick<
  ProjectSpaceBackend,
  'getConnectorOverview' | 'getGitHubCatalog' | 'getGitHubRepositoryDetails'
>;

const names = new Set([
  'list_codex_tasks', 'read_codex_task', 'send_codex_message', 'start_codex_task'
]);

export function isLegacyCodexTaskTool(name: string) {
  return names.has(name);
}

export async function callLegacyCodexTaskTool(input: {
  backend: LegacyCodexTaskBackend;
  logger: ProjectSpaceLogger;
  name: string;
  rawArguments: Record<string, unknown>;
  runtime(): Promise<ConfiguredCodexMachineTasksRuntime>;
  taskExecutions(): Promise<TaskExecutionService> | undefined;
  userId: string;
}): Promise<CallToolResult> {
  switch (input.name) {
    case 'list_codex_tasks':
      return list(input);
    case 'read_codex_task':
      return read(input);
    case 'start_codex_task':
      return start(input);
    case 'send_codex_message':
      return send(input);
    default:
      return toolError(`Unknown tool: ${input.name}`, currentRequestId());
  }
}

async function list(input: Parameters<typeof callLegacyCodexTaskTool>[0]) {
  const request = toolSchemas.list_codex_tasks.parse(input.rawArguments);
  const taskExecutions = input.taskExecutions();
  const executionResult = taskExecutions
    ? await (await taskExecutions).list({ userId: input.userId }, {
      agent: 'codex', includeArchived: request.includeArchived, limit: 100
    })
    : undefined;
  const executions = executionResult?.executions.filter((execution) => (
    (!request.connectorId || execution.connector?.id === request.connectorId) &&
    (!request.search || executionMatchesSearch(execution, request.search))
  ));
  const boundThreadIds = new Set(executions?.flatMap(({ executor }) => (
    executor ? [executor.externalId] : []
  )) ?? []);
  const configured = await input.runtime();
  const connectorIds = request.connectorId
    ? [request.connectorId]
    : (await input.backend.getConnectorOverview()).machines.map(({ id }) => id);
  const results = await Promise.all(connectorIds.map(async (connectorId) => {
    try {
      const result = await configured.sessions.service.list({ userId: input.userId }, {
        includeArchived: request.includeArchived ?? false,
        machineId: connectorId,
        search: request.search
      });
      return {
        checkedAt: result.checkedAt, inventoryState: result.inventoryState,
        machine: result.machine,
        sessions: result.sessions
          .filter(({ id }) => !boundThreadIds.has(id))
          .map(sanitizeSession)
      };
    } catch (error) {
      input.logger.warn('mcp.task_inventory.unavailable', {
        connectorId, tool: input.name
      }, error);
      return {
        connectorId,
        error: error instanceof Error ? error.message : 'Task inventory unavailable.'
      };
    }
  }));
  return toolResult(executionResult ? { ...executionResult, executions, results } : { results });
}

function executionMatchesSearch(
  execution: Awaited<ReturnType<TaskExecutionService['list']>>['executions'][number],
  search: string
) {
  const needle = search.trim().toLocaleLowerCase();
  return !needle || [
    execution.id, execution.source.taskId, execution.source.providerTaskId,
    execution.source.repositoryId, execution.source.branch,
    execution.blockedReason, execution.state
  ].some((value) => value?.toLocaleLowerCase().includes(needle));
}

async function read(input: Parameters<typeof callLegacyCodexTaskTool>[0]) {
  const request = toolSchemas.read_codex_task.parse(input.rawArguments);
  const taskExecutions = input.taskExecutions();
  if (taskExecutions) {
    const result = await (await taskExecutions).readByExecutor(
      { userId: input.userId }, 'codex', request.threadId, undefined, request.last
    );
    if (result) return toolResult(result);
  }
  return toolResult(sanitizeTaskRead(
    await (await input.runtime()).service.read({ userId: input.userId }, request)
  ));
}

async function start(input: Parameters<typeof callLegacyCodexTaskTool>[0]) {
  const request = toolSchemas.start_codex_task.parse({
    ...input.rawArguments,
    task: input.rawArguments.task ?? input.rawArguments.issue
  });
  const { task, ...legacyRequest } = request;
  const repositoryId = request.repositoryId;
  if (!repositoryId) throw new Error('Select an exact authorized repository.');
  const taskExecutions = input.taskExecutions();
  if (taskExecutions && request.environmentId && uuidPattern.test(request.environmentId)) {
    return toolResult(await (await taskExecutions).start({ userId: input.userId }, {
      agent: 'codex', dryRun: request.dryRun, environmentId: request.environmentId,
      operationId: request.operationId ?? `mcp:start:${randomUUID()}`,
      task: { number: task, provider: 'github', repositoryId }
    }));
  }
  if (request.dryRun) await validateLegacyDryRun(input, repositoryId, task);
  const result = await (await input.runtime()).service.start({ userId: input.userId }, {
    ...legacyRequest,
    dryRun: request.dryRun ?? false,
    issue: task,
    operationId: request.operationId ?? `mcp:start:${randomUUID()}`
  });
  return toolResult(sanitizeCodexTaskStartResult(result));
}

async function validateLegacyDryRun(
  input: Parameters<typeof callLegacyCodexTaskTool>[0],
  repositoryId: string,
  task: number
) {
  const { catalog, repository } = await resolveGitHubRepository(input.backend, repositoryId);
  if (!repository) {
    throw new Error(catalog.message ?? 'The GitHub repository is not available.');
  }
  const details = await input.backend.getGitHubRepositoryDetails(repository.fullName);
  if (details.status !== 'connected') {
    throw new Error(details.message ?? 'GitHub task details are unavailable.');
  }
  const sourceTask = details.issues.find(({ number }) => number === task);
  if (!sourceTask) throw new Error('The GitHub task was not found.');
  if (sourceTask.state !== 'open') throw new Error('Only open GitHub tasks can be started.');
}

async function send(input: Parameters<typeof callLegacyCodexTaskTool>[0]) {
  const request = toolSchemas.send_codex_message.parse(input.rawArguments);
  const taskExecutions = input.taskExecutions();
  if (taskExecutions) {
    const execution = await (await taskExecutions).readByExecutor(
      { userId: input.userId }, 'codex', request.threadId
    );
    if (execution) return toolResult(await (await taskExecutions).send({ userId: input.userId }, {
      executionId: execution.execution.id,
      message: request.message,
      operationId: request.operationId ?? `mcp:send:${randomUUID()}`,
      wait: request.wait
    }));
  }
  const result = await (await input.runtime()).service.send({ userId: input.userId }, {
    ...request,
    operationId: request.operationId ?? `mcp:send:${randomUUID()}`,
    wait: request.wait ?? false
  });
  return toolResult(sanitizeTaskRead(result));
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
