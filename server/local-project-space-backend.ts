import { getCodexStatus, openCodexTarget } from './local-codex-client';
import {
  registerLocalConnectorDevServerExecutor,
  registerLocalConnectorWorktreeActionExecutor
} from './connector-command-hub';
import type { ConnectorDevServerAdapter } from './connector-dev-server-contract';
import { createLocalDevServerAdapter } from './local-dev-server-adapter';
import type { ConnectorWorktreeActionAdapter } from './connector-worktree-action-contract';
import { createLocalWorktreeActionAdapter } from './local-worktree-action-adapter';
import { runTerminalCommand } from './local-command-runner';
import { loadConnectorProjectDiscovery } from './connector-discovery';
import { getRegisteredConnectorDiscovery } from './connector-hub';
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
  mergeProjectDiscoveries,
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
import { connectorRuntimeRecord } from './connector-build-info';
import { configuredConnectorMachineId } from './project-connector-config';
import {
  CODEX_SESSIONS_BROWSER_CONNECTOR_CAPABILITY,
  CODEX_AUTHORIZATION_CONNECTOR_CAPABILITY,
  CODEX_AUTHORIZATION_REQUIRED_CONNECTOR_CAPABILITY,
  CODEX_MACHINE_TASKS_CONNECTOR_CAPABILITY,
  CODEX_MACHINE_TASKS_DURABLE_OPERATIONS_CAPABILITY,
  CODEX_RUNTIME_CONNECTOR_CAPABILITY,
  CODEX_SESSIONS_CONNECTOR_CAPABILITY,
  CODEX_SESSIONS_INSPECT_CONNECTOR_CAPABILITY,
  CODEX_SESSIONS_MODEL_SELECTION_CONNECTOR_CAPABILITY,
  CODEX_SESSIONS_MODEL_SETTINGS_CONNECTOR_CAPABILITY
} from './codex-sessions-connector-contract';
import {
  CODEX_DAEMON_CONNECTOR_CAPABILITY,
  type CodexDaemonEvidence
} from '../src/shared/codex-daemon-api';
import { CodexDaemonManager } from './codex-daemon/manager';
import {
  applyProjectStructureAction,
  listProjectTrash,
  restoreProjectTrashEntry
} from './project-structure-violations';
import { getScopeDevboxOverview, startScopeDevboxJob } from './local-scope-devbox-jobs';
import {
  createConfiguredConnectorRuntime,
  type ConfiguredConnectorRuntime
} from './configured-connector-runtime';
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
  getAppMeta?: () => AppMeta | Promise<AppMeta>;
  selectProjectDirectory?: () => Promise<ProjectDirectorySelection>;
}

async function localConnectorIdentity(connectorMachineId?: string) {
  const connector = await getConnectorOverview();
  const localMachine =
    connector.machines.find((machine) => machine.connector.status === 'local') ??
    connector.machines[0];
  const machineName = localMachine?.name ?? localMachineName();
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
  ConnectorWorktreeActionAdapter &
  Pick<ConfiguredConnectorRuntime, 'decideReconnect'>;
export { isWebHubMachine };
const baseConnectorCommandCapabilities = [
  'filesystem.directory',
  'filesystem.file',
  'filesystem.folder.create',
  'filesystem.folder.delete',
  'filesystem.folder.rename',
  'filesystem.root',
  'dev-server.inspect',
  'dev-server.list',
  'dev-server.start',
  'dev-server.stop',
  'worktree.materialize',
  'worktree.setup.inspect',
  'worktree.setup.run',
  'terminal.run',
  'runtime.restart',
  'runtime.stop',
  'runtime.update',
  'worktrees.list',
  'worktrees.list.v2'
];
const codexDaemonInspector = new CodexDaemonManager({
  manager: {
    executeManagedOperation: async (_operationId, _fingerprint, action) => action()
  }
});
const inspectCodexDaemon = () => codexDaemonInspector.inspect();

async function connectorCommandCapabilities(daemon: CodexDaemonEvidence) {
  const readiness = daemon.state === 'ready'
    ? 'ready'
    : daemon.state === 'authorization-required'
      ? 'authorization-required'
      : daemon.installed
        ? 'runtime-only'
        : 'missing';
  return [
    ...baseConnectorCommandCapabilities,
    ...((process.platform === 'linux' || process.platform === 'darwin') &&
      process.env.PROJECT_SPACE_INSTALL_SOURCE === 'managed'
      ? [CODEX_DAEMON_CONNECTOR_CAPABILITY]
      : []),
    ...(readiness !== 'missing' ? [CODEX_RUNTIME_CONNECTOR_CAPABILITY] : []),
    ...(readiness !== 'missing' ? [CODEX_AUTHORIZATION_CONNECTOR_CAPABILITY] : []),
    ...(readiness === 'authorization-required'
      ? [CODEX_AUTHORIZATION_REQUIRED_CONNECTOR_CAPABILITY]
      : []),
    ...(readiness === 'ready' ? [
    CODEX_SESSIONS_BROWSER_CONNECTOR_CAPABILITY,
    CODEX_MACHINE_TASKS_CONNECTOR_CAPABILITY,
    ...(process.env.PROJECT_CODEX_OPERATION_SNAPSHOT_FILE
      ? [CODEX_MACHINE_TASKS_DURABLE_OPERATIONS_CAPABILITY]
      : []),
    CODEX_SESSIONS_CONNECTOR_CAPABILITY,
    CODEX_SESSIONS_INSPECT_CONNECTOR_CAPABILITY,
    CODEX_SESSIONS_MODEL_SELECTION_CONNECTOR_CAPABILITY,
    CODEX_SESSIONS_MODEL_SETTINGS_CONNECTOR_CAPABILITY
    ] : [])
  ];
}

export function createLocalProjectSpaceBackend(
  options: LocalProjectSpaceBackendOptions = {}
): LocalProjectSpaceBackend {
  const devServerAdapter = createLocalDevServerAdapter();
  const worktreeActionAdapter = createLocalWorktreeActionAdapter();
  const loadConnectorOverview = () => loadConnectorOverviewForMachine(options.connectorMachineId);
  const connectorRuntime = createConfiguredConnectorRuntime({ loadOverview: loadConnectorOverview });
  const registeredLocalMachines = new Set<string>();

  function registerLocalDevServer(machineId: string) {
    if (!registeredLocalMachines.has(machineId)) {
      registerLocalConnectorDevServerExecutor(machineId, devServerAdapter);
      registerLocalConnectorWorktreeActionExecutor(machineId, worktreeActionAdapter);
      registeredLocalMachines.add(machineId);
    }
  }

  registerLocalDevServer(
    options.connectorMachineId ?? configuredConnectorMachineId() ?? localMachineName()
  );
  return {
    ...createLocalProjectMachineBackend(loadConnectorOverview),
    async getAppMeta() {
      return options.getAppMeta?.() ?? readAppMeta();
    },
    async getCodexStatus() {
      return getCodexStatus();
    },
    async getConnectorOverview() {
      return loadConnectorOverview();
    },
    decideReconnect(machine) {
      return connectorRuntime.decideReconnect(machine);
    },
    getMachineRuntime(machineId) {
      return connectorRuntime.getMachineRuntime(machineId);
    },
    startMachineRuntimeOperation(machineId, request) {
      return connectorRuntime.startMachineRuntimeOperation(machineId, request);
    },
    stopMachineRuntime(machineId) {
      return connectorRuntime.stopMachineRuntime(machineId);
    },
    async getConnectorProjectRegistry() {
      const [identity, rawDiscovery, daemon] = await Promise.all([
        localConnectorIdentity(options.connectorMachineId),
        discoverLocalProjects(),
        inspectCodexDaemon()
      ]);
      const capabilities = await connectorCommandCapabilities(daemon);
      const { connector, localMachine, machineId, machineName } = identity;
      const discovery = scopeDiscoveryToMachine(rawDiscovery, machineId);
      registerLocalDevServer(machineId);

      return {
        checkedAt: new Date().toISOString(),
        connector: {
          battery: localMachine?.battery,
          capabilities,
          compute: localMachine?.compute,
          daemon,
          environment: localMachine?.environment,
          executionScopeId: localMachine?.executionScopeId,
          kind: process.env.PROJECT_CONNECTOR_MACHINE_KIND ?? localMachine?.kind,
          machineId,
          machineName,
          network: {
            ...localMachine?.network,
            localName: process.env.PROJECT_CONNECTOR_SSH_HOST ?? localMachine?.network.localName,
            sshUser: process.env.PROJECT_CONNECTOR_SSH_USER ?? localMachine?.network.sshUser,
            tailscaleIp: process.env.PROJECT_CONNECTOR_SSH_HOST ?? localMachine?.network.tailscaleIp
          },
          origin: connector.connectorOrigin,
          primaryUser: process.env.PROJECT_CONNECTOR_SSH_USER ?? localMachine?.primaryUser,
          runtime: connectorRuntimeRecord(),
          serviceName: process.env.PROJECT_CONNECTOR_SERVICE_NAME ?? 'project-space-connector'
        },
        discovery
      };
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
      if (process.env.PROJECT_SPACE_DISCOVERY_SOURCE === 'connector') {
        const identity = await localConnectorIdentity(options.connectorMachineId);
        const discovery = (await loadConnectorProjectDiscovery()) ?? {
          groups: [],
          projects: [],
          rootItems: [],
          rootPath: 'connector',
          structureViolations: []
        };
        return scopeDiscoveryToMachine(discovery, identity.machineId);
      }

      const [identity, localDiscovery] = await Promise.all([
        localConnectorIdentity(options.connectorMachineId),
        discoverLocalProjects()
      ]);
      return mergeProjectDiscoveries(
        scopeDiscoveryToMachine(localDiscovery, identity.machineId),
        await getRegisteredConnectorDiscovery()
      );
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
