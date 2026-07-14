import {
  getCurrentAuthSession,
  isProjectSpaceAuthRequired
} from './local-auth-store';
import {
  isDatabaseConfigured,
  listMachineMemberships,
  readMachineMembership,
  readUserProjectsState,
  upsertUserProjectsState
} from './local-database-store';
import {
  emptyProjectsState,
  normalizeProjectsState
} from './database/projects-state';
import type {
  ConnectorOverviewResult,
  ProjectDiscoveryResult,
  ProjectSpaceBackend,
  ProjectsState
} from '../src/shared/project-space-api';

export class ProjectSpaceAccessError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 403) {
    super(message);
    this.name = 'ProjectSpaceAccessError';
    this.statusCode = statusCode;
  }
}

export interface AuthorizedProjectSpaceBackendOptions {
  authRequired?(): boolean;
  currentUserId?(): string | undefined;
  databaseConfigured?(): boolean;
  listMemberships?(userId: string): Promise<Array<{ machineId: string }>>;
  readMembership?(input: {
    machineId: string;
    userId: string;
  }): Promise<{ role: 'member' | 'owner' } | null>;
  readProjectsState?(userId: string): Promise<ProjectsState | null>;
  writeProjectsState?(userId: string, state: ProjectsState): Promise<unknown>;
}

function createAccessPolicy(options: AuthorizedProjectSpaceBackendOptions) {
  const authRequired = options.authRequired ?? isProjectSpaceAuthRequired;
  const databaseConfigured = options.databaseConfigured ?? isDatabaseConfigured;
  const membershipsFor = options.listMemberships ?? listMachineMemberships;
  const membershipFor = options.readMembership ?? readMachineMembership;
  const projectsStateFor = options.readProjectsState ?? readUserProjectsState;
  const writeProjectsStateFor =
    options.writeProjectsState ??
    ((userId: string, state: ProjectsState) => upsertUserProjectsState({ state, userId }));
  const readUserId = options.currentUserId ?? (() => getCurrentAuthSession()?.userId);

  function currentUserId() {
    const userId = readUserId();
    if (userId) {
      return userId;
    }
    if (!authRequired()) {
      return 'local-development-user';
    }
    throw new ProjectSpaceAccessError('Login required.', 401);
  }

  async function accessibleMachineIds() {
    if (!authRequired()) {
      return undefined;
    }
    if (!databaseConfigured()) {
      throw new ProjectSpaceAccessError(
        'Machine access is unavailable until the database is configured.',
        503
      );
    }
    const memberships = await membershipsFor(currentUserId());
    return new Set(memberships.map((membership) => membership.machineId));
  }

  return {
    accessibleMachineIds,
    authRequired,
    currentUserId,
    databaseConfigured,
    projectsStateFor,
    async requireMachineAccess(machineId: string) {
      const allowed = await accessibleMachineIds();
      if (allowed && !allowed.has(machineId)) {
        throw new ProjectSpaceAccessError('You do not have access to this machine.');
      }
    },
    async requireMachineOwner(machineId: string) {
      if (!authRequired()) return;
      if (!databaseConfigured()) {
        throw new ProjectSpaceAccessError(
          'Machine access is unavailable until the database is configured.', 503
        );
      }
      const membership = await membershipFor({ machineId, userId: currentUserId() });
      if (membership?.role !== 'owner') {
        throw new ProjectSpaceAccessError(
          'Only the machine owner can manage its connector runtime.'
        );
      }
    },
    requireLocalHostAccess() {
      if (authRequired()) {
        throw new ProjectSpaceAccessError(
          'This local-host operation is disabled in the hosted multi-user app.'
        );
      }
    },
    requireHostedDatabase() {
      if (authRequired() && !databaseConfigured()) {
        throw new ProjectSpaceAccessError(
          'Account data is unavailable until the database is configured.',
          503
        );
      }
    },
    writeProjectsStateFor
  };
}

function filterOverview(
  overview: ConnectorOverviewResult,
  allowed: ReadonlySet<string> | undefined
) {
  if (!allowed) {
    return overview;
  }

  return {
    machines: overview.machines.filter((machine) => allowed.has(machine.id)),
    machinesRepo: { exists: false, path: '' },
    tailscale: {
      connected: false,
      installed: false,
      ips: [],
      peersOnline: 0,
      serveOrigins: []
    }
  };
}

function filterDiscovery(
  discovery: ProjectDiscoveryResult,
  allowed: ReadonlySet<string> | undefined
) {
  if (!allowed) {
    return discovery;
  }

  const projects = discovery.projects.filter(
    (project) => Boolean(project.machineId) && allowed.has(project.machineId!)
  );
  const projectIds = new Set(projects.map((project) => project.id));
  const groups = discovery.groups
    .map((group) => ({
      ...group,
      childProjectIds: group.childProjectIds.filter((projectId) => projectIds.has(projectId))
    }))
    .filter((group) => group.childProjectIds.length > 0);
  const groupIds = new Set(groups.map((group) => group.id));

  return {
    ...discovery,
    groups,
    projects,
    rootItems: discovery.rootItems.filter((item) =>
      item.kind === 'project' ? projectIds.has(item.projectId) : groupIds.has(item.groupId)
    ),
    rootPath: projects.length > 0 ? 'authorized-connectors' : '',
    structureViolations: (discovery.structureViolations ?? []).filter(
      (violation) => Boolean(violation.machineId) && allowed.has(violation.machineId!)
    )
  };
}

export function createAuthorizedProjectSpaceBackend(
  backend: ProjectSpaceBackend,
  options: AuthorizedProjectSpaceBackendOptions = {}
): ProjectSpaceBackend {
  const policy = createAccessPolicy(options);
  const authorized: ProjectSpaceBackend = {
    ...backend,

    async getConnectorOverview() {
      const [overview, allowed] = await Promise.all([
        backend.getConnectorOverview(),
        policy.accessibleMachineIds()
      ]);
      return filterOverview(overview, allowed);
    },

    async getMachineRuntime(machineId) {
      await policy.requireMachineAccess(machineId);
      return backend.getMachineRuntime(machineId);
    },

    async startMachineRuntimeOperation(machineId, request) {
      await policy.requireMachineOwner(machineId);
      return backend.startMachineRuntimeOperation(machineId, request);
    },

    async getConnectorProjectRegistry() {
      policy.requireLocalHostAccess();
      return backend.getConnectorProjectRegistry();
    },

    async getDeployedEnvironmentStatus(repositoryFullName) {
      const details = await backend.getGitHubRepositoryDetails(repositoryFullName);
      if (details.status !== 'connected') {
        return {
          checkedAt: new Date().toISOString(),
          environments: [],
          repositoryFullName,
          status: 'unauthorized' as const
        };
      }
      return backend.getDeployedEnvironmentStatus(repositoryFullName);
    },

    async getGitHubPipelineStatus(repositoryFullName, options) {
      const details = await backend.getGitHubRepositoryDetails(repositoryFullName);
      if (details.status !== 'connected') {
        return { checkedAt: new Date().toISOString(), runs: [], status: details.status === 'auth-required' ? 'auth-required' as const : 'unauthorized' as const };
      }
      return backend.getGitHubPipelineStatus(repositoryFullName, options);
    },

    async getGitHubWorkflowRunDetail(repositoryFullName, runId) {
      const details = await backend.getGitHubRepositoryDetails(repositoryFullName);
      if (details.status !== 'connected') {
        return { checkedAt: new Date().toISOString(), jobs: [], status: details.status === 'auth-required' ? 'auth-required' as const : 'unauthorized' as const };
      }
      return backend.getGitHubWorkflowRunDetail(repositoryFullName, runId);
    },

    async getCodexStatus() {
      policy.requireLocalHostAccess();
      return backend.getCodexStatus();
    },

    async loadLauncherApps() {
      policy.requireLocalHostAccess();
      return backend.loadLauncherApps();
    },

    async loadLauncherAppIcon(appId) {
      policy.requireLocalHostAccess();
      return backend.loadLauncherAppIcon(appId);
    },

    async loadProjectDiscovery() {
      const [discovery, allowed] = await Promise.all([
        backend.loadProjectDiscovery(),
        policy.accessibleMachineIds()
      ]);
      return filterDiscovery(discovery, allowed);
    },

    async loadProjectWorktrees(projectPath, machineId) {
      if (!machineId) {
        policy.requireLocalHostAccess();
        return backend.loadProjectWorktrees(projectPath);
      }
      await policy.requireMachineAccess(machineId);
      if (policy.authRequired()) {
        const discovery = filterDiscovery(
          await backend.loadProjectDiscovery(),
          await policy.accessibleMachineIds()
        );
        const project = discovery.projects.find(
          (candidate) =>
            candidate.machineId === machineId && candidate.rootPath === projectPath
        );
        if (!project) {
          throw new ProjectSpaceAccessError('The selected project is not available on this machine.');
        }
        return backend.loadProjectWorktrees(project.rootPath, machineId);
      }
      return backend.loadProjectWorktrees(projectPath, machineId);
    },

    async loadProjectsState() {
      if (!policy.authRequired()) {
        return backend.loadProjectsState();
      }
      policy.requireHostedDatabase();
      return (
        (await policy.projectsStateFor(policy.currentUserId())) ?? emptyProjectsState()
      );
    },

    async saveProjectsState(state) {
      if (!policy.authRequired()) {
        return backend.saveProjectsState(state);
      }
      policy.requireHostedDatabase();
      await policy.writeProjectsStateFor(
        policy.currentUserId(),
        normalizeProjectsState(state)
      );
    },

    async getMachineFileSystemRoot(request) {
      await policy.requireMachineAccess(request.machineId);
      return backend.getMachineFileSystemRoot(request);
    },

    async readMachineDirectory(request) {
      await policy.requireMachineAccess(request.machineId);
      return backend.readMachineDirectory(request);
    },

    async readMachineFile(request) {
      await policy.requireMachineAccess(request.machineId);
      return backend.readMachineFile(request);
    },

    async createMachineDirectory(request) {
      await policy.requireMachineAccess(request.machineId);
      return backend.createMachineDirectory(request);
    },

    async renameMachineDirectory(request) {
      await policy.requireMachineAccess(request.machineId);
      return backend.renameMachineDirectory(request);
    },

    async deleteMachineDirectories(request) {
      await policy.requireMachineAccess(request.machineId);
      return backend.deleteMachineDirectories(request);
    },

    async getCodexModels(request) {
      await policy.requireMachineAccess(request.machineId);
      return backend.getCodexModels(request);
    },

    async runCodexChat(request) {
      await policy.requireMachineAccess(request.machineId);
      return backend.runCodexChat(request);
    },

    async streamCodexChat(request, emit, signal) {
      await policy.requireMachineAccess(request.machineId);
      return backend.streamCodexChat(request, emit, signal);
    },

    async runMachineTerminalCommand(request) {
      await policy.requireMachineAccess(request.machineId);
      return backend.runMachineTerminalCommand(request);
    },

    async startScopeDevboxJob(request) {
      policy.requireLocalHostAccess();
      return backend.startScopeDevboxJob(request);
    },

    async runProjectCliCommand(request) {
      if (policy.authRequired()) {
        throw new ProjectSpaceAccessError(
          'Project CLI commands must run through an authorized machine connector.'
        );
      }
      return backend.runProjectCliCommand(request);
    },

    async runTerminalCommand(request) {
      policy.requireLocalHostAccess();
      return backend.runTerminalCommand(request);
    },

    async readDirectory(path) {
      policy.requireLocalHostAccess();
      return backend.readDirectory(path);
    },

    async getTemplateAdherence(request) {
      policy.requireLocalHostAccess();
      return backend.getTemplateAdherence(request);
    },

    async loadProjectctlOverview(projectPath) {
      policy.requireLocalHostAccess();
      return backend.loadProjectctlOverview(projectPath);
    },

    async loadProjectctlPreview(projectPath) {
      policy.requireLocalHostAccess();
      return backend.loadProjectctlPreview(projectPath);
    },

    async getGitStatus(cwd) {
      policy.requireLocalHostAccess();
      return backend.getGitStatus(cwd);
    },

    async getGitDiff(request) {
      policy.requireLocalHostAccess();
      return backend.getGitDiff(request);
    },

    async getGitHistory(request) {
      policy.requireLocalHostAccess();
      return backend.getGitHistory(request);
    },

    async stageGitPaths(request) {
      policy.requireLocalHostAccess();
      return backend.stageGitPaths(request);
    },

    async unstageGitPaths(request) {
      policy.requireLocalHostAccess();
      return backend.unstageGitPaths(request);
    },

    async commitGitChanges(request) {
      policy.requireLocalHostAccess();
      return backend.commitGitChanges(request);
    },

    async openPathInApp(request) {
      policy.requireLocalHostAccess();
      return backend.openPathInApp(request);
    },

    async openCodexSkills() {
      policy.requireLocalHostAccess();
      return backend.openCodexSkills();
    },

    async openCodexTarget(request) {
      policy.requireLocalHostAccess();
      return backend.openCodexTarget(request);
    },

    async selectProjectDirectory() {
      policy.requireLocalHostAccess();
      return backend.selectProjectDirectory();
    },

    async applyProjectStructureAction(request) {
      policy.requireLocalHostAccess();
      return backend.applyProjectStructureAction(request);
    },

    async listProjectTrash() {
      policy.requireLocalHostAccess();
      return backend.listProjectTrash();
    },

    async restoreProjectTrashEntry(request) {
      policy.requireLocalHostAccess();
      return backend.restoreProjectTrashEntry(request);
    },

    async getPlatformOverview() {
      policy.requireLocalHostAccess();
      return backend.getPlatformOverview();
    },

    async deployProject(request) {
      policy.requireLocalHostAccess();
      return backend.deployProject(request);
    },

    async backupProject(request) {
      policy.requireLocalHostAccess();
      return backend.backupProject(request);
    },

    async openWorkspaceTool(request) {
      policy.requireLocalHostAccess();
      return backend.openWorkspaceTool(request);
    },

    async getScopeDevboxOverview() {
      policy.requireLocalHostAccess();
      return backend.getScopeDevboxOverview();
    }
  };

  return authorized;
}
