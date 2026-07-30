import type {
  CodexSessionInspectResult,
  CodexSessionListResult
} from '../src/shared/codex-sessions-api';
import type {
  DevServerActionRequest,
  DevServerInspectRequest,
  DevServerOverviewResult,
  GitHubRepositoryDetailsResult,
  MachineRecord,
  PhysicalMachineRecord,
  ProjectDiscoveryResult,
  ProjectWorktreeRecord
} from '../src/shared/project-space-api';
import type {
  PullRequestPrototypeIdentity,
  PullRequestPrototypeEvidence,
  PullRequestPrototypeIterationRequest,
  PullRequestPrototypeIterationResult,
  PullRequestPrototypeIterationReason
} from '../src/shared/pr-prototype-iteration-api';
import type {
  AvailablePullRequestDevServerSurface
} from '../src/shared/pr-preview-test-surfaces-api';
import type { PullRequestDevServerLease } from './pr-test-surfaces/lease-service';

const evidenceFreshnessMs = 45_000;

interface IterationDependencies {
  devServers: {
    inspect(request: DevServerInspectRequest): Promise<DevServerOverviewResult>;
    start(request: DevServerActionRequest): Promise<DevServerOverviewResult>;
  };
  inspectCodexTask(
    userId: string,
    machineId: string,
    threadId: string
  ): Promise<CodexSessionInspectResult>;
  listCodexTasks(userId: string, machineId: string): Promise<CodexSessionListResult>;
  listConnectorMachines(): Promise<MachineRecord[]>;
  listPhysicalMachines(userId: string): Promise<PhysicalMachineRecord[]>;
  loadDiscovery(): Promise<ProjectDiscoveryResult>;
  loadRepository(repositoryFullName: string): Promise<GitHubRepositoryDetailsResult>;
  loadWorktrees(projectPath: string, machineId: string): Promise<ProjectWorktreeRecord[]>;
  now?: () => Date;
  register(input: {
    identity: PullRequestPrototypeIdentity;
    runtime: {
      checkedAt: string;
      state: 'running';
      tailscaleIpv4: string;
      tailscalePort: number;
    };
    userId: string;
  }): Promise<{
    lease: PullRequestDevServerLease;
  }>;
  scheduleHeartbeat?(input: {
    identity: PullRequestPrototypeIdentity;
    lease: PullRequestDevServerLease;
    userId: string;
  }): void;
}

class IterationBlocked extends Error {
  constructor(
    readonly state: Extract<
      PullRequestPrototypeIterationResult['state'],
      'mismatched' | 'offline' | 'stale' | 'unauthorized' | 'unavailable'
    >,
    readonly reasonCode: PullRequestPrototypeIterationReason,
    readonly evidence: PullRequestPrototypeEvidence
  ) {
    super(reasonCode);
  }
}

function normalizedRequest(input: PullRequestPrototypeIterationRequest) {
  const repositoryFullName = input.repositoryFullName.trim();
  const headSha = input.headSha.trim().toLowerCase();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryFullName)) {
    throw new TypeError('Invalid repositoryFullName.');
  }
  if (!Number.isSafeInteger(input.pullRequestNumber) || input.pullRequestNumber <= 0) {
    throw new TypeError('Invalid pullRequestNumber.');
  }
  if (!/^[0-9a-f]{40}$/.test(headSha)) throw new TypeError('Invalid headSha.');
  if (!['desktop-prototype', 'mobile-prototype'].includes(input.surface)) {
    throw new TypeError('Invalid prototype surface.');
  }
  return { ...input, headSha, repositoryFullName };
}

function blocked(
  checkedAt: string,
  error: unknown,
  input: PullRequestPrototypeIterationRequest
): PullRequestPrototypeIterationResult {
  if (error instanceof IterationBlocked) {
    return {
      action: 'none',
      checkedAt,
      evidence: error.evidence,
      reasonCode: error.reasonCode,
      state: error.state
    };
  }
  return {
    action: 'none',
    checkedAt,
    evidence: {
      headSha: input.headSha,
      pullRequestNumber: input.pullRequestNumber,
      repositoryFullName: input.repositoryFullName
    },
    reasonCode: 'repository-unavailable',
    state: 'unavailable'
  };
}

function isFresh(value: string | undefined, checkedAt: Date) {
  const observed = value ? Date.parse(value) : Number.NaN;
  const age = checkedAt.getTime() - observed;
  return Number.isFinite(observed) && age >= -5_000 && age <= evidenceFreshnessMs;
}

function containsPath(root: string, candidate: string | undefined) {
  if (!candidate) return false;
  const normalizedRoot = root.replace(/\/+$/, '');
  return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`);
}

function serverIdFor(surface: PullRequestPrototypeIterationRequest['surface']) {
  return surface === 'mobile-prototype' ? 'prototype-mobile' : 'prototype-desktop';
}

function sameIdentity(
  left: PullRequestPrototypeIdentity,
  right: PullRequestPrototypeIdentity
) {
  return (
    left.repositoryFullName.toLowerCase() === right.repositoryFullName.toLowerCase() &&
    left.pullRequestNumber === right.pullRequestNumber &&
    left.headSha === right.headSha &&
    left.branchName === right.branchName &&
    left.connectorId === right.connectorId &&
    left.machineId === right.machineId &&
    left.projectId === right.projectId &&
    left.worktreeId === right.worktreeId &&
    left.worktreePath === right.worktreePath &&
    left.codexTask.threadId === right.codexTask.threadId &&
    left.serverId === right.serverId &&
    left.surface === right.surface
  );
}

export function createPullRequestPrototypeIterationService(
  dependencies: IterationDependencies
) {
  const now = dependencies.now ?? (() => new Date());

  async function discover(
    userId: string,
    input: PullRequestPrototypeIterationRequest
  ): Promise<{
    checkedAt: string;
    identity: PullRequestPrototypeIdentity;
    serverStartedAt?: string;
    serverState: import('../src/shared/dev-server-api').DevServerState;
  }> {
    const request = normalizedRequest(input);
    const evidence: PullRequestPrototypeEvidence = {
      headSha: request.headSha,
      pullRequestNumber: request.pullRequestNumber,
      repositoryFullName: request.repositoryFullName
    };
    const fail = (
      state: IterationBlocked['state'],
      reasonCode: PullRequestPrototypeIterationReason
    ) => new IterationBlocked(state, reasonCode, { ...evidence });
    const checkedAtDate = now();
    const checkedAt = checkedAtDate.toISOString();
    const repository = await dependencies.loadRepository(request.repositoryFullName);
    if (repository.status !== 'connected') {
      throw fail(
        repository.status === 'unauthorized' || repository.status === 'auth-required'
          ? 'unauthorized'
          : 'unavailable',
        repository.status === 'unauthorized' || repository.status === 'auth-required'
          ? 'repository-unauthorized'
          : 'repository-unavailable'
      );
    }
    const pullRequest = repository.pullRequests.find(
      (candidate) => candidate.number === request.pullRequestNumber
    );
    if (!pullRequest || pullRequest.state !== 'open' || !pullRequest.headBranch) {
      throw fail('unavailable', 'pull-request-closed');
    }
    evidence.branchName = pullRequest.headBranch;
    if (pullRequest.headSha?.toLowerCase() !== request.headSha) {
      throw fail('mismatched', 'head-mismatch');
    }

    const [discovery, connectors, physicalMachines] = await Promise.all([
      dependencies.loadDiscovery(),
      dependencies.listConnectorMachines(),
      dependencies.listPhysicalMachines(userId)
    ]);
    const projects = discovery.projects.filter((project) =>
      project.machineId &&
      project.github?.fullName.toLowerCase() === request.repositoryFullName.toLowerCase()
    );
    if (projects.length !== 1 || !projects[0]!.machineId) {
      throw fail(
        projects.length > 1 ? 'mismatched' : 'unavailable',
        projects.length > 1 ? 'evidence-ambiguous' : 'worktree-missing'
      );
    }
    const project = projects[0]!;
    const connectorId = project.machineId!;
    evidence.connectorId = connectorId;
    evidence.projectId = project.id;
    const physicalMatches = physicalMachines.filter((machine) =>
      machine.connectorIds.includes(connectorId)
    );
    if (physicalMatches.length !== 1) {
      throw fail(
        physicalMatches.length > 1 ? 'mismatched' : 'unauthorized',
        physicalMatches.length > 1 ? 'evidence-ambiguous' : 'repository-unauthorized'
      );
    }
    evidence.machineId = physicalMatches[0]!.id;
    evidence.machineName = physicalMatches[0]!.name;
    const connector = connectors.find((candidate) => candidate.id === connectorId);
    if (!connector || connector.connector.status !== 'online') {
      throw fail('offline', 'machine-offline');
    }
    if (!isFresh(connector.connector.lastSeen, checkedAtDate)) {
      throw fail('stale', 'machine-stale');
    }

    const worktrees = await dependencies.loadWorktrees(project.rootPath, connectorId);
    const exactWorktrees = worktrees.filter((worktree) =>
      worktree.status === 'ready' &&
      worktree.branchName === pullRequest.headBranch &&
      worktree.headSha?.toLowerCase() === request.headSha
    );
    if (exactWorktrees.length !== 1) {
      const branchExists = worktrees.some((worktree) => worktree.branchName === pullRequest.headBranch);
      throw fail(
        exactWorktrees.length > 1 || branchExists ? 'mismatched' : 'unavailable',
        exactWorktrees.length > 1 ? 'evidence-ambiguous' :
          branchExists ? 'worktree-mismatched' : 'worktree-missing'
      );
    }
    const worktree = exactWorktrees[0]!;
    evidence.worktreeId = worktree.id;
    evidence.worktreePath = worktree.path;
    const taskList = await dependencies.listCodexTasks(userId, connectorId);
    if (taskList.inventoryState !== 'live' || !isFresh(taskList.checkedAt, checkedAtDate)) {
      throw fail('stale', 'codex-task-stale');
    }
    const taskCandidates = taskList.sessions.filter((session) =>
      !session.archived &&
      ['active', 'idle'].includes(session.status) &&
      containsPath(worktree.path, session.cwd)
    );
    if (taskCandidates.length !== 1) {
      throw fail(
        taskCandidates.length > 1 ? 'mismatched' : 'unavailable',
        taskCandidates.length > 1 ? 'evidence-ambiguous' : 'codex-task-missing'
      );
    }
    const task = taskCandidates[0]!;
    const inspection = await dependencies.inspectCodexTask(userId, connectorId, task.id);
    const capability = inspection.writeCapability;
    if (
      inspection.taskLocation.worktreeRoot !== worktree.path ||
      !isFresh(inspection.checkedAt, checkedAtDate)
    ) {
      throw fail('mismatched', 'codex-task-mismatched');
    }
    if (
      !capability ||
      capability.state !== 'ready' ||
      !capability.canContinue ||
      Date.parse(capability.expiresAt) <= checkedAtDate.getTime()
    ) {
      throw fail('stale', 'codex-task-stale');
    }
    evidence.codexTask = {
      checkedAt: inspection.checkedAt,
      threadId: task.id,
      title: task.title
    };

    const serverId = serverIdFor(request.surface);
    evidence.serverId = serverId;
    const overview = await dependencies.devServers.inspect({
      machineId: connectorId,
      projectId: project.id
    });
    const declared = overview.servers.find((server) =>
      server.worktreeId === worktree.id &&
      server.serverId === serverId &&
      server.capability === 'configured'
    );
    if (!declared || !['owner', 'member'].includes(overview.access)) {
      throw fail('unavailable', 'dev-server-undeclared');
    }

    return {
      checkedAt,
      identity: {
        branchName: pullRequest.headBranch,
        codexTask: {
          checkedAt: inspection.checkedAt,
          threadId: task.id,
          title: task.title
        },
        connectorId,
        headSha: request.headSha,
        machineId: physicalMatches[0]!.id,
        machineName: physicalMatches[0]!.name,
        projectId: project.id,
        pullRequestNumber: request.pullRequestNumber,
        repositoryFullName: request.repositoryFullName,
        serverId,
        surface: request.surface,
        worktreeId: worktree.id,
        worktreePath: worktree.path
      },
      ...(declared.startedAt ? { serverStartedAt: declared.startedAt } : {}),
      serverState: declared.state
    };
  }

  async function read(
    userId: string,
    input: PullRequestPrototypeIterationRequest,
    live?: AvailablePullRequestDevServerSurface
  ): Promise<PullRequestPrototypeIterationResult> {
    const checkedAt = now().toISOString();
    try {
      const target = await discover(userId, input);
      const responseTime = now();
      if (
        live &&
        live.commitSha === target.identity.headSha &&
        live.connectorId === target.identity.connectorId &&
        live.machineId === target.identity.machineId &&
        live.servedSurface === target.identity.surface &&
        Date.parse(live.leaseExpiresAt) > responseTime.getTime() &&
        isFresh(live.verifiedAt, responseTime)
      ) {
        return {
          action: 'open',
          checkedAt: target.checkedAt,
          identity: target.identity,
          leaseExpiresAt: live.leaseExpiresAt,
          state: 'available',
          url: live.url
        };
      }
      return {
        action: 'start',
        checkedAt: target.checkedAt,
        identity: target.identity,
        ...(target.serverStartedAt ? { serverStartedAt: target.serverStartedAt } : {}),
        serverState: target.serverState,
        state: 'startable'
      };
    } catch (error) {
      return blocked(checkedAt, error, input);
    }
  }

  async function start(
    userId: string,
    input: PullRequestPrototypeIterationRequest
  ): Promise<PullRequestPrototypeIterationResult> {
    const checkedAt = now().toISOString();
    try {
      const target = await discover(userId, input);
      const overview = await dependencies.devServers.start({
        machineId: target.identity.connectorId,
        projectId: target.identity.projectId,
        serverId: target.identity.serverId,
        worktreeId: target.identity.worktreeId
      });
      const verifiedAfterStart = await discover(userId, input);
      if (!sameIdentity(target.identity, verifiedAfterStart.identity)) {
        throw new IterationBlocked(
          'mismatched',
          'worktree-mismatched',
          {
            ...verifiedAfterStart.identity,
            codexTask: verifiedAfterStart.identity.codexTask
          }
        );
      }
      const identity = verifiedAfterStart.identity;
      const server = overview.servers.find((candidate) =>
        candidate.worktreeId === identity.worktreeId &&
        candidate.serverId === identity.serverId
      );
      if (
        !server ||
        server.state !== 'running' ||
        !server.tailscaleIPv4 ||
        !server.publicPort ||
        !isFresh(server.checkedAt, now())
      ) {
        throw new IterationBlocked(
          'unavailable',
          'dev-server-undeclared',
          {
            ...identity,
            codexTask: identity.codexTask
          }
        );
      }
      const lease = await dependencies.register({
        identity,
        runtime: {
          checkedAt: server.checkedAt,
          state: 'running',
          tailscaleIpv4: server.tailscaleIPv4,
          tailscalePort: server.publicPort
        },
        userId
      });
      dependencies.scheduleHeartbeat?.({
        identity,
        lease: lease.lease,
        userId
      });
      return {
        action: 'open',
        checkedAt: verifiedAfterStart.checkedAt,
        identity,
        leaseExpiresAt: lease.lease.expiresAt,
        state: 'available',
        url: lease.lease.tailscaleUrl
      };
    } catch (error) {
      return blocked(checkedAt, error, input);
    }
  }

  return { read, start };
}
