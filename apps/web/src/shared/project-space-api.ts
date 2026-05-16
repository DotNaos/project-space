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

export interface ToolLaunchRequest {
  tool: WorkspaceTool;
  projectId: string;
  worktreeId?: string;
}

export interface ToolLaunchResult {
  status: 'placeholder';
  message: string;
}

export interface TerminalCommandRequest {
  cwd: string;
  command: string;
}

export interface TerminalCommandResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface GitStatusEntry {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  displayStatus: string;
}

export interface GitStatusResult {
  branchName: string;
  entries: GitStatusEntry[];
  isRepository: boolean;
  repositoryRoot: string;
  summary: {
    changed: number;
    staged: number;
    untracked: number;
  };
  upstream?: string;
}

export interface GitDiffRequest {
  cwd: string;
  path?: string;
  staged?: boolean;
}

export interface GitDiffResult {
  diff: string;
  path?: string;
  staged: boolean;
}

export interface GitStageRequest {
  cwd: string;
  paths: string[];
}

export interface GitCommitRequest {
  cwd: string;
  message: string;
}

export interface GitActionResult {
  message: string;
  status: 'success' | 'error';
  stdout?: string;
  stderr?: string;
}

export interface CodexStatusResult {
  appServerOrigin?: string;
  appServerReachable: boolean;
  appInstalled: boolean;
  appPath?: string;
  cliAvailable: boolean;
  cliPath?: string;
  codexHome: string;
  configPath: string;
  currentThreadId?: string;
  skillsPath: string;
}

export interface CodexOpenRequest {
  cwd: string;
}

export interface OpenPathInAppRequest {
  appId: string;
  path: string;
}

export interface OpenPathInAppResult {
  status: 'success' | 'error';
  message?: string;
}

export type ConnectorStatus = 'local' | 'online' | 'offline' | 'not-installed';
export type DeploymentVisibility = 'private' | 'public';

export interface MachineConnectorRecord {
  installCommand: string;
  lastSeen?: string;
  origin?: string;
  status: ConnectorStatus;
}

export interface MachineRecord {
  id: string;
  kind: string;
  name: string;
  primaryUser?: string;
  profile?: string;
  roles: string[];
  sourcePath: string;
  network: {
    localName?: string;
    sshUser?: string;
    tailscaleIp?: string;
  };
  connector: MachineConnectorRecord;
}

export interface TailscaleStatusResult {
  connected: boolean;
  error?: string;
  installed: boolean;
  ips: string[];
  peersOnline: number;
  serveOrigins: string[];
  selfName?: string;
  tailnet?: string;
}

export interface ConnectorOverviewResult {
  connectorOrigin?: string;
  machines: MachineRecord[];
  machinesRepo: {
    exists: boolean;
    path: string;
  };
  tailscale: TailscaleStatusResult;
}

export interface DeploymentRecordSummary {
  appSlug: string;
  createdAt?: string;
  environment: string;
  id: string;
  routeHost?: string;
  routeKind?: DeploymentVisibility;
  runtimeDir?: string;
  sourceRef?: string;
  status: string;
  updatedAt?: string;
}

export interface BackupRecordSummary {
  appSlug: string;
  artifactPath?: string;
  createdAt?: string;
  environment: string;
  id: string;
  status: string;
  target: string;
}

export interface PlatformOverviewResult {
  apiBaseUrl?: string;
  apiReachable: boolean;
  backups: BackupRecordSummary[];
  deployments: DeploymentRecordSummary[];
  error?: string;
  healthStatus?: string;
  platformRepo: {
    exists: boolean;
    path: string;
  };
}

export interface ProjectDeployRequest {
  cwd: string;
  displayName?: string;
  environment: string;
  envFilePath?: string;
  gitRef?: string;
  planOnly?: boolean;
  projectSlug?: string;
  repoUrl?: string;
  visibility: DeploymentVisibility;
}

export interface ProjectBackupRequest {
  environment: string;
  projectSlug: string;
  target: string;
}

export interface ProjectSpaceBackend {
  getAppMeta(): Promise<AppMeta>;
  getCodexStatus(): Promise<CodexStatusResult>;
  getConnectorOverview(): Promise<ConnectorOverviewResult>;
  getGitDiff(request: GitDiffRequest): Promise<GitDiffResult>;
  getGitStatus(cwd: string): Promise<GitStatusResult>;
  getPlatformOverview(): Promise<PlatformOverviewResult>;
  loadLauncherAppIcon(appId: string): Promise<string | undefined>;
  loadLauncherApps(): Promise<LauncherAppRecord[]>;
  loadProjectDiscovery(): Promise<ProjectDiscoveryResult>;
  loadProjectsState(): Promise<ProjectsState>;
  loadProjectWorktrees(projectPath: string): Promise<ProjectWorktreeRecord[]>;
  openCodexSkills(): Promise<OpenPathInAppResult>;
  openCodexTarget(request: CodexOpenRequest): Promise<OpenPathInAppResult>;
  openPathInApp(request: OpenPathInAppRequest): Promise<OpenPathInAppResult>;
  readDirectory(path: string): Promise<FileSystemEntry[]>;
  runTerminalCommand(request: TerminalCommandRequest): Promise<TerminalCommandResult>;
  saveProjectsState(state: ProjectsState): Promise<void>;
  selectProjectDirectory(): Promise<ProjectDirectorySelection>;
  stageGitPaths(request: GitStageRequest): Promise<GitActionResult>;
  deployProject(request: ProjectDeployRequest): Promise<GitActionResult>;
  backupProject(request: ProjectBackupRequest): Promise<GitActionResult>;
  unstageGitPaths(request: GitStageRequest): Promise<GitActionResult>;
  commitGitChanges(request: GitCommitRequest): Promise<GitActionResult>;
  openWorkspaceTool(request: ToolLaunchRequest): Promise<ToolLaunchResult>;
}
