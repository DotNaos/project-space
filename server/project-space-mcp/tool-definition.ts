import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import {
  projectSpaceMcpReadScope,
  projectSpaceMcpWriteScope
} from '../project-space-mcp-oauth-store';

export type OAuthTool = Tool & {
  securitySchemes: Array<{ scopes: string[]; type: 'oauth2' }>;
};

export function defineOAuthTool(
  name: string,
  title: string,
  description: string,
  inputSchema: Tool['inputSchema'],
  annotations: NonNullable<Tool['annotations']>,
  requiredScopes?: readonly string[],
  outputSchema?: Tool['outputSchema']
): OAuthTool {
  const scopes = requiredScopes
    ? [...requiredScopes]
    : annotations.readOnlyHint
      ? [projectSpaceMcpReadScope]
      : [projectSpaceMcpReadScope, projectSpaceMcpWriteScope];
  const securitySchemes = [{ type: 'oauth2' as const, scopes }];
  return {
    name, title, description, inputSchema, annotations, securitySchemes,
    ...(outputSchema ? { outputSchema } : {}),
    _meta: { securitySchemes }
  } as OAuthTool;
}
