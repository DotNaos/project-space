import { describe, expect, test } from 'bun:test';
import {
  projectSpaceMcpDefaultScopes,
  projectSpaceMcpReadScope,
  projectSpaceMcpShellRecoveryScope,
  projectSpaceMcpShellWorkspaceScope,
  projectSpaceMcpSupportedScopes,
  projectSpaceMcpWriteScope
} from '../server/project-space-mcp-oauth-store';
import {
  scopesForTool,
  tools,
  toolSchemas
} from '../server/project-space-mcp/tool-catalog';
import { recoveryApprovalRequest } from '../server/project-space-mcp/workspace-commands';

const names = [
  'start_workspace_command',
  'get_workspace_command',
  'cancel_workspace_command',
  'start_environment_recovery_command',
  'cancel_environment_recovery_command'
];

describe('Project Space MCP workspace command catalogue', () => {
  test('publishes the exact asynchronous workspace and recovery boundary', () => {
    const published = tools.filter(({ name }) => names.includes(name));
    expect(published.map(({ name }) => name)).toEqual(names);
    for (const tool of published) expect(tool._meta?.securitySchemes).toEqual(tool.securitySchemes);
    expect(published[0]?.annotations).toMatchObject({
      destructiveHint: true, idempotentHint: true, readOnlyHint: false
    });
    expect(published[1]?.annotations).toMatchObject({ readOnlyHint: true });
    expect(published[3]?.annotations).toMatchObject({ destructiveHint: true });
  });

  test('keeps recovery separately privileged and neither scope default-granted', () => {
    expect(scopesForTool('start_workspace_command')).toEqual([
      projectSpaceMcpReadScope, projectSpaceMcpWriteScope, projectSpaceMcpShellWorkspaceScope
    ]);
    expect(scopesForTool('start_environment_recovery_command')).toEqual([
      projectSpaceMcpReadScope, projectSpaceMcpWriteScope, projectSpaceMcpShellRecoveryScope
    ]);
    expect(scopesForTool('cancel_environment_recovery_command')).toEqual([
      projectSpaceMcpReadScope, projectSpaceMcpWriteScope, projectSpaceMcpShellRecoveryScope
    ]);
    expect(projectSpaceMcpSupportedScopes).toContain(projectSpaceMcpShellWorkspaceScope);
    expect(projectSpaceMcpSupportedScopes).toContain(projectSpaceMcpShellRecoveryScope);
    expect(projectSpaceMcpDefaultScopes).not.toContain(projectSpaceMcpShellWorkspaceScope as never);
    expect(projectSpaceMcpDefaultScopes).not.toContain(projectSpaceMcpShellRecoveryScope as never);
  });

  test('rejects raw target selectors and self-asserted recovery approval', () => {
    const start = {
      command: 'git status --short',
      executionId: '11111111-1111-4111-8111-111111111111',
      operationId: 'workspace:start:001'
    };
    expect(toolSchemas.start_workspace_command.safeParse(start).success).toBe(true);
    expect(toolSchemas.start_workspace_command.safeParse({ ...start, cwd: '/tmp' }).success).toBe(false);
    expect(toolSchemas.start_workspace_command.safeParse({ ...start, connectorId: 'machine-1' }).success)
      .toBe(false);
    const recovery = {
      command: 'project doctor',
      environmentId: start.executionId, operationId: 'recovery:start:001'
    };
    expect(toolSchemas.start_environment_recovery_command.safeParse(recovery).success).toBe(true);
    expect(toolSchemas.start_environment_recovery_command.safeParse({
      ...recovery, approved: true
    }).success).toBe(false);
  });

  test('shows the complete recovery command before approval', () => {
    const command = `printf safe; ${'x'.repeat(2_100)}; printf dangerous-suffix`;
    expect(recoveryApprovalRequest({
      command,
      environmentId: '11111111-1111-4111-8111-111111111111'
    }).message).toEndWith(command);
  });
});
