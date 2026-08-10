import { describe, expect, test } from 'bun:test';

import {
  scopesForTool,
  tools,
  toolSchemas
} from '../server/project-space-mcp/tool-catalog';
import {
  projectSpaceMcpExecutionApproveScope,
  projectSpaceMcpEnvironmentDeleteScope,
  projectSpaceMcpEnvironmentManageScope,
  projectSpaceMcpExecutionWriteScope,
  projectSpaceMcpReadScope,
  projectSpaceMcpWriteScope
} from '../server/project-space-mcp-oauth-store';

const manageScopes = [
  projectSpaceMcpReadScope,
  projectSpaceMcpWriteScope,
  projectSpaceMcpEnvironmentManageScope
];
const deleteScopes = [
  projectSpaceMcpReadScope,
  projectSpaceMcpWriteScope,
  projectSpaceMcpEnvironmentDeleteScope
];

describe('Project Space MCP execution Environment lifecycle catalogue', () => {
  test('publishes exactly four provider-neutral lifecycle mutations', () => {
    const lifecycleTools = tools.filter(({ name }) => (
      name.endsWith('_execution_environment') &&
      name !== 'get_execution_environment'
    ));

    expect(lifecycleTools.map(({ name }) => name)).toEqual([
      'provision_execution_environment',
      'start_execution_environment',
      'stop_execution_environment',
      'delete_execution_environment'
    ]);
    expect(lifecycleTools.slice(0, 3).map(({ annotations }) => annotations)).toEqual([
      expect.objectContaining({
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: false
      }),
      expect.objectContaining({
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: false
      }),
      expect.objectContaining({
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: false
      })
    ]);
    expect(lifecycleTools[3]?.annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false
    });
  });

  test('requires only the exact lifecycle scope for each mutation class', () => {
    for (const name of [
      'provision_execution_environment',
      'start_execution_environment',
      'stop_execution_environment'
    ]) {
      expect(scopesForTool(name)).toEqual(manageScopes);
      expect(tools.find((tool) => tool.name === name)).toMatchObject({
        _meta: { securitySchemes: [{ scopes: manageScopes, type: 'oauth2' }] },
        securitySchemes: [{ scopes: manageScopes, type: 'oauth2' }]
      });
    }

    expect(scopesForTool('delete_execution_environment')).toEqual(deleteScopes);
    expect(tools.find(({ name }) => name === 'delete_execution_environment')).toMatchObject({
      _meta: { securitySchemes: [{ scopes: deleteScopes, type: 'oauth2' }] },
      securitySchemes: [{ scopes: deleteScopes, type: 'oauth2' }]
    });
    expect(scopesForTool('list_execution_environments')).toEqual([
      projectSpaceMcpReadScope
    ]);
  });

  test('accepts bounded safe requests and rejects ambiguous provider input', () => {
    const operationId = 'lifecycle:00000000-0000-4000-8000-000000000536';
    expect(toolSchemas.provision_execution_environment.parse({
      branch: 'issue-536-manage-codespaces',
      operationId,
      provider: 'github_codespaces',
      repositoryId: 'DotNaos/project-space',
      task: 536
    })).toEqual({
      branch: 'issue-536-manage-codespaces',
      operationId,
      provider: 'github_codespaces',
      repositoryId: 'DotNaos/project-space',
      task: 536
    });
    expect(toolSchemas.start_execution_environment.safeParse({
      environmentId: 'environment-codespace',
      operationId
    }).success).toBe(true);
    expect(toolSchemas.stop_execution_environment.safeParse({
      environmentId: 'environment-codespace',
      operationId,
      reason: 'No execution is active.'
    }).success).toBe(true);
    expect(toolSchemas.delete_execution_environment.safeParse({
      environmentId: 'environment-codespace',
      operationId
    }).success).toBe(true);

    expect(toolSchemas.provision_execution_environment.safeParse({
      branch: '../unsafe',
      operationId,
      provider: 'github_codespaces',
      repositoryId: 'DotNaos/project-space',
      task: 536
    }).success).toBe(false);
    expect(toolSchemas.provision_execution_environment.safeParse({
      branch: 'refs/.hidden',
      operationId,
      provider: 'github_codespaces',
      repositoryId: 'DotNaos/project-space',
      task: 536
    }).success).toBe(false);
    expect(toolSchemas.provision_execution_environment.safeParse({
      branch: 'issue-536',
      operationId,
      provider: 'arbitrary_cloud',
      repositoryId: 'DotNaos/project-space',
      task: 536
    }).success).toBe(false);
    expect(toolSchemas.start_execution_environment.safeParse({
      environmentId: 'environment-codespace',
      operationId: 'short'
    }).success).toBe(false);
    expect(toolSchemas.delete_execution_environment.safeParse({
      environmentId: 'environment-codespace',
      operationId,
      repositoryId: 'attacker/repository'
    }).success).toBe(false);
  });
});

describe('Project Space MCP Task Execution catalogue', () => {
  const taskExecutionNames = [
    'start_task_execution',
    'list_task_executions',
    'get_task_execution',
    'wait_task_execution',
    'send_task_execution_message',
    'respond_task_execution_approval',
    'respond_task_execution_input',
    'cancel_task_execution',
    'archive_task_execution'
  ];

  test('publishes the exact provider-neutral lifecycle with structured results', () => {
    const published = tools.filter(({ name }) => taskExecutionNames.includes(name));
    expect(published.map(({ name }) => name)).toEqual(taskExecutionNames);
    for (const entry of published) {
      expect(entry.outputSchema).toMatchObject({
        properties: { result: expect.any(Object) },
        required: ['result'],
        type: 'object'
      });
      expect(entry._meta?.securitySchemes).toEqual(entry.securitySchemes);
    }
    expect(published.find(({ name }) => name === 'respond_task_execution_approval')?.annotations)
      .toMatchObject({ destructiveHint: true, idempotentHint: true, readOnlyHint: false });
    expect(published.find(({ name }) => name === 'cancel_task_execution')?.annotations)
      .toMatchObject({ destructiveHint: true, idempotentHint: true, readOnlyHint: false });
  });

  test('requires the execution scope only for mutating tools', () => {
    const mutationScopes = [
      projectSpaceMcpReadScope,
      projectSpaceMcpWriteScope,
      projectSpaceMcpExecutionWriteScope
    ];
    for (const name of [
      'start_task_execution', 'send_task_execution_message',
      'cancel_task_execution', 'archive_task_execution'
    ]) {
      expect(scopesForTool(name)).toEqual(mutationScopes);
    }
    for (const name of ['respond_task_execution_approval', 'respond_task_execution_input']) {
      expect(scopesForTool(name)).toEqual([
        projectSpaceMcpReadScope,
        projectSpaceMcpWriteScope,
        projectSpaceMcpExecutionApproveScope
      ]);
    }
    for (const name of ['list_task_executions', 'get_task_execution', 'wait_task_execution']) {
      expect(scopesForTool(name)).toEqual([projectSpaceMcpReadScope]);
    }
  });

  test('keeps start and response identities strict and unambiguous', () => {
    const request = {
      environmentId: '11111111-1111-4111-8111-111111111111',
      operationId: 'task-execution:start:001',
      task: { number: 548, provider: 'github', repositoryId: '480' }
    };
    expect(toolSchemas.start_task_execution.safeParse(request).success).toBe(true);
    expect(toolSchemas.start_task_execution.safeParse({
      ...request,
      briefing: { objective: 'Implement it.' },
      handoff: { id: '22222222-2222-4222-8222-222222222222', revision: 1 }
    }).success).toBe(false);
    expect(toolSchemas.start_task_execution.safeParse({ ...request, unknown: true }).success)
      .toBe(false);
    expect(toolSchemas.start_task_execution.safeParse({ ...request, operationId: 'short' }).success)
      .toBe(false);
    expect(toolSchemas.respond_task_execution_approval.safeParse({
      decision: 'allow-once', executionId: request.environmentId,
      operationId: 'task-execution:approval:001', requestId: 'request-1', turnId: 'turn-1'
    }).success).toBe(true);
    expect(toolSchemas.respond_task_execution_input.safeParse({
      answers: [{ questionId: 'question-1', value: 'yes' }],
      executionId: request.environmentId, operationId: 'task-execution:input:001',
      requestId: 'request-1', turnId: 'turn-1'
    }).success).toBe(true);
  });
});
