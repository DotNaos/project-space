import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import type {
  MachineDirectoryMutationResult,
  MachineRecord,
  ProjectSpaceBackend
} from '../src/shared/project-space-api';
import {
  getCodexModels as getLocalCodexModels,
  runCodexChat,
  streamCodexChat as streamLocalCodexChat
} from './local-codex-client';
import { runTerminalCommand } from './local-command-runner';
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

const canonicalRuntimeRequired =
  'This operation requires the canonical Environment and Workspace Runtime.';

function isLocalMachine(machine: MachineRecord) {
  // Connector registrations are never trusted as local process authority.
  return machine.connector.status === 'local' && machine.sourcePath !== 'connector-hub';
}

function isRetiredConnectorMachine(machine: MachineRecord) {
  return machine.sourcePath === 'connector-hub';
}

function directoryMutationError(message: string): MachineDirectoryMutationResult {
  return {
    affectedPaths: [],
    errorCode: 'unsupported',
    message,
    status: 'error'
  };
}

async function runDirectoryMutation(
  machineId: string,
  localAction: () => Promise<MachineDirectoryMutationResult>,
  loadConnectorOverview: typeof loadMergedConnectorOverview = loadMergedConnectorOverview
) {
  const overview = await loadConnectorOverview();
  const machine = overview.machines.find((entry) => entry.id === machineId);
  if (!machine) {
    return directoryMutationError('This machine is not in the connector registry.');
  }
  if (isLocalMachine(machine)) {
    return localAction();
  }
  return directoryMutationError(canonicalRuntimeRequired);
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
      if (isLocalMachine(machine)) {
        return loadLocalProjectWorktrees(projectPath, options);
      }
      throw new Error(canonicalRuntimeRequired);
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

      if (isLocalMachine(machine)) {
        return getLocalCodexModels(request);
      }

      if (isRetiredConnectorMachine(machine)) {
        return { message: canonicalRuntimeRequired, models: [], status: 'error' };
      }

      if (machine.connector.status !== 'online') {
        return {
          message: `${machine.name} is ${machine.connector.status}.`,
          models: [],
          status: 'error'
        };
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

      if (isLocalMachine(machine)) {
        return runCodexChat(request);
      }

      if (isRetiredConnectorMachine(machine)) {
        return { message: canonicalRuntimeRequired, status: 'error' };
      }

      if (machine.connector.status !== 'online') {
        return {
          message: `${machine.name} is ${machine.connector.status}.`,
          status: 'error'
        };
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

      if (isLocalMachine(machine)) {
        await streamLocalCodexChat(request, emit, undefined, signal);
        return;
      }

      if (isRetiredConnectorMachine(machine)) {
        emit({ message: canonicalRuntimeRequired, type: 'error' });
        return;
      }

      if (machine.connector.status !== 'online') {
        emit({ message: `${machine.name} is ${machine.connector.status}.`, type: 'error' });
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
      if (isLocalMachine(machine)) {
        return {
          defaultPath: join(homedir(), 'projects'),
          homePath: homedir(),
          status: 'success'
        };
      }
      return {
        defaultPath: '',
        errorCode: 'unsupported',
        homePath: '',
        message: canonicalRuntimeRequired,
        status: 'error'
      };
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
      if (isLocalMachine(machine)) {
        return readHomeDirectory(request.path);
      }
      return {
        entries: [],
        errorCode: 'unsupported',
        message: canonicalRuntimeRequired,
        path: request.path,
        status: 'error'
      };
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
      if (isLocalMachine(machine)) {
        return readHomeFile(request.path);
      }
      return {
        errorCode: 'unsupported',
        message: canonicalRuntimeRequired,
        name: basename(request.path),
        path: request.path,
        status: 'error'
      };
    },
    async createMachineDirectory(request) {
      return runDirectoryMutation(
        request.machineId,
        () => createHomeFolder(request.parentPath, request.name),
        loadConnectorOverview
      );
    },
    async renameMachineDirectory(request) {
      return runDirectoryMutation(
        request.machineId,
        () => renameHomeFolder(request.path, request.name),
        loadConnectorOverview
      );
    },
    async deleteMachineDirectories(request) {
      return runDirectoryMutation(
        request.machineId,
        () => deleteHomeFolders(request.paths),
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

      if (isLocalMachine(machine)) {
        return runTerminalCommand({
          command: request.command,
          cwd: homedir()
        });
      }

      return {
        command: request.command,
        cwd: `machine:${machine.id}`,
        durationMs: 0,
        exitCode: 1,
        stderr: canonicalRuntimeRequired,
        stdout: ''
      };
    }
  };
}
