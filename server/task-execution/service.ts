import type { TaskExecutionResult } from '../../src/shared/task-execution-mcp-api';
import {
  type TaskExecutionService,
  type TaskExecutionServiceDependencies
} from './service-contracts';
export type {
  TaskExecutionActor,
  TaskExecutionService,
  TaskExecutionServiceDependencies
} from './service-contracts';
export {
  TaskExecutionConflictError,
  TaskExecutionNotFoundError
} from './service-contracts';
import { createTaskExecutionMutations } from './service-mutations';
import { createTaskHandoffService } from './handoff-service';
import { createTaskExecutionReader } from './service-read';
import { createTaskExecutionStarter } from './service-start';

export function createTaskExecutionService(
  dependencies: TaskExecutionServiceDependencies
): TaskExecutionService {
  const reader = createTaskExecutionReader(dependencies);
  const readResult = async (
    actor: { userId: string },
    executionId: string,
    operationId: string,
    replayed?: boolean
  ): Promise<TaskExecutionResult> => ({
    ...await reader.get(actor, { executionId, limit: 100 }),
    operationId,
    ...(replayed ? { replayed: true } : {})
  });
  const mutations = createTaskExecutionMutations(dependencies, readResult);
  const handoffs = createTaskHandoffService(dependencies);
  const start = createTaskExecutionStarter(dependencies, readResult);
  return {
    archive: mutations.archive,
    cancel: mutations.cancel,
    createHandoff: handoffs.create,
    get: reader.get,
    getHandoff: handoffs.get,
    list: reader.list,
    readByExecutor: (actor, agent, externalId, afterCursor, limit) => (
      agent === 'codex'
        ? reader.readByExecutor(actor, externalId, afterCursor, limit)
        : Promise.resolve(undefined)
    ),
    respondApproval: mutations.respondApproval,
    respondInput: mutations.respondInput,
    send: mutations.send,
    start,
    updateHandoff: handoffs.updateExecution,
    wait: reader.wait
  };
}
