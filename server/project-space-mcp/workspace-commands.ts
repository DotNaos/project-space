import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { WorkspaceCommandService } from '../workspace-command/service';
import { toolResult } from './results';
import { toolSchemas } from './tool-catalog';

const names = new Set([
  'cancel_environment_recovery_command',
  'cancel_workspace_command',
  'get_workspace_command',
  'start_environment_recovery_command',
  'start_workspace_command'
]);

export function isWorkspaceCommandTool(name: string) { return names.has(name); }

export function recoveryApprovalRequest(input: { command: string; environmentId: string }) {
  return {
    mode: 'form' as const,
    message: [
      `Approve this privileged recovery command for Environment ${input.environmentId}?`,
      '',
      input.command
    ].join('\n'),
    requestedSchema: {
      type: 'object' as const,
      properties: {
        approved: {
          type: 'boolean' as const,
          title: 'Approve recovery command',
          description: 'Run this command through the exact Codespace recovery channel.'
        }
      },
      required: ['approved']
    }
  };
}

export function recoveryApprovalAccepted(result: {
  action: string;
  content?: Record<string, unknown>;
}) {
  return result.action === 'accept' && result.content?.approved === true;
}

export async function callWorkspaceCommandTool(input: {
  approveRecovery(input: { command: string; environmentId: string }): Promise<boolean>;
  name: string;
  rawArguments: Record<string, unknown>;
  service: WorkspaceCommandService;
  userId: string;
}): Promise<CallToolResult | undefined> {
  const actor = { userId: input.userId };
  switch (input.name) {
    case 'start_workspace_command':
      return toolResult(await input.service.startWorkspace(
        actor, toolSchemas.start_workspace_command.parse(input.rawArguments)
      ));
    case 'start_environment_recovery_command':
      {
        const request = toolSchemas.start_environment_recovery_command.parse(input.rawArguments);
        return toolResult(await input.service.startRecovery(
          actor,
          request,
          () => input.approveRecovery({
            command: request.command,
            environmentId: request.environmentId
          })
        ));
      }
    case 'get_workspace_command':
      return toolResult(await input.service.get(
        actor, toolSchemas.get_workspace_command.parse(input.rawArguments)
      ));
    case 'cancel_workspace_command':
      return toolResult(await input.service.cancelWorkspace(
        actor, toolSchemas.cancel_workspace_command.parse(input.rawArguments)
      ));
    case 'cancel_environment_recovery_command':
      return toolResult(await input.service.cancelRecovery(
        actor, toolSchemas.cancel_environment_recovery_command.parse(input.rawArguments)
      ));
    default:
      return undefined;
  }
}
