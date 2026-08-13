import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'bun:test';

import {
  handleRetiredConnectorHttp,
  legacyConnectorRetirement,
  rejectRetiredConnectorUpgrade,
  rejectRetiredMachineTerminalUpgrade
} from '../server/legacy-connector-retirement';
import { createLocalProjectSpaceBackend } from '../server/local-project-space-backend';
import { createProjectSpaceServer } from '../server/project-space-http';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

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
  test('removes Connector startup wiring from production and local development', () => {
    const webServer = readFileSync(`${repositoryRoot}/server/web-server.ts`, 'utf8');
    const vite = readFileSync(`${repositoryRoot}/vite.config.ts`, 'utf8');
    const packageJson = JSON.parse(
      readFileSync(`${repositoryRoot}/package.json`, 'utf8')
    ) as { scripts: Record<string, string> };

    expect(webServer).not.toContain('readAndStartAuthenticatedProjectConnectorRuntime');
    expect(webServer).not.toContain('startProjectConnectorWebSocket');
    expect(webServer).not.toContain('resolveProjectConnectorTargets');
    expect(vite).not.toContain('createConnectorCommandUpgradeHandler');
    expect(vite).not.toContain('startProjectConnectorWebSocket');
    expect(vite).not.toContain('PROJECT_SPACE_ENABLE_CONNECTOR_BRIDGE');
    expect(Object.keys(packageJson.scripts).filter((name) => name.startsWith('connector:')))
      .toEqual([]);
  });

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

      const report = await fetch(`${server.origin}/api/connector-retirement/report`);
      expect(report.status).toBe(410);
      expect(await report.json()).toEqual(legacyConnectorRetirement);

    } finally {
      await server.close();
    }
  });

  test.each([
    ['POST', '/api/connectors/project-registry'],
    ['POST', '/api/connectors/install-command'],
    ['DELETE', '/api/connectors/credentials/credential-id'],
    ['POST', '/api/pull-request-previews/dev-server/register'],
    ['GET', '/api/machines/machine-one/runtime'],
    ['POST', '/api/machines/machine-one/runtime/operations'],
    ['POST', '/api/machines/machine-one/runtime/stop']
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

  test('rejects the legacy machine terminal upgrade before backend dispatch', async () => {
    const socket = new PassThrough();
    let response = '';
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
    });

    expect(rejectRetiredMachineTerminalUpgrade(
      { url: '/api/machines/machine-one/terminal' } as IncomingMessage,
      socket
    )).toBe(true);
    await new Promise<void>((resolve) => socket.once('end', resolve));

    expect(response).toContain('HTTP/1.1 409 Conflict');
    expect(response).toContain('canonical_runtime_required');
    expect(response).not.toContain('101 Switching Protocols');
  });

  test('enforces legacy machine terminal retirement before production backend dispatch', async () => {
    const backend = createLocalProjectSpaceBackend();
    let machineOverviewCalls = 0;
    const server = await createProjectSpaceServer({
      backend: new Proxy(backend, {
        get(target, property, receiver) {
          if (property === 'getConnectorOverview') {
            return async () => {
              machineOverviewCalls += 1;
              return target.getConnectorOverview();
            };
          }
          return Reflect.get(target, property, receiver);
        }
      }),
      host: '127.0.0.1',
      port: 0
    });

    try {
      const socket = new PassThrough();
      let response = '';
      socket.on('data', (chunk) => {
        response += chunk.toString('utf8');
      });
      const closed = new Promise<void>((resolve) => socket.once('end', resolve));
      server.server.emit(
        'upgrade',
        { url: '/api/machines/machine-one/terminal' } as IncomingMessage,
        socket,
        Buffer.alloc(0)
      );
      await closed;

      expect(response).toContain('HTTP/1.1 409 Conflict');
      expect(response).toContain('canonical_runtime_required');
      expect(machineOverviewCalls).toBe(0);
    } finally {
      await server.close();
    }
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
