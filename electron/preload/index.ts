import { contextBridge, ipcRenderer } from 'electron';

import {
  projectSpaceChannels,
  type ProjectSpaceApi,
  type ToolLaunchRequest
} from '../../src/shared/electron-api';

const api: ProjectSpaceApi = {
  getAppMeta() {
    return ipcRenderer.invoke(projectSpaceChannels.appMeta);
  },
  selectProjectDirectory() {
    return ipcRenderer.invoke(projectSpaceChannels.selectProjectDirectory);
  },
  openWorkspaceTool(request: ToolLaunchRequest) {
    return ipcRenderer.invoke(projectSpaceChannels.openWorkspaceTool, request);
  }
};

contextBridge.exposeInMainWorld('projectSpace', api);
