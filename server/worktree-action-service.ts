import type {
  GitHubCatalogRepository,
  ProjectSpaceBackend,
  ProjectSpaceRecord,
  ProjectWorktreeRecord
} from '../src/shared/project-space-api';
import type {
  WorktreeMaterializeRequest,
  WorktreeMaterializeResult,
  WorktreeSetupInspectRequest,
  WorktreeSetupResult,
  WorktreeSetupRunRequest
} from '../src/shared/worktree-action-api';
import type {
  ConnectorWorktreeActionActor,
  ConnectorWorktreeActionResult,
  ConnectorWorktreeActionTrustedRequest
} from './connector-worktree-action-contract';

interface Membership {
  machineId: string;
  role: 'owner' | 'member';
  userId: string;
}
export interface WorktreeActionServiceOptions {
  backend: Pick<
    ProjectSpaceBackend,
    | 'getConnectorOverview'
    | 'getGitHubCatalog'
    | 'getGitHubRepositoryDetails'
    | 'loadProjectDiscovery'
    | 'loadProjectWorktrees'
  >;
  connector: {
    run(
      operation: ConnectorWorktreeActionTrustedRequest['operation'],
      request: ConnectorWorktreeActionTrustedRequest,
      actor: ConnectorWorktreeActionActor
    ): Promise<ConnectorWorktreeActionResult>;
  };
  database: {
    isConfigured(): boolean;
    readMachineMembership(input: { machineId: string; userId: string }): Promise<Membership | null>;
  };
  now?: () => Date;
  userId(): string;
}

function id(value: unknown, name: string, max = 512) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > max ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new Error(`${name} is invalid.`);
  return value;
}
function sha(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}
function publicStepError(state: string) {
  if (state === 'failed') return 'Setup step failed.';
  if (state === 'interrupted') return 'Setup step was interrupted and can be retried.';
  if (state === 'stale') return 'Setup step is stale because the repository changed.';
  return undefined;
}
function headSha(worktree: ProjectWorktreeRecord) {
  const value = (worktree as ProjectWorktreeRecord & { headSha?: string }).headSha;
  return sha(value) ? value : undefined;
}
function repositoryMatches(projectId: string, repository: GitHubCatalogRepository) {
  return projectId === `github:${repository.id}` || projectId === `github:${repository.fullName}`;
}

export function createWorktreeActionService(options: WorktreeActionServiceOptions) {
  const now = options.now ?? (() => new Date());
  let generation = 0;
  const locks = new Map<string, Promise<void>>();
  async function exclusive<T>(key: string, action: () => Promise<T>) {
    const previous = locks.get(key) ?? Promise.resolve();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    locks.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (locks.get(key) === tail) locks.delete(key);
    }
  }
  function actor(): ConnectorWorktreeActionActor {
    generation = Math.max(generation + 1, Date.now());
    return { generation, userId: options.userId() };
  }
  async function requireMachine(machineId: string) {
    const machine = (await options.backend.getConnectorOverview()).machines.find(
      (candidate) => candidate.id === machineId
    );
    if (!machine) throw new Error('The selected machine is not registered.');
    if (machine.connector.status !== 'local' && machine.connector.status !== 'online')
      throw new Error('The selected machine connector is offline.');
    if (!options.database.isConfigured()) throw new Error('Machine authorization is unavailable.');
    if (
      !(await options.database.readMachineMembership({
        machineId,
        userId: options.userId()
      }))
    )
      throw new Error('You do not have access to this machine.');
  }
  async function repositoryFor(machineId: string, projectId: string) {
    const [catalog, discovery] = await Promise.all([
      options.backend.getGitHubCatalog(),
      options.backend.loadProjectDiscovery()
    ]);
    if (catalog.status !== 'connected')
      throw new Error('The authorized GitHub catalog is unavailable.');
    const project = discovery.projects.find(
      (candidate) => candidate.id === projectId && candidate.machineId === machineId
    );
    const fullName = project?.github?.fullName;
    const repository = catalog.repositories.find((candidate) =>
      fullName ? candidate.fullName === fullName : repositoryMatches(projectId, candidate)
    );
    if (!repository)
      throw new Error('The selected project is not in the authorized GitHub catalog.');
    return { project, repository };
  }
  async function branchFor(repository: GitHubCatalogRepository, branchNameValue: string) {
    const branchName = id(branchNameValue, 'branchName', 255);
    const details = await options.backend.getGitHubRepositoryDetails(repository.fullName);
    if (details.status !== 'connected')
      throw new Error('The selected repository details are unavailable.');
    const branch = details.branches.find((candidate) => candidate.name === branchName);
    if (!branch || !sha(branch.commitSha))
      throw new Error('The selected GitHub branch does not have an approved exact commit.');
    return { branchName, commitSha: branch.commitSha };
  }
  async function worktreeFor(request: WorktreeSetupInspectRequest) {
    const machineId = id(request.machineId, 'machineId', 256),
      projectId = id(request.projectId, 'projectId');
    await requireMachine(machineId);
    const { project, repository } = await repositoryFor(machineId, projectId);
    const machineProject =
      project ??
      (await options.backend.loadProjectDiscovery()).projects.find(
        (candidate) =>
          candidate.machineId === machineId && candidate.github?.fullName === repository.fullName
      );
    if (!machineProject)
      throw new Error('The selected project has not been discovered on this machine.');
    const worktreeId = id(request.worktreeId, 'worktreeId', 2048);
    const worktree = (
      await options.backend.loadProjectWorktrees(machineProject.rootPath, machineId)
    ).find((candidate) => candidate.id === worktreeId && candidate.status === 'ready');
    if (!worktree || !headSha(worktree))
      throw new Error('The selected stable worktree is not available on this machine.');
    return { machineId, projectId, repository, worktree };
  }
  function mapSetup(
    result: Extract<ConnectorWorktreeActionResult, { operation: 'setup.inspect' | 'setup.run' }>
  ): WorktreeSetupResult {
    return {
      capability: result.capability,
      checkedAt: result.checkedAt,
      ...(result.lastError
        ? {
            lastError:
              result.capability === 'unavailable'
                ? 'Trusted setup is unavailable.'
                : 'Trusted setup did not complete.'
          }
        : {}),
      machineId: result.machineId,
      projectId: result.projectId,
      steps: result.steps.map((step) => ({
        checkedAt: step.checkedAt,
        commitSha: step.commitSha,
        declarationDigest: step.declarationDigest,
        ...(step.finishedAt ? { finishedAt: step.finishedAt } : {}),
        ...(publicStepError(step.state) ? { lastError: publicStepError(step.state) } : {}),
        setupStepId: step.setupStepId,
        ...(step.startedAt ? { startedAt: step.startedAt } : {}),
        state: step.state
      })),
      worktreeId: result.worktreeId
    };
  }
  async function inspectResolved(target: Awaited<ReturnType<typeof worktreeFor>>) {
    const result = await options.connector.run(
      'setup.inspect',
      {
        expectedHeadSha: headSha(target.worktree)!,
        machineId: target.machineId,
        operation: 'setup.inspect',
        projectId: target.projectId,
        repositoryFullName: target.repository.fullName,
        worktreeId: target.worktree.id
      },
      actor()
    );
    if (result.operation !== 'setup.inspect')
      throw new Error('Connector returned an unexpected setup result.');
    return result;
  }
  return {
    async materialize(request: WorktreeMaterializeRequest): Promise<WorktreeMaterializeResult> {
      const machineId = id(request.machineId, 'machineId', 256),
        projectId = id(request.projectId, 'projectId');
      await requireMachine(machineId);
      const { repository } = await repositoryFor(machineId, projectId);
      const branch = await branchFor(repository, request.branchName);
      return exclusive(`${machineId}\0${repository.fullName}\0${branch.branchName}`, async () => {
        const result = await options.connector.run(
          'materialize',
          {
            ...branch,
            machineId,
            operation: 'materialize',
            projectId,
            repositoryFullName: repository.fullName
          },
          actor()
        );
        if (result.operation !== 'materialize')
          throw new Error('Connector returned an unexpected materialization result.');
        if (result.state === 'error' || !result.projectPath || !result.worktreePath)
          return {
            branchName: branch.branchName,
            checkedAt: result.checkedAt,
            commitSha: branch.commitSha,
            lastError: 'Worktree materialization failed on the selected machine.',
            machineId,
            projectId,
            state: 'error'
          };
        const refreshed = await options.backend.loadProjectWorktrees(result.projectPath, machineId);
        const worktree = refreshed.find(
          (candidate) =>
            candidate.branchName === branch.branchName &&
            headSha(candidate) === branch.commitSha &&
            candidate.path === result.worktreePath
        );
        if (!worktree)
          return {
            branchName: branch.branchName,
            checkedAt: now().toISOString(),
            commitSha: branch.commitSha,
            lastError: 'Git-authoritative discovery did not confirm the new worktree.',
            machineId,
            projectId,
            state: 'error'
          };
        return {
          branchName: branch.branchName,
          checkedAt: result.checkedAt,
          commitSha: branch.commitSha,
          machineId,
          projectId,
          state: result.state,
          worktreeId: worktree.id
        };
      });
    },
    async inspectSetup(request: WorktreeSetupInspectRequest) {
      return mapSetup(await inspectResolved(await worktreeFor(request)));
    },
    async runSetup(request: WorktreeSetupRunRequest) {
      const target = await worktreeFor(request);
      const setupStepId = id(request.setupStepId, 'setupStepId', 64);
      return exclusive(`${target.machineId}\0${target.worktree.id}\0${setupStepId}`, async () => {
        const inspected = await inspectResolved(target);
        const step = inspected.steps.find((candidate) => candidate.setupStepId === setupStepId);
        if (!step) throw new Error('The selected setup step is not declared by this repository.');
        const result = await options.connector.run(
          'setup.run',
          {
            declarationDigest: step.declarationDigest,
            expectedHeadSha: headSha(target.worktree)!,
            machineId: target.machineId,
            operation: 'setup.run',
            projectId: target.projectId,
            repositoryFullName: target.repository.fullName,
            setupStepId,
            worktreeId: target.worktree.id
          },
          actor()
        );
        if (result.operation !== 'setup.run')
          throw new Error('Connector returned an unexpected setup result.');
        return mapSetup(result);
      });
    }
  };
}
