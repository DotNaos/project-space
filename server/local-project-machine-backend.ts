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
import { isConnectorHubMachine, isHubLocalMachine } from './connector-hub';
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
type WorktreeLoadOptions = { signal?: AbortSignal; timeoutMs?: number };

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
  connectorAction: () => Promise<MachineDirectoryMutationResult>,
  loadConnectorOverview: typeof loadMergedConnectorOverview = loadMergedConnectorOverview
) {
  const overview = await loadConnectorOverview();
  const machine = overview.machines.find((entry) => entry.id === machineId);
  if (!machine) {
    return directoryMutationError('This machine is not in the connector registry.');
  }
  if (isHubLocalMachine(machine)) {
    return localAction();
  }
  if (!isConnectorHubMachine(machine) || machine.connector.status !== 'online') {
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

export function createLocalProjectMachineBackend(
  loadConnectorOverview: typeof loadMergedConnectorOverview = loadMergedConnectorOverview
): Pick<
  ProjectSpaceBackend,
  MachineBackendMethod
> {
  return {
    async loadProjectWorktrees(
      projectPath: string, machineId?: string, options?: WorktreeLoadOptions
    ) {
      if (!machineId) {
        return loadLocalProjectWorktrees(projectPath, options);
      }

      const overview = await loadConnectorOverview();
      const machine = overview.machines.find((entry) => entry.id === machineId);
      if (!machine) {
        throw new Error(`Machine ${machineId} was not found.`);
      }
      if (isHubLocalMachine(machine)) {
        return loadLocalProjectWorktrees(projectPath, options);
      }
      if (!isConnectorHubMachine(machine) || machine.connector.status !== 'online') {
        throw new Error(`${machine.name} cannot provide its worktrees right now.`);
      }

      try {
        return await requestConnectorProjectWorktrees({ machineId, projectPath }, options);
      } catch (error) {
        throw new Error(
          error instanceof Error
            ? error.message
            : 'Could not load worktrees from the machine connector.'
        );
      }
    },
    async getCodexModels(request) {
      const overview = await loadConnectorOverview();
      const machine = overview.machines.find((entry) => entry.id === request.machineId);

      if (!machine) {
        return {
          message: `Machine ${request.machineId} was not found.`,
          models: [],
          status: 'error'
        };
      }

      if (isHubLocalMachine(machine)) {
        return getLocalCodexModels(request);
      }

      if (machine.connector.status !== 'online') {
        return {
          message: `${machine.name} is ${machine.connector.status}.`,
          models: [],
          status: 'error'
        };
      }

      if (isConnectorHubMachine(machine)) {
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
      const overview = await loadConnectorOverview();
      const machine = overview.machines.find((entry) => entry.id === request.machineId);

      if (!machine) {
        return {
          message: `Machine ${request.machineId} was not found.`,
          status: 'error'
        };
      }

      if (isHubLocalMachine(machine)) {
        return runCodexChat(request);
      }

      if (machine.connector.status !== 'online') {
        return {
          message: `${machine.name} is ${machine.connector.status}.`,
          status: 'error'
        };
      }

      if (isConnectorHubMachine(machine)) {
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
      const overview = await loadConnectorOverview();
      const machine = overview.machines.find((entry) => entry.id === request.machineId);

      if (!machine) {
        emit({ message: `Machine ${request.machineId} was not found.`, type: 'error' });
        return;
      }

      if (isHubLocalMachine(machine)) {
        await streamLocalCodexChat(request, emit, undefined, signal);
        return;
      }

      if (machine.connector.status !== 'online') {
        emit({ message: `${machine.name} is ${machine.connector.status}.`, type: 'error' });
        return;
      }

      if (isConnectorHubMachine(machine)) {
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
      const overview = await loadConnectorOverview();
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
      if (isHubLocalMachine(machine)) {
        return {
          defaultPath: join(homedir(), 'projects'),
          homePath: homedir(),
          status: 'success'
        };
      }
      if (!isConnectorHubMachine(machine) || machine.connector.status !== 'online') {
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
      const overview = await loadConnectorOverview();
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
      if (isHubLocalMachine(machine)) {
        return readHomeDirectory(request.path);
      }
      if (!isConnectorHubMachine(machine) || machine.connector.status !== 'online') {
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
      const overview = await loadConnectorOverview();
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
      if (isHubLocalMachine(machine)) {
        return readHomeFile(request.path);
      }
      if (!isConnectorHubMachine(machine) || machine.connector.status !== 'online') {
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
        () => requestConnectorFolderCreate(request),
        loadConnectorOverview
      );
    },
    async renameMachineDirectory(request) {
      return runDirectoryMutation(
        request.machineId,
        () => renameHomeFolder(request.path, request.name),
        () => requestConnectorFolderRename(request),
        loadConnectorOverview
      );
    },
    async deleteMachineDirectories(request) {
      return runDirectoryMutation(
        request.machineId,
        () => deleteHomeFolders(request.paths),
        () => requestConnectorFolderDelete(request),
        loadConnectorOverview
      );
    },
    async runMachineTerminalCommand(request) {
      const overview = await loadConnectorOverview();
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

      if (isHubLocalMachine(machine)) {
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

      if (isConnectorHubMachine(machine)) {
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
