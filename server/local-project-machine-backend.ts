import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import type {
  MachineDirectoryMutationResult,
  ProjectSpaceBackend
} from '../src/shared/project-space-api';
import {
  requestConnectorDirectory,
  requestConnectorFile,
  requestConnectorFileSystemRoot,
  requestConnectorFolderCreate,
  requestConnectorFolderDelete,
  requestConnectorFolderRename,
  requestConnectorModels,
  requestConnectorProjectWorktrees,
  requestConnectorTerminalCommand,
  streamConnectorCodexChat
} from './connector-command-hub';
import {
  getCodexModels as getLocalCodexModels,
  runCodexChat,
  streamCodexChat as streamLocalCodexChat
} from './local-codex-client';
import { runSshTerminalCommand, runTerminalCommand } from './local-command-runner';
import {
  createMachineSshTarget,
  loadMergedConnectorOverview,
  readLocalDirectoryEntries,
  remoteCodexRuntime
} from './local-project-machines';
import { loadLocalProjectWorktrees } from './local-project-worktrees';
import {
  createHomeFolder,
  deleteHomeFolders,
  readHomeDirectory,
  readHomeFile,
  renameHomeFolder
} from './machine-filesystem';

type MachineBackendMethod =
  | 'createMachineDirectory'
  | 'deleteMachineDirectories'
  | 'getCodexModels'
  | 'getMachineFileSystemRoot'
  | 'loadProjectWorktrees'
  | 'readDirectory'
  | 'readMachineDirectory'
  | 'readMachineFile'
  | 'renameMachineDirectory'
  | 'runCodexChat'
  | 'runMachineTerminalCommand'
  | 'streamCodexChat';

function directoryMutationError(message: string): MachineDirectoryMutationResult {
  return {
    affectedPaths: [],
    errorCode: 'disconnected',
    message,
    status: 'error'
  };
}

async function runDirectoryMutation(
  machineId: string,
  localAction: () => Promise<MachineDirectoryMutationResult>,
  connectorAction: () => Promise<MachineDirectoryMutationResult>
) {
  const overview = await loadMergedConnectorOverview();
  const machine = overview.machines.find((entry) => entry.id === machineId);
  if (!machine) {
    return directoryMutationError('This machine is not in the connector registry.');
  }
  if (machine.connector.status === 'local' || machine.kind === 'local') {
    return localAction();
  }
  if (machine.connector.status !== 'online' || machine.sourcePath !== 'connector-hub') {
    return directoryMutationError(`${machine.name} is ${machine.connector.status}.`);
  }
  try {
    return await connectorAction();
  } catch (error) {
    return directoryMutationError(
      error instanceof Error ? error.message : 'The machine connector is not available right now.'
    );
  }
}

export function createLocalProjectMachineBackend(): Pick<
  ProjectSpaceBackend,
  MachineBackendMethod
> {
  return {
    async loadProjectWorktrees(projectPath: string, machineId?: string) {
      if (!machineId) {
        return loadLocalProjectWorktrees(projectPath);
      }

      const overview = await loadMergedConnectorOverview();
      const machine = overview.machines.find((entry) => entry.id === machineId);
      if (!machine) {
        throw new Error(`Machine ${machineId} was not found.`);
      }
      if (machine.connector.status === 'local' || machine.kind === 'local') {
        return loadLocalProjectWorktrees(projectPath);
      }
      if (machine.connector.status !== 'online' || machine.sourcePath !== 'connector-hub') {
        throw new Error(`${machine.name} cannot provide its worktrees right now.`);
      }

      try {
        return await requestConnectorProjectWorktrees({ machineId, projectPath });
      } catch (error) {
        throw new Error(
          error instanceof Error
            ? error.message
            : 'Could not load worktrees from the machine connector.'
        );
      }
    },
    async getCodexModels(request) {
      const overview = await loadMergedConnectorOverview();
      const machine = overview.machines.find((entry) => entry.id === request.machineId);

      if (!machine) {
        return {
          message: `Machine ${request.machineId} was not found.`,
          models: [],
          status: 'error'
        };
      }

      if (machine.connector.status === 'local' || machine.kind === 'local') {
        return getLocalCodexModels(request);
      }

      if (machine.connector.status !== 'online') {
        return {
          message: `${machine.name} is ${machine.connector.status}.`,
          models: [],
          status: 'error'
        };
      }

      if (machine.sourcePath === 'connector-hub') {
        try {
          return await requestConnectorModels(request);
        } catch (error) {
          return {
            message:
              error instanceof Error ? error.message : 'Could not reach the machine connector.',
            models: [],
            status: 'error'
          };
        }
      }

      const target = createMachineSshTarget(machine);
      if (!target) {
        return {
          message: `${machine.name} does not have an SSH target.`,
          models: [],
          status: 'error'
        };
      }

      return getLocalCodexModels(request, remoteCodexRuntime(target, request.cwd));
    },
    async runCodexChat(request) {
      const overview = await loadMergedConnectorOverview();
      const machine = overview.machines.find((entry) => entry.id === request.machineId);

      if (!machine) {
        return {
          message: `Machine ${request.machineId} was not found.`,
          status: 'error'
        };
      }

      if (machine.connector.status === 'local' || machine.kind === 'local') {
        return runCodexChat(request);
      }

      if (machine.connector.status !== 'online') {
        return {
          message: `${machine.name} is ${machine.connector.status}.`,
          status: 'error'
        };
      }

      if (machine.sourcePath === 'connector-hub') {
        let result = '';
        let failure = '';
        try {
          await streamConnectorCodexChat(request, (event) => {
            if (event.type === 'done') {
              result = event.response;
            } else if (event.type === 'error') {
              failure = event.message;
            }
          });
          return failure
            ? { message: failure, status: 'error' }
            : { response: result, status: 'success' };
        } catch (error) {
          return {
            message:
              error instanceof Error ? error.message : 'Could not reach the machine connector.',
            status: 'error'
          };
        }
      }

      const target = createMachineSshTarget(machine);

      if (!target) {
        return {
          message: `${machine.name} does not have an SSH target.`,
          status: 'error'
        };
      }

      return runCodexChat(request, remoteCodexRuntime(target, request.cwd));
    },
    async streamCodexChat(request, emit, signal) {
      const overview = await loadMergedConnectorOverview();
      const machine = overview.machines.find((entry) => entry.id === request.machineId);

      if (!machine) {
        emit({ message: `Machine ${request.machineId} was not found.`, type: 'error' });
        return;
      }

      if (machine.connector.status === 'local' || machine.kind === 'local') {
        await streamLocalCodexChat(request, emit, undefined, signal);
        return;
      }

      if (machine.connector.status !== 'online') {
        emit({ message: `${machine.name} is ${machine.connector.status}.`, type: 'error' });
        return;
      }

      if (machine.sourcePath === 'connector-hub') {
        try {
          await streamConnectorCodexChat(request, emit);
        } catch (error) {
          emit({
            message:
              error instanceof Error ? error.message : 'Could not reach the machine connector.',
            type: 'error'
          });
        }
        return;
      }

      const target = createMachineSshTarget(machine);

      if (!target) {
        emit({ message: `${machine.name} does not have an SSH target.`, type: 'error' });
        return;
      }

      await streamLocalCodexChat(
        request,
        emit,
        remoteCodexRuntime(target, request.cwd),
        signal
      );
    },
    async readDirectory(path: string) {
      return readLocalDirectoryEntries(path);
    },
    async getMachineFileSystemRoot(request) {
      const overview = await loadMergedConnectorOverview();
      const machine = overview.machines.find((entry) => entry.id === request.machineId);
      if (!machine) {
        return {
          defaultPath: '',
          errorCode: 'disconnected',
          homePath: '',
          message: 'This machine is not in the connector registry.',
          status: 'error'
        };
      }
      if (machine.connector.status === 'local' || machine.kind === 'local') {
        return {
          defaultPath: join(homedir(), 'projects'),
          homePath: homedir(),
          status: 'success'
        };
      }
      if (machine.connector.status !== 'online' || machine.sourcePath !== 'connector-hub') {
        return {
          defaultPath: '',
          errorCode: 'disconnected',
          homePath: '',
          message: `${machine.name} is ${machine.connector.status}.`,
          status: 'error'
        };
      }

      try {
        return await requestConnectorFileSystemRoot(request);
      } catch (error) {
        return {
          defaultPath: '',
          errorCode: 'disconnected',
          homePath: '',
          message:
            error instanceof Error
              ? error.message
              : 'The machine connector is not available right now.',
          status: 'error'
        };
      }
    },
    async readMachineDirectory(request) {
      const overview = await loadMergedConnectorOverview();
      const machine = overview.machines.find((entry) => entry.id === request.machineId);
      if (!machine) {
        return {
          entries: [],
          errorCode: 'disconnected',
          message: 'This machine is not in the connector registry.',
          path: request.path,
          status: 'error'
        };
      }
      if (machine.connector.status === 'local' || machine.kind === 'local') {
        return readHomeDirectory(request.path);
      }
      if (machine.connector.status !== 'online' || machine.sourcePath !== 'connector-hub') {
        return {
          entries: [],
          errorCode: 'disconnected',
          message: `${machine.name} is ${machine.connector.status}.`,
          path: request.path,
          status: 'error'
        };
      }

      try {
        return await requestConnectorDirectory(request);
      } catch (error) {
        return {
          entries: [],
          errorCode: 'disconnected',
          message:
            error instanceof Error
              ? error.message
              : 'The machine connector is not available right now.',
          path: request.path,
          status: 'error'
        };
      }
    },
    async readMachineFile(request) {
      const overview = await loadMergedConnectorOverview();
      const machine = overview.machines.find((entry) => entry.id === request.machineId);
      if (!machine) {
        return {
          errorCode: 'disconnected',
          message: 'This machine is not in the connector registry.',
          name: basename(request.path),
          path: request.path,
          status: 'error'
        };
      }
      if (machine.connector.status === 'local' || machine.kind === 'local') {
        return readHomeFile(request.path);
      }
      if (machine.connector.status !== 'online' || machine.sourcePath !== 'connector-hub') {
        return {
          errorCode: 'disconnected',
          message: `${machine.name} is ${machine.connector.status}.`,
          name: basename(request.path),
          path: request.path,
          status: 'error'
        };
      }

      try {
        return await requestConnectorFile(request);
      } catch (error) {
        return {
          errorCode: 'disconnected',
          message:
            error instanceof Error
              ? error.message
              : 'The machine connector is not available right now.',
          name: basename(request.path),
          path: request.path,
          status: 'error'
        };
      }
    },
    async createMachineDirectory(request) {
      return runDirectoryMutation(
        request.machineId,
        () => createHomeFolder(request.parentPath, request.name),
        () => requestConnectorFolderCreate(request)
      );
    },
    async renameMachineDirectory(request) {
      return runDirectoryMutation(
        request.machineId,
        () => renameHomeFolder(request.path, request.name),
        () => requestConnectorFolderRename(request)
      );
    },
    async deleteMachineDirectories(request) {
      return runDirectoryMutation(
        request.machineId,
        () => deleteHomeFolders(request.paths),
        () => requestConnectorFolderDelete(request)
      );
    },
    async runMachineTerminalCommand(request) {
      const overview = await loadMergedConnectorOverview();
      const machine = overview.machines.find((entry) => entry.id === request.machineId);

      if (!machine) {
        return {
          command: request.command,
          cwd: `machine:${request.machineId}`,
          durationMs: 0,
          exitCode: 1,
          stderr: `Machine ${request.machineId} was not found.`,
          stdout: ''
        };
      }

      if (machine.connector.status === 'local' || machine.kind === 'local') {
        return runTerminalCommand({
          command: request.command,
          cwd: homedir()
        });
      }

      if (machine.connector.status !== 'online') {
        return {
          command: request.command,
          cwd: `machine:${machine.id}`,
          durationMs: 0,
          exitCode: 1,
          stderr: `${machine.name} is ${machine.connector.status}.`,
          stdout: ''
        };
      }

      if (machine.sourcePath === 'connector-hub') {
        try {
          return await requestConnectorTerminalCommand(request);
        } catch (error) {
          return {
            command: request.command,
            cwd: `machine:${machine.id}`,
            durationMs: 0,
            exitCode: 1,
            stderr:
              error instanceof Error
                ? error.message
                : 'The machine connector is not available right now.',
            stdout: ''
          };
        }
      }

      const target = createMachineSshTarget(machine);

      if (!target) {
        return {
          command: request.command,
          cwd: `machine:${machine.id}`,
          durationMs: 0,
          exitCode: 1,
          stderr: `${machine.name} does not have an SSH target.`,
          stdout: ''
        };
      }

      return runSshTerminalCommand({
        command: request.command,
        target
      });
    }
  };
}
