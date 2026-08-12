import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';

import { describe, expect, test } from 'bun:test';

import {
  handleRetiredConnectorHttp,
  legacyConnectorRetirement,
  rejectRetiredConnectorUpgrade
} from '../server/legacy-connector-retirement';
import { createLocalProjectSpaceBackend } from '../server/local-project-space-backend';
import { createProjectSpaceServer } from '../server/project-space-http';

function retiredHttpResponse() {
  let statusCode = 0;
  let body = '';
  const headers = new Map<string, string>();
  const response = {
    end(value?: string) {
      body = value ?? '';
    },
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    writeHead(code: number, values: Record<string, string>) {
      statusCode = code;
      for (const [name, value] of Object.entries(values)) {
        headers.set(name.toLowerCase(), value);
      }
    }
  } as unknown as ServerResponse;
  return {
    response,
    result: () => ({ body, headers, statusCode })
  };
}

describe('legacy Connector retirement boundary', () => {
  test('is enforced by the production HTTP router', async () => {
    const server = await createProjectSpaceServer({
      backend: createLocalProjectSpaceBackend(),
      host: '127.0.0.1',
      port: 0
    });

    try {
      const installer = await fetch(`${server.origin}/connector/install.sh`);
      expect(installer.status).toBe(410);
      expect(await installer.text()).not.toContain('#!/');

      const registry = await fetch(`${server.origin}/api/connectors/project-registry`, {
        method: 'POST'
      });
      expect(registry.status).toBe(410);
      expect(await registry.json()).toEqual(legacyConnectorRetirement);

    } finally {
      await server.close();
    }
  });

  test.each([
    ['POST', '/api/connectors/project-registry'],
    ['POST', '/api/connectors/install-command'],
    ['DELETE', '/api/connectors/credentials/credential-id'],
    ['POST', '/api/pull-request-previews/dev-server/register']
  ])('retires %s %s before legacy handling', (method, pathname) => {
    const capture = retiredHttpResponse();
    const handled = handleRetiredConnectorHttp(
      { method } as IncomingMessage,
      capture.response,
      new URL(pathname, 'https://projects.example.test')
    );

    expect(handled).toBe(true);
    expect(capture.result().statusCode).toBe(410);
    expect(JSON.parse(capture.result().body)).toEqual(legacyConnectorRetirement);
    expect(capture.result().headers.get('cache-control')).toBe('no-store');
  });

  test('replaces the installer script with a stable migration message', () => {
    const capture = retiredHttpResponse();
    expect(handleRetiredConnectorHttp(
      { method: 'GET' } as IncomingMessage,
      capture.response,
      new URL('/connector/install.sh', 'https://projects.example.test')
    )).toBe(true);

    expect(capture.result().statusCode).toBe(410);
    expect(capture.result().body).toContain('permanent Project Space Connector has been retired');
    expect(capture.result().body).toContain('project environment bootstrap');
    expect(capture.result().body).not.toContain('#!/');
  });

  test('rejects the retired WebSocket upgrade before authentication', async () => {
    const socket = new PassThrough();
    let response = '';
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
    });

    expect(rejectRetiredConnectorUpgrade(
      { url: '/api/connectors/socket' } as IncomingMessage,
      socket
    )).toBe(true);
    await new Promise<void>((resolve) => socket.once('end', resolve));

    expect(response).toContain('HTTP/1.1 410 Gone');
    expect(response).toContain('canonical_runtime_required');
    expect(response).not.toContain('101 Switching Protocols');
  });

  test('does not intercept canonical runtime routes', () => {
    const capture = retiredHttpResponse();
    expect(handleRetiredConnectorHttp(
      { method: 'POST' } as IncomingMessage,
      capture.response,
      new URL('/api/runtime-control/v1/operations', 'https://projects.example.test')
    )).toBe(false);
  });
});
