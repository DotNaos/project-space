import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { TaskExecutionService } from '../task-execution/service';
import { toolResult } from './results';
import { toolSchemas } from './tool-catalog';

const taskExecutionToolNames = new Set([
  'archive_task_execution',
  'cancel_task_execution',
  'get_task_execution',
  'list_task_executions',
  'respond_task_execution_approval',
  'respond_task_execution_input',
  'send_task_execution_message',
  'start_task_execution',
  'wait_task_execution'
]);

export function isTaskExecutionTool(name: string) {
  return taskExecutionToolNames.has(name);
}

export async function callTaskExecutionTool(input: {
  name: string;
  rawArguments: Record<string, unknown>;
  service: TaskExecutionService;
  userId: string;
}): Promise<CallToolResult | undefined> {
  const actor = { userId: input.userId };
  switch (input.name) {
    case 'start_task_execution':
      return toolResult(await input.service.start(
        actor,
        toolSchemas.start_task_execution.parse(input.rawArguments)
      ));
    case 'list_task_executions':
      return toolResult(await input.service.list(
        actor,
        toolSchemas.list_task_executions.parse(input.rawArguments)
      ));
    case 'get_task_execution':
      return toolResult(await input.service.get(
        actor,
        toolSchemas.get_task_execution.parse(input.rawArguments)
      ));
    case 'wait_task_execution':
      return toolResult(await input.service.wait(
        actor,
        toolSchemas.wait_task_execution.parse(input.rawArguments)
      ));
    case 'send_task_execution_message':
      return toolResult(await input.service.send(
        actor,
        toolSchemas.send_task_execution_message.parse(input.rawArguments)
      ));
    case 'respond_task_execution_approval':
      return toolResult(await input.service.respondApproval(
        actor,
        toolSchemas.respond_task_execution_approval.parse(input.rawArguments)
      ));
    case 'respond_task_execution_input':
      return toolResult(await input.service.respondInput(
        actor,
        toolSchemas.respond_task_execution_input.parse(input.rawArguments)
      ));
    case 'cancel_task_execution':
      return toolResult(await input.service.cancel(
        actor,
        toolSchemas.cancel_task_execution.parse(input.rawArguments)
      ));
    case 'archive_task_execution':
      return toolResult(await input.service.archive(
        actor,
        toolSchemas.archive_task_execution.parse(input.rawArguments)
      ));
    default:
      return undefined;
  }
}
