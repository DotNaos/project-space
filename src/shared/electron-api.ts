export const projectSpaceChannels = {
  appMeta: 'app:get-meta',
  openCodexSkills: 'codex:open-skills',
  gestureScrollState: 'gesture:scroll-state',
  loadLauncherAppIcon: 'launcher:load-app-icon',
  loadLauncherApps: 'launcher:load-apps',
  loadProjectDiscovery: 'projects:load-discovery',
  loadProjectsState: 'projects:load-state',
  loadProjectWorktrees: 'projects:load-worktrees',
  openPathInApp: 'launcher:open-path',
  readDirectory: 'filesystem:read-directory',
  saveProjectsState: 'projects:save-state',
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

export interface ProjectSpaceRecord {
  id: string;
  name: string;
  rootPath: string;
  kind: 'workspace' | 'standalone';
  groupId?: string;
}

export interface ProjectGroupRecord {
  id: string;
  name: string;
  rootPath: string;
  childProjectIds: string[];
}

export type ProjectNavigationItem =
  | {
      id: string;
      kind: 'project';
      label: string;
      projectId: string;
    }
  | {
      id: string;
      kind: 'group';
      label: string;
      groupId: string;
    };

export interface ProjectDiscoveryResult {
  rootPath: string;
  groups: ProjectGroupRecord[];
  projects: ProjectSpaceRecord[];
  rootItems: ProjectNavigationItem[];
}

export type ExplorerTarget =
  | {
      kind: 'workspace';
    }
  | {
      kind: 'worktree';
      worktreeId: string;
    };

export interface LauncherAppRecord {
  id: string;
  label: string;
  appName: string;
  iconDataUrl?: string;
  iconUrl?: string;
}

export const launcherAppLabels: Record<string, string> = {
  'android-studio': 'Android Studio',
  antigravity: 'Antigravity',
  codex: 'Codex',
  cursor: 'Cursor',
  finder: 'Finder',
  ghostty: 'Ghostty',
  rider: 'Rider',
  terminal: 'Terminal',
  'vscode-insiders': 'VS Code Insiders',
  xcode: 'Xcode'
};

export interface ProjectsState {
  activeGroupId: string;
  selectedExplorerTarget: ExplorerTarget;
  selectedLauncherAppId: string;
  selectedProjectId: string;
}

export interface ProjectWorktreeRecord {
  id: string;
  name: string;
  path: string;
  branchName?: string;
  isBase: boolean;
  status: 'ready' | 'broken';
}

export interface FileSystemEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory';
}

export type GestureScrollState = 'begin' | 'end';

export interface ToolLaunchRequest {
  tool: WorkspaceTool;
  projectId: string;
  worktreeId?: string;
}

export interface ToolLaunchResult {
  status: 'placeholder';
  message: string;
}

export interface OpenPathInAppRequest {
  appId: string;
  path: string;
}

export interface OpenPathInAppResult {
  status: 'success' | 'error';
  message?: string;
}

export interface ProjectSpaceApi {
  getAppMeta(): Promise<AppMeta>;
  loadLauncherAppIcon(appId: string): Promise<string | undefined>;
  loadLauncherApps(): Promise<LauncherAppRecord[]>;
  loadProjectDiscovery(): Promise<ProjectDiscoveryResult>;
  loadProjectsState(): Promise<ProjectsState>;
  loadProjectWorktrees(projectPath: string): Promise<ProjectWorktreeRecord[]>;
  openCodexSkills(): Promise<OpenPathInAppResult>;
  openPathInApp(request: OpenPathInAppRequest): Promise<OpenPathInAppResult>;
  onGestureScrollState(listener: (state: GestureScrollState) => void): () => void;
  readDirectory(path: string): Promise<FileSystemEntry[]>;
  saveProjectsState(state: ProjectsState): Promise<void>;
  selectProjectDirectory(): Promise<ProjectDirectorySelection>;
  openWorkspaceTool(request: ToolLaunchRequest): Promise<ToolLaunchResult>;
}
