export const projectSpaceChannels = {
  appMeta: 'app:get-meta',
  createProjectWorktree: 'projects:create-worktree',
  createGithubIdeaFromDraft: 'ideas:create-github-from-draft',
  deleteLocalIdeaDraft: 'ideas:delete-local-draft',
  exportIdeasToWorktree: 'ideas:export-to-worktree',
  moveIdeaToWorktree: 'ideas:move-to-worktree',
  listGithubIdeas: 'ideas:list-github',
  loadLocalIdeaDrafts: 'ideas:load-local-drafts',
  loadProjectIssueSourceConfig: 'ideas:load-project-issue-source-config',
  openCodexSkills: 'codex:open-skills',
  openExternalUrl: 'browser:open-external-url',
  gestureScrollState: 'gesture:scroll-state',
  loadLauncherAppIcon: 'launcher:load-app-icon',
  loadLauncherApps: 'launcher:load-apps',
  loadProjectDiscovery: 'projects:load-discovery',
  loadProjectsState: 'projects:load-state',
  loadProjectWorktrees: 'projects:load-worktrees',
  openPathInApp: 'launcher:open-path',
  readDirectory: 'filesystem:read-directory',
  saveLocalIdeaDraft: 'ideas:save-local-draft',
  saveProjectIssueSourceConfig: 'ideas:save-project-issue-source-config',
  saveProjectsState: 'projects:save-state',
  selectProjectDirectory: 'projects:select-directory',
  updateGithubIdea: 'ideas:update-github',
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
  ideaIds: string[];
  id: string;
  name: string;
  path: string;
  branchName?: string;
  isBase: boolean;
  status: 'ready' | 'broken';
}

export interface CreateProjectWorktreeRequest {
  branchName: string;
  projectPath: string;
  worktreePathName: string;
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

export interface IdeaRecordBase {
  id: string;
  title: string;
  body: string;
  iteration: string;
  createdAt: string;
  updatedAt: string;
  evolvesIdeaId?: string;
}

export interface LocalIdeaDraftRecord extends IdeaRecordBase {
  source: 'local';
}

export interface GithubIdeaRecord extends IdeaRecordBase {
  source: 'github';
  githubIssueNumber: number;
  githubIssueUrl: string;
  githubLabels: string[];
  githubState: 'open' | 'closed';
}

export type IdeaRecord = LocalIdeaDraftRecord | GithubIdeaRecord;

export interface SaveLocalIdeaDraftRequest {
  draft: LocalIdeaDraftRecord;
  projectPath: string;
}

export interface DeleteLocalIdeaDraftRequest {
  ideaId: string;
  projectPath: string;
}

export interface ListGithubIdeasRequest {
  includeClosed?: boolean;
  projectPath: string;
}

export interface CreateGithubIdeaFromDraftRequest {
  draft: LocalIdeaDraftRecord;
  projectPath: string;
}

export interface UpdateGithubIdeaRequest {
  idea: GithubIdeaRecord;
  projectPath: string;
}

export type GithubIdeaMutationResult =
  | {
      idea: GithubIdeaRecord;
      status: 'success';
    }
  | {
      message: string;
      status: 'error';
    };

export interface ExportIdeasToWorktreeRequest {
  ideas: IdeaRecord[];
  worktreePath: string;
}

export interface MoveIdeaToWorktreeRequest {
  idea: IdeaRecord;
  targetWorktreePath?: string;
  worktreePaths: string[];
}

export type ProjectIssueProviderKind = 'azure-devops' | 'github' | 'unconfigured';

export interface ProjectIssueSourceConfig {
  kind: ProjectIssueProviderKind;
  source: 'inferred' | 'saved' | 'unconfigured';
  url: string;
}

export interface SaveProjectIssueSourceConfigRequest {
  config: {
    kind: Exclude<ProjectIssueProviderKind, 'unconfigured'>;
    url: string;
  };
  projectPath: string;
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
  createProjectWorktree(request: CreateProjectWorktreeRequest): Promise<ProjectWorktreeRecord[]>;
  createGithubIdeaFromDraft(
    request: CreateGithubIdeaFromDraftRequest
  ): Promise<GithubIdeaMutationResult>;
  deleteLocalIdeaDraft(request: DeleteLocalIdeaDraftRequest): Promise<void>;
  exportIdeasToWorktree(request: ExportIdeasToWorktreeRequest): Promise<void>;
  getAppMeta(): Promise<AppMeta>;
  listGithubIdeas(request: ListGithubIdeasRequest): Promise<GithubIdeaRecord[]>;
  loadLauncherAppIcon(appId: string): Promise<string | undefined>;
  loadLauncherApps(): Promise<LauncherAppRecord[]>;
  loadLocalIdeaDrafts(projectPath: string): Promise<LocalIdeaDraftRecord[]>;
  loadProjectIssueSourceConfig(projectPath: string): Promise<ProjectIssueSourceConfig>;
  loadProjectDiscovery(): Promise<ProjectDiscoveryResult>;
  loadProjectsState(): Promise<ProjectsState>;
  loadProjectWorktrees(projectPath: string): Promise<ProjectWorktreeRecord[]>;
  moveIdeaToWorktree(request: MoveIdeaToWorktreeRequest): Promise<void>;
  openCodexSkills(): Promise<OpenPathInAppResult>;
  openExternalUrl(url: string): Promise<OpenPathInAppResult>;
  openPathInApp(request: OpenPathInAppRequest): Promise<OpenPathInAppResult>;
  onGestureScrollState(listener: (state: GestureScrollState) => void): () => void;
  readDirectory(path: string): Promise<FileSystemEntry[]>;
  saveLocalIdeaDraft(request: SaveLocalIdeaDraftRequest): Promise<LocalIdeaDraftRecord>;
  saveProjectIssueSourceConfig(request: SaveProjectIssueSourceConfigRequest): Promise<ProjectIssueSourceConfig>;
  saveProjectsState(state: ProjectsState): Promise<void>;
  selectProjectDirectory(): Promise<ProjectDirectorySelection>;
  updateGithubIdea(request: UpdateGithubIdeaRequest): Promise<GithubIdeaMutationResult>;
  openWorkspaceTool(request: ToolLaunchRequest): Promise<ToolLaunchResult>;
}
