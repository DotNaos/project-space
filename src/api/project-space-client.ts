import type {
  AppMeta,
  CodexChatRequest,
  CodexChatResult,
  CodexChatStreamEvent,
  CodexModelCatalogueRequest,
  CodexModelCatalogueResult,
  CodexOpenRequest,
  CodexStatusResult,
  ConnectorCredentialRecord,
  ConnectorInstallerResult,
  ConnectorOverviewResult,
  DevServerActionRequest,
  DevServerInspectRequest,
  DevServerOverviewResult,
  FileSystemEntry,
  GitActionResult,
  GitCommitRequest,
  GitDiffRequest,
  GitDiffResult,
  GitHistoryRequest,
  GitHistoryResult,
  GitHubCatalogResult,
  GitHubBranchCreateRequest,
  GitHubBranchDeleteRequest,
  GitHubHistoryRequest,
  GitHubBranchMutationResult,
  GitHubIssueCommentCreateRequest,
  GitHubIssueCommentMutationResult,
  GitHubIssueCommentsResult,
  GitHubIssueCreateRequest,
  GitHubIssueMutationResult,
  GitHubIssueUpdateRequest,
  GitHubPullRequestCreateRequest,
  GitHubPullRequestMutationResult,
  GitHubRepositoryDetailsResult,
  GitHubOAuthDevicePollRequest,
  GitHubOAuthDevicePollResult,
  GitHubOAuthDeviceStartResult,
  GitHubPipelineStatusResult,
  GitStageRequest,
  GitStatusResult,
  LauncherAppRecord,
  MachineFileSystemDirectoryRequest,
  MachineFileSystemDirectoryResult,
  MachineFileSystemFileRequest,
  MachineFileSystemFileResult,
  MachineFileSystemRequest,
  MachineFileSystemRootResult,
  MachineDirectoryCreateRequest,
  MachineDirectoryDeleteRequest,
  MachineDirectoryMutationResult,
  MachineDirectoryRenameRequest,
  MachineTerminalCommandRequest,
  OpenPathInAppRequest,
  OpenPathInAppResult,
  PlatformOverviewResult,
  ProjectSpaceAuthSessionResult,
  ProjectBackupRequest,
  ConnectorProjectRegistryResult,
  ProjectCliCommandRequest,
  ProjectCliCommandResult,
  ProjectDeployRequest,
  ProjectDirectorySelection,
  ProjectDiscoveryResult,
  ProjectSpaceBackend,
  ProjectStructureActionRequest,
  ProjectStructureActionResult,
  ProjectTrashListResult,
  ProjectTrashRestoreRequest,
  ProjectTrashRestoreResult,
  ProjectctlOverviewResult,
  ProjectctlPlanResult,
  ProjectRunSettingsRecord,
  ProjectRunSettingsUpdateRequest,
  ProjectsState,
  ProjectWorktreeDiscoveryResult,
  ProjectWorktreeRecord,
  WorktreeMaterializeRequest,
  WorktreeMaterializeResult,
  WorktreeSetupInspectRequest,
  WorktreeSetupResult,
  WorktreeSetupRunRequest,
  ScopeDevboxOverviewResult,
  ScopeDevboxStartRequest,
  ScopeDevboxJobRecord,
  TemplateAdherenceReport,
  TemplateAdherenceRequest,
  TerminalCommandRequest,
  TerminalCommandResult,
  ToolLaunchRequest,
  ToolLaunchResult
} from '@/shared/project-space-api';

const authTokenStorageKey = 'project-space.session-token';
let projectSpaceAuthToken = '';
let projectSpaceAuthTokenProvider: (() => Promise<string | null>) | null = null;
const githubRepositoryDetailsRequests = new Map<string, Promise<GitHubRepositoryDetailsResult>>();

export function getProjectSpaceAuthToken() {
  return projectSpaceAuthToken;
}

export function setProjectSpaceAuthTokenProvider(provider: (() => Promise<string | null>) | null) {
  projectSpaceAuthTokenProvider = provider;

  if (!provider) {
    projectSpaceAuthToken = '';
  }
}

export function setProjectSpaceAuthToken(token: string) {
  projectSpaceAuthToken = token;

  if (typeof window === 'undefined') {
    return;
  }

  if (token) {
    window.localStorage.setItem(authTokenStorageKey, token);
    return;
  }

  window.localStorage.removeItem(authTokenStorageKey);
}

export async function refreshProjectSpaceAuthToken() {
  if (!projectSpaceAuthTokenProvider) {
    return projectSpaceAuthToken;
  }

  projectSpaceAuthToken = (await projectSpaceAuthTokenProvider()) ?? '';
  return projectSpaceAuthToken;
}

const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
function isLoopbackUrl(url: URL) {
  return (
    ['http:', 'https:'].includes(url.protocol) && loopbackHosts.has(url.hostname.toLowerCase())
  );
}

function isPlainLoopbackOrigin(url: URL) {
  return (
    isLoopbackUrl(url) &&
    !url.username &&
    !url.password &&
    url.pathname === '/' &&
    !url.search &&
    !url.hash
  );
}
export function resolveProjectSpaceApiBaseUrl(currentHref: string, explicit?: string | null) {
  try {
    const current = new URL(currentHref);
    if (!isLoopbackUrl(current)) return '';

    for (const value of [current.searchParams.get('projectSpaceApi'), explicit]) {
      if (!value) continue;
      try {
        const candidate = new URL(value);
        if (isPlainLoopbackOrigin(candidate)) {
          return candidate.origin === current.origin ? '' : candidate.origin;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return '';
  }
  return '';
}

export function isProjectSpaceApiRequestAllowed(currentHref: string, requestHref: string) {
  try {
    const current = new URL(currentHref);
    const request = new URL(requestHref, current);
    return (
      ['http:', 'https:'].includes(request.protocol) &&
      !request.username &&
      !request.password &&
      (request.origin === current.origin || (isLoopbackUrl(current) && isLoopbackUrl(request)))
    );
  } catch {
    return false;
  }
}

function resolveApiBaseUrl() {
  return typeof window === 'undefined'
    ? ''
    : resolveProjectSpaceApiBaseUrl(
        window.location.href,
        import.meta.env.VITE_PROJECT_SPACE_API_BASE_URL
      );
}

function resolveApiRequestUrl(baseUrl: string, path: string) {
  if (typeof window === 'undefined') throw new Error('API requests require a browser window.');
  const requestUrl = new URL(`${baseUrl}${path}`, window.location.href);
  if (!isProjectSpaceApiRequestAllowed(window.location.href, requestUrl.toString())) {
    throw new Error('Project Space refused an API request to an untrusted origin.');
  }
  return requestUrl.toString();
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => undefined)) as
    { error?: string } | T | undefined;

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload && payload.error
        ? payload.error
        : `Request failed with ${response.status}.`;

    throw new Error(message);
  }

  return payload as T;
}

class HttpProjectSpaceClient implements ProjectSpaceBackend {
  private readonly baseUrl = resolveApiBaseUrl();

  private async request<T>(path: string, init?: RequestInit) {
    const requestUrl = resolveApiRequestUrl(this.baseUrl, path);
    const token = await refreshProjectSpaceAuthToken();

    return fetch(requestUrl, {
      ...init,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers
      },
      redirect: 'error'
    }).then((response) => readJsonResponse<T>(response));
  }

  getAppMeta(): Promise<AppMeta> {
    return this.request('/api/app/meta');
  }

  getAuthSession(): Promise<ProjectSpaceAuthSessionResult> {
    return this.request('/api/auth/session');
  }

  async logout(): Promise<void> {
    await this.request('/api/auth/logout', {
      method: 'POST'
    }).catch(() => undefined);
    setProjectSpaceAuthToken('');
  }

  getCodexStatus(): Promise<CodexStatusResult> {
    return this.request('/api/codex/status');
  }

  getConnectorOverview(): Promise<ConnectorOverviewResult> {
    return this.request('/api/connectors/overview');
  }

  getConnectorProjectRegistry(): Promise<ConnectorProjectRegistryResult> {
    return this.request('/api/connectors/project-registry');
  }

  getDeployedEnvironmentStatus(repositoryFullName: string) {
    return this.request<import('@/shared/project-space-api').DeployedEnvironmentStatusResult>(
      `/api/deployed-environments/status?repositoryFullName=${encodeURIComponent(repositoryFullName)}`
    );
  }

  getConnectorInstallCommand(): Promise<ConnectorInstallerResult> {
    return this.request('/api/connectors/install-command', { method: 'POST' });
  }

  listConnectorCredentials(): Promise<{
    credentials: ConnectorCredentialRecord[];
  }> {
    return this.request('/api/connectors/credentials');
  }

  revokeConnectorCredential(credentialId: string): Promise<{ revoked: boolean }> {
    return this.request(`/api/connectors/credentials/${encodeURIComponent(credentialId)}`, {
      method: 'DELETE'
    });
  }

  runProjectCliCommand(request: ProjectCliCommandRequest): Promise<ProjectCliCommandResult> {
    return this.request('/api/project-cli/run', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  getTemplateAdherence(request: TemplateAdherenceRequest): Promise<TemplateAdherenceReport> {
    return this.request('/api/template/adherence', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  getGitHubCatalog(options: { forceRefresh?: boolean } = {}): Promise<GitHubCatalogResult> {
    return this.request(`/api/github/catalog${options.forceRefresh ? '?refresh=1' : ''}`);
  }

  createGitHubIssue(request: GitHubIssueCreateRequest): Promise<GitHubIssueMutationResult> {
    return this.request('/api/github/issues', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  createGitHubBranch(request: GitHubBranchCreateRequest): Promise<GitHubBranchMutationResult> {
    return this.request('/api/github/branches', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  deleteGitHubBranch(request: GitHubBranchDeleteRequest): Promise<GitHubBranchMutationResult> {
    return this.request('/api/github/branches', {
      body: JSON.stringify(request),
      method: 'DELETE'
    });
  }

  createGitHubPullRequest(
    request: GitHubPullRequestCreateRequest
  ): Promise<GitHubPullRequestMutationResult> {
    return this.request('/api/github/pull-requests', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  createGitHubIssueComment(
    request: GitHubIssueCommentCreateRequest
  ): Promise<GitHubIssueCommentMutationResult> {
    return this.request('/api/github/issue-comments', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  getGitHubIssueComments(fullName: string, number: number): Promise<GitHubIssueCommentsResult> {
    const query = new URLSearchParams({ fullName, number: String(number) });

    return this.request(`/api/github/issue-comments?${query.toString()}`);
  }

  getGitHubPipelineStatus(
    fullName: string,
    options: { page?: number; perPage?: number } = {}
  ): Promise<GitHubPipelineStatusResult> {
    const query = new URLSearchParams({ fullName });
    if (options.page) query.set('page', String(options.page));
    if (options.perPage) query.set('perPage', String(options.perPage));

    return this.request(`/api/github/pipeline?${query.toString()}`);
  }

  getGitHubWorkflowRunDetail(
    fullName: string,
    runId: number
  ): Promise<import('@/shared/project-space-api').GitHubWorkflowRunDetailResult> {
    const query = new URLSearchParams({ fullName });
    return this.request(`/api/github/workflow-runs/${runId}?${query.toString()}`);
  }

  getGitHubRepositoryDetails(fullName: string): Promise<GitHubRepositoryDetailsResult> {
    const query = new URLSearchParams({ fullName });
    const cacheKey = query.toString();
    const activeRequest = githubRepositoryDetailsRequests.get(cacheKey);

    if (activeRequest) {
      return activeRequest;
    }

    const request = this.request<GitHubRepositoryDetailsResult>(
      `/api/github/repository-details?${cacheKey}`
    ).finally(() => {
      githubRepositoryDetailsRequests.delete(cacheKey);
    });

    githubRepositoryDetailsRequests.set(cacheKey, request);
    return request;
  }

  updateGitHubIssue(request: GitHubIssueUpdateRequest): Promise<GitHubIssueMutationResult> {
    return this.request('/api/github/issues', {
      body: JSON.stringify(request),
      method: 'PATCH'
    });
  }

  getGitDiff(request: GitDiffRequest): Promise<GitDiffResult> {
    return this.request('/api/git/diff', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  getGitHistory(request: GitHistoryRequest): Promise<GitHistoryResult> {
    return this.request('/api/git/history', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  getGitHubHistory(request: GitHubHistoryRequest): Promise<GitHistoryResult> {
    return this.request('/api/github/history', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  getGitStatus(cwd: string): Promise<GitStatusResult> {
    const query = new URLSearchParams({ cwd });

    return this.request(`/api/git/status?${query.toString()}`);
  }

  getPlatformOverview(): Promise<PlatformOverviewResult> {
    return this.request('/api/platform/overview');
  }

  loadLauncherAppIcon(appId: string): Promise<string | undefined> {
    return this.request<{ iconDataUrl?: string }>(
      `/api/launcher/apps/${encodeURIComponent(appId)}/icon`
    ).then((payload) => payload.iconDataUrl);
  }

  loadLauncherApps(): Promise<LauncherAppRecord[]> {
    return this.request('/api/launcher/apps');
  }

  loadProjectDiscovery(): Promise<ProjectDiscoveryResult> {
    return this.request('/api/projects/discovery');
  }

  applyProjectStructureAction(
    request: ProjectStructureActionRequest
  ): Promise<ProjectStructureActionResult> {
    return this.request('/api/projects/structure-actions', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  listProjectTrash(): Promise<ProjectTrashListResult> {
    return this.request('/api/projects/trash');
  }

  restoreProjectTrashEntry(
    request: ProjectTrashRestoreRequest
  ): Promise<ProjectTrashRestoreResult> {
    return this.request('/api/projects/trash/restore', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  loadProjectctlOverview(projectPath: string): Promise<ProjectctlOverviewResult> {
    const query = new URLSearchParams({ projectPath });

    return this.request(`/api/projectctl/overview?${query.toString()}`);
  }

  loadProjectctlPreview(projectPath: string): Promise<ProjectctlPlanResult> {
    const query = new URLSearchParams({ projectPath });

    return this.request(`/api/projectctl/preview?${query.toString()}`);
  }

  loadProjectsState(): Promise<ProjectsState> {
    return this.request('/api/projects/state');
  }

  discoverProjectWorktrees(
    projectId: string,
    machineId?: string
  ): Promise<ProjectWorktreeDiscoveryResult> {
    const query = new URLSearchParams({ projectId });
    if (machineId) {
      query.set('machineId', machineId);
    }

    return this.request(`/api/projects/worktrees?${query.toString()}`);
  }

  async loadProjectWorktrees(
    projectId: string,
    machineId?: string
  ): Promise<ProjectWorktreeRecord[]> {
    const discovery = await this.discoverProjectWorktrees(projectId, machineId);
    if (discovery.state === 'ready') return discovery.worktrees;
    if (discovery.state === 'proven-empty') return [];
    throw new Error(discovery.message);
  }

  materializeWorktree(request: WorktreeMaterializeRequest): Promise<WorktreeMaterializeResult> {
    return this.request('/api/worktrees/materialize', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  inspectWorktreeSetup(request: WorktreeSetupInspectRequest): Promise<WorktreeSetupResult> {
    return this.request('/api/worktrees/setup/inspect', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  runWorktreeSetup(request: WorktreeSetupRunRequest): Promise<WorktreeSetupResult> {
    return this.request('/api/worktrees/setup/run', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  inspectDevServers(request: DevServerInspectRequest): Promise<DevServerOverviewResult> {
    return this.request('/api/dev-servers/inspect', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  startDevServer(request: DevServerActionRequest): Promise<DevServerOverviewResult> {
    return this.request('/api/dev-servers/start', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  stopDevServer(request: DevServerActionRequest): Promise<DevServerOverviewResult> {
    return this.request('/api/dev-servers/stop', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  updateProjectRunSettings(
    request: ProjectRunSettingsUpdateRequest
  ): Promise<ProjectRunSettingsRecord> {
    return this.request('/api/dev-servers/settings', {
      body: JSON.stringify(request),
      method: 'PUT'
    });
  }

  openCodexSkills(): Promise<OpenPathInAppResult> {
    return this.request('/api/codex/open-skills', {
      method: 'POST'
    });
  }

  openCodexTarget(request: CodexOpenRequest): Promise<OpenPathInAppResult> {
    return this.request('/api/codex/open-target', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  getCodexModels(request: CodexModelCatalogueRequest): Promise<CodexModelCatalogueResult> {
    return this.request('/api/codex/models', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  runCodexChat(request: CodexChatRequest): Promise<CodexChatResult> {
    return this.request('/api/codex/chat', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  streamCodexChat(
    request: CodexChatRequest,
    emit: (event: CodexChatStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    return streamCodexChat(request, emit, signal);
  }

  openPathInApp(request: OpenPathInAppRequest): Promise<OpenPathInAppResult> {
    return this.request('/api/launcher/open-path', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  readDirectory(path: string): Promise<FileSystemEntry[]> {
    const query = new URLSearchParams({ path });

    return this.request(`/api/filesystem/directory?${query.toString()}`);
  }

  getMachineFileSystemRoot(
    request: MachineFileSystemRequest
  ): Promise<MachineFileSystemRootResult> {
    return this.request('/api/machines/filesystem/root', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  readMachineDirectory(
    request: MachineFileSystemDirectoryRequest
  ): Promise<MachineFileSystemDirectoryResult> {
    return this.request('/api/machines/filesystem/directory', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  readMachineFile(request: MachineFileSystemFileRequest): Promise<MachineFileSystemFileResult> {
    return this.request('/api/machines/filesystem/file', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  createMachineDirectory(
    request: MachineDirectoryCreateRequest
  ): Promise<MachineDirectoryMutationResult> {
    return this.request('/api/machines/filesystem/folders/create', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  renameMachineDirectory(
    request: MachineDirectoryRenameRequest
  ): Promise<MachineDirectoryMutationResult> {
    return this.request('/api/machines/filesystem/folders/rename', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  deleteMachineDirectories(
    request: MachineDirectoryDeleteRequest
  ): Promise<MachineDirectoryMutationResult> {
    return this.request('/api/machines/filesystem/folders/delete', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  runTerminalCommand(request: TerminalCommandRequest): Promise<TerminalCommandResult> {
    return this.request('/api/terminal/run', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  runMachineTerminalCommand(
    request: MachineTerminalCommandRequest
  ): Promise<TerminalCommandResult> {
    return this.request('/api/machines/terminal/run', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  getScopeDevboxOverview(): Promise<ScopeDevboxOverviewResult> {
    return this.request('/api/scope-devbox/overview');
  }

  startScopeDevboxJob(request: ScopeDevboxStartRequest): Promise<ScopeDevboxJobRecord> {
    return this.request('/api/scope-devbox/jobs', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  saveProjectsState(state: ProjectsState): Promise<void> {
    return this.request('/api/projects/state', {
      body: JSON.stringify(state),
      method: 'PUT'
    });
  }

  selectProjectDirectory(): Promise<ProjectDirectorySelection> {
    return this.request('/api/projects/select-directory', {
      method: 'POST'
    });
  }

  startGitHubOAuthDeviceFlow(): Promise<GitHubOAuthDeviceStartResult> {
    return this.request('/api/github/oauth/device/start', {
      method: 'POST'
    });
  }

  pollGitHubOAuthDeviceFlow(
    request: GitHubOAuthDevicePollRequest
  ): Promise<GitHubOAuthDevicePollResult> {
    return this.request('/api/github/oauth/device/poll', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  stageGitPaths(request: GitStageRequest): Promise<GitActionResult> {
    return this.request('/api/git/stage', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  deployProject(request: ProjectDeployRequest): Promise<GitActionResult> {
    return this.request('/api/platform/deploy-project', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  backupProject(request: ProjectBackupRequest): Promise<GitActionResult> {
    return this.request('/api/platform/backup-project', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  unstageGitPaths(request: GitStageRequest): Promise<GitActionResult> {
    return this.request('/api/git/unstage', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  commitGitChanges(request: GitCommitRequest): Promise<GitActionResult> {
    return this.request('/api/git/commit', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  openWorkspaceTool(request: ToolLaunchRequest): Promise<ToolLaunchResult> {
    return this.request('/api/workspace-tool/open', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }
}

export const projectSpaceClient = new HttpProjectSpaceClient();

export async function streamCodexChat(
  request: CodexChatRequest,
  emit: (event: CodexChatStreamEvent) => void,
  signal?: AbortSignal
) {
  const baseUrl = resolveApiBaseUrl();
  const requestUrl = resolveApiRequestUrl(baseUrl, '/api/codex/chat/stream');
  const token = await refreshProjectSpaceAuthToken();
  const response = await fetch(requestUrl, {
    body: JSON.stringify(request),
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json'
    },
    method: 'POST',
    redirect: 'error',
    signal
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => undefined)) as
      { error?: string } | undefined;

    throw new Error(payload?.error ?? `Request failed with ${response.status}.`);
  }

  if (!response.body) {
    throw new Error('Streaming is not available in this browser.');
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      emit(JSON.parse(trimmed) as CodexChatStreamEvent);
    }
  }

  buffer += decoder.decode();
  const trimmed = buffer.trim();

  if (trimmed) {
    emit(JSON.parse(trimmed) as CodexChatStreamEvent);
  }
}
