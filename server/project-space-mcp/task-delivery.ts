import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import {
  TASK_DELIVERY_MCP_API_VERSION,
  type GetTaskDeliveryStatusRequest
} from '../../src/shared/task-delivery-mcp-api';
import type { TaskDeliveryService } from '../task-delivery/service';
import { TaskDeliveryTargetUnavailableError } from '../task-delivery/service';
import { toolResult } from './results';
import { taskDeliveryToolSchemas } from './task-delivery-tool-catalog';

const taskDeliveryToolNames = new Set(Object.keys(taskDeliveryToolSchemas));

export function isTaskDeliveryTool(name: string) {
  return taskDeliveryToolNames.has(name);
}

export async function callTaskDeliveryTool(input: {
  clientId?: string;
  name: string;
  rawArguments: Record<string, unknown>;
  service: TaskDeliveryService;
  userId: string;
}): Promise<CallToolResult | undefined> {
  const actor = { ...(input.clientId ? { clientId: input.clientId } : {}), userId: input.userId };
  try {
    switch (input.name) {
      case 'get_task_delivery_status':
        return toolResult(await input.service.getStatus(
          actor,
          taskDeliveryToolSchemas.get_task_delivery_status.parse(
            input.rawArguments
          ) as GetTaskDeliveryStatusRequest
        ));
      case 'create_or_update_task_pull_request':
        return toolResult(await input.service.createOrUpdatePullRequest(
          actor,
          taskDeliveryToolSchemas.create_or_update_task_pull_request.parse(input.rawArguments)
        ));
      case 'request_task_review':
        return toolResult(await input.service.requestReview(
          actor,
          taskDeliveryToolSchemas.request_task_review.parse(input.rawArguments)
        ));
      case 'merge_task_pull_request':
        return toolResult(await input.service.mergePullRequest(
          actor,
          taskDeliveryToolSchemas.merge_task_pull_request.parse(input.rawArguments)
        ));
      case 'complete_task':
        return toolResult(await input.service.completeTask(
          actor,
          taskDeliveryToolSchemas.complete_task.parse(input.rawArguments)
        ));
      default:
        return undefined;
    }
  } catch (error) {
    if (!(error instanceof TaskDeliveryTargetUnavailableError)) throw error;
    if (input.name === 'get_task_delivery_status') {
      return toolResult({ apiVersion: TASK_DELIVERY_MCP_API_VERSION, deliveries: [] });
    }
    const operationId = typeof input.rawArguments.operationId === 'string'
      ? input.rawArguments.operationId : 'unavailable';
    return toolResult({
      apiVersion: TASK_DELIVERY_MCP_API_VERSION,
      blockedReason: 'target_unavailable',
      message: 'The Task delivery target is unavailable.',
      operationId,
      replayed: false,
      state: 'blocked'
    });
  }
}
