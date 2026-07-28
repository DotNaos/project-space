import type {
  PullRequestFeedbackEligibility,
  PullRequestFeedbackReasonCode,
  PullRequestLiveDevelopmentContext,
  PullRequestTestSurface,
  PullRequestTestSurfaceKind,
  PullRequestTestSurfaceReasonCode,
  PullRequestTestSurfacesResult
} from '../../src/shared/pr-preview-test-surfaces-api';
import type {
  PullRequestDevServerLease,
  PullRequestDevServerScopeEvidence
} from './lease-service';
import {
  canonicalDeployedSurfaceUrl,
  canonicalTailscaleUrl,
  requireCommitSha,
  requirePullRequestNumber,
  requireRepositoryFullName,
  requireTimestamp
} from './validation';

type DeployedKind = Exclude<PullRequestTestSurfaceKind, 'dev-server'>;

export type PullRequestDeployedSurfaceEvidence =
  | {
      kind: DeployedKind;
      state: 'pending';
    }
  | {
      kind: DeployedKind;
      state: 'unavailable';
    }
  | {
      commitSha: string;
      kind: DeployedKind;
      state: 'available';
      url: string;
      verifiedAt: string;
    };

export type PullRequestMachineEvidence =
  | {
      checkedAt: string;
      connectorId: string;
      machineId: string;
      state: 'online';
    }
  | {
      checkedAt: string;
      connectorId: string;
      machineId: string;
      state: 'offline';
    };

export type PullRequestCodexTaskEvidence =
  | {
      branchName: string;
      checkedAt: string;
      commitSha: string;
      connectorId: string;
      machineId: string;
      state: 'available';
      threadId: string;
      worktreeId: string;
      writeCapabilityExpiresAt: string;
    }
  | {
      reason: 'missing' | 'unavailable';
      state: 'unavailable';
    };

export interface PullRequestTestSurfaceResolutionInput {
  checkedAt: string;
  deployedSurfaces: PullRequestDeployedSurfaceEvidence[];
  headSha: string;
  lease?: PullRequestDevServerLease;
  machineEvidence?: PullRequestMachineEvidence;
  pullRequestNumber: number;
  pullRequestState: 'closed' | 'open';
  registrationEvidence?: PullRequestDevServerScopeEvidence;
  repositoryAccess: 'authorized' | 'unauthorized' | 'unavailable';
  repositoryFullName: string;
  taskEvidence?: PullRequestCodexTaskEvidence;
}

const deployedKinds: DeployedKind[] = [
  'full-preview',
  'mobile-prototype',
  'desktop-prototype'
];
const liveEvidenceFreshnessMs = 45_000;

export function resolvePullRequestTestSurfaces(
  input: PullRequestTestSurfaceResolutionInput
): PullRequestTestSurfacesResult {
  const checkedAt = requireTimestamp(input.checkedAt, 'checkedAt');
  const repositoryFullName = requireRepositoryFullName(input.repositoryFullName);
  const pullRequestNumber = requirePullRequestNumber(input.pullRequestNumber);
  const headSha = requireCommitSha(input.headSha);

  const blockedReason = repositoryReason(input.repositoryAccess) ??
    (input.pullRequestState === 'closed' ? 'pull-request-closed' : undefined);
  const deployed = deployedKinds.map((kind) =>
    blockedReason
      ? unavailable(kind, 'unavailable', blockedReason)
      : resolveDeployed(kind, input.deployedSurfaces, pullRequestNumber, headSha)
  );
  const live = blockedReason
    ? unavailable('dev-server', 'unavailable', blockedReason)
    : resolveLive(input, checkedAt, repositoryFullName, pullRequestNumber, headSha);
  const liveContext = liveContextFrom(live, input.lease);
  const feedback = resolveFeedback(input, live, checkedAt, headSha);

  return {
    checkedAt,
    feedback,
    headSha,
    liveContext,
    pullRequestNumber,
    repositoryFullName,
    surfaces: [...deployed, live]
  };
}

function repositoryReason(
  access: PullRequestTestSurfaceResolutionInput['repositoryAccess']
): PullRequestTestSurfaceReasonCode | undefined {
  if (access === 'unauthorized') return 'repository-unauthorized';
  if (access === 'unavailable') return 'deployment-unavailable';
  return undefined;
}

function resolveDeployed(
  kind: DeployedKind,
  evidence: PullRequestDeployedSurfaceEvidence[],
  pullRequestNumber: number,
  headSha: string
): PullRequestTestSurface {
  const matches = evidence.filter((candidate) => candidate.kind === kind);
  if (matches.length !== 1) {
    return unavailable(kind, 'unavailable', 'deployment-not-published');
  }
  const candidate = matches[0]!;
  if (candidate.state === 'pending') {
    return unavailable(kind, 'pending', 'deployment-pending');
  }
  if (candidate.state === 'unavailable') {
    return unavailable(kind, 'unavailable', 'deployment-unavailable');
  }

  let commitSha: string;
  let verifiedAt: string;
  let url: string;
  try {
    commitSha = requireCommitSha(candidate.commitSha);
    verifiedAt = requireTimestamp(candidate.verifiedAt, 'verifiedAt');
    url = canonicalDeployedSurfaceUrl(candidate.url, kind, pullRequestNumber);
  } catch {
    return unavailable(kind, 'stale', 'deployment-verification-missing');
  }
  if (commitSha !== headSha) {
    return unavailable(kind, 'stale', 'deployment-head-mismatch');
  }
  return {
    commitSha,
    kind,
    source: 'deployed',
    state: 'available',
    url,
    verifiedAt
  };
}

function resolveLive(
  input: PullRequestTestSurfaceResolutionInput,
  checkedAt: string,
  repositoryFullName: string,
  pullRequestNumber: number,
  headSha: string
): PullRequestTestSurface {
  const lease = input.lease;
  if (!lease) {
    return unavailable('dev-server', 'unavailable', 'live-registration-missing');
  }
  if (lease.revokedAt) {
    return unavailable('dev-server', 'unavailable', 'live-server-stopped');
  }
  if (Date.parse(lease.expiresAt) <= Date.parse(checkedAt)) {
    return unavailable('dev-server', 'stale', 'live-heartbeat-expired');
  }
  const machine = input.machineEvidence;
  if (
    !machine ||
    machine.state !== 'online' ||
    !evidenceIsFresh(machine.checkedAt, checkedAt) ||
    machine.connectorId !== lease.connectorId ||
    machine.machineId !== lease.machineId
  ) {
    return unavailable('dev-server', 'stale', 'live-machine-offline');
  }
  if (
    lease.repositoryFullName.toLowerCase() !== repositoryFullName.toLowerCase() ||
    lease.pullRequestNumber !== pullRequestNumber ||
    lease.commitSha !== headSha ||
    !registrationMatchesLease(input.registrationEvidence, lease, checkedAt)
  ) {
    return unavailable('dev-server', 'stale', 'live-registration-mismatch');
  }
  try {
    if (
      canonicalTailscaleUrl(
        lease.tailscaleIpv4,
        lease.tailscalePort,
        lease.servedSurface
      ) !==
      lease.tailscaleUrl
    ) {
      return unavailable('dev-server', 'stale', 'live-registration-mismatch');
    }
  } catch {
    return unavailable('dev-server', 'stale', 'live-registration-mismatch');
  }
  return {
    commitSha: lease.commitSha,
    connectorId: lease.connectorId,
    kind: 'dev-server',
    leaseExpiresAt: lease.expiresAt,
    machineId: lease.machineId,
    servedSurface: lease.servedSurface,
    source: 'live',
    state: 'available',
    url: lease.tailscaleUrl,
    verifiedAt: lease.heartbeatAt
  };
}

function registrationMatchesLease(
  evidence: PullRequestDevServerScopeEvidence | undefined,
  lease: PullRequestDevServerLease,
  checkedAt: string
) {
  return Boolean(
    evidence &&
    evidence.state === 'verified' &&
    evidenceIsFresh(evidence.checkedAt, checkedAt) &&
    evidence.repositoryFullName.toLowerCase() === lease.repositoryFullName.toLowerCase() &&
    evidence.pullRequestNumber === lease.pullRequestNumber &&
    evidence.projectId === lease.projectId &&
    evidence.worktreeId === lease.worktreeId &&
    evidence.branchName === lease.branchName &&
    evidence.commitSha.toLowerCase() === lease.commitSha &&
    evidence.servedSurface === lease.servedSurface &&
    evidence.serverId === lease.serverId &&
    evidence.connectorId === lease.connectorId &&
    evidence.machineId === lease.machineId
  );
}

function resolveFeedback(
  input: PullRequestTestSurfaceResolutionInput,
  live: PullRequestTestSurface,
  checkedAt: string,
  headSha: string
): PullRequestFeedbackEligibility {
  if (live.state !== 'available') {
    return feedbackUnavailable(
      live.state === 'stale' ? 'stale' : 'unavailable',
      'feedback-not-live'
    );
  }
  const lease = input.lease!;
  if (!lease.codexThreadId) {
    return feedbackUnavailable('unavailable', 'feedback-task-missing');
  }
  const task = input.taskEvidence;
  if (!task || task.state === 'unavailable') {
    return feedbackUnavailable(
      task?.reason === 'missing' ? 'unavailable' : 'stale',
      task?.reason === 'missing' ? 'feedback-task-missing' : 'feedback-task-unavailable'
    );
  }
  if (
    task.threadId !== lease.codexThreadId ||
    task.connectorId !== lease.connectorId ||
    task.machineId !== lease.machineId ||
    task.worktreeId !== lease.worktreeId ||
    task.branchName !== lease.branchName ||
    task.commitSha.toLowerCase() !== headSha
  ) {
    return feedbackUnavailable('unavailable', 'feedback-task-mismatch');
  }
  if (!evidenceIsFresh(task.checkedAt, checkedAt)) {
    return feedbackUnavailable('stale', 'feedback-task-unavailable');
  }
  if (Date.parse(task.writeCapabilityExpiresAt) <= Date.parse(checkedAt)) {
    return feedbackUnavailable('stale', 'feedback-write-capability-expired');
  }
  return {
    state: 'available',
    threadId: lease.codexThreadId,
    verifiedAt: requireTimestamp(task.checkedAt, 'task.checkedAt')
  };
}

function evidenceIsFresh(value: string, checkedAt: string) {
  const observed = Date.parse(value);
  const current = Date.parse(checkedAt);
  const age = current - observed;
  return Number.isFinite(observed) &&
    Number.isFinite(current) &&
    age >= -5_000 &&
    age <= liveEvidenceFreshnessMs;
}

function unavailable(
  kind: PullRequestTestSurfaceKind,
  state: 'pending' | 'stale' | 'unavailable',
  reasonCode: PullRequestTestSurfaceReasonCode
): PullRequestTestSurface {
  return { kind, reasonCode, state };
}

function feedbackUnavailable(
  state: 'stale' | 'unavailable',
  reasonCode: PullRequestFeedbackReasonCode
): PullRequestFeedbackEligibility {
  return { reasonCode, state };
}

function liveContextFrom(
  live: PullRequestTestSurface,
  lease: PullRequestDevServerLease | undefined
): PullRequestLiveDevelopmentContext {
  if (live.kind === 'dev-server' && live.state === 'available' && lease) {
    return {
      connectorId: lease.connectorId,
      heartbeatAt: lease.heartbeatAt,
      leaseExpiresAt: lease.expiresAt,
      machineId: lease.machineId,
      servedSurface: lease.servedSurface,
      state: 'available',
      verifiedAt: live.verifiedAt
    };
  }
  return {
    reasonCode: live.state === 'available'
      ? 'live-registration-mismatch'
      : live.reasonCode,
    state: live.state === 'stale' ? 'stale' : 'unavailable'
  };
}
