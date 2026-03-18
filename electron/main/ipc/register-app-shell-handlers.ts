import { app, ipcMain } from 'electron';

import {
  projectSpaceChannels,
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
    projectSpaceChannels.openWorkspaceTool,
    async (_event, request: ToolLaunchRequest): Promise<ToolLaunchResult> => {
      return {
        status: 'placeholder',
        message: `Launcher placeholder: ${request.tool} will attach to worktree ${request.worktreeId ?? 'unselected'} later.`
      };
    }
  );
}
