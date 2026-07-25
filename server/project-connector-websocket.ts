import type { ConnectorProjectRegistryResult, ProjectSpaceBackend } from '../src/shared/project-space-api';
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
import { CodexSessionsConnectorDispatcher } from './codex-sessions/connector-dispatch';
import {
  createProjectConnectorCodexAuthorizationManager,
  createProjectConnectorCodexSessionManager,
  handleProjectConnectorCodexMessage,
  sendProjectConnectorCodexResult
} from './project-connector-codex-runtime';
import {
  connectorRegistryForRuntimeConfiguration,
  createConfiguredConnectorRuntimeDispatcher
} from './connector-runtime-command-routing';
import { clearConnectorRuntimeMaintenanceEvidence } from './connector-build-info';
import { connectorRuntimeMaintenanceEvidence } from './connector-runtime-registration-decision';
import { publishConnectorRuntimeReadiness } from './connector-runtime-readiness';
import {
  sendConnectorJson as sendJson,
  settleConnectorCommandWithin as settleWithin
} from './project-connector-websocket-utils';
import { createProjectConnectorWorktreeLoads } from './project-connector-worktree-loads';
import { createProjectConnectorRuntimeStopControl } from './project-connector-runtime-stop';
import { createMachineResourceCollector } from './machine-resource-collector';
import type { MachineResourceSnapshot } from '../src/shared/machine-resources-api';

const defaultResourceIntervalMs = 5_000;

interface ProjectConnectorWebSocketOptions extends ProjectConnectorConnectionOptions {
  backend: ProjectSpaceBackend & Partial<ConnectorDevServerAdapter & ConnectorWorktreeActionAdapter>;
  collectResources?(connectorId: string): Promise<MachineResourceSnapshot>;
  environment?: NodeJS.ProcessEnv;
  resourceIntervalMs?: number;
  runtimeShutdown?(): Promise<void> | void;
}

export function startProjectConnectorWebSocket(options: ProjectConnectorWebSocketOptions) {
  const { backend } = options;
  const connection = resolveProjectConnectorConnection(options);
  const { targets } = connection;
  const resourceIntervalMs = options.resourceIntervalMs ?? defaultResourceIntervalMs;
  if (!Number.isSafeInteger(resourceIntervalMs) || resourceIntervalMs <= 0) {
    throw new Error('Connector resource interval must be a positive integer.');
  }
  const collectResources = options.collectResources ?? createMachineResourceCollector();
  if (targets.length === 0) {
    return {
      close() {}
    };
  }

  let closed = false;
  const cleanupTasks: Array<() => void> = [];
  const codexSessionManager = createProjectConnectorCodexSessionManager(
    options.environment ?? process.env, options.runtimeCredential?.machineId
  );
  const codexAuthorizationManager = createProjectConnectorCodexAuthorizationManager(
    options.environment ?? process.env, options.runtimeCredential?.machineId
  );
  cleanupTasks.push(() => void codexSessionManager.close());
  cleanupTasks.push(() => void codexAuthorizationManager.close());

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
    const shutdownRuntime = options.runtimeShutdown ?? (() => {
      process.kill(process.pid, 'SIGTERM');
    });
    const runtimeDispatcher = createConfiguredConnectorRuntimeDispatcher({
      commandVerificationKey: commandGrantPublicKey, machineId: options.runtimeCredential?.machineId,
      shutdown: shutdownRuntime
    });
    const runtimeStopControl = createProjectConnectorRuntimeStopControl({
      commandVerificationKey: commandGrantPublicKey,
      machineId: options.runtimeCredential?.machineId,
      shutdown: shutdownRuntime
    });
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
    const codexSessionsDispatcher = commandGrantPublicKey
      ? new CodexSessionsConnectorDispatcher({
          authorization: codexAuthorizationManager,
          expectedMachineId: options.runtimeCredential?.machineId,
          manager: codexSessionManager,
          verificationKey: commandGrantPublicKey
        })
      : undefined;
    cleanupTasks.push(() => codexSessionsDispatcher?.close());

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
      const worktreeLoads = createProjectConnectorWorktreeLoads(
        backend,
        (message) => sendJson(socket, message)
      );
      let cleanedUp = false;
      let registryPublishPending = false;
      let registryTimer: ReturnType<typeof setInterval> | undefined;
      let resourceTimer: ReturnType<typeof setInterval> | undefined;
      let registrationEvidence: ReturnType<typeof connectorRuntimeMaintenanceEvidence>;
      let registrationRegistry: ConnectorProjectRegistryResult | undefined;
      let registered = false;
      let resourcePublishPending = false;
      let serialMessages = Promise.resolve();
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
        worktreeLoads.cancelAll();
        codexSessionsDispatcher?.cancelAll();
        codexSessionsDispatcher?.setExpectedGeneration();
        runtimeDispatcher?.setExpectedGeneration();
        runtimeStopControl.setExpectedGeneration();
        if (registryTimer) {
          clearInterval(registryTimer);
          registryTimer = undefined;
        }
        if (resourceTimer) {
          clearInterval(resourceTimer);
          resourceTimer = undefined;
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
          if (register) runtimeStopControl.configure(registry);
          registry = connectorRegistryForRuntimeConfiguration(registry, [
            ...(runtimeDispatcher ? ['runtime.restart', 'runtime.update'] : []),
            ...(runtimeStopControl.configured ? ['runtime.stop'] : [])
          ]);
        } catch {
          return false;
        }
        if (!isCurrentConnection() || socket.readyState !== WebSocket.OPEN) {
          return false;
        }
        if (register) {
          registrationEvidence = connectorRuntimeMaintenanceEvidence(registry);
          registrationRegistry = registry;
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

      async function publishResources() {
        const connectorId = registrationRegistry?.connector.machineId;
        if (
          !connectorId ||
          !registered ||
          !isCurrentConnection() ||
          socket.readyState !== WebSocket.OPEN
        ) {
          return;
        }
        const payload = await collectResources(connectorId);
        if (
          payload.connectorId === connectorId &&
          isCurrentConnection() &&
          socket.readyState === WebSocket.OPEN
        ) {
          sendJson(socket, {
            payload,
            type: 'connector.resources'
          });
        }
      }

      function startResourcePublisher() {
        if (resourceTimer || !isCurrentConnection()) return;
        const publish = () => {
          if (resourcePublishPending) return;
          resourcePublishPending = true;
          void publishResources()
            .catch(() => undefined)
            .finally(() => {
              resourcePublishPending = false;
            });
        };
        publish();
        resourceTimer = setInterval(publish, resourceIntervalMs);
      }

      socket.addEventListener('open', () => {
        void publishRegistry(true).then((published) => {
          if (!published && isCurrentConnection()) {
            socket.close();
          }
        });
      });

      async function handleMessage(message: ConnectorMachineMessage) {
        if (!isCurrentConnection()) return;
        if (message.type === 'connector.registered') {
          if (registered) throw new Error('Connector was registered more than once.');
          if ((registrationEvidence || message.maintenance) && !runtimeDispatcher) {
            throw new Error('Connector runtime maintenance is not configured.');
          }
          await runtimeDispatcher?.acceptRegistration(registrationEvidence, message.maintenance);
          registered = true;
          runtimeDispatcher?.setExpectedGeneration(message.generation);
          runtimeStopControl.setExpectedGeneration(message.generation);
          codexSessionsDispatcher?.setExpectedGeneration(message.generation);
          if (registrationEvidence && !(await publishRegistry()))
            throw new Error('Connector runtime maintenance acknowledgement failed.');
          if (registrationEvidence) clearConnectorRuntimeMaintenanceEvidence(registrationEvidence);
          if (options.runtimeCredential && registrationRegistry) {
            await publishConnectorRuntimeReadiness(
              registrationRegistry,
              options.runtimeCredential.machineId
            );
          }
          startRegistryPublisher();
          startResourcePublisher();
          return;
        }
        if (!registered) throw new Error('Connector command arrived before registration.');
        if (message.type === 'runtime.maintenance') {
          if (!runtimeDispatcher) throw new Error('Connector runtime maintenance is unavailable.');
          runtimeDispatcher.dispatch(
            message.id, message.payload,
            (result) => { if (isCurrentConnection()) sendJson(socket, result); },
            () => socket.close(1008, 'Connector runtime authorization failed.')
          );
          return;
        }
        if (message.type === 'runtime.stop') {
          await runtimeStopControl.dispatch(message, socket, isCurrentConnection);
          return;
        }
        if (message.type === 'connector.command.cancel') {
          if (codexSessionsDispatcher?.cancel(message.id, (result) =>
            sendProjectConnectorCodexResult(socket, result, isCurrentConnection))) {
            return;
          }
          if (worktreeLoads.cancel(message.id)) return;
          runningChats.get(message.id)?.abort();
          return;
        }

        if (message.type === 'codex.attach.input' || message.type === 'codex.sessions.command') {
          handleProjectConnectorCodexMessage({
            dispatcher: codexSessionsDispatcher, isCurrentConnection, message, socket
          });
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
          worktreeLoads.start(message);
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
      }

      socket.addEventListener('message', (event) => {
        const message = parseConnectorMessage(event.data);
        if (!isConnectorMachineMessage(message)) return;
        serialMessages = serialMessages
          .then(() => handleMessage(message))
          .catch(() => socket.close(1008, 'Connector message handling failed.'));
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
