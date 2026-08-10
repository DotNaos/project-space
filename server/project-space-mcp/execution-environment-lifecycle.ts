import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type {
  DeleteExecutionEnvironmentRequest,
  ExecutionEnvironmentMutationRequest,
  ProvisionExecutionEnvironmentRequest,
  StopExecutionEnvironmentRequest
} from '../../src/shared/execution-environment-lifecycle-api';
import type {
  ExecutionEnvironmentLifecycleService
} from '../execution-environment-lifecycle/service';
import { toolResult } from './results';
import { toolSchemas } from './tool-catalog';

export async function callExecutionEnvironmentLifecycleTool(input: {
  name: string;
  rawArguments: Record<string, unknown>;
  service: ExecutionEnvironmentLifecycleService;
  userId: string;
}): Promise<CallToolResult | undefined> {
  const actor = { userId: input.userId };
  let result;
  switch (input.name) {
    case 'provision_execution_environment':
      result = await input.service.provision(
        actor,
        toolSchemas.provision_execution_environment.parse(input.rawArguments) as
          ProvisionExecutionEnvironmentRequest
      );
      break;
    case 'start_execution_environment':
      result = await input.service.start(
        actor,
        toolSchemas.start_execution_environment.parse(input.rawArguments) as
          ExecutionEnvironmentMutationRequest
      );
      break;
    case 'stop_execution_environment':
      result = await input.service.stop(
        actor,
        toolSchemas.stop_execution_environment.parse(input.rawArguments) as
          StopExecutionEnvironmentRequest
      );
      break;
    case 'delete_execution_environment':
      result = await input.service.delete(
        actor,
        toolSchemas.delete_execution_environment.parse(input.rawArguments) as
          DeleteExecutionEnvironmentRequest
      );
      break;
    default:
      return undefined;
  }
  return toolResult(
    result,
    Boolean(result.blocked) || ['failed', 'uncertain'].includes(result.lifecycle.normalized)
  );
}
