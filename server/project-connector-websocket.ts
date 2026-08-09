import type { ConnectorProjectRegistryResult, ProjectSpaceBackend } from '../src/shared/project-space-api';
import { ConnectorDevServerCommandExecutor } from './connector-dev-server-executor';
import {
  connectorDevServerErrorResult,
  connectorDevServerListErrorResult,
  type ConnectorDevServerAdapter,
  type ConnectorDevServerOperation
} from './connector-dev-server-contract';
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
import { createProjectConnectorActionControls } from './project-connector-action-controls';
import { CodexDaemonManager } from './codex-daemon/manager';
import { projectSpaceLogger, recordObservedError } from './observability';
interface ProjectConnectorWebSocketOptions extends ProjectConnectorConnectionOptions {
  backend: ProjectSpaceBackend & Partial<ConnectorDevServerAdapter & ConnectorWorktreeActionAdapter>;
  environment?: NodeJS.ProcessEnv;
  runtimeShutdown?(): Promise<void> | void;
}
export function startProjectConnectorWebSocket(options: ProjectConnectorWebSocketOptions) {
  const { backend } = options;
  const connection = resolveProjectConnectorConnection(options);
  const { targets } = connection;
  if (targets.length === 0) {
    return { close() {} };
  }
  let closed = false;
  const cleanupTasks: Array<() => void> = [];
  const codexSessionManager = createProjectConnectorCodexSessionManager(
    options.environment ?? process.env, options.runtimeCredential?.machineId
  );
  const codexDaemonManager = new CodexDaemonManager({
    environment: options.environment ?? process.env,
    manager: codexSessionManager
  });
  const codexAuthorizationManager = createProjectConnectorCodexAuthorizationManager(
    options.environment ?? process.env,
    options.runtimeCredential?.machineId,
    { onReady: () => codexSessionManager.close() }
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
          recordObservedError('connector', 'registry_publish_failed');
          projectSpaceLogger.warn('connector.registry.publish_failed', {
            component: 'connector',
            target: target.name
          }, error);
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
      recordObservedError('connector', 'websocket_unavailable');
      projectSpaceLogger.warn('connector.websocket.unavailable', {
        component: 'connector',
        target: target.name
      });
      return;
    }

    const resolvedHubUrl = target.wsUrl;
    let activeSocket: WebSocket | undefined;
    let cleanupActiveConnection: (() => void) | undefined;
    let publishCurrentRegistry: (() => Promise<boolean>) | undefined;
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
    const actionControls = createProjectConnectorActionControls({
      backend, machineId: options.runtimeCredential?.machineId,
      verificationKey: commandGrantPublicKey
    });
    const codexSessionsDispatcher = commandGrantPublicKey
      ? new CodexSessionsConnectorDispatcher({
          authorization: codexAuthorizationManager,
          daemonManager: codexDaemonManager,
          expectedMachineId: options.runtimeCredential?.machineId,
          manager: codexSessionManager,
          onDaemonChanged: async () => {
            await publishCurrentRegistry?.();
          },
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
      let publishThisRegistry: (() => Promise<boolean>) | undefined;
      let registryPublishPending = false;
      let registryTimer: ReturnType<typeof setInterval> | undefined;
      let registrationEvidence: ReturnType<typeof connectorRuntimeMaintenanceEvidence>;
      let registrationRegistry: ConnectorProjectRegistryResult | undefined;
      let registered = false;
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
        actionControls.setExpectedGeneration();
        if (registryTimer) {
          clearInterval(registryTimer);
          registryTimer = undefined;
        }
        if (publishCurrentRegistry === publishThisRegistry) {
          publishCurrentRegistry = undefined;
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
      publishThisRegistry = () => publishRegistry();
      publishCurrentRegistry = publishThisRegistry;

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
          actionControls.setExpectedGeneration(message.generation);
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

        if (actionControls.handle(message, socket)) return;

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
