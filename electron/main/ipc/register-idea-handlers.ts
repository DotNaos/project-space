import { ipcMain } from 'electron';

import type {
  CreateGithubIdeaFromDraftRequest,
  DeleteLocalIdeaDraftRequest,
  ExportIdeasToWorktreeRequest,
  MoveIdeaToWorktreeRequest,
  SaveLocalIdeaDraftRequest,
  UpdateGithubIdeaRequest
} from '../../../src/shared/electron-api';
import { projectSpaceChannels } from '../../../src/shared/electron-api';
import {
  createGithubIdeaFromDraft,
  listGithubIdeas,
  updateGithubIdea
} from './ideas/github-ideas';
import {
  loadGitHubAuthStatus,
  signOutGitHubAuth,
  startGitHubAuth
} from './github-auth';
import {
  loadProjectIssueSourceConfig,
  saveProjectIssueSourceConfig
} from './ideas/project-issue-source-config';
import {
  deleteLocalIdeaDraft,
  exportIdeasToWorktree,
  moveIdeaToWorktree,
  loadLocalIdeaDrafts,
  saveLocalIdeaDraft
} from './ideas/idea-storage';

export function registerIdeaHandlers() {
  ipcMain.handle(projectSpaceChannels.loadGithubAuthStatus, async () => {
    return loadGitHubAuthStatus();
  });

  ipcMain.handle(projectSpaceChannels.startGithubAuth, async () => {
    return startGitHubAuth();
  });

  ipcMain.handle(projectSpaceChannels.signOutGithubAuth, async () => {
    return signOutGitHubAuth();
  });

  ipcMain.handle(projectSpaceChannels.loadProjectIssueSourceConfig, async (_event, projectPath: string) => {
    return loadProjectIssueSourceConfig(projectPath);
  });

  ipcMain.handle(projectSpaceChannels.loadLocalIdeaDrafts, async (_event, projectPath: string) => {
    return loadLocalIdeaDrafts(projectPath);
  });

  ipcMain.handle(
    projectSpaceChannels.saveLocalIdeaDraft,
    async (_event, request: SaveLocalIdeaDraftRequest) => {
      return saveLocalIdeaDraft(request);
    }
  );

  ipcMain.handle(
    projectSpaceChannels.saveProjectIssueSourceConfig,
    async (_event, request) => {
      return saveProjectIssueSourceConfig(request);
    }
  );

  ipcMain.handle(
    projectSpaceChannels.deleteLocalIdeaDraft,
    async (_event, request: DeleteLocalIdeaDraftRequest) => {
      deleteLocalIdeaDraft(request);
    }
  );

  ipcMain.handle(projectSpaceChannels.listGithubIdeas, async (_event, request) => {
    return listGithubIdeas(request);
  });

  ipcMain.handle(
    projectSpaceChannels.createGithubIdeaFromDraft,
    async (_event, request: CreateGithubIdeaFromDraftRequest) => {
      return createGithubIdeaFromDraft(request);
    }
  );

  ipcMain.handle(
    projectSpaceChannels.updateGithubIdea,
    async (_event, request: UpdateGithubIdeaRequest) => {
      return updateGithubIdea(request);
    }
  );

  ipcMain.handle(
    projectSpaceChannels.exportIdeasToWorktree,
    async (_event, request: ExportIdeasToWorktreeRequest) => {
      exportIdeasToWorktree(request);
    }
  );

  ipcMain.handle(
    projectSpaceChannels.moveIdeaToWorktree,
    async (_event, request: MoveIdeaToWorktreeRequest) => {
      moveIdeaToWorktree(request);
    }
  );
}
