import type { ProjectSpaceBackend } from '../src/shared/project-space-api';
import {
  isConnectorMachineMessage,
  parseConnectorMessage,
  type ConnectorHubMessage,
  type ConnectorMachineMessage
} from './connector-command-protocol';
import {
  connectorRegistrationHeaders,
  connectorRegistrationTokenForTarget,
  resolveProjectConnectorTargets,
  type ProjectConnectorHubTarget
} from './project-connector-config';

interface ProjectConnectorWebSocketOptions {
  backend: ProjectSpaceBackend;
  hubHttpUrl?: string;
  hubUrl?: string;
}

const reconnectDelayMs = 5_000;
const registryIntervalMs = 30_000;
const filesystemCommandTimeoutMs = 8_000;

function sendJson(socket: WebSocket, payload: unknown) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function settleWithin<T>(promise: Promise<T>, fallback: T) {
  return new Promise<T>((resolve) => {
    const timeout = setTimeout(() => resolve(fallback), filesystemCommandTimeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      () => {
        clearTimeout(timeout);
        resolve(fallback);
      }
    );
  });
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
    const runningChats = new Map<string, AbortController>();

    async function publishRegistry(register = false) {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }

      const registry = await backend.getConnectorProjectRegistry();
      const message: ConnectorHubMessage = register
        ? {
            payload: registry,
            token: connectorRegistrationTokenForTarget(target),
            type: 'connector.register'
          }
        : {
            payload: registry,
            type: 'connector.registry'
          };
      sendJson(socket, message);
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
        void publishRegistry(true);
        registryTimer = setInterval(() => {
          void publishRegistry();
        }, registryIntervalMs);
      });

      socket.addEventListener('message', (event) => {
        const message = parseConnectorMessage(event.data);

        if (!isConnectorMachineMessage(message) || !socket) {
          return;
        }

        if (message.type === 'connector.command.cancel') {
          runningChats.get(message.id)?.abort();
          return;
        }

        if (message.type === 'codex.models') {
          void backend
            .getCodexModels(message.payload)
            .then((result) => {
              if (socket) {
                sendJson(socket, {
                  id: message.id,
                  payload: result,
                  type: 'codex.models.result'
                } satisfies ConnectorHubMessage);
              }
            })
            .catch((error) => {
              if (socket) {
                sendJson(socket, {
                  id: message.id,
                  payload: {
                    message: error instanceof Error ? error.message : 'Could not load Codex models.',
                    models: [],
                    status: 'error'
                  },
                  type: 'codex.models.result'
                } satisfies ConnectorHubMessage);
              }
            });
          return;
        }

        if (message.type === 'codex.chat') {
          const controller = new AbortController();
          runningChats.set(message.id, controller);
          void backend
            .streamCodexChat(message.payload, (event) => {
              if (socket) {
                sendJson(socket, {
                  id: message.id,
                  payload: event,
                  type: 'codex.chat.event'
                } satisfies ConnectorHubMessage);
              }
            }, controller.signal)
            .catch((error) => {
              if (socket) {
                sendJson(socket, {
                  id: message.id,
                  payload: {
                    message: error instanceof Error ? error.message : 'Codex chat failed.',
                    type: 'error'
                  },
                  type: 'codex.chat.event'
                } satisfies ConnectorHubMessage);
              }
            })
            .finally(() => {
              runningChats.delete(message.id);
              if (socket) {
                sendJson(socket, {
                  id: message.id,
                  type: 'codex.chat.complete'
                } satisfies ConnectorHubMessage);
              }
            });
          return;
        }

        if (message.type === 'terminal.run') {
          void backend.runMachineTerminalCommand(message.payload).then((result) => {
            if (socket) {
              sendJson(socket, {
                id: message.id,
                payload: result,
                type: 'terminal.result'
              } satisfies ConnectorHubMessage);
            }
          });
          return;
        }

        if (message.type === 'worktrees.list') {
          void backend.loadProjectWorktrees(message.payload.projectPath).then((result) => {
            if (socket) {
              sendJson(socket, {
                id: message.id,
                payload: result,
                type: 'worktrees.result'
              } satisfies ConnectorHubMessage);
            }
          });
          return;
        }

        if (message.type === 'filesystem.root') {
          void settleWithin(backend.getMachineFileSystemRoot(message.payload), {
            defaultPath: '',
            errorCode: 'permission-denied',
            homePath: '',
            message: 'The machine did not respond while opening its home directory.',
            status: 'error'
          }).then((result) => {
            if (socket) {
              sendJson(socket, {
                id: message.id,
                payload: result,
                type: 'filesystem.root.result'
              } satisfies ConnectorHubMessage);
            }
          });
          return;
        }

        if (message.type === 'filesystem.directory') {
          void settleWithin(backend.readMachineDirectory(message.payload), {
            entries: [],
            errorCode: 'permission-denied',
            message: 'macOS blocked this folder. Grant Full Disk Access to the Project Space connector and retry.',
            path: message.payload.path,
            status: 'error'
          }).then((result) => {
            if (socket) {
              sendJson(socket, {
                id: message.id,
                payload: result,
                type: 'filesystem.directory.result'
              } satisfies ConnectorHubMessage);
            }
          });
          return;
        }

        if (message.type === 'filesystem.file') {
          void settleWithin(backend.readMachineFile(message.payload), {
            errorCode: 'permission-denied',
            message: 'macOS blocked this file. Grant Full Disk Access to the Project Space connector and retry.',
            name: message.payload.path.split('/').pop() ?? message.payload.path,
            path: message.payload.path,
            status: 'error'
          }).then((result) => {
            if (socket) {
              sendJson(socket, {
                id: message.id,
                payload: result,
                type: 'filesystem.file.result'
              } satisfies ConnectorHubMessage);
            }
          });
          return;
        }

        if (message.type !== 'project-cli.run') {
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
          } satisfies ConnectorHubMessage);
        });
      });

      socket.addEventListener('close', () => {
        for (const controller of runningChats.values()) {
          controller.abort();
        }
        runningChats.clear();
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
