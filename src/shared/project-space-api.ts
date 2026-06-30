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

export interface ProjectctlDiscoverySummary {
  hasGoals: boolean;
  hasLock: boolean;
  hasProject: boolean;
  status: 'managed' | 'partial' | 'unmanaged';
}

export type FullstackTemplateStatus = 'implemented' | 'partial' | 'not-detected' | 'template-source';

export interface FullstackTemplateCheck {
  matched: string[];
  missing: string[];
  score: number;
  status: FullstackTemplateStatus;
}

export interface ProjectSpaceRecord {
  id: string;
  name: string;
  rootPath: string;
  kind: 'workspace' | 'standalone';
  groupId?: string;
  projectctl?: ProjectctlDiscoverySummary;
  fullstackTemplate?: FullstackTemplateCheck;
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

export type GitHubAuthSource = 'stored-oauth' | 'environment';
export type GitHubCatalogStatus = 'connected' | 'auth-required' | 'not-configured' | 'error';
export type GitHubProjectConfigStatus = 'complete' | 'partial' | 'missing' | 'unknown';

export interface GitHubCatalogRepository {
  defaultBranch?: string;
  description?: string;
  fullName: string;
  id: number;
  isPrivate: boolean;
  name: string;
  owner: string;
  projectConfig: {
    projectYaml: boolean;
    status: GitHubProjectConfigStatus;
    templateLock: boolean;
  };
  pushedAt?: string;
  updatedAt?: string;
  url: string;
}

export interface GitHubCatalogResult {
  auth?: {
    login?: string;
    source: GitHubAuthSource;
  };
  checkedAt: string;
  message?: string;
  repositories: GitHubCatalogRepository[];
  status: GitHubCatalogStatus;
}

export interface GitHubOAuthDeviceStartResult {
  deviceCode?: string;
  expiresAt?: string;
  intervalSeconds?: number;
  message?: string;
  status: 'pending' | 'not-configured' | 'error';
  userCode?: string;
  verificationUri?: string;
}

export interface GitHubOAuthDevicePollRequest {
  deviceCode: string;
}

export interface GitHubOAuthDevicePollResult {
  catalog?: GitHubCatalogResult;
  intervalSeconds?: number;
  message?: string;
  status: 'pending' | 'connected' | 'expired' | 'denied' | 'error';
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
  serviceName?: string;
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

export interface ConnectorProjectRegistryResult {
  checkedAt: string;
  connector: {
    machineId: string;
    machineName: string;
    origin?: string;
    serviceName?: string;
  };
  discovery: ProjectDiscoveryResult;
}

export type ProjectCliCommand =
  | 'validate'
  | 'module-list'
  | 'module-show'
  | 'template-sync'
  | 'template-update'
  | 'deploy-status';

export interface ProjectCliCommandRequest {
  command: ProjectCliCommand;
  cwd: string;
  moduleName?: string;
}

export interface ProjectCliCommandResult {
  args: string[];
  command: ProjectCliCommand;
  cwd: string;
  durationMs: number;
  exitCode: number | null;
  stderr: string;
  stdout: string;
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

export interface ProjectctlPresenceReport {
  label: string;
  path: string;
  present: boolean;
}

export interface ProjectctlCheckItem {
  command?: string;
  files?: string[];
  notes?: string[];
  path?: string;
  runtime?: string;
  status: string;
}

export interface ProjectctlProjectSettings {
  bundleId?: string;
  displayName: string;
  kind: string;
  modulePath?: string;
  name: string;
  port?: number;
  slug: string;
}

export interface ProjectctlEnvironmentConfig {
  default?: boolean;
  name: string;
  purpose: string;
}

export interface ProjectctlInspectResult {
  capabilities?: string[];
  features?: Record<string, ProjectctlCheckItem>;
  hasGoals: boolean;
  hasLock: boolean;
  hasProject: boolean;
  lock?: {
    addons?: Record<string, { status: string }>;
    capabilities?: string[];
    features?: Record<string, ProjectctlCheckItem>;
    migration?: {
      appliedMigrations?: string[];
      lastAppliedVersion?: string;
      notes?: string[];
    };
    platforms?: Record<string, ProjectctlCheckItem>;
    preset?: {
      name: string;
      version: string;
    };
    project?: {
      backend?: string;
      bundleId?: string;
      displayName: string;
      kind: string;
      modulePath?: string;
      slug: string;
    };
    template?: {
      generator: string;
      repository: string;
      version: string;
    };
  };
  markers: ProjectctlPresenceReport[];
  project?: {
    addons?: Record<string, { enabled: boolean }>;
    environments?: ProjectctlEnvironmentConfig[];
    preset?: {
      disabled?: string[];
      name: string;
      options?: Record<string, unknown>;
      version: string;
    };
    project: ProjectctlProjectSettings;
  };
  root: string;
  templateVersion: string;
}

export interface ProjectctlPlanOperation {
  kind: string;
  owner?: string;
  path: string;
  reason?: string;
}

export interface ProjectctlPlanResult {
  changes: boolean;
  conflictCount: number;
  counts: Record<string, number>;
  operations: ProjectctlPlanOperation[];
  root: string;
  summary: string;
  templateVersion: string;
}

export interface ProjectctlOverviewResult {
  available: boolean;
  error?: string;
  inspect?: ProjectctlInspectResult;
  preview?: ProjectctlPlanResult;
  status?: ProjectctlPlanResult;
  toolPath?: string;
}

export type ScopeDevboxAgent = 'codex' | 'gemini';
export type ScopeDevboxJobStatus = 'queued' | 'running' | 'passed' | 'failed' | 'rejected';

export interface ScopeDevboxJobRecord {
  agent: ScopeDevboxAgent;
  createdAt: string;
  exitCode?: number | null;
  id: string;
  logPath: string;
  machineId: string;
  machineName?: string;
  message?: string;
  model: string;
  repoPath: string;
  scopePath: string;
  status: ScopeDevboxJobStatus;
  task: string;
  updatedAt: string;
  writableFiles: string[];
}

export interface ScopeDevboxOverviewResult {
  defaultAgent: ScopeDevboxAgent;
  defaultModel: string;
  devboxRepo: {
    exists: boolean;
    path: string;
  };
  jobs: ScopeDevboxJobRecord[];
}

export interface ScopeDevboxStartRequest {
  agent: ScopeDevboxAgent;
  machineId: string;
  model: string;
  repoPath: string;
  task: string;
  writableFiles: string[];
}

export interface ProjectSpaceBackend {
  getAppMeta(): Promise<AppMeta>;
  getCodexStatus(): Promise<CodexStatusResult>;
  getConnectorOverview(): Promise<ConnectorOverviewResult>;
  getConnectorProjectRegistry(): Promise<ConnectorProjectRegistryResult>;
  runProjectCliCommand(request: ProjectCliCommandRequest): Promise<ProjectCliCommandResult>;
  getGitHubCatalog(): Promise<GitHubCatalogResult>;
  getGitDiff(request: GitDiffRequest): Promise<GitDiffResult>;
  getGitStatus(cwd: string): Promise<GitStatusResult>;
  getPlatformOverview(): Promise<PlatformOverviewResult>;
  loadLauncherAppIcon(appId: string): Promise<string | undefined>;
  loadLauncherApps(): Promise<LauncherAppRecord[]>;
  loadProjectDiscovery(): Promise<ProjectDiscoveryResult>;
  loadProjectctlOverview(projectPath: string): Promise<ProjectctlOverviewResult>;
  loadProjectctlPreview(projectPath: string): Promise<ProjectctlPlanResult>;
  loadProjectsState(): Promise<ProjectsState>;
  loadProjectWorktrees(projectPath: string): Promise<ProjectWorktreeRecord[]>;
  openCodexSkills(): Promise<OpenPathInAppResult>;
  openCodexTarget(request: CodexOpenRequest): Promise<OpenPathInAppResult>;
  openPathInApp(request: OpenPathInAppRequest): Promise<OpenPathInAppResult>;
  readDirectory(path: string): Promise<FileSystemEntry[]>;
  runTerminalCommand(request: TerminalCommandRequest): Promise<TerminalCommandResult>;
  saveProjectsState(state: ProjectsState): Promise<void>;
  selectProjectDirectory(): Promise<ProjectDirectorySelection>;
  startGitHubOAuthDeviceFlow(): Promise<GitHubOAuthDeviceStartResult>;
  pollGitHubOAuthDeviceFlow(
    request: GitHubOAuthDevicePollRequest
  ): Promise<GitHubOAuthDevicePollResult>;
  getScopeDevboxOverview(): Promise<ScopeDevboxOverviewResult>;
  startScopeDevboxJob(request: ScopeDevboxStartRequest): Promise<ScopeDevboxJobRecord>;
  stageGitPaths(request: GitStageRequest): Promise<GitActionResult>;
  deployProject(request: ProjectDeployRequest): Promise<GitActionResult>;
  backupProject(request: ProjectBackupRequest): Promise<GitActionResult>;
  unstageGitPaths(request: GitStageRequest): Promise<GitActionResult>;
  commitGitChanges(request: GitCommitRequest): Promise<GitActionResult>;
  openWorkspaceTool(request: ToolLaunchRequest): Promise<ToolLaunchResult>;
}
