import type { ProjectSpaceBackend } from '../src/shared/project-space-api';
import { ConnectorDevServerCommandExecutor } from './connector-dev-server-executor';
import {
  connectorDevServerErrorResult,
  connectorDevServerListErrorResult,
  type ConnectorDevServerAdapter,
  type ConnectorDevServerOperation
} from './connector-dev-server-contract';
import { ConnectorWorktreeActionExecutor } from './connector-worktree-action-executor';
import type { ConnectorWorktreeActionAdapter } from './connector-worktree-action-contract';
import {
  isConnectorMachineMessage,
  parseConnectorMessage,
  type ConnectorHubMessage,
  type ConnectorMachineMessage
} from './connector-command-protocol';
import {
  connectorCommandGrantPublicKeyForTarget,
  connectorRegistrationHeaders,
  type ProjectConnectorHubTarget
} from './project-connector-config';
import {
  resolveProjectConnectorConnection,
  type ProjectConnectorConnectionOptions
} from './project-connector-runtime-binding';

interface ProjectConnectorWebSocketOptions extends ProjectConnectorConnectionOptions {
  backend: ProjectSpaceBackend &
    Partial<ConnectorDevServerAdapter & ConnectorWorktreeActionAdapter>;
}

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

export function startProjectConnectorWebSocket(options: ProjectConnectorWebSocketOptions) {
  const { backend } = options;
  const connection = resolveProjectConnectorConnection(options);
  const { targets } = connection;
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
      const registry = await connection.registry(backend);
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
            throw new Error(
              `${response.status} ${response.statusText}${detail ? `: ${detail}` : ''}`
            );
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
    }, connection.registryIntervalMs);
    cleanupTasks.push(() => clearInterval(httpRegistryTimer));
  }

  function startWebSocketBridge(target: ProjectConnectorHubTarget) {
    if (!target.wsUrl) {
      return;
    }

    if (typeof WebSocket === 'undefined') {
      console.warn(
        `Connector hub ${target.name} has a WebSocket URL, but WebSocket is not available.`
      );
      return;
    }

    const resolvedHubUrl = target.wsUrl;
    let activeSocket: WebSocket | undefined;
    let cleanupActiveConnection: (() => void) | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const adapter: ConnectorDevServerAdapter =
      typeof backend.runDevServerCommand === 'function'
        ? (backend as ConnectorDevServerAdapter)
        : {
            async listDevServers(request) {
              return connectorDevServerListErrorResult(request, request.actor.generation);
            },
            async runDevServerCommand(request) {
              return connectorDevServerErrorResult(
                request,
                request.actor.generation,
                'This connector does not provide dev-server commands.',
                'unavailable'
              );
            }
          };
    const commandGrantPublicKey = connectorCommandGrantPublicKeyForTarget(target);
    const devServerExecutor = commandGrantPublicKey
      ? new ConnectorDevServerCommandExecutor(
          adapter,
          commandGrantPublicKey,
          options.runtimeCredential?.machineId
        )
      : undefined;
    const worktreeActionExecutor =
      commandGrantPublicKey && typeof backend.runWorktreeAction === 'function'
        ? new ConnectorWorktreeActionExecutor(
            backend as ConnectorWorktreeActionAdapter,
            commandGrantPublicKey,
            options.runtimeCredential?.machineId
          )
        : undefined;

    function scheduleReconnect() {
      if (closed || reconnectTimer) {
        return;
      }

      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, connection.reconnectDelayMs);
    }

    function connect() {
      if (closed || !resolvedHubUrl) {
        return;
      }

      const socket = new WebSocket(resolvedHubUrl);
      const runningChats = new Map<string, AbortController>();
      let cleanedUp = false;
      let registryPublishPending = false;
      let registryTimer: ReturnType<typeof setInterval> | undefined;
      activeSocket = socket;

      function isCurrentConnection() {
        return !closed && activeSocket === socket;
      }

      function cleanupConnection(closeSocket: boolean) {
        if (cleanedUp) {
          return;
        }
        cleanedUp = true;
        for (const controller of runningChats.values()) {
          controller.abort();
        }
        runningChats.clear();
        if (registryTimer) {
          clearInterval(registryTimer);
          registryTimer = undefined;
        }
        if (closeSocket) {
          socket.close();
        }
      }

      cleanupActiveConnection = () => cleanupConnection(true);

      async function publishRegistry(register = false) {
        if (!isCurrentConnection() || socket.readyState !== WebSocket.OPEN) {
          return false;
        }

        let registry: Awaited<ReturnType<typeof backend.getConnectorProjectRegistry>>;
        try {
          registry = await connection.registry(backend);
        } catch {
          return false;
        }
        if (!isCurrentConnection() || socket.readyState !== WebSocket.OPEN) {
          return false;
        }
        const message: ConnectorHubMessage = register
          ? {
              payload: registry,
              token: connection.registrationToken(target),
              type: 'connector.register'
            }
          : {
              payload: registry,
              type: 'connector.registry'
            };
        sendJson(socket, message);
        return true;
      }

      function startRegistryPublisher() {
        if (registryTimer || !isCurrentConnection()) {
          return;
        }
        registryTimer = setInterval(() => {
          if (registryPublishPending) {
            return;
          }
          registryPublishPending = true;
          void publishRegistry().finally(() => {
            registryPublishPending = false;
          });
        }, connection.registryIntervalMs);
      }

      socket.addEventListener('open', () => {
        void publishRegistry(true).then((published) => {
          if (!published && isCurrentConnection()) {
            socket.close();
          }
        });
      });

      socket.addEventListener('message', (event) => {
        const message = parseConnectorMessage(event.data);

        if (!isCurrentConnection() || !isConnectorMachineMessage(message)) {
          return;
        }

        if (message.type === 'connector.registered') {
          startRegistryPublisher();
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
                    message:
                      error instanceof Error ? error.message : 'Could not load Codex models.',
                    models: [],
                    status: 'error'
                  },
                  type: 'codex.models.result'
                } satisfies ConnectorHubMessage);
              }
            });
          return;
        }

        if (message.type === 'dev-server.list') {
          const execution = devServerExecutor
            ? devServerExecutor.execute('list', message.payload)
            : Promise.resolve(
                connectorDevServerListErrorResult(message.payload, message.payload.grant.generation)
              );
          void execution.then((result) => {
            if (socket) {
              sendJson(socket, {
                id: message.id,
                payload: result,
                type: 'dev-server.list.result'
              } satisfies ConnectorHubMessage);
            }
          });
          return;
        }

        if (message.type === 'worktree.action') {
          if (!worktreeActionExecutor) {
            socket?.close(1008, 'Worktree actions are not configured.');
            return;
          }
          void worktreeActionExecutor
            .execute(message.payload.operation, message.payload)
            .then((result) => {
              if (socket)
                sendJson(socket, {
                  id: message.id,
                  payload: result,
                  type: 'worktree.action.result'
                } satisfies ConnectorHubMessage);
            })
            .catch(() => socket?.close(1008, 'Worktree action authorization failed.'));
          return;
        }

        if (
          message.type === 'dev-server.inspect' ||
          message.type === 'dev-server.start' ||
          message.type === 'dev-server.stop'
        ) {
          const operation = message.type.slice('dev-server.'.length) as Exclude<
            ConnectorDevServerOperation,
            'list'
          >;
          const resultType = `${message.type}.result` as
            'dev-server.inspect.result' | 'dev-server.start.result' | 'dev-server.stop.result';
          const execution = devServerExecutor
            ? devServerExecutor.execute(operation, message.payload)
            : Promise.resolve(
                connectorDevServerErrorResult(
                  message.payload,
                  message.payload.grant.generation,
                  'Connector command verification is not configured.',
                  'unavailable'
                )
              );
          void execution.then((result) => {
            if (socket) {
              sendJson(socket, {
                id: message.id,
                payload: result,
                type: resultType
              } satisfies ConnectorHubMessage);
            }
          });
          return;
        }

        if (message.type === 'codex.chat') {
          const controller = new AbortController();
          runningChats.set(message.id, controller);
          void backend
            .streamCodexChat(
              message.payload,
              (event) => {
                if (socket) {
                  sendJson(socket, {
                    id: message.id,
                    payload: event,
                    type: 'codex.chat.event'
                  } satisfies ConnectorHubMessage);
                }
              },
              controller.signal
            )
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
            message:
              'macOS blocked this folder. Grant Full Disk Access to the Project Space connector and retry.',
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
            message:
              'macOS blocked this file. Grant Full Disk Access to the Project Space connector and retry.',
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

        if (message.type === 'filesystem.folder.create') {
          void settleWithin(backend.createMachineDirectory(message.payload), {
            affectedPaths: [],
            errorCode: 'failed',
            message: 'The machine did not respond while creating the folder.',
            status: 'error'
          }).then((result) => {
            if (socket) {
              sendJson(socket, {
                id: message.id,
                payload: result,
                type: 'filesystem.folder.create.result'
              } satisfies ConnectorHubMessage);
            }
          });
          return;
        }

        if (message.type === 'filesystem.folder.rename') {
          void settleWithin(backend.renameMachineDirectory(message.payload), {
            affectedPaths: [],
            errorCode: 'failed',
            message: 'The machine did not respond while renaming the folder.',
            status: 'error'
          }).then((result) => {
            if (socket) {
              sendJson(socket, {
                id: message.id,
                payload: result,
                type: 'filesystem.folder.rename.result'
              } satisfies ConnectorHubMessage);
            }
          });
          return;
        }

        if (message.type === 'filesystem.folder.delete') {
          void backend
            .deleteMachineDirectories(message.payload)
            .then((result) => {
              if (socket) {
                sendJson(socket, {
                  id: message.id,
                  payload: result,
                  type: 'filesystem.folder.delete.result'
                } satisfies ConnectorHubMessage);
              }
            })
            .catch(() => {
              if (socket) {
                sendJson(socket, {
                  id: message.id,
                  payload: {
                    affectedPaths: [],
                    errorCode: 'failed',
                    message: 'The folders could not be deleted.',
                    status: 'error'
                  },
                  type: 'filesystem.folder.delete.result'
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
        const wasCurrentConnection = activeSocket === socket;
        cleanupConnection(false);
        if (!wasCurrentConnection) {
          return;
        }
        activeSocket = undefined;
        cleanupActiveConnection = undefined;
        scheduleReconnect();
      });

      socket.addEventListener('error', () => {
        socket.close();
      });
    }

    connect();
    cleanupTasks.push(() => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      cleanupActiveConnection?.();
      cleanupActiveConnection = undefined;
      activeSocket = undefined;
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
