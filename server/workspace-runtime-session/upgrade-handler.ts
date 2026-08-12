import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { type RawData, WebSocket, WebSocketServer } from 'ws';

import type { RuntimeCredentialScope } from './contracts';
import { WorkspaceRuntimeSessionService, runtimeSessionFailure } from './service';
import { parseRegistration, parseRuntimeCodexMessage, parseRuntimeEvent } from './validation';

const socketPath = '/api/workspace-runtimes/socket';
const registrationTimeoutMs = 10_000;

export function createWorkspaceRuntimeSessionUpgradeHandler(
  service: WorkspaceRuntimeSessionService
) {
  const webSocketServer = new WebSocketServer({ maxPayload: 64 * 1024, noServer: true });

  webSocketServer.on('connection', (socket: WebSocket, _request: IncomingMessage, scope: RuntimeCredentialScope) => {
    let active: { scope: RuntimeCredentialScope; sessionId: string } | undefined;
    let pending = false;
    const registrationTimeout = setTimeout(() => {
      if (!active) socket.close(1008, 'Workspace Runtime registration timed out.');
    }, registrationTimeoutMs);
    const expiryTimeout = service.closeExpired(scope, socket);

    socket.on('message', async (data: RawData, isBinary: boolean) => {
      const encoded = Array.isArray(data)
        ? Buffer.concat(data)
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : data;
      if (isBinary || encoded.byteLength > 64 * 1024) {
        socket.close(1003, 'Workspace Runtime messages must be bounded JSON text.');
        return;
      }
      if (pending) {
        socket.close(1008, 'Workspace Runtime operation is already pending.');
        return;
      }
      pending = true;
      try {
        const parsed = JSON.parse(encoded.toString()) as unknown;
        if (!active) {
          active = await service.register(socket, scope, parseRegistration(parsed));
          clearTimeout(registrationTimeout);
        } else {
          const type = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as { type?: unknown }).type
            : undefined;
          if (typeof type === 'string' && type.startsWith('runtime.codex.')) {
            service.acceptCodex(active, parseRuntimeCodexMessage(parsed, active.scope, active.sessionId));
          } else {
            const result = await service.append(active, parseRuntimeEvent(parsed));
            socket.send(JSON.stringify(result.response));
            if (result.stopped) socket.close(1000, 'Workspace Runtime stopped gracefully.');
          }
        }
      } catch (error) {
        const failure = runtimeSessionFailure(error);
        socket.close(failure.code, failure.reason);
      } finally {
        pending = false;
      }
    });

    socket.on('close', () => {
      clearTimeout(registrationTimeout);
      clearTimeout(expiryTimeout);
      if (active) void service.disconnect(active);
    });
  });

  return {
    async close() {
      service.close();
      await Promise.all([...webSocketServer.clients].map((socket) => new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) return resolve();
        socket.once('close', () => resolve());
        socket.terminate();
      })));
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(fallback);
          resolve();
        };
        const fallback = setTimeout(finish, 250);
        webSocketServer.close(finish);
      });
    },
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== socketPath) return false;
      if (url.search || request.headers.authorization === undefined ||
        Array.isArray(request.headers.authorization)) {
        reject(socket, 401);
        return true;
      }
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization);
      if (!match) {
        reject(socket, 401);
        return true;
      }
      void service.authenticate(match[1]!).then((scope) => {
        if (!scope || socket.destroyed) {
          reject(socket, 401);
          return;
        }
        webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
          webSocketServer.emit('connection', webSocket, request, scope);
        });
      }).catch(() => reject(socket, 503));
      return true;
    }
  };
}

function reject(socket: Duplex, status: 401 | 503) {
  if (socket.destroyed) return;
  const message = status === 401 ? 'Unauthorized' : 'Service Unavailable';
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
