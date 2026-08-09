import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

export function bearerToken(request: IncomingMessage) {
  const header = request.headers.authorization;
  return header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : undefined;
}

export function requiredUserId(authInfo: AuthInfo) {
  const userId = authInfo.extra?.userId;
  if (typeof userId !== 'string' || !userId) {
    throw new Error('The OAuth token has no Project Space user.');
  }
  return userId;
}

export function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export function applyMcpCors(response: ServerResponse) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  response.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, Last-Event-ID, MCP-Protocol-Version, MCP-Session-Id, X-Request-ID'
  );
  response.setHeader(
    'Access-Control-Expose-Headers',
    'MCP-Session-Id, WWW-Authenticate, X-Request-ID'
  );
}

export function writeJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8'
  }).end(JSON.stringify(value));
}

export function methodNotAllowed(response: ServerResponse, allow: string) {
  response.setHeader('Allow', allow);
  writeJson(response, 405, { error: 'Method not allowed.' });
  return true;
}
