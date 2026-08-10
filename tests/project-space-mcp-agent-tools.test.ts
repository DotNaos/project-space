import { describe, expect, test } from 'bun:test';

import {
  scopesForTool,
  tools,
  toolSchemas
} from '../server/project-space-mcp/tool-catalog';
import {
  projectSpaceMcpAgentAuthorizeScope,
  projectSpaceMcpReadScope,
  projectSpaceMcpWriteScope
} from '../server/project-space-mcp-oauth-store';

const authorizationScopes = [
  projectSpaceMcpReadScope,
  projectSpaceMcpWriteScope,
  projectSpaceMcpAgentAuthorizeScope
];

describe('Project Space MCP agent tools', () => {
  test('publishes exactly four provider-neutral agent tools with truthful annotations', () => {
    const agentTools = tools.filter(({ name }) => name.includes('_agent_'));
    expect(agentTools.map(({ name }) => name)).toEqual([
      'get_agent_status',
      'start_agent_authorization',
      'get_agent_authorization',
      'cancel_agent_authorization'
    ]);
    expect(agentTools.map(({ annotations }) => annotations)).toEqual([
      { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: true },
      { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: false },
      { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: true },
      { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: false }
    ]);
  });

  test('requires the elevated scope only for start and cancel', () => {
    for (const name of ['start_agent_authorization', 'cancel_agent_authorization']) {
      expect(scopesForTool(name)).toEqual(authorizationScopes);
      expect(tools.find((tool) => tool.name === name)).toMatchObject({
        _meta: { securitySchemes: [{ scopes: authorizationScopes, type: 'oauth2' }] },
        securitySchemes: [{ scopes: authorizationScopes, type: 'oauth2' }]
      });
    }
    for (const name of ['get_agent_status', 'get_agent_authorization']) {
      expect(scopesForTool(name)).toEqual([projectSpaceMcpReadScope]);
    }
  });

  test('accepts only canonical bounded Environment requests', () => {
    const operationId = 'agent-auth:00000000-0000-4000-8000-000000000540';
    expect(toolSchemas.get_agent_status.parse({
      agent: 'codex',
      environmentId: 'environment-codespace-540'
    })).toEqual({
      agent: 'codex',
      environmentId: 'environment-codespace-540'
    });
    for (const schema of [
      toolSchemas.start_agent_authorization,
      toolSchemas.get_agent_authorization,
      toolSchemas.cancel_agent_authorization
    ]) {
      expect(schema.safeParse({
        agent: 'codex',
        environmentId: 'environment-codespace-540',
        operationId
      }).success).toBe(true);
      expect(schema.safeParse({
        agent: 'claude',
        environmentId: 'environment-codespace-540',
        operationId
      }).success).toBe(false);
      expect(schema.safeParse({
        agent: 'codex',
        environmentId: 'environment-codespace-540',
        operationId,
        physicalMachineId: 'legacy-machine'
      }).success).toBe(false);
    }
    expect(toolSchemas.get_agent_status.safeParse({
      agent: 'codex',
      environmentId: ''
    }).success).toBe(false);
    expect(toolSchemas.start_agent_authorization.safeParse({
      agent: 'codex',
      environmentId: 'environment-codespace-540',
      operationId: 'short'
    }).success).toBe(false);
  });
});
