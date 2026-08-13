import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

import { writeJson, writeText } from './project-space-http-response';

export const legacyConnectorRetirement = {
  code: 'canonical_runtime_required',
  error: 'The permanent Project Space Connector has been retired. Use a canonical Environment and Workspace Runtime.',
  replacement: 'project environment bootstrap'
} as const;

const retiredApiPaths = new Set([
  '/api/connectors/credentials',
  '/api/connectors/install-command',
  '/api/connectors/overview',
  '/api/connectors/project-registry',
  '/api/connectors/socket',
  '/api/connector-retirement/report'
]);

const retiredPullRequestDevServerPrefix = '/api/pull-request-previews/dev-server/';
const retiredSocketPath = '/api/connectors/socket';
const retiredMachineRuntime = /^\/api\/machines\/[^/]+\/runtime(?:\/(?:operations|stop))?$/;
const retiredMachineTerminal = /^\/api\/machines\/[^/]+\/terminal$/;

const retiredMachineTerminalUpgrade = {
  error: {
    code: 'canonical_runtime_required',
    message: 'Machine terminals require the canonical Environment and Workspace Runtime.'
  }
} as const;

export function handleRetiredConnectorHttp(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
) {
  if (request.method === 'GET' && url.pathname === '/connector/install.sh') {
    response.setHeader('Cache-Control', 'no-store');
    writeText(
      response,
      410,
      `${legacyConnectorRetirement.error}\nReplacement: ${legacyConnectorRetirement.replacement}\n`,
      'text/plain; charset=utf-8'
    );
    return true;
  }

  const retiredCredentialPath = /^\/api\/connectors\/credentials\/[^/]+$/.test(url.pathname);
  const retiredPullRequestDevServer = url.pathname.startsWith(retiredPullRequestDevServerPrefix);
  if (!retiredApiPaths.has(url.pathname) && !retiredCredentialPath && !retiredPullRequestDevServer &&
      !retiredMachineRuntime.test(url.pathname)) {
    return false;
  }

  response.setHeader('Cache-Control', 'no-store');
  writeJson(response, 410, legacyConnectorRetirement);
  return true;
}

export function rejectRetiredConnectorUpgrade(request: IncomingMessage, socket: Duplex) {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== retiredSocketPath) return false;
  const body = JSON.stringify(legacyConnectorRetirement);
  socket.end([
    'HTTP/1.1 410 Gone',
    'Connection: close',
    'Cache-Control: no-store',
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body
  ].join('\r\n'));
  return true;
}

export function rejectRetiredMachineTerminalUpgrade(request: IncomingMessage, socket: Duplex) {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (!retiredMachineTerminal.test(url.pathname)) return false;
  const body = JSON.stringify(retiredMachineTerminalUpgrade);
  socket.end([
    'HTTP/1.1 409 Conflict',
    'Connection: close',
    'Cache-Control: private, no-store',
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body
  ].join('\r\n'));
  return true;
}
