import { app, dialog, ipcMain } from 'electron';
import { basename } from 'node:path';

import {
  projectSpaceChannels,
  type ProjectDirectorySelection,
  type ToolLaunchRequest,
  type ToolLaunchResult
} from '../../../src/shared/electron-api';

export function registerAppShellHandlers() {
  ipcMain.handle(projectSpaceChannels.appMeta, () => {
    return {
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform
    };
  });

  ipcMain.handle(
    projectSpaceChannels.selectProjectDirectory,
    async (): Promise<ProjectDirectorySelection> => {
      const result = await dialog.showOpenDialog({
        title: 'Select project folder',
        properties: ['openDirectory', 'createDirectory']
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true };
      }

      const selectedPath = result.filePaths[0];

      return {
        canceled: false,
        path: selectedPath,
        name: basename(selectedPath)
      };
    }
  );

  ipcMain.handle(
    projectSpaceChannels.openWorkspaceTool,
    async (_event, request: ToolLaunchRequest): Promise<ToolLaunchResult> => {
      return {
        status: 'placeholder',
        message: `Launcher placeholder: ${request.tool} will attach to worktree ${request.worktreeId ?? 'unselected'} later.`
      };
    }
  );
}
