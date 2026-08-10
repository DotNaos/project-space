import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { AgentRuntimeService } from '../agent-authorization/service';
import { toolSchemas } from './tool-catalog';
import { toolResult } from './results';

const agentRuntimeTools = new Set([
  'cancel_agent_authorization',
  'get_agent_authorization',
  'get_agent_status',
  'start_agent_authorization'
]);

export function isAgentRuntimeTool(name: string) {
  return agentRuntimeTools.has(name);
}

export async function callAgentRuntimeTool(input: {
  name: string;
  rawArguments: Record<string, unknown>;
  service: AgentRuntimeService;
  userId: string;
}): Promise<CallToolResult | undefined> {
  if (input.name === 'get_agent_status') {
    return toolResult(await input.service.status(
      { userId: input.userId },
      toolSchemas.get_agent_status.parse(input.rawArguments)
    ));
  }
  const action = actionFor(input.name);
  if (!action) return undefined;
  const schema = input.name === 'start_agent_authorization'
    ? toolSchemas.start_agent_authorization
    : input.name === 'get_agent_authorization'
      ? toolSchemas.get_agent_authorization
      : toolSchemas.cancel_agent_authorization;
  return toolResult(await input.service.authorize(
    action,
    { userId: input.userId },
    schema.parse(input.rawArguments)
  ));
}

function actionFor(name: string) {
  if (name === 'start_agent_authorization') return 'start' as const;
  if (name === 'get_agent_authorization') return 'status' as const;
  if (name === 'cancel_agent_authorization') return 'cancel' as const;
  return undefined;
}
