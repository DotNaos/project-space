export type * from './dev-server-api';
export type * from './worktree-action-api';
export type * from './connector-runtime-api';
export type * from './roadmap-api';
export type * from './project-catalog-api';

import type {
  ConnectorRuntimeRecord,
  ConnectorRuntimeUpdateRecord,
  MachineRuntimeOperationRequest,
  MachineRuntimeOperationResult,
  MachineRuntimeStopResult,
  MachineRuntimeStatusResult
} from './connector-runtime-api';
import type {
  RoadmapDependencyMutationRequest,
  RoadmapPlanUpdateRequest,
  RoadmapResult
} from './roadmap-api';
import type { CodexDaemonEvidence } from './codex-daemon-api';

export type WorkspaceTool = 'ide' | 'terminal' | 'git' | 'dev-server';

export interface AppMeta {
  name: string;
  version: string;
  platform: string;
  buildTime?: string;
  commit?: string;
  commitShort?: string;
  environment?: string;
  nodeVersion?: string;
  ref?: string;
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

export type FullstackTemplateStatus =
  'implemented' | 'partial' | 'not-detected' | 'template-source';

export interface FullstackTemplateCheck {
  matched: string[];
  missing: string[];
  score: number;
  status: FullstackTemplateStatus;
}

export interface ProjectSpaceRecord {
  id: string;
  machineId?: string;
  name: string;
  rootPath: string;
  kind: 'workspace' | 'standalone' | 'github';
  groupId?: string;
  projectctl?: ProjectctlDiscoverySummary;
  fullstackTemplate?: FullstackTemplateCheck;
  gitStatus?: ProjectGitStatusSummary;
  github?: GitHubCatalogRepository;
}

export interface ProjectGitStatusSummary {
  branchName: string;
  changed: number;
  hasUnstagedChanges: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
}

export type ProjectStructureViolationType =
  | 'git_repo_missing_github_remote'
  | 'nested_project_checkout'
  | 'root_stray_file'
  | 'root_stray_folder'
  | 'worktrees_stray_file'
  | 'worktrees_missing_project_layer'
  | 'orphan_worktree_container'
  | 'worktree_project_stray_file'
  | 'worktree_stray_folder';

export interface ProjectStructureViolationRecord {
  id: string;
  type: ProjectStructureViolationType;
  severity: 'warning' | 'error';
  path: string;
  relativePath: string;
  name: string;
  title: string;
  detail: string;
  machineId?: string;
  projectName?: string;
}

export type ProjectStructureActionType =
  'move_to_poc' | 'move_to_trash' | 'initialize_git' | 'keep_local_only';

export interface ProjectStructureActionRequest {
  action: ProjectStructureActionType;
  path: string;
  type: ProjectStructureViolationType;
}

export interface ProjectStructureActionResult {
  message: string;
  status: 'success' | 'error';
  trashPath?: string;
}

export interface ProjectTrashEntryRecord {
  id: string;
  itemPath: string;
  name: string;
  originalPath: string;
  originalRelativePath: string;
  reason: ProjectStructureViolationType;
  trashPath: string;
  trashedAt: string;
}

export interface ProjectTrashListResult {
  entries: ProjectTrashEntryRecord[];
  trashPath: string;
}

export interface ProjectTrashRestoreRequest {
  trashPath: string;
}

export interface ProjectTrashRestoreResult {
  message: string;
  restoredPath?: string;
  status: 'success' | 'error';
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
  structureViolations: ProjectStructureViolationRecord[];
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
  pinnedProjectIds: string[];
  recentProjectIds: string[];
  selectedExplorerTarget: ExplorerTarget;
  selectedLauncherAppId: string;
  selectedProjectId: string;
}

export interface ProjectWorktreeRecord {
  id: string;
  name: string;
  path: string;
  branchName?: string;
  detached: boolean;
  headCommittedAt?: string;
  headSha?: string;
  isBase: boolean;
  kind: 'project-managed' | 'codex' | 'external';
  locked: boolean;
  lockedReason?: string;
  prunable: boolean;
  prunableReason?: string;
  status: 'ready' | 'locked' | 'prunable' | 'missing' | 'broken' | 'unavailable';
  statusReason?: string;
}

export interface ProjectWorktreeDiscoveryEvidence {
  checkedAt: string;
  projectPath: string;
  source: 'git-worktree-list';
}

export type ProjectWorktreeDiscoveryResult =
  | {
      evidence: ProjectWorktreeDiscoveryEvidence;
      state: 'ready';
      worktrees: [ProjectWorktreeRecord, ...ProjectWorktreeRecord[]];
    }
  | {
      evidence: ProjectWorktreeDiscoveryEvidence;
      state: 'proven-empty';
      worktrees: [];
    }
  | {
      checkedAt: string;
      message: string;
      reason:
        | 'connector-update-required'
        | 'project-mismatch'
        | 'request-failed'
        | 'scan-failed'
        | 'source-disagreement';
      state: 'blocked';
    };

export type ProjectWorktreeDiscoveryState =
  | { state: 'checking' }
  | ProjectWorktreeDiscoveryResult;

export interface FileSystemEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  isProject?: boolean;
  modifiedAt?: string;
  sizeBytes?: number;
}

export type MachineFileSystemErrorCode =
  | 'disconnected'
  | 'failed'
  | 'not-found'
  | 'outside-home'
  | 'permission-denied'
  | 'too-large'
  | 'unsupported';

export interface MachineFileSystemRequest {
  machineId: string;
}

export interface MachineFileSystemDirectoryRequest extends MachineFileSystemRequest {
  path: string;
}

export interface MachineFileSystemFileRequest extends MachineFileSystemRequest {
  path: string;
}

export interface MachineDirectoryCreateRequest extends MachineFileSystemRequest {
  name: string;
  parentPath: string;
}

export interface MachineDirectoryRenameRequest extends MachineFileSystemRequest {
  name: string;
  path: string;
}

export interface MachineDirectoryDeleteRequest extends MachineFileSystemRequest {
  paths: string[];
}

export type MachineDirectoryMutationErrorCode =
  | MachineFileSystemErrorCode
  | 'already-exists'
  | 'invalid-name'
  | 'not-directory'
  | 'protected'
  | 'symlink';

export interface MachineDirectoryMutationResult {
  affectedPaths: string[];
  errorCode?: MachineDirectoryMutationErrorCode;
  message?: string;
  status: 'success' | 'error';
}

export interface MachineFileSystemRootResult {
  defaultPath: string;
  homePath: string;
  message?: string;
  errorCode?: MachineFileSystemErrorCode;
  status: 'success' | 'error';
}

export interface MachineFileSystemDirectoryResult {
  entries: FileSystemEntry[];
  path: string;
  message?: string;
  errorCode?: MachineFileSystemErrorCode;
  status: 'success' | 'error';
}

export interface MachineFileSystemFileResult {
  content?: string;
  modifiedAt?: string;
  name: string;
  path: string;
  sizeBytes?: number;
  truncated?: boolean;
  message?: string;
  errorCode?: MachineFileSystemErrorCode;
  status: 'success' | 'error';
}

export interface MachineProjectWorktreesRequest {
  machineId: string;
  projectPath: string;
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

export interface MachineTerminalCommandRequest {
  command: string;
  machineId: string;
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
  /** When set, returns the patch introduced by this commit instead of working-tree changes. */
  commit?: string;
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

export interface ProjectSpaceAuthUser {
  email?: string;
  id?: string;
  login: string;
  role: 'user';
}

export interface ProjectSpaceAuthSessionResult {
  authenticated: boolean;
  authRequired: boolean;
  expiresAt?: string;
  message?: string;
  user?: ProjectSpaceAuthUser;
}

export interface ProjectSpaceAuthDeviceStartResult {
  deviceCode?: string;
  expiresAt?: string;
  intervalSeconds?: number;
  message?: string;
  status: 'pending' | 'not-configured' | 'error';
  userCode?: string;
  verificationUri?: string;
}

export interface ProjectSpaceAuthDevicePollRequest {
  deviceCode: string;
}

export interface ProjectSpaceAuthDevicePollResult {
  expiresAt?: string;
  intervalSeconds?: number;
  message?: string;
  sessionToken?: string;
  status: 'pending' | 'connected' | 'expired' | 'denied' | 'error';
  user?: ProjectSpaceAuthUser;
}

export type GitHubAuthSource = 'stored-oauth' | 'environment';
export type GitHubCatalogStatus =
  'connected' | 'auth-required' | 'unauthorized' | 'not-configured' | 'rate-limited' | 'error';
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

export interface GitHubBranchRecord {
  commitSha?: string;
  isDefault: boolean;
  linkedIssueNumbers?: number[];
  name: string;
  url?: string;
}

export interface GitHubPullRequestRecord {
  headBranch?: string;
  headSha?: string;
  linkedIssueNumbers?: number[];
  mergeCommitHash?: string;
  number: number;
  state: 'open' | 'closed' | 'merged';
  title: string;
  updatedAt?: string;
  url: string;
}

export interface GitHubIssueRecord {
  author?: string;
  body?: string;
  id?: number;
  labels: string[];
  number: number;
  state: 'open' | 'closed';
  title: string;
  updatedAt?: string;
  url: string;
}

export interface GitHubIssueCommentRecord {
  author?: string;
  body: string;
  createdAt?: string;
  id: number;
  updatedAt?: string;
  url: string;
}

export interface GitHubIssueCreateRequest {
  body?: string;
  fullName: string;
  labels?: string[];
  operationId: string;
  title: string;
}

export type GitHubIssueCreationState = 'complete' | 'retryable' | 'uncertain';

export interface GitHubIssueUpdateRequest {
  body?: string;
  fullName: string;
  labels?: string[];
  number: number;
  state?: 'open' | 'closed';
  title?: string;
}

export interface GitHubIssueMutationResult {
  issue?: GitHubIssueRecord;
  message?: string;
  status: GitHubCatalogStatus;
}

export interface GitHubIssueCreationResult extends GitHubIssueMutationResult {
  creationState: GitHubIssueCreationState;
  replayed?: boolean;
}

export interface GitHubIssueCommentsResult {
  comments: GitHubIssueCommentRecord[];
  message?: string;
  status: GitHubCatalogStatus;
}

export interface GitHubIssueCommentCreateRequest {
  body: string;
  fullName: string;
  number: number;
}

export interface GitHubIssueCommentMutationResult {
  comment?: GitHubIssueCommentRecord;
  message?: string;
  status: GitHubCatalogStatus;
}

export interface GitHubBranchCreateRequest {
  fullName: string;
  issueNumber?: number;
  name: string;
  sourceBranch?: string;
}

export interface GitHubBranchDeleteRequest {
  fullName: string;
  name: string;
}

export interface GitHubBranchMutationResult {
  branch?: GitHubBranchRecord;
  message?: string;
  status: GitHubCatalogStatus;
}

export interface GitHubPullRequestCreateRequest {
  baseBranch: string;
  body?: string;
  fullName: string;
  headBranch: string;
  issueNumber?: number;
  title: string;
}

export interface GitHubPullRequestMutationResult {
  message?: string;
  pullRequest?: GitHubPullRequestRecord;
  status: GitHubCatalogStatus;
}

export interface GitHubRepositoryDetailsResult {
  branches: GitHubBranchRecord[];
  checkedAt: string;
  issues: GitHubIssueRecord[];
  message?: string;
  pullRequests: GitHubPullRequestRecord[];
  status: GitHubCatalogStatus;
}

export type GitHubWorkflowRunConclusion =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'action_required'
  | 'neutral'
  | 'stale';

export type GitHubWorkflowRunKind = 'deployment' | 'ci' | 'release' | 'other';
export type GitHubWorkflowRunStatus =
  'queued' | 'in_progress' | 'completed' | 'waiting' | 'pending' | 'requested' | 'unknown';

export interface GitHubWorkflowRunSummary {
  actor?: string;
  attempt?: number;
  branch?: string;
  conclusion?: GitHubWorkflowRunConclusion;
  createdAt?: string;
  displayTitle?: string;
  event?: string;
  headSha?: string;
  id: number;
  kind: GitHubWorkflowRunKind;
  name?: string;
  runNumber?: number;
  runStartedAt?: string;
  status: GitHubWorkflowRunStatus;
  updatedAt?: string;
  url?: string;
  workflowId?: number;
  workflowPath?: string;
}

export interface GitHubPipelineStatusResult {
  checkedAt: string;
  message?: string;
  pagination?: { hasNext: boolean; page: number; perPage: number };
  runs: GitHubWorkflowRunSummary[];
  status: GitHubCatalogStatus;
}

export interface GitHubWorkflowStep {
  completedAt?: string;
  conclusion?: GitHubWorkflowRunConclusion;
  durationMs?: number;
  name: string;
  number: number;
  startedAt?: string;
  status: GitHubWorkflowRunStatus;
}

export interface GitHubWorkflowJob {
  completedAt?: string;
  conclusion?: GitHubWorkflowRunConclusion;
  durationMs?: number;
  id: number;
  name: string;
  sequence: number;
  startedAt?: string;
  status: GitHubWorkflowRunStatus;
  steps: GitHubWorkflowStep[];
}

export interface GitHubWorkflowRunDetailResult {
  checkedAt: string;
  jobs: GitHubWorkflowJob[];
  message?: string;
  partial?: boolean;
  run?: GitHubWorkflowRunSummary;
  status: GitHubCatalogStatus;
}

export interface GitHubCatalogResult {
  auth?: {
    login?: string;
    source: GitHubAuthSource;
  };
  checkedAt: string;
  cache?: {
    lastUpdated?: string;
    state: 'miss' | 'fresh' | 'stale' | 'refreshing' | 'refresh-failed';
  };
  message?: string;
  repositories: GitHubCatalogRepository[];
  status: GitHubCatalogStatus;
  timings?: {
    authMs?: number;
    cacheReadMs?: number;
    githubMs?: number;
    normalizationMs?: number;
    tokenLookupMs?: number;
    totalMs?: number;
  };
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
  prompt?: string;
}

export interface CodexChatMessageRecord {
  id: string;
  role: 'assistant' | 'user';
  text: string;
}

export interface CodexChatRequest {
  cwd: string;
  machineId: string;
  messages: CodexChatMessageRecord[];
  model?: string;
  prompt: string;
  systemPrompt?: string;
}

export interface CodexChatResult {
  message?: string;
  response?: string;
  status: 'success' | 'error';
}

export type CodexChatStreamEvent =
  | { delta: string; type: 'delta' }
  | { response: string; type: 'done' }
  | { message: string; type: 'error' };

export interface CodexModelCatalogueRequest {
  cwd: string;
  machineId: string;
}

export interface CodexReasoningEffortOptionRecord {
  description: string;
  reasoningEffort: string;
}

export interface CodexModelServiceTierRecord {
  description: string;
  id: string;
  name: string;
}

export interface CodexModelRecord {
  defaultReasoningEffort?: string;
  defaultServiceTier?: string | null;
  description: string;
  displayName: string;
  id: string;
  isDefault: boolean;
  model: string;
  serviceTiers?: CodexModelServiceTierRecord[];
  supportedReasoningEfforts?: CodexReasoningEffortOptionRecord[];
}

export interface CodexModelCatalogueResult {
  message?: string;
  models: CodexModelRecord[];
  status: 'success' | 'error';
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

export type ConnectorEnvironmentKind = 'linux' | 'macos' | 'windows' | 'wsl';

export interface ConnectorEnvironmentRecord {
  kind: ConnectorEnvironmentKind;
  label?: string;
}

export interface MachineConnectorRecord {
  capabilities?: string[];
  daemon?: CodexDaemonEvidence;
  installCommand: string;
  lastSeen?: string;
  origin?: string;
  profile?: {
    channel: 'dev';
    source: 'source';
  };
  runtime?: ConnectorRuntimeRecord;
  serviceName?: string;
  status: ConnectorStatus;
  update?: ConnectorRuntimeUpdateRecord;
}

export interface MachineBatteryRecord {
  percentage: number;
  state?: 'charged' | 'charging' | 'discharging' | 'unknown';
}

export interface MachineRecord {
  id: string;
  kind: string;
  name: string;
  battery?: MachineBatteryRecord;
  os?: {
    codename?: string;
    family?: string;
    version?: string;
  };
  environment?: ConnectorEnvironmentRecord;
  executionScopeId?: string;
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

/**
 * Connector-backed APIs still use the historical MachineRecord wire shape.
 * Product-facing code should use this name when the record identifies one
 * connector installation rather than physical hardware.
 */
export type ConnectorInstallationRecord = MachineRecord;

export interface PhysicalMachineRecord {
  connectorIds: string[];
  id: string;
  name: string;
}

export interface PhysicalMachinesResult {
  machines: PhysicalMachineRecord[];
}

export interface PhysicalMachineSaveRequest {
  connectorIds: string[];
  id?: string;
  name: string;
}

export interface MachineExecutionScopeRecord {
  id: string;
  machineIds: string[];
  name: string;
}

export interface MachineExecutionScopesResult {
  scopes: MachineExecutionScopeRecord[];
}

export interface MachineExecutionScopeSaveRequest {
  id?: string;
  machineIds: string[];
  name: string;
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
  physicalMachines?: PhysicalMachineRecord[];
  machinesRepo: {
    exists: boolean;
    path: string;
  };
  tailscale: TailscaleStatusResult;
}

export interface ConnectorProjectRegistryResult {
  checkedAt: string;
  connector: {
    battery?: MachineBatteryRecord;
    capabilities?: string[];
    daemon?: CodexDaemonEvidence;
    environment?: ConnectorEnvironmentRecord;
    executionScopeId?: string;
    kind?: string;
    machineId: string;
    machineName: string;
    network?: MachineRecord['network'];
    origin?: string;
    primaryUser?: string;
    runtime?: ConnectorRuntimeRecord;
    serviceName?: string;
  };
  discovery: ProjectDiscoveryResult;
}

export type ProjectCliCommand =
  | 'validate'
  | 'template-init'
  | 'module-list'
  | 'module-show'
  | 'template-sync'
  | 'template-sync-apply'
  | 'template-update'
  | 'deploy-status'
  | 'deploy-dry-run';

export type ProjectDeployEnvironment = 'prod' | 'beta';

export interface ProjectCliCommandRequest {
  command: ProjectCliCommand;
  cwd: string;
  environment?: ProjectDeployEnvironment;
  machineId?: string;
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

export type TemplateAdherenceEntryStatus =
  'OK' | 'ADDED' | 'MISSING' | 'CHANGED' | 'WAIVED' | 'VIOLATION';

export interface TemplateAdherenceEntry {
  code?: string;
  kind: 'dir' | 'file';
  module?: string;
  note?: string;
  path: string;
  slot?: string;
  status: TemplateAdherenceEntryStatus;
}

export interface TemplateAdherenceDiagnostic {
  note?: string;
  path: string;
  status: TemplateAdherenceEntryStatus;
}

export interface TemplateAdherenceFile {
  code?: string;
  diagnostics?: TemplateAdherenceDiagnostic[];
  module?: string;
  note?: string;
  path: string;
  status: TemplateAdherenceEntryStatus;
}

export interface TemplateAdherenceSummary {
  added: number;
  changed: number;
  missing: number;
  ok: number;
  total: number;
  violation: number;
  waived: number;
}

export interface TemplateAdherenceRequest {
  cwd: string;
}

export interface TemplateAdherenceReport {
  checkedAt: string;
  cwd: string;
  durationMs: number;
  error?: string;
  files: TemplateAdherenceFile[];
  projectName?: string;
  status: 'error' | 'ok' | 'violations';
  structure: TemplateAdherenceEntry[];
  summary?: TemplateAdherenceSummary;
  templateLabel?: string;
}

export interface DeployCliEnvironmentReport {
  apiUrl?: string;
  branch?: string;
  composeProject?: string;
  environment: string;
  name: string;
  remotePath?: string;
  remoteRef?: string;
  remoteUrl?: string;
  status?: string;
  webUrl?: string;
}

export interface DeployCliStatusReport {
  environments: DeployCliEnvironmentReport[];
  host?: string;
  projectName?: string;
  projectRoot?: string;
}

export type DeployedEnvironmentVerification =
  'healthy' | 'unhealthy' | 'inconsistent' | 'unavailable';

export interface DeployedEnvironmentStatus {
  deployedSha?: string;
  displayName: string;
  id: string;
  githubUrl?: string;
  liveUrl?: string;
  liveUrlState: 'available' | 'not-configured' | 'withheld';
  sourceRef?: string;
  verification: DeployedEnvironmentVerification;
  verifiedAt?: string;
}

export interface DeployedEnvironmentStatusResult {
  checkedAt: string;
  environments: DeployedEnvironmentStatus[];
  repositoryFullName: string;
  status: 'available' | 'unauthorized' | 'unavailable';
}

export type PullRequestPreviewLifecycle =
  | 'queued'
  | 'validating'
  | 'building'
  | 'waiting-for-lock'
  | 'deploying'
  | 'verifying'
  | 'ready'
  | 'rejected'
  | 'superseded'
  | 'failed-initial'
  | 'update-failed'
  | 'cleanup-queued'
  | 'deleting'
  | 'cleanup-failed'
  | 'removed'
  | 'unknown';

export interface PullRequestPreviewStatus {
  currentHeadSha?: string;
  headBranch?: string;
  liveUrl?: string;
  liveUrlState: 'available' | 'not-configured' | 'withheld';
  pullRequestNumber: number;
  pullRequestState?: GitHubPullRequestRecord['state'];
  pullRequestTitle?: string;
  pullRequestUrl?: string;
  repositoryFullName: string;
  requestedSha?: string;
  runningSha?: string;
  state: PullRequestPreviewLifecycle;
  updatedAt?: string;
  verifiedAt?: string;
}

export interface PullRequestPreviewStatusResult {
  checkedAt: string;
  previews: PullRequestPreviewStatus[];
  repositoryFullName: string;
  status: 'available' | 'unauthorized' | 'unavailable';
}

export interface DeploymentRecordSummary {
  appSlug: string;
  createdAt?: string;
  environment: string;
  id: string;
  live?: {
    checkedAt: string;
    error?: string;
    latencyMs?: number;
    status: 'offline' | 'online' | 'unknown';
    statusCode?: number;
    url?: string;
  };
  revision?: string;
  routeHost?: string;
  routeKind?: DeploymentVisibility;
  runtimeDir?: string;
  sourceRef?: string;
  status: string;
  updatedAt?: string;
  version?: string;
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

export interface GitHistoryRequest {
  cwd?: string;
  limit?: number;
  ref?: string;
  repositoryFullName?: string;
}

export interface GitHubHistoryRequest {
  fullName: string;
  limit?: number;
  ref?: string;
}

export interface GitHistoryCommit {
  author: string;
  date: string;
  hash: string;
  parents: string[];
  refs: string[];
  subject: string;
}

export interface GitHistoryResult {
  commits: GitHistoryCommit[];
  cwd: string;
  isRepository: boolean;
  message?: string;
  repositoryRoot: string;
  stderr?: string;
}

export interface ProjectSpaceBackend {
  getAppMeta(): Promise<AppMeta>;
  getCodexStatus(): Promise<CodexStatusResult>;
  getConnectorOverview(): Promise<ConnectorOverviewResult>;
  getMachineRuntime(machineId: string): Promise<MachineRuntimeStatusResult>;
  startMachineRuntimeOperation(
    machineId: string,
    request: MachineRuntimeOperationRequest
  ): Promise<MachineRuntimeOperationResult>;
  stopMachineRuntime(machineId: string): Promise<MachineRuntimeStopResult>;
  getConnectorProjectRegistry(): Promise<ConnectorProjectRegistryResult>;
  getDeployedEnvironmentStatus(
    repositoryFullName: string
  ): Promise<DeployedEnvironmentStatusResult>;
  runProjectCliCommand(request: ProjectCliCommandRequest): Promise<ProjectCliCommandResult>;
  getTemplateAdherence(request: TemplateAdherenceRequest): Promise<TemplateAdherenceReport>;
  getGitHubCatalog(options?: { forceRefresh?: boolean }): Promise<GitHubCatalogResult>;
  getGitHubHistory(request: GitHubHistoryRequest): Promise<GitHistoryResult>;
  getGitHubPipelineStatus(
    fullName: string,
    options?: { page?: number; perPage?: number }
  ): Promise<GitHubPipelineStatusResult>;
  getGitHubWorkflowRunDetail(
    fullName: string,
    runId: number
  ): Promise<GitHubWorkflowRunDetailResult>;
  getGitDiff(request: GitDiffRequest): Promise<GitDiffResult>;
  getGitHistory(request: GitHistoryRequest): Promise<GitHistoryResult>;
  getGitStatus(cwd: string): Promise<GitStatusResult>;
  getPlatformOverview(): Promise<PlatformOverviewResult>;
  loadLauncherAppIcon(appId: string): Promise<string | undefined>;
  loadLauncherApps(): Promise<LauncherAppRecord[]>;
  loadProjectDiscovery(): Promise<ProjectDiscoveryResult>;
  applyProjectStructureAction(
    request: ProjectStructureActionRequest
  ): Promise<ProjectStructureActionResult>;
  listProjectTrash(): Promise<ProjectTrashListResult>;
  restoreProjectTrashEntry(request: ProjectTrashRestoreRequest): Promise<ProjectTrashRestoreResult>;
  loadProjectctlOverview(projectPath: string): Promise<ProjectctlOverviewResult>;
  loadProjectctlPreview(projectPath: string): Promise<ProjectctlPlanResult>;
  loadProjectsState(): Promise<ProjectsState>;
  loadProjectWorktrees(projectPath: string, machineId?: string): Promise<ProjectWorktreeRecord[]>;
  openCodexSkills(): Promise<OpenPathInAppResult>;
  openCodexTarget(request: CodexOpenRequest): Promise<OpenPathInAppResult>;
  getCodexModels(request: CodexModelCatalogueRequest): Promise<CodexModelCatalogueResult>;
  runCodexChat(request: CodexChatRequest): Promise<CodexChatResult>;
  streamCodexChat(
    request: CodexChatRequest,
    emit: (event: CodexChatStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<void>;
  openPathInApp(request: OpenPathInAppRequest): Promise<OpenPathInAppResult>;
  readDirectory(path: string): Promise<FileSystemEntry[]>;
  getMachineFileSystemRoot(request: MachineFileSystemRequest): Promise<MachineFileSystemRootResult>;
  readMachineDirectory(
    request: MachineFileSystemDirectoryRequest
  ): Promise<MachineFileSystemDirectoryResult>;
  readMachineFile(request: MachineFileSystemFileRequest): Promise<MachineFileSystemFileResult>;
  createMachineDirectory(
    request: MachineDirectoryCreateRequest
  ): Promise<MachineDirectoryMutationResult>;
  renameMachineDirectory(
    request: MachineDirectoryRenameRequest
  ): Promise<MachineDirectoryMutationResult>;
  deleteMachineDirectories(
    request: MachineDirectoryDeleteRequest
  ): Promise<MachineDirectoryMutationResult>;
  runTerminalCommand(request: TerminalCommandRequest): Promise<TerminalCommandResult>;
  runMachineTerminalCommand(request: MachineTerminalCommandRequest): Promise<TerminalCommandResult>;
  saveProjectsState(state: ProjectsState): Promise<void>;
  selectProjectDirectory(): Promise<ProjectDirectorySelection>;
  startGitHubOAuthDeviceFlow(): Promise<GitHubOAuthDeviceStartResult>;
  pollGitHubOAuthDeviceFlow(
    request: GitHubOAuthDevicePollRequest
  ): Promise<GitHubOAuthDevicePollResult>;
  getScopeDevboxOverview(): Promise<ScopeDevboxOverviewResult>;
  createGitHubBranch(request: GitHubBranchCreateRequest): Promise<GitHubBranchMutationResult>;
  deleteGitHubBranch(request: GitHubBranchDeleteRequest): Promise<GitHubBranchMutationResult>;
  createGitHubPullRequest(
    request: GitHubPullRequestCreateRequest
  ): Promise<GitHubPullRequestMutationResult>;
  createGitHubIssue(request: GitHubIssueCreateRequest): Promise<GitHubIssueCreationResult>;
  createGitHubIssueComment(
    request: GitHubIssueCommentCreateRequest
  ): Promise<GitHubIssueCommentMutationResult>;
  getGitHubIssueComments(fullName: string, number: number): Promise<GitHubIssueCommentsResult>;
  getGitHubRepositoryDetails(fullName: string): Promise<GitHubRepositoryDetailsResult>;
  getRoadmap(fullName: string): Promise<RoadmapResult>;
  updateRoadmapPlan(request: RoadmapPlanUpdateRequest): Promise<RoadmapResult>;
  addRoadmapDependency(request: RoadmapDependencyMutationRequest): Promise<RoadmapResult>;
  removeRoadmapDependency(request: RoadmapDependencyMutationRequest): Promise<RoadmapResult>;
  updateGitHubIssue(request: GitHubIssueUpdateRequest): Promise<GitHubIssueMutationResult>;
  startScopeDevboxJob(request: ScopeDevboxStartRequest): Promise<ScopeDevboxJobRecord>;
  stageGitPaths(request: GitStageRequest): Promise<GitActionResult>;
  deployProject(request: ProjectDeployRequest): Promise<GitActionResult>;
  backupProject(request: ProjectBackupRequest): Promise<GitActionResult>;
  unstageGitPaths(request: GitStageRequest): Promise<GitActionResult>;
  commitGitChanges(request: GitCommitRequest): Promise<GitActionResult>;
  openWorkspaceTool(request: ToolLaunchRequest): Promise<ToolLaunchResult>;
}
