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
  MachineRuntimeOperationRequest,
  MachineRuntimeOperationResult,
  MachineRuntimeStopResult,
  MachineRuntimeStatusResult,
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
  GitStageRequest,
  GitStatusResult,
  LauncherAppRecord,
  MachineFileSystemDirectoryRequest,
  MachineFileSystemDirectoryResult,
  MachineFileSystemFileRequest,
  MachineFileSystemFileResult,
  MachineFileSystemRequest,
  MachineExecutionScopeRecord,
  MachineExecutionScopesResult,
  MachineExecutionScopeSaveRequest,
  MachineFileSystemRootResult,
  MachineDirectoryCreateRequest,
  MachineDirectoryDeleteRequest,
  MachineDirectoryMutationResult,
  MachineDirectoryRenameRequest,
  MachineTerminalCommandRequest,
  OpenPathInAppRequest,
  OpenPathInAppResult,
  PhysicalMachineRecord,
  PhysicalMachinesResult,
  PhysicalMachineSaveRequest,
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
import {
  refreshProjectSpaceAuthToken,
  setProjectSpaceAuthToken
} from './project-space-client-auth';
import type {
  CodexMachineTaskStartRecoveryResult,
  CodexMachineTaskStartRequest,
  CodexMachineTaskStartResult,
  CodexMachineTaskExistingRequest,
  CodexMachineTaskExistingResult
} from '@/shared/codex-machine-tasks-api';
import type {
  CodexAuthorizationRequest,
  CodexAuthorizationResult
} from '@/shared/codex-authorization-api';
import type {
  GitHubCodespaceRunnerRequest,
  GitHubCodespaceRunnerResult
} from '@/shared/github-codespace-runner-api';
import { GitHubProjectSpaceClient } from './project-space-client-github';
import { resolveApiBaseUrl, resolveApiRequestUrl } from './project-space-client-http';

export {
  getProjectSpaceAuthToken,
  refreshProjectSpaceAuthToken,
  setProjectSpaceAuthToken,
  setProjectSpaceAuthTokenProvider
} from './project-space-client-auth';
export {
  isProjectSpaceApiRequestAllowed,
  resolveProjectSpaceApiBaseUrl
} from './project-space-client-http';

class HttpProjectSpaceClient extends GitHubProjectSpaceClient implements ProjectSpaceBackend {

  getAppMeta(): Promise<AppMeta> {
    return this.request('/api/app/meta');
  }

  getLocalSimulationState(): Promise<{
    createdAt: string;
    revision: number;
    scenario: string;
    updatedAt: string;
  }> {
    return this.request('/api/local-simulation');
  }

  resetLocalSimulation(): Promise<{ revision: number; scenario: string }> {
    return this.request('/api/local-simulation/reset', { method: 'POST' });
  }

  getReleaseChangelog() {
    return this.request<import('@/shared/release-changelog-api').ReleaseChangelogResult>(
      '/api/app/releases'
    );
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

  getMachineRuntime(machineId: string, signal?: AbortSignal): Promise<MachineRuntimeStatusResult> {
    return this.request(`/api/machines/${encodeURIComponent(machineId)}/runtime`, { signal });
  }

  startMachineRuntimeOperation(
    machineId: string,
    operation: MachineRuntimeOperationRequest
  ): Promise<MachineRuntimeOperationResult> {
    return this.request(`/api/machines/${encodeURIComponent(machineId)}/runtime/operations`, {
      body: JSON.stringify(operation),
      method: 'POST'
    });
  }

  stopMachineRuntime(machineId: string): Promise<MachineRuntimeStopResult> {
    return this.request(`/api/machines/${encodeURIComponent(machineId)}/runtime/stop`, {
      body: JSON.stringify({}),
      method: 'POST'
    });
  }

  getConnectorProjectRegistry(): Promise<ConnectorProjectRegistryResult> {
    return this.request('/api/connectors/project-registry');
  }

  getDeployedEnvironmentStatus(repositoryFullName: string) {
    return this.request<import('@/shared/project-space-api').DeployedEnvironmentStatusResult>(
      `/api/deployed-environments/status?repositoryFullName=${encodeURIComponent(repositoryFullName)}`
    );
  }

  getPullRequestPreviewStatus(repositoryFullName: string, pullRequestNumber?: number) {
    const query = new URLSearchParams({ repositoryFullName });
    if (pullRequestNumber !== undefined) {
      query.set('pullRequestNumber', String(pullRequestNumber));
    }
    return this.request<import('@/shared/project-space-api').PullRequestPreviewStatusResult>(
      `/api/pull-request-previews/status?${query.toString()}`
    );
  }

  getPullRequestPreviewHub(repositoryFullName = 'DotNaos/project-space') {
    return this.requestPreviewHub<import('@/shared/pull-request-preview-hub-api').PreviewHubInventoryResult>(
      `/api/pull-request-preview-hub?repositoryFullName=${encodeURIComponent(repositoryFullName)}`
    );
  }

  startPullRequestPreview(request: import('@/shared/pull-request-preview-hub-api').PreviewHubStartRequest) {
    return this.requestPreviewHub<import('@/shared/pull-request-preview-hub-api').PreviewHubMutationResult>(
      '/api/pull-request-preview-hub/start',
      { body: JSON.stringify(request), method: 'POST' }
    );
  }

  stopPullRequestPreview(request: import('@/shared/pull-request-preview-hub-api').PreviewHubStopRequest) {
    return this.requestPreviewHub<import('@/shared/pull-request-preview-hub-api').PreviewHubMutationResult>(
      '/api/pull-request-preview-hub/stop',
      { body: JSON.stringify(request), method: 'POST' }
    );
  }

  touchPullRequestPreview(request: import('@/shared/pull-request-preview-hub-api').PreviewHubTouchRequest) {
    return this.requestPreviewHub<import('@/shared/pull-request-preview-hub-api').PreviewHubMutationResult>(
      '/api/pull-request-preview-hub/touch',
      { body: JSON.stringify(request), method: 'POST' }
    );
  }

  establishPullRequestPreviewAccess(pullRequestNumber: number) {
    return this.establishPreviewAccess(pullRequestNumber);
  }

  getPullRequestTestSurfaces(repositoryFullName: string, pullRequestNumber: number) {
    const query = new URLSearchParams({
      pullRequestNumber: String(pullRequestNumber),
      repositoryFullName
    });
    return this.request<
      import('@/shared/pr-preview-test-surfaces-api').PullRequestTestSurfacesResult
    >(`/api/pull-request-previews/test-surfaces?${query.toString()}`);
  }

  startCodexMachineTask(
    request: CodexMachineTaskStartRequest
  ): Promise<CodexMachineTaskStartResult> {
    return this.request('/api/codex/tasks/start', {
      body: JSON.stringify(request),
      headers: { 'Idempotency-Key': request.operationId },
      method: 'POST'
    });
  }

  getExistingCodexMachineTask(
    request: CodexMachineTaskExistingRequest
  ): Promise<CodexMachineTaskExistingResult> {
    const query = new URLSearchParams({
      connectorId: request.connectorId,
      issue: String(request.issue),
      repositoryId: request.repositoryId
    });
    return this.request(`/api/codex/tasks/existing?${query.toString()}`);
  }

  authorizeCodex(request: CodexAuthorizationRequest): Promise<CodexAuthorizationResult> {
    return this.request('/api/codex/authorization', {
      body: JSON.stringify(request),
      headers: { 'Idempotency-Key': request.operationId },
      method: 'POST'
    });
  }

  runGitHubCodespace(
    request: GitHubCodespaceRunnerRequest
  ): Promise<GitHubCodespaceRunnerResult> {
    return this.request('/api/github/codespace-runner', {
      body: JSON.stringify(request),
      headers: { 'Idempotency-Key': request.operationId },
      method: 'POST'
    });
  }

  recoverCodexMachineTaskStart(
    request: CodexMachineTaskStartRequest
  ): Promise<CodexMachineTaskStartRecoveryResult> {
    return this.request('/api/codex/tasks/start/recover', {
      body: JSON.stringify(request),
      headers: { 'Idempotency-Key': request.operationId },
      method: 'POST'
    });
  }

  getPullRequestPrototypeIteration(
    request: import('@/shared/pr-prototype-iteration-api').PullRequestPrototypeIterationRequest,
    signal?: AbortSignal
  ) {
    const query = new URLSearchParams({
      headSha: request.headSha,
      pullRequestNumber: String(request.pullRequestNumber),
      repositoryFullName: request.repositoryFullName,
      surface: request.surface
    });
    return this.request<
      import('@/shared/pr-prototype-iteration-api').PullRequestPrototypeIterationResult
    >(`/api/pull-request-previews/prototype-iteration?${query.toString()}`, { signal });
  }

  startPullRequestPrototypeIteration(
    request: import('@/shared/pr-prototype-iteration-api').PullRequestPrototypeIterationRequest
  ) {
    return this.request<
      import('@/shared/pr-prototype-iteration-api').PullRequestPrototypeIterationResult
    >('/api/pull-request-previews/prototype-iteration', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  sendPullRequestPrototypeFeedback(
    feedback: import('@/shared/pr-preview-test-surfaces-api').PullRequestPrototypeFeedbackRequest
  ) {
    return this.request<
      import('@/shared/pr-preview-test-surfaces-api').PullRequestPrototypeFeedbackResult
    >('/api/pull-request-previews/feedback', {
      body: JSON.stringify(feedback),
      method: 'POST'
    });
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

  listPhysicalMachines(): Promise<PhysicalMachinesResult> {
    return this.request('/api/physical-machines');
  }

  savePhysicalMachine(
    request: PhysicalMachineSaveRequest
  ): Promise<{ machine: PhysicalMachineRecord }> {
    return this.request('/api/physical-machines', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  deletePhysicalMachine(physicalMachineId: string): Promise<{ deleted: boolean }> {
    return this.request(`/api/physical-machines/${encodeURIComponent(physicalMachineId)}`, {
      method: 'DELETE'
    });
  }

  listMachineExecutionScopes(): Promise<MachineExecutionScopesResult> {
    return this.request('/api/machines/execution-scopes');
  }

  saveMachineExecutionScope(
    request: MachineExecutionScopeSaveRequest
  ): Promise<{ scope: MachineExecutionScopeRecord }> {
    return this.request('/api/machines/execution-scopes', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  deleteMachineExecutionScope(scopeId: string): Promise<{ deleted: boolean }> {
    return this.request(`/api/machines/execution-scopes/${encodeURIComponent(scopeId)}`, {
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
