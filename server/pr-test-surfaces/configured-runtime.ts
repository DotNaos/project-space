import { randomUUID } from 'node:crypto';

import type {
  PullRequestDevServerHeartbeatRequest,
  PullRequestDevServerRegistrationRequest,
  PullRequestDevServerReleaseRequest,
  PullRequestPrototypeFeedbackRequest,
  PullRequestPrototypeFeedbackResult,
  PullRequestTestSurfacesResult
} from '../../src/shared/pr-preview-test-surfaces-api';
import type { ProjectSpaceBackend } from '../../src/shared/project-space-api';
import {
  getRegisteredConnectorMachines,
  getRegisteredConnectorRegistries
} from '../connector-hub';
import { createConfiguredCodexSessionsRuntime } from '../codex-sessions/configured-runtime';
import {
  getMachineConnectionDatabaseClient,
  isDatabaseConfigured,
  listPhysicalMachines
} from '../local-database-store';
import { getPullRequestPreviewStatus } from '../pull-request-preview-status';
import {
  createPullRequestDevServerLeaseService,
  InMemoryPullRequestDevServerLeaseStore,
  type PullRequestDevServerActor,
  type PullRequestDevServerLeaseStore,
  type PullRequestDevServerScopeEvidence
} from './lease-service';
import { PostgresPullRequestDevServerLeaseStore } from './postgres-lease-store';
import {
  resolvePullRequestTestSurfaces,
  type PullRequestCodexTaskEvidence,
  type PullRequestDeployedSurfaceEvidence,
  type PullRequestMachineEvidence
} from './state-resolver';

export class PullRequestFeedbackUnavailableError extends Error {}

const memoryStore = new InMemoryPullRequestDevServerLeaseStore();
let databaseStore: Promise<PostgresPullRequestDevServerLeaseStore> | undefined;
let codexRuntime: ReturnType<typeof createConfiguredCodexSessionsRuntime> | undefined;

async function configuredStore(): Promise<PullRequestDevServerLeaseStore> {
  if (!isDatabaseConfigured()) return memoryStore;
  databaseStore ??= getMachineConnectionDatabaseClient()
    .then((client) => new PostgresPullRequestDevServerLeaseStore(client));
  return databaseStore;
}

async function registeredScope(
  actor: PullRequestDevServerActor,
  registration: Omit<
    PullRequestDevServerRegistrationRequest,
    'connectorId' | 'machineId' | 'runtime'
  >
): Promise<PullRequestDevServerScopeEvidence | null> {
  if (!isDatabaseConfigured()) return null;
  const machines = await listPhysicalMachines(actor.userId);
  const physicalMachine = machines.find((machine) =>
    machine.id === actor.machineId && machine.connectorIds.includes(actor.connectorId)
  );
  if (!physicalMachine) return null;
  const connector = (await getRegisteredConnectorRegistries()).find(
    (entry) => entry.registry.connector.machineId === actor.connectorId
  );
  if (!connector) return null;
  const project = connector.registry.discovery.projects.find(
    (candidate) => candidate.id === registration.projectId
  );
  if (
    !project ||
    project.github?.fullName?.toLowerCase() !== registration.repositoryFullName.toLowerCase() ||
    prototypeSurfaceForServer(registration.serverId) !== registration.servedSurface
  ) {
    return null;
  }
  return {
    branchName: registration.branchName,
    checkedAt: new Date().toISOString(),
    commitSha: registration.commitSha,
    connectorId: actor.connectorId,
    machineId: actor.machineId,
    projectId: registration.projectId,
    pullRequestNumber: registration.pullRequestNumber,
    repositoryFullName: registration.repositoryFullName,
    servedSurface: registration.servedSurface,
    serverId: registration.serverId,
    state: 'verified',
    worktreeId: registration.worktreeId
  };
}

async function leaseService() {
  return createPullRequestDevServerLeaseService({
    store: await configuredStore(),
    verifyScope: registeredScope
  });
}

export async function registerConfiguredPullRequestDevServer(
  actor: PullRequestDevServerActor,
  request: PullRequestDevServerRegistrationRequest
) {
  return (await leaseService()).register(actor, {
    branchName: request.branchName,
    codexThreadId: request.codexThreadId,
    commitSha: request.commitSha,
    projectId: request.projectId,
    pullRequestNumber: request.pullRequestNumber,
    repositoryFullName: request.repositoryFullName,
    runtime: request.runtime,
    servedSurface: request.servedSurface,
    serverId: request.serverId,
    worktreeId: request.worktreeId
  });
}

export async function heartbeatConfiguredPullRequestDevServer(
  actor: PullRequestDevServerActor,
  request: PullRequestDevServerHeartbeatRequest
) {
  return (await leaseService()).heartbeat({
    actor,
    generation: request.generation,
    leaseId: request.leaseId,
    runtime: request.runtime,
    servedSurface: request.servedSurface
  });
}

export async function releaseConfiguredPullRequestDevServer(
  actor: PullRequestDevServerActor,
  request: PullRequestDevServerReleaseRequest
) {
  return (await leaseService()).release({
    actor,
    generation: request.generation,
    leaseId: request.leaseId
  });
}

export async function readConfiguredPullRequestTestSurfaces(input: {
  backend: ProjectSpaceBackend;
  pullRequestNumber: number;
  repositoryFullName: string;
  userId: string;
}): Promise<PullRequestTestSurfacesResult> {
  const checkedAt = new Date().toISOString();
  const details = await input.backend.getGitHubRepositoryDetails(input.repositoryFullName);
  const pullRequest = details.status === 'connected'
    ? details.pullRequests.find((candidate) => candidate.number === input.pullRequestNumber)
    : undefined;
  const repositoryAccess = details.status === 'connected'
    ? 'authorized'
    : ['error', 'rate-limited'].includes(details.status)
      ? 'unavailable'
      : 'unauthorized';
  const headSha = pullRequest?.headSha ?? '0'.repeat(40);
  const previewStatus = repositoryAccess === 'authorized'
    ? await getPullRequestPreviewStatus(input.repositoryFullName, input.pullRequestNumber)
    : undefined;
  const deployedSurfaces = deployedEvidence(previewStatus?.previews[0]);
  const store = await configuredStore();
  const lease = await store.readCurrent({
    ownerUserId: input.userId,
    pullRequestNumber: input.pullRequestNumber,
    repositoryFullName: input.repositoryFullName
  }) ?? undefined;
  const machineEvidence = lease
    ? await currentMachineEvidence(input.userId, lease.machineId, lease.connectorId)
    : undefined;
  const registrationEvidence = lease
    ? await currentRegistrationEvidence(input.backend, lease)
    : undefined;
  const taskEvidence = lease?.codexThreadId && machineEvidence?.state === 'online'
    ? await currentTaskEvidence(input.backend, input.userId, lease).catch(() => ({
        reason: 'unavailable' as const,
        state: 'unavailable' as const
      }))
    : undefined;

  return resolvePullRequestTestSurfaces({
    checkedAt,
    deployedSurfaces,
    headSha,
    lease,
    machineEvidence,
    pullRequestNumber: input.pullRequestNumber,
    pullRequestState: pullRequest?.state === 'open' ? 'open' : 'closed',
    registrationEvidence,
    repositoryAccess,
    repositoryFullName: input.repositoryFullName,
    taskEvidence
  });
}

export async function sendConfiguredPullRequestPrototypeFeedback(input: {
  backend: ProjectSpaceBackend;
  feedback: PullRequestPrototypeFeedbackRequest;
  userId: string;
}): Promise<PullRequestPrototypeFeedbackResult> {
  const comment = boundedFeedbackText(input.feedback.comment, 'comment', 4_000);
  const scenario = boundedFeedbackText(input.feedback.scenario, 'scenario', 128);
  const selectedElement = optionalFeedbackText(
    input.feedback.selectedElement,
    'selectedElement',
    1_000
  );
  const screenshotContext = optionalFeedbackText(
    input.feedback.screenshotContext,
    'screenshotContext',
    2_000
  );
  const result = await readConfiguredPullRequestTestSurfaces({
    backend: input.backend,
    pullRequestNumber: input.feedback.pullRequestNumber,
    repositoryFullName: input.feedback.repositoryFullName,
    userId: input.userId
  });
  if (result.feedback.state !== 'available') {
    throw new PullRequestFeedbackUnavailableError(result.feedback.reasonCode);
  }
  const lease = await (await configuredStore()).readCurrent({
    ownerUserId: input.userId,
    pullRequestNumber: input.feedback.pullRequestNumber,
    repositoryFullName: input.feedback.repositoryFullName
  });
  if (
    !lease ||
    lease.codexThreadId !== result.feedback.threadId ||
    lease.servedSurface !== input.feedback.surface
  ) {
    throw new PullRequestFeedbackUnavailableError('feedback-task-mismatch');
  }
  codexRuntime ??= createConfiguredCodexSessionsRuntime();
  await (await codexRuntime).service.continue(
    { userId: input.userId },
    {
      machineId: lease.connectorId,
      message: [
        'Prototype feedback',
        `Repository: ${result.repositoryFullName}`,
        `PR: #${result.pullRequestNumber}`,
        `Commit: ${result.headSha}`,
        `Surface: ${input.feedback.surface}`,
        `Scenario: ${scenario}`,
        `Viewport: ${input.feedback.viewport}`,
        ...(selectedElement ? [`Selected element: ${selectedElement}`] : []),
        ...(screenshotContext ? [`Screenshot context: ${screenshotContext}`] : []),
        '',
        comment
      ].join('\n'),
      operationId: randomUUID(),
      threadId: lease.codexThreadId
    }
  );
  return { state: 'sent', threadId: lease.codexThreadId };
}

function deployedEvidence(
  preview: Awaited<ReturnType<typeof getPullRequestPreviewStatus>>['previews'][number] | undefined
): PullRequestDeployedSurfaceEvidence[] {
  if (!preview) {
    return [
      { kind: 'full-preview', state: 'unavailable' },
      { kind: 'mobile-prototype', state: 'unavailable' },
      { kind: 'desktop-prototype', state: 'unavailable' }
    ];
  }
  const pending = !['ready', 'update-failed', 'removed'].includes(preview.state);
  const unavailable = (kind: PullRequestDeployedSurfaceEvidence['kind']) => ({
    kind,
    state: pending ? 'pending' as const : 'unavailable' as const
  });
  const verifiedAt = preview.verifiedAt ?? preview.updatedAt;
  const full = preview.liveUrl && preview.runningSha && verifiedAt
    ? {
        commitSha: preview.runningSha,
        kind: 'full-preview' as const,
        state: 'available' as const,
        url: preview.liveUrl,
        verifiedAt
      }
    : unavailable('full-preview');
  const desktop = preview.prototypeUrl && preview.prototypeMetaSha && verifiedAt
    ? {
        commitSha: preview.prototypeMetaSha,
        kind: 'desktop-prototype' as const,
        state: 'available' as const,
        url: preview.prototypeUrl,
        verifiedAt
      }
    : unavailable('desktop-prototype');
  const mobile = desktop.state === 'available'
    ? {
        ...desktop,
        kind: 'mobile-prototype' as const,
        url: desktop.url.replace('/prototype/desktop/', '/prototype/mobile/')
      }
    : unavailable('mobile-prototype');
  return [full, mobile, desktop];
}

async function currentMachineEvidence(
  userId: string,
  machineId: string,
  connectorId: string
): Promise<PullRequestMachineEvidence | undefined> {
  const [machines, physicalMachines] = await Promise.all([
    getRegisteredConnectorMachines(),
    isDatabaseConfigured() ? listPhysicalMachines(userId) : Promise.resolve([])
  ]);
  if (!physicalMachines.some((machine) =>
    machine.id === machineId && machine.connectorIds.includes(connectorId)
  )) return undefined;
  const connector = machines.find((machine) => machine.id === connectorId);
  return connector ? {
    checkedAt: connector.connector.lastSeen ?? new Date().toISOString(),
    connectorId,
    machineId,
    state: connector.connector.status === 'online' ? 'online' : 'offline'
  } : undefined;
}

async function currentTaskEvidence(
  backend: ProjectSpaceBackend,
  userId: string,
  lease: NonNullable<Awaited<ReturnType<PullRequestDevServerLeaseStore['readCurrent']>>>
): Promise<PullRequestCodexTaskEvidence> {
  const discovery = await backend.loadProjectDiscovery();
  const project = discovery.projects.find((candidate) =>
    candidate.id === lease.projectId && candidate.machineId === lease.connectorId
  );
  if (!project) return { reason: 'missing', state: 'unavailable' };
  const worktrees = await backend.loadProjectWorktrees(project.rootPath, lease.connectorId);
  const worktree = worktrees.find((candidate) => candidate.id === lease.worktreeId);
  if (!worktree || !lease.codexThreadId) {
    return { reason: 'missing', state: 'unavailable' };
  }
  codexRuntime ??= createConfiguredCodexSessionsRuntime();
  const inspection = await (await codexRuntime).service.inspect(
    { userId },
    { machineId: lease.connectorId, threadId: lease.codexThreadId }
  );
  const capability = inspection.writeCapability;
  if (
    inspection.taskLocation.worktreeRoot !== worktree.path ||
    !worktree.branchName ||
    !worktree.headSha ||
    !capability ||
    capability.state !== 'ready' ||
    !capability.canContinue
  ) {
    return { reason: 'unavailable', state: 'unavailable' };
  }
  return {
    branchName: worktree.branchName,
    checkedAt: inspection.checkedAt,
    commitSha: worktree.headSha,
    connectorId: lease.connectorId,
    machineId: lease.machineId,
    state: 'available',
    threadId: lease.codexThreadId,
    worktreeId: worktree.id,
    writeCapabilityExpiresAt: capability.expiresAt
  };
}

async function currentRegistrationEvidence(
  backend: ProjectSpaceBackend,
  lease: NonNullable<Awaited<ReturnType<PullRequestDevServerLeaseStore['readCurrent']>>>
): Promise<PullRequestDevServerScopeEvidence | undefined> {
  const discovery = await backend.loadProjectDiscovery();
  const project = discovery.projects.find((candidate) =>
    candidate.id === lease.projectId &&
    candidate.machineId === lease.connectorId &&
    candidate.github?.fullName?.toLowerCase() === lease.repositoryFullName.toLowerCase()
  );
  if (!project || prototypeSurfaceForServer(lease.serverId) !== lease.servedSurface) {
    return undefined;
  }
  const worktrees = await backend.loadProjectWorktrees(project.rootPath, lease.connectorId);
  const worktree = worktrees.find((candidate) => candidate.id === lease.worktreeId);
  if (
    !worktree ||
    worktree.branchName !== lease.branchName ||
    worktree.headSha !== lease.commitSha
  ) {
    return undefined;
  }
  return {
    branchName: worktree.branchName,
    checkedAt: new Date().toISOString(),
    commitSha: worktree.headSha,
    connectorId: lease.connectorId,
    machineId: lease.machineId,
    projectId: project.id,
    pullRequestNumber: lease.pullRequestNumber,
    repositoryFullName: lease.repositoryFullName,
    servedSurface: lease.servedSurface,
    serverId: lease.serverId,
    state: 'verified',
    worktreeId: worktree.id
  };
}

function prototypeSurfaceForServer(serverId: string) {
  if (serverId === 'prototype-desktop') return 'desktop-prototype';
  if (serverId === 'prototype-mobile') return 'mobile-prototype';
  return undefined;
}

function boundedFeedbackText(value: string, name: string, maximum: number) {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)
  ) {
    throw new TypeError(`${name} is invalid.`);
  }
  return normalized;
}

function optionalFeedbackText(
  value: string | undefined,
  name: string,
  maximum: number
) {
  return value === undefined ? undefined : boundedFeedbackText(value, name, maximum);
}
