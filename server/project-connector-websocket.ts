import type {
  ProjectCliCommandRequest,
  ProjectSpaceBackend
} from '../src/shared/project-space-api';
import {
  connectorRegistrationHeaders,
  resolveProjectConnectorTargets,
  type ProjectConnectorHubTarget
} from './project-connector-config';

interface ConnectorCommandMessage {
  id?: string;
  payload?: ProjectCliCommandRequest;
  type: 'project-cli.run';
}

interface ProjectConnectorWebSocketOptions {
  backend: ProjectSpaceBackend;
  hubHttpUrl?: string;
  hubUrl?: string;
}

const reconnectDelayMs = 5_000;
const registryIntervalMs = 30_000;

function sendJson(socket: WebSocket, payload: unknown) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function parseMessage(data: MessageEvent['data']) {
  try {
    return JSON.parse(typeof data === 'string' ? data : String(data)) as ConnectorCommandMessage;
  } catch {
    return undefined;
  }
}

export function startProjectConnectorWebSocket({
  backend,
  hubHttpUrl,
  hubUrl
}: ProjectConnectorWebSocketOptions) {
  const targets = resolveProjectConnectorTargets({ hubHttpUrl, hubUrl });
  if (targets.length === 0) {
    return {
      close() {}
    };
  }

  let closed = false;
  const cleanupTasks: Array<() => void> = [];

  function startHttpRegistryPublisher(target: ProjectConnectorHubTarget) {
    if (!target.url) {
      return;
    }
    const resolvedHubHttpUrl = target.url;

    async function publishRegistryToHttpHub() {
      const registry = await backend.getConnectorProjectRegistry();
      await fetch(`${resolvedHubHttpUrl}/api/connectors/project-registry`, {
        body: JSON.stringify(registry),
        headers: {
          'Content-Type': 'application/json',
          ...connectorRegistrationHeaders(target)
        },
        method: 'POST'
      })
        .then(async (response) => {
          if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`${response.status} ${response.statusText}${detail ? `: ${detail}` : ''}`);
          }
        })
        .catch((error) => {
          console.warn(
            `Could not publish connector registry to ${target.name} (${resolvedHubHttpUrl}): ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        });
    }

    void publishRegistryToHttpHub();
    const httpRegistryTimer = setInterval(() => {
      void publishRegistryToHttpHub();
    }, registryIntervalMs);
    cleanupTasks.push(() => clearInterval(httpRegistryTimer));
  }

  function startWebSocketBridge(target: ProjectConnectorHubTarget) {
    if (!target.wsUrl) {
      return;
    }

    if (typeof WebSocket === 'undefined') {
      console.warn(`Connector hub ${target.name} has a WebSocket URL, but WebSocket is not available.`);
      return;
    }

    const resolvedHubUrl = target.wsUrl;
    let socket: WebSocket | undefined;
    let registryTimer: ReturnType<typeof setInterval> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    async function publishRegistry() {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }

      const registry = await backend.getConnectorProjectRegistry();
      sendJson(socket, {
        payload: registry,
        type: 'connector.registry'
      });
    }

    function scheduleReconnect() {
      if (closed || reconnectTimer) {
        return;
      }

      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, reconnectDelayMs);
    }

    function connect() {
      if (closed || !resolvedHubUrl) {
        return;
      }

      socket = new WebSocket(resolvedHubUrl);

      socket.addEventListener('open', () => {
        void publishRegistry();
        registryTimer = setInterval(() => {
          void publishRegistry();
        }, registryIntervalMs);
      });

      socket.addEventListener('message', (event) => {
        const message = parseMessage(event.data);

        if (message?.type !== 'project-cli.run' || !message.payload) {
          return;
        }

        void backend.runProjectCliCommand(message.payload).then((result) => {
          if (!socket) {
            return;
          }

          sendJson(socket, {
            id: message.id,
            payload: result,
            type: 'project-cli.result'
          });
        });
      });

      socket.addEventListener('close', () => {
        if (registryTimer) {
          clearInterval(registryTimer);
          registryTimer = undefined;
        }
        scheduleReconnect();
      });

      socket.addEventListener('error', () => {
        socket?.close();
      });
    }

    connect();
    cleanupTasks.push(() => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      if (registryTimer) {
        clearInterval(registryTimer);
      }
      socket?.close();
    });
  }

  for (const target of targets) {
    startHttpRegistryPublisher(target);
    startWebSocketBridge(target);
  }

  return {
    close() {
      closed = true;
      cleanupTasks.forEach((cleanup) => cleanup());
    }
  };
}
