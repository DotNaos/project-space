import type {
  AppMeta,
  CodexOpenRequest,
  CodexStatusResult,
  ConnectorOverviewResult,
  FileSystemEntry,
  GitActionResult,
  GitCommitRequest,
  GitDiffRequest,
  GitDiffResult,
  GitHubCatalogResult,
  GitHubRepositoryDetailsResult,
  GitHubOAuthDevicePollRequest,
  GitHubOAuthDevicePollResult,
  GitHubOAuthDeviceStartResult,
  GitStageRequest,
  GitStatusResult,
  LauncherAppRecord,
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
  ProjectctlOverviewResult,
  ProjectctlPlanResult,
  ProjectsState,
  ProjectWorktreeRecord,
  ScopeDevboxOverviewResult,
  ScopeDevboxStartRequest,
  ScopeDevboxJobRecord,
  TerminalCommandRequest,
  TerminalCommandResult,
  ToolLaunchRequest,
  ToolLaunchResult
} from '@/shared/project-space-api';

const authTokenStorageKey = 'project-space.session-token';
let projectSpaceAuthToken = '';
let projectSpaceAuthTokenProvider: (() => Promise<string | null>) | null = null;

export function getProjectSpaceAuthToken() {
  return projectSpaceAuthToken;
}

export function setProjectSpaceAuthTokenProvider(
  provider: (() => Promise<string | null>) | null
) {
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

function resolveApiBaseUrl() {
  const explicitBaseUrl = import.meta.env.VITE_PROJECT_SPACE_API_BASE_URL;

  if (explicitBaseUrl) {
    return explicitBaseUrl.replace(/\/+$/, '');
  }

  const currentUrl = new URL(window.location.href);
  const queryBaseUrl = currentUrl.searchParams.get('projectSpaceApi');

  if (queryBaseUrl) {
    return queryBaseUrl.replace(/\/+$/, '');
  }

  return '';
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => undefined)) as
    | { error?: string }
    | T
    | undefined;

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
    const token = await refreshProjectSpaceAuthToken();

    return fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers
      }
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

  runProjectCliCommand(request: ProjectCliCommandRequest): Promise<ProjectCliCommandResult> {
    return this.request('/api/project-cli/run', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  getGitHubCatalog(): Promise<GitHubCatalogResult> {
    return this.request('/api/github/catalog');
  }

  getGitHubRepositoryDetails(fullName: string): Promise<GitHubRepositoryDetailsResult> {
    const query = new URLSearchParams({ fullName });

    return this.request(`/api/github/repository-details?${query.toString()}`);
  }

  getGitDiff(request: GitDiffRequest): Promise<GitDiffResult> {
    return this.request('/api/git/diff', {
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

  loadProjectWorktrees(projectPath: string): Promise<ProjectWorktreeRecord[]> {
    const query = new URLSearchParams({ projectPath });

    return this.request(`/api/projects/worktrees?${query.toString()}`);
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
