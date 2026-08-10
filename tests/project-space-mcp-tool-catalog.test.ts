import { describe, expect, test } from 'bun:test';

import {
  scopesForTool,
  tools,
  toolSchemas
} from '../server/project-space-mcp/tool-catalog';
import {
  projectSpaceMcpEnvironmentDeleteScope,
  projectSpaceMcpEnvironmentManageScope,
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
