export const projectSpaceChannels = {
  appMeta: 'app:get-meta',
  selectProjectDirectory: 'projects:select-directory',
  openWorkspaceTool: 'workspace-tool:open'
} as const;

export type WorkspaceTool = 'ide' | 'terminal' | 'git' | 'dev-server';

export interface AppMeta {
  name: string;
  version: string;
  platform: string;
}

export interface ProjectDirectorySelection {
  canceled: boolean;
  path?: string;
  name?: string;
}

export interface ToolLaunchRequest {
  tool: WorkspaceTool;
  projectId: string;
  worktreeId?: string;
}

export interface ToolLaunchResult {
  status: 'placeholder';
  message: string;
}

export interface ProjectSpaceApi {
  getAppMeta(): Promise<AppMeta>;
  selectProjectDirectory(): Promise<ProjectDirectorySelection>;
  openWorkspaceTool(request: ToolLaunchRequest): Promise<ToolLaunchResult>;
}
