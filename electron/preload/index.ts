import { contextBridge, ipcRenderer } from 'electron';

import {
  type GestureScrollState,
  type OpenPathInAppRequest,
  projectSpaceChannels,
  type ProjectsState,
  type ProjectSpaceApi,
  type ToolLaunchRequest
} from '../../src/shared/electron-api';

const api: ProjectSpaceApi = {
  getAppMeta() {
    return ipcRenderer.invoke(projectSpaceChannels.appMeta);
  },
  openCodexSkills() {
    return ipcRenderer.invoke(projectSpaceChannels.openCodexSkills);
  },
  loadLauncherAppIcon(appId: string) {
    return ipcRenderer.invoke(projectSpaceChannels.loadLauncherAppIcon, appId);
  },
  loadLauncherApps() {
    return ipcRenderer.invoke(projectSpaceChannels.loadLauncherApps);
  },
  loadProjectDiscovery() {
    return ipcRenderer.invoke(projectSpaceChannels.loadProjectDiscovery);
  },
  loadProjectsState() {
    return ipcRenderer.invoke(projectSpaceChannels.loadProjectsState);
  },
  loadProjectWorktrees(projectPath: string) {
    return ipcRenderer.invoke(projectSpaceChannels.loadProjectWorktrees, projectPath);
  },
  openPathInApp(request: OpenPathInAppRequest) {
    return ipcRenderer.invoke(projectSpaceChannels.openPathInApp, request);
  },
  onGestureScrollState(listener: (state: GestureScrollState) => void) {
    const handleGestureScrollState = (_event: Electron.IpcRendererEvent, state: GestureScrollState) => {
      listener(state);
    };

    ipcRenderer.on(projectSpaceChannels.gestureScrollState, handleGestureScrollState);

    return () => {
      ipcRenderer.removeListener(projectSpaceChannels.gestureScrollState, handleGestureScrollState);
    };
  },
  readDirectory(path: string) {
    return ipcRenderer.invoke(projectSpaceChannels.readDirectory, path);
  },
  saveProjectsState(state: ProjectsState) {
    return ipcRenderer.invoke(projectSpaceChannels.saveProjectsState, state);
  },
  selectProjectDirectory() {
    return ipcRenderer.invoke(projectSpaceChannels.selectProjectDirectory);
  },
  openWorkspaceTool(request: ToolLaunchRequest) {
    return ipcRenderer.invoke(projectSpaceChannels.openWorkspaceTool, request);
  }
};

contextBridge.exposeInMainWorld('projectSpace', api);
