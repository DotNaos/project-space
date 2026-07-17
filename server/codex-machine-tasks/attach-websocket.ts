import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocket, WebSocketServer } from 'ws';

import { openConnectorCodexAttach } from '../codex-sessions/connector-hub';
import { CodexAttachLeaseStore, type CodexAttachLease } from './attach-lease-store';

const attachPath = /^\/api\/codex\/tasks\/([0-9a-fA-F-]{36})\/attach\/socket$/;
const maximumAttachMessageBytes = 16 * 1024 * 1024;
const maximumQueuedMessages = 64;
const maximumBufferedBytes = 8 * 1024 * 1024;

type OpenAttach = typeof openConnectorCodexAttach;

export function createCodexAttachUpgradeHandler(
  leases: CodexAttachLeaseStore,
  openAttach: OpenAttach = openConnectorCodexAttach
) {
  const webSocketServer = new WebSocketServer({
    maxPayload: maximumAttachMessageBytes,
    noServer: true
  });
  const acceptedLeases = new WeakMap<IncomingMessage, CodexAttachLease>();

  webSocketServer.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    const lease = acceptedLeases.get(request);
    acceptedLeases.delete(request);
    if (!lease) {
      socket.close(1008, 'Attach capability denied.');
      return;
    }

    const controller = new AbortController();
    const queued: string[] = [];
    let queuedBytes = 0;
    let tunnel: Awaited<ReturnType<typeof openConnectorCodexAttach>> | undefined;
    let settled = false;

    const close = () => {
      controller.abort();
      tunnel?.close();
    };
    socket.once('close', close);
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, 'Codex attach accepts text JSON only.');
        return;
      }
      const message = data.toString('utf8');
      const bytes = Buffer.byteLength(message);
      if (bytes < 1 || bytes > maximumAttachMessageBytes) {
        socket.close(1009, 'Codex attach message is too large.');
        return;
      }
      if (tunnel) {
        try {
          tunnel.send(message);
        } catch {
          socket.close(1011, 'Codex attach relay failed.');
        }
        return;
      }
      if (settled || queued.length >= maximumQueuedMessages ||
        queuedBytes + bytes > maximumAttachMessageBytes) {
        socket.close(1009, 'Too much Codex attach input before relay readiness.');
        return;
      }
      queued.push(message);
      queuedBytes += bytes;
    });

    void openAttach({
      machineId: lease.connectorId,
      operationId: lease.operationId,
      threadId: lease.threadId
    }, {
      generation: lease.generation,
      onClose() {
        if (socket.readyState === WebSocket.OPEN) socket.close(1011, 'Codex attach relay ended.');
      },
      onMessage(message) {
        if (socket.readyState !== WebSocket.OPEN ||
          socket.bufferedAmount > maximumBufferedBytes) {
          socket.close(1011, 'Codex attach client is not keeping up.');
          return;
        }
        socket.send(message);
      },
      signal: controller.signal,
      userId: lease.userId
    }).then((opened) => {
      settled = true;
      if (socket.readyState !== WebSocket.OPEN) {
        opened.close();
        return;
      }
      tunnel = opened;
      for (const message of queued) opened.send(message);
      queued.length = 0;
    }).catch(() => {
      settled = true;
      if (socket.readyState === WebSocket.OPEN) socket.close(1011, 'Codex attach relay unavailable.');
    });
  });

  return {
    close() {
      leases.clear();
      for (const client of webSocketServer.clients) client.close(1001, 'Project Space is stopping.');
      webSocketServer.close();
    },
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const match = url.pathname.match(attachPath);
      if (!match) return false;
      const token = bearerToken(request);
      const lease = !url.search && token ? leases.consume(token, match[1]) : undefined;
      if (!lease) {
        rejectUpgrade(socket);
        return true;
      }
      acceptedLeases.set(request, lease);
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit('connection', webSocket, request);
      });
      return true;
    }
  };
}

function bearerToken(request: IncomingMessage) {
  const authorizationHeaders = request.rawHeaders.filter((value, index) => (
    index % 2 === 0 && value.toLowerCase() === 'authorization'
  ));
  if (authorizationHeaders.length !== 1 || typeof request.headers.authorization !== 'string') {
    return undefined;
  }
  const match = request.headers.authorization.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
  return match?.[1];
}

function rejectUpgrade(socket: Duplex) {
  socket.end(
    'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
  );
}
