import { getCodexStatus, openCodexTarget } from './local-codex-client';
import type { ConnectorDevServerAdapter } from './connector-dev-server-contract';
import { createLocalDevServerAdapter } from './local-dev-server-adapter';
import type { ConnectorWorktreeActionAdapter } from './connector-worktree-action-contract';
import { createLocalWorktreeActionAdapter } from './local-worktree-action-adapter';
import { runTerminalCommand } from './local-command-runner';
import {
  commitGitChanges,
  getGitDiff,
  getGitHistory,
  getGitStatus,
  stageGitPaths,
  unstageGitPaths
} from './local-git-client';
import {
  getGitHubCatalog,
  getGitHubHistory,
  getGitHubPipelineStatus,
  getGitHubWorkflowRunDetail,
  getGitHubRepositoryDetails,
  pollGitHubOAuthDeviceFlow,
  startGitHubOAuthDeviceFlow
} from './local-github-catalog';
import {
  createGitHubBranch,
  deleteGitHubBranch,
  createGitHubIssue,
  createGitHubIssueComment,
  createGitHubPullRequest,
  getGitHubIssueComments,
  updateGitHubIssue
} from './local-github-issue-actions';
import { startGitHubIssueDevelopment } from './local-github-issue-development';
import {
  loadInstalledLauncherApps,
  loadLauncherAppIcon,
  openCodexSkills,
  openPathInApp
} from './local-launcher-apps';
import { getConnectorOverview } from './local-machine-registry';
import { localMachineName } from './local-machine-identity';
import {
  discoverLocalProjects,
  localProjectsDiscoveryRoot,
  readProjectsState,
  writeProjectsState
} from './local-project-discovery';
import { isWebHubMachine, loadMergedConnectorOverview } from './local-project-machines';
import { createLocalProjectMachineBackend } from './local-project-machine-backend';
import { runProjectCliCommand } from './local-project-cli-client';
import { getDeployedEnvironmentStatus } from './deployed-environment-status';
import { getGitHubBranchComparison } from './github-branch-comparison';
import { getTemplateAdherence } from './local-template-adherence';
import {
  addRoadmapDependency,
  getRoadmap,
  removeRoadmapDependency,
  updateRoadmapPlan
} from './roadmap/roadmap-service';
import { getProjectctlOverview, getProjectctlPreview } from './local-projectctl-client';
import { backupProject, deployProject, getPlatformOverview } from './local-platform-operations';
import { readAppMeta } from './app-meta';
import { configuredConnectorMachineId } from './project-connector-config';
import {
  applyProjectStructureAction,
  listProjectTrash,
  restoreProjectTrashEntry
} from './project-structure-violations';
import { getScopeDevboxOverview, startScopeDevboxJob } from './local-scope-devbox-jobs';
import type {
  AppMeta,
  ProjectDirectorySelection,
  ProjectSpaceBackend,
  ProjectsState,
  ToolLaunchRequest,
  ToolLaunchResult
} from '../src/shared/project-space-api';

interface LocalProjectSpaceBackendOptions {
  connectorMachineId?: string;
  connectorMachineName?: string;
  getAppMeta?: () => AppMeta | Promise<AppMeta>;
  selectProjectDirectory?: () => Promise<ProjectDirectorySelection>;
}

function connectorMachineName(value: string | undefined) {
  return value && value.length <= 256 && value.trim() === value &&
    ![...value].some((character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    ? value
    : undefined;
}

async function localConnectorIdentity(
  connectorMachineId?: string,
  requestedMachineName?: string
) {
  const connector = await getConnectorOverview();
  const localMachine =
    connector.machines.find((machine) => machine.connector.status === 'local') ??
    connector.machines[0];
  const machineName = connectorMachineName(requestedMachineName) ??
    localMachine?.name ?? localMachineName();
  return {
    connector,
    localMachine,
    machineId:
      connectorMachineId ?? configuredConnectorMachineId() ?? localMachine?.id ?? machineName,
    machineName
  };
}

async function loadConnectorOverviewForMachine(connectorMachineId?: string) {
  if (!connectorMachineId) {
    return loadMergedConnectorOverview();
  }

  const connector = await getConnectorOverview();
  const localMachine = connector.machines.find((machine) => machine.connector.status === 'local');
  return {
    ...connector,
    machines: localMachine ? [{ ...localMachine, id: connectorMachineId }] : []
  };
}

function scopeDiscoveryToMachine<
  Discovery extends Awaited<ReturnType<typeof discoverLocalProjects>>
>(discovery: Discovery, machineId: string): Discovery {
  return {
    ...discovery,
    projects: discovery.projects.map((project) => ({ ...project, machineId })),
    structureViolations: (discovery.structureViolations ?? []).map((violation) => ({
      ...violation,
      machineId
    }))
  };
}

export type LocalProjectSpaceBackend = ProjectSpaceBackend &
  ConnectorDevServerAdapter &
  ConnectorWorktreeActionAdapter;
export { isWebHubMachine };
export function createLocalProjectSpaceBackend(
  options: LocalProjectSpaceBackendOptions = {}
): LocalProjectSpaceBackend {
  const devServerAdapter = createLocalDevServerAdapter();
  const worktreeActionAdapter = createLocalWorktreeActionAdapter();
  const loadConnectorOverview = () => loadConnectorOverviewForMachine(options.connectorMachineId);
  return {
    ...createLocalProjectMachineBackend(loadConnectorOverview),
    async getAppMeta() {
      const meta = await (options.getAppMeta?.() ?? readAppMeta());
      return {
        ...meta,
        runtime: meta.runtime ?? {
          apis: 'external',
          data: process.env.PROJECT_SPACE_DATA === 'local' ? 'local' : 'remote',
          network: 'external',
          secrets: 'required'
        }
      };
    },
    async getCodexStatus() {
      return getCodexStatus();
    },
    async getConnectorOverview() {
      return loadConnectorOverview();
    },
    async getMachineRuntime(machineId) {
      return {
        capabilities: [],
        machineId,
        online: false,
        update: { state: 'unsupported' as const }
      };
    },
    async startMachineRuntimeOperation() {
      throw new Error('Connector runtime maintenance has been retired.');
    },
    async stopMachineRuntime() {
      throw new Error('Connector runtime stop has been retired.');
    },
    async getConnectorProjectRegistry() {
      throw new Error(
        'The permanent Project Space Connector has been retired. Use a canonical Environment and Workspace Runtime.'
      );
    },
    async getDeployedEnvironmentStatus(repositoryFullName) {
      return getDeployedEnvironmentStatus(repositoryFullName);
    },
    async runProjectCliCommand(request) {
      return runProjectCliCommand(request);
    },
    async runDevServerCommand(request) {
      return devServerAdapter.runDevServerCommand(request);
    },
    async runWorktreeAction(request) {
      return worktreeActionAdapter.runWorktreeAction(request);
    },
    async listDevServers(request) {
      return devServerAdapter.listDevServers(request);
    },
    async getTemplateAdherence(request) {
      return getTemplateAdherence(request);
    },
    async getGitHubCatalog(options) {
      return getGitHubCatalog(options);
    },
    async createGitHubIssue(request) {
      return createGitHubIssue(request);
    },
    async getGitHubPipelineStatus(fullName: string, options) {
      return getGitHubPipelineStatus(fullName, options);
    },
    async getGitHubWorkflowRunDetail(fullName: string, runId: number) {
      return getGitHubWorkflowRunDetail(fullName, runId);
    },
    async getGitHubRepositoryDetails(fullName: string) {
      return getGitHubRepositoryDetails(fullName);
    },
    async getRoadmap(fullName: string) {
      return getRoadmap(fullName);
    },
    async updateRoadmapPlan(request) {
      return updateRoadmapPlan(request);
    },
    async addRoadmapDependency(request) {
      return addRoadmapDependency(request);
    },
    async removeRoadmapDependency(request) {
      return removeRoadmapDependency(request);
    },
    async getGitHubHistory(request) {
      return getGitHubHistory(request);
    },
    async getGitHubBranchComparison(request) {
      return getGitHubBranchComparison(request);
    },
    async updateGitHubIssue(request) {
      return updateGitHubIssue(request);
    },
    async getGitDiff(request) {
      return getGitDiff(request);
    },
    async getGitHistory(request) {
      return getGitHistory(request);
    },
    async getGitStatus(cwd: string) {
      return getGitStatus(cwd);
    },
    async getPlatformOverview() {
      return getPlatformOverview();
    },
    async loadLauncherApps() {
      return loadInstalledLauncherApps();
    },
    async loadLauncherAppIcon(appId: string) {
      return loadLauncherAppIcon(appId);
    },
    async loadProjectDiscovery() {
      const [identity, localDiscovery] = await Promise.all([
        localConnectorIdentity(options.connectorMachineId, options.connectorMachineName),
        discoverLocalProjects()
      ]);
      return scopeDiscoveryToMachine(localDiscovery, identity.machineId);
    },
    async applyProjectStructureAction(request) {
      return applyProjectStructureAction(localProjectsDiscoveryRoot, request);
    },
    async listProjectTrash() {
      return listProjectTrash(localProjectsDiscoveryRoot);
    },
    async restoreProjectTrashEntry(request) {
      return restoreProjectTrashEntry(localProjectsDiscoveryRoot, request);
    },
    async loadProjectctlOverview(projectPath: string) {
      return getProjectctlOverview(projectPath);
    },
    async loadProjectctlPreview(projectPath: string) {
      return getProjectctlPreview(projectPath);
    },
    async loadProjectsState() {
      return readProjectsState();
    },
    async openCodexSkills() {
      return openCodexSkills();
    },
    async openCodexTarget(request) {
      return openCodexTarget(request);
    },
    async openPathInApp(request) {
      return openPathInApp(request);
    },
    async runTerminalCommand(request) {
      return runTerminalCommand(request);
    },
    async saveProjectsState(state: ProjectsState) {
      writeProjectsState(state);
    },
    async selectProjectDirectory() {
      return options.selectProjectDirectory?.() ?? { canceled: true };
    },
    async startGitHubOAuthDeviceFlow() {
      return startGitHubOAuthDeviceFlow();
    },
    async pollGitHubOAuthDeviceFlow(request) {
      return pollGitHubOAuthDeviceFlow(request);
    },
    async getScopeDevboxOverview() {
      return getScopeDevboxOverview();
    },
    async createGitHubBranch(request) {
      return createGitHubBranch(request);
    },
    async deleteGitHubBranch(request) {
      return deleteGitHubBranch(request);
    },
    async createGitHubPullRequest(request) {
      return createGitHubPullRequest(request);
    },
    async startGitHubIssueDevelopment(request) {
      return startGitHubIssueDevelopment(request);
    },
    async startScopeDevboxJob(request) {
      return startScopeDevboxJob(request);
    },
    async createGitHubIssueComment(request) {
      return createGitHubIssueComment(request);
    },
    async getGitHubIssueComments(fullName: string, number: number) {
      return getGitHubIssueComments(fullName, number);
    },
    async stageGitPaths(request) {
      return stageGitPaths(request);
    },
    async deployProject(request) {
      return deployProject(request);
    },
    async backupProject(request) {
      return backupProject(request);
    },
    async unstageGitPaths(request) {
      return unstageGitPaths(request);
    },
    async commitGitChanges(request) {
      return commitGitChanges(request);
    },
    async openWorkspaceTool(request: ToolLaunchRequest): Promise<ToolLaunchResult> {
      return {
        message: `Launcher placeholder: ${request.tool} will attach to worktree ${request.worktreeId ?? 'unselected'} later.`,
        status: 'placeholder'
      };
    }
  };
}
