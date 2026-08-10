import type { IncomingMessage } from 'node:http';

import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { isProjectSpaceAuthRequired } from '../local-auth-store';
import { currentRequestId } from '../observability';
import {
  projectSpaceMcpDefaultScopes,
  projectSpaceMcpReadScope,
  projectSpaceMcpScopes
} from '../project-space-mcp-oauth-store';
import { bearerToken } from './http';
import { toolError } from './results';

const protectedResourcePath = '/.well-known/oauth-protected-resource/mcp';

export const projectSpaceMcpAuthenticationScopes = projectSpaceMcpDefaultScopes;

export async function authenticateProjectSpaceMcpRequest(
  request: IncomingMessage,
  verifyAccessToken: (request: IncomingMessage, token: string) => Promise<AuthInfo>
): Promise<AuthInfo | undefined> {
  if (!isProjectSpaceAuthRequired()) {
    return {
      clientId: 'project-space-local-development',
      extra: { userId: 'local-development-user' },
      scopes: [...projectSpaceMcpScopes],
      token: 'local-development'
    };
  }
  const token = bearerToken(request);
  if (!token) return undefined;
  const authInfo = await verifyAccessToken(request, token);
  return authInfo.scopes.includes(projectSpaceMcpReadScope) ? authInfo : undefined;
}

export function projectSpaceMcpAuthenticationError(challenge: string): CallToolResult {
  return {
    ...toolError('Authentication required.', currentRequestId()),
    _meta: { 'mcp/www_authenticate': [challenge] }
  };
}

export function projectSpaceMcpAuthChallenge(
  origin: string,
  scopes: readonly string[] = projectSpaceMcpAuthenticationScopes
) {
  return `Bearer resource_metadata="${new URL(protectedResourcePath, origin)}", scope="${scopes.join(' ')}"`;
}
