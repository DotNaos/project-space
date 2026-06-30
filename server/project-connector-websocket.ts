import type {
  ProjectCliCommandRequest,
  ProjectSpaceBackend
} from '../src/shared/project-space-api';

interface ConnectorCommandMessage {
  id?: string;
  payload?: ProjectCliCommandRequest;
  type: 'project-cli.run';
}

interface ProjectConnectorWebSocketOptions {
  backend: ProjectSpaceBackend;
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
  hubUrl = process.env.PROJECT_CONNECTOR_HUB_WS_URL
}: ProjectConnectorWebSocketOptions) {
  if (!hubUrl) {
    return {
      close() {}
    };
  }

  if (typeof WebSocket === 'undefined') {
    console.warn('PROJECT_CONNECTOR_HUB_WS_URL is set, but WebSocket is not available.');
    return {
      close() {}
    };
  }

  const resolvedHubUrl = hubUrl;
  let closed = false;
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
    if (closed) {
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

  return {
    close() {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      if (registryTimer) {
        clearInterval(registryTimer);
      }
      socket?.close();
    }
  };
}
