import { contextBridge, ipcRenderer } from 'electron';

import {
  type CreateProjectWorktreeRequest,
  type CreateGithubIdeaFromDraftRequest,
  type DeleteLocalIdeaDraftRequest,
  type ExportIdeasToWorktreeRequest,
  type GestureScrollState,
  type ListGithubIdeasRequest,
  type LocalIdeaDraftRecord,
  type MoveIdeaToWorktreeRequest,
  type OpenPathInAppRequest,
  projectSpaceChannels,
  type ProjectIssueSourceConfig,
  type ProjectsState,
  type ProjectSpaceApi,
  type SaveLocalIdeaDraftRequest,
  type SaveProjectIssueSourceConfigRequest,
  type ToolLaunchRequest,
  type UpdateGithubIdeaRequest
} from '../../src/shared/electron-api';

const api: ProjectSpaceApi = {
  createProjectWorktree(request: CreateProjectWorktreeRequest) {
    return ipcRenderer.invoke(projectSpaceChannels.createProjectWorktree, request);
  },
  createGithubIdeaFromDraft(request: CreateGithubIdeaFromDraftRequest) {
    return ipcRenderer.invoke(projectSpaceChannels.createGithubIdeaFromDraft, request);
  },
  deleteLocalIdeaDraft(request: DeleteLocalIdeaDraftRequest) {
    return ipcRenderer.invoke(projectSpaceChannels.deleteLocalIdeaDraft, request);
  },
  exportIdeasToWorktree(request: ExportIdeasToWorktreeRequest) {
    return ipcRenderer.invoke(projectSpaceChannels.exportIdeasToWorktree, request);
  },
  moveIdeaToWorktree(request: MoveIdeaToWorktreeRequest) {
    return ipcRenderer.invoke(projectSpaceChannels.moveIdeaToWorktree, request);
  },
  getAppMeta() {
    return ipcRenderer.invoke(projectSpaceChannels.appMeta);
  },
  listGithubIdeas(request: ListGithubIdeasRequest) {
    return ipcRenderer.invoke(projectSpaceChannels.listGithubIdeas, request);
  },
  loadGithubAuthStatus() {
    return ipcRenderer.invoke(projectSpaceChannels.loadGithubAuthStatus);
  },
  loadProjectIssueSourceConfig(projectPath: string) {
    return ipcRenderer.invoke(projectSpaceChannels.loadProjectIssueSourceConfig, projectPath);
  },
  openCodexSkills() {
    return ipcRenderer.invoke(projectSpaceChannels.openCodexSkills);
  },
  openExternalUrl(url: string) {
    return ipcRenderer.invoke(projectSpaceChannels.openExternalUrl, url);
  },
  loadLauncherAppIcon(appId: string) {
    return ipcRenderer.invoke(projectSpaceChannels.loadLauncherAppIcon, appId);
  },
  loadLauncherApps() {
    return ipcRenderer.invoke(projectSpaceChannels.loadLauncherApps);
  },
  loadLocalIdeaDrafts(projectPath: string) {
    return ipcRenderer.invoke(projectSpaceChannels.loadLocalIdeaDrafts, projectPath);
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
  saveLocalIdeaDraft(request: SaveLocalIdeaDraftRequest) {
    return ipcRenderer.invoke(projectSpaceChannels.saveLocalIdeaDraft, request);
  },
  saveProjectIssueSourceConfig(request: SaveProjectIssueSourceConfigRequest) {
    return ipcRenderer.invoke(projectSpaceChannels.saveProjectIssueSourceConfig, request);
  },
  saveProjectsState(state: ProjectsState) {
    return ipcRenderer.invoke(projectSpaceChannels.saveProjectsState, state);
  },
  selectProjectDirectory() {
    return ipcRenderer.invoke(projectSpaceChannels.selectProjectDirectory);
  },
  signOutGithubAuth() {
    return ipcRenderer.invoke(projectSpaceChannels.signOutGithubAuth);
  },
  startGithubAuth() {
    return ipcRenderer.invoke(projectSpaceChannels.startGithubAuth);
  },
  updateGithubIdea(request: UpdateGithubIdeaRequest) {
    return ipcRenderer.invoke(projectSpaceChannels.updateGithubIdea, request);
  },
  openWorkspaceTool(request: ToolLaunchRequest) {
    return ipcRenderer.invoke(projectSpaceChannels.openWorkspaceTool, request);
  }
};

contextBridge.exposeInMainWorld('projectSpace', api);
