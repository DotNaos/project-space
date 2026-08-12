import type { ProjectSpaceBackend } from '../src/shared/project-space-api';
import type { ConnectorHubMessage, ConnectorMachineMessage } from './connector-command-protocol';
import type {
  ConnectorRuntimeMaintenanceActivity,
  ConnectorRuntimeMaintenanceAdmission
} from './connector-runtime-maintenance-safety';
import { sendConnectorJson, settleConnectorCommandWithin } from './project-connector-websocket-utils';

const maintenanceMessage = 'Connector runtime maintenance is in progress.';

export function createProjectConnectorLegacyControls(options: {
  backend: ProjectSpaceBackend;
  isCurrentConnection(): boolean;
  maintenanceAdmission?: ConnectorRuntimeMaintenanceAdmission;
  socket: WebSocket;
}) {
  const { backend, socket } = options;
  const runningChats = new Map<string, AbortController>();

  function send(message: ConnectorHubMessage) {
    if (options.isCurrentConnection()) sendConnectorJson(socket, message);
  }

  function runMutation(
    scope: ConnectorRuntimeMaintenanceActivity,
    onBusy: () => void,
    action: () => Promise<void>,
    onFailure: (error: unknown) => void
  ) {
    const lease = options.maintenanceAdmission?.tryBeginActivity(scope);
    if (options.maintenanceAdmission && !lease) {
      onBusy();
      return;
    }
    void (async () => {
      try {
        await action();
      } catch (error) {
        onFailure(error);
      } finally {
        lease?.release();
      }
    })();
  }

  function handle(message: ConnectorMachineMessage) {
    if (message.type === 'codex.models') {
      void backend.getCodexModels(message.payload).then((payload) => send({
        id: message.id, payload, type: 'codex.models.result'
      })).catch((error) => send({
        id: message.id,
        payload: {
          message: error instanceof Error ? error.message : 'Could not load Codex models.',
          models: [],
          status: 'error'
        },
        type: 'codex.models.result'
      }));
      return true;
    }

    if (message.type === 'codex.chat') {
      const reject = (error: unknown = maintenanceMessage) => {
        send({
          id: message.id,
          payload: {
            message: error instanceof Error ? error.message : String(error),
            type: 'error'
          },
          type: 'codex.chat.event'
        });
        send({ id: message.id, type: 'codex.chat.complete' });
      };
      runMutation('codex-chat', () => reject(), async () => {
        const controller = new AbortController();
        runningChats.set(message.id, controller);
        try {
          await backend.streamCodexChat(
            message.payload,
            (payload) => send({ id: message.id, payload, type: 'codex.chat.event' }),
            controller.signal
          );
          send({ id: message.id, type: 'codex.chat.complete' });
        } finally {
          runningChats.delete(message.id);
        }
      }, reject);
      return true;
    }

    if (message.type === 'terminal.run') {
      const reject = (error: unknown = maintenanceMessage) => send({
        id: message.id,
        payload: {
          command: message.payload.command,
          cwd: '',
          durationMs: 0,
          exitCode: null,
          stderr: error instanceof Error ? error.message : String(error),
          stdout: ''
        },
        type: 'terminal.result'
      });
      runMutation('terminal', () => reject(), async () => {
        const payload = await backend.runMachineTerminalCommand(message.payload);
        send({ id: message.id, payload, type: 'terminal.result' });
      }, reject);
      return true;
    }

    if (message.type === 'filesystem.root') {
      void settleConnectorCommandWithin(backend.getMachineFileSystemRoot(message.payload), {
        defaultPath: '', errorCode: 'permission-denied', homePath: '',
        message: 'The machine did not respond while opening its home directory.', status: 'error'
      }).then((payload) => send({ id: message.id, payload, type: 'filesystem.root.result' }));
      return true;
    }

    if (message.type === 'filesystem.directory') {
      void settleConnectorCommandWithin(backend.readMachineDirectory(message.payload), {
        entries: [], errorCode: 'permission-denied',
        message: 'macOS blocked this folder. Grant Full Disk Access to the Project Space connector and retry.',
        path: message.payload.path, status: 'error'
      }).then((payload) => send({ id: message.id, payload, type: 'filesystem.directory.result' }));
      return true;
    }

    if (message.type === 'filesystem.file') {
      void settleConnectorCommandWithin(backend.readMachineFile(message.payload), {
        errorCode: 'permission-denied',
        message: 'macOS blocked this file. Grant Full Disk Access to the Project Space connector and retry.',
        name: message.payload.path.split('/').pop() ?? message.payload.path,
        path: message.payload.path, status: 'error'
      }).then((payload) => send({ id: message.id, payload, type: 'filesystem.file.result' }));
      return true;
    }

    if (message.type === 'filesystem.folder.create') {
      const reject = (error: unknown = maintenanceMessage) => send({
        id: message.id,
        payload: {
          affectedPaths: [], errorCode: 'failed',
          message: error instanceof Error ? error.message : String(error), status: 'error'
        },
        type: 'filesystem.folder.create.result'
      });
      runMutation('filesystem', () => reject(), async () => {
        const payload = await settleConnectorCommandWithin(
          backend.createMachineDirectory(message.payload),
          {
            affectedPaths: [], errorCode: 'failed',
            message: 'The machine did not respond while creating the folder.', status: 'error'
          }
        );
        send({ id: message.id, payload, type: 'filesystem.folder.create.result' });
      }, reject);
      return true;
    }

    if (message.type === 'filesystem.folder.rename') {
      const reject = (error: unknown = maintenanceMessage) => send({
        id: message.id,
        payload: {
          affectedPaths: [], errorCode: 'failed',
          message: error instanceof Error ? error.message : String(error), status: 'error'
        },
        type: 'filesystem.folder.rename.result'
      });
      runMutation('filesystem', () => reject(), async () => {
        const payload = await settleConnectorCommandWithin(
          backend.renameMachineDirectory(message.payload),
          {
            affectedPaths: [], errorCode: 'failed',
            message: 'The machine did not respond while renaming the folder.', status: 'error'
          }
        );
        send({ id: message.id, payload, type: 'filesystem.folder.rename.result' });
      }, reject);
      return true;
    }

    if (message.type === 'filesystem.folder.delete') {
      const reject = (error: unknown = maintenanceMessage) => send({
        id: message.id,
        payload: {
          affectedPaths: [], errorCode: 'failed',
          message: error instanceof Error ? error.message : String(error), status: 'error'
        },
        type: 'filesystem.folder.delete.result'
      });
      runMutation('filesystem', () => reject(), async () => {
        const payload = await backend.deleteMachineDirectories(message.payload);
        send({ id: message.id, payload, type: 'filesystem.folder.delete.result' });
      }, reject);
      return true;
    }

    if (message.type !== 'project-cli.run') return false;
    const reject = (error: unknown = maintenanceMessage) => send({
      id: message.id,
      payload: {
        args: [], command: message.payload.command, cwd: message.payload.cwd, durationMs: 0,
        exitCode: null, stderr: error instanceof Error ? error.message : String(error), stdout: ''
      },
      type: 'project-cli.result'
    });
    runMutation('project-cli', () => reject(), async () => {
      const payload = await backend.runProjectCliCommand(message.payload);
      send({ id: message.id, payload, type: 'project-cli.result' });
    }, reject);
    return true;
  }

  return {
    cancel(id: string) {
      const controller = runningChats.get(id);
      controller?.abort();
      return Boolean(controller);
    },
    cancelAll() {
      for (const controller of runningChats.values()) controller.abort();
      runningChats.clear();
    },
    handle
  };
}
