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
  GitStageRequest,
  GitStatusResult,
  LauncherAppRecord,
  OpenPathInAppRequest,
  OpenPathInAppResult,
  PlatformOverviewResult,
  ProjectBackupRequest,
  ProjectDeployRequest,
  ProjectDirectorySelection,
  ProjectDiscoveryResult,
  ProjectSpaceBackend,
  ProjectctlOverviewResult,
  ProjectctlPlanResult,
  ProjectsState,
  ProjectWorktreeRecord,
  TerminalCommandRequest,
  TerminalCommandResult,
  ToolLaunchRequest,
  ToolLaunchResult
} from '@/shared/project-space-api';

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

  private request<T>(path: string, init?: RequestInit) {
    return fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers
      }
    }).then((response) => readJsonResponse<T>(response));
  }

  getAppMeta(): Promise<AppMeta> {
    return this.request('/api/app/meta');
  }

  getCodexStatus(): Promise<CodexStatusResult> {
    return this.request('/api/codex/status');
  }

  getConnectorOverview(): Promise<ConnectorOverviewResult> {
    return this.request('/api/connectors/overview');
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
