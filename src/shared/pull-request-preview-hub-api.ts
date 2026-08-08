import type { PullRequestPreviewLifecycle, PullRequestPreviewStatus } from './project-space-api';

export type PreviewHubLifecycleState =
  | 'not_deployed'
  | 'building'
  | 'ready'
  | 'starting'
  | 'online'
  | 'stopping'
  | 'failed'
  | 'expired'
  | 'removed';

export type PreviewHubFailureCode =
  | 'capacity_requires_choice'
  | 'storage_blocked'
  | 'head_changed'
  | 'not_open'
  | 'not_found'
  | 'unauthorized'
  | 'rate_limited'
  | 'unhealthy'
  | 'invalid_return_target'
  | 'transition_invalid'
  | 'operation_failed';

export interface PreviewHubRecord {
  author?: { avatarUrl?: string; login: string };
  capacityBlocked?: boolean;
  changeIdentity?: string;
  checksStatus?: 'passing' | 'failing' | 'pending' | 'unknown';
  currentHeadSha?: string;
  failureCode?: PreviewHubFailureCode;
  failureMessage?: string;
  headBranch?: string;
  isDraft?: boolean;
  lastActivityAt?: string;
  activeLeaseExpiresAt?: string;
  lastVerifiedAt?: string;
  lifecycle: PreviewHubLifecycleState;
  pullRequestNumber: number;
  pullRequestState?: 'open' | 'closed' | 'merged';
  pullRequestTitle?: string;
  pullRequestUrl?: string;
  requestedHeadSha: string;
  repositoryFullName: string;
  returnTarget?: string;
  safeStorageBytes?: number;
  stateChangedAt: string;
  verifiedRunningHeadSha?: string;
  previewUrl?: string;
  allowedActions: Array<'open' | 'start' | 'stop' | 'deploy'>;
}

export interface PreviewHubCapacityCandidate {
  pullRequestNumber: number;
  repositoryFullName: string;
  requestedHeadSha: string;
  lastActivityAt?: string;
  lastVerifiedAt?: string;
  previewUrl?: string;
}

export interface PreviewHubInventoryResult {
  checkedAt: string;
  inventoryRevision: string;
  maxOnline: number;
  onlineCount: number;
  occupiedCount: number;
  previews: PreviewHubRecord[];
  repositoryFullName: string;
  status: 'available' | 'unauthorized' | 'unavailable';
  storage?: {
    budgetBytes?: number;
    usedBytes?: number;
    minimumFreeBytes?: number;
    freeBytes?: number;
    state: 'available' | 'blocked' | 'unknown';
  };
}

export interface PreviewHubStartRequest {
  inventoryRevision?: string;
  pullRequestNumber: number;
  repositoryFullName: string;
  requestedHeadSha: string;
  returnTarget?: string;
  selectedReplacementPullRequestNumber?: number;
  selectedReplacementRepositoryFullName?: string;
  selectedReplacementHeadSha?: string;
}

export interface PreviewHubStopRequest {
  pullRequestNumber: number;
  repositoryFullName: string;
  requestedHeadSha: string;
}

export interface PreviewHubTouchRequest {
  pullRequestNumber: number;
  repositoryFullName: string;
  requestedHeadSha: string;
}

export type PreviewHubMutationResult =
  | {
      code: 'accepted';
      inventoryRevision: string;
      lifecycle: 'building' | 'starting' | 'stopping' | 'online';
      pullRequestNumber: number;
      returnTarget?: string;
    }
  | {
      code: 'capacity_requires_choice';
      inventoryRevision: string;
      online: PreviewHubCapacityCandidate[];
    }
  | {
      code: Exclude<PreviewHubFailureCode, 'capacity_requires_choice'>;
      message: string;
    };

export function previewHubLifecycleFromLegacyState(
  state: PullRequestPreviewLifecycle,
  hasVerifiedRunningHead: boolean
): PreviewHubLifecycleState {
  if (state === 'not-deployed') return 'not_deployed';
  if (state === 'removed') return 'removed';
  if (state === 'starting' || state === 'stopping') return state;
  if (state === 'expired') return 'expired';
  if (state === 'failed-initial' || state === 'update-failed' || state === 'cleanup-failed') {
    return 'failed';
  }
  if (state === 'ready') return hasVerifiedRunningHead ? 'online' : 'ready';
  if (state === 'deleting' || state === 'cleanup-queued') return 'stopping';
  if (state === 'deploying' || state === 'verifying' || state === 'waiting-for-lock') return 'starting';
  if (state === 'building' || state === 'validating' || state === 'queued') return 'building';
  return hasVerifiedRunningHead ? 'online' : 'failed';
}

export function previewHubRecordFromLegacyStatus(
  preview: PullRequestPreviewStatus,
  now = new Date().toISOString()
): PreviewHubRecord {
  const requestedHeadSha = preview.requestedSha ?? preview.currentHeadSha;
  const exactOpenHead = preview.pullRequestState === 'open' &&
    Boolean(requestedHeadSha) &&
    preview.currentHeadSha === requestedHeadSha;
  const verifiedRunningHeadSha = exactOpenHead && preview.runningSha && preview.prototypeHealthy &&
    preview.prototypeMetaSha === preview.runningSha &&
    preview.runningSha === requestedHeadSha ? preview.runningSha : undefined;
  const lifecycle = previewHubLifecycleFromLegacyState(preview.state, Boolean(verifiedRunningHeadSha));
  const isOnline = lifecycle === 'online';
  const capacityBlocked = preview.capacityBlocked || (
    preview.state === 'online' &&
    Boolean(preview.runningSha) &&
    Boolean(preview.currentHeadSha) &&
    preview.currentHeadSha !== preview.runningSha
  );
  return {
    author: preview.author,
    capacityBlocked,
    activeLeaseExpiresAt: preview.activeLeaseExpiresAt,
    changeIdentity: preview.pullRequestTitle,
    checksStatus: preview.checksStatus,
    currentHeadSha: preview.currentHeadSha,
    failureCode: lifecycle === 'failed' ? 'operation_failed' : undefined,
    failureMessage: lifecycle === 'failed' ? preview.message : undefined,
    headBranch: preview.headBranch,
    isDraft: preview.isDraft,
    lastActivityAt: preview.lastActivityAt,
    lifecycle,
    pullRequestNumber: preview.pullRequestNumber,
    pullRequestState: preview.pullRequestState,
    pullRequestTitle: preview.pullRequestTitle,
    pullRequestUrl: preview.pullRequestUrl,
    requestedHeadSha: requestedHeadSha ?? '',
    repositoryFullName: preview.repositoryFullName,
    safeStorageBytes: preview.safeStorageBytes,
    stateChangedAt: preview.updatedAt ?? now,
    verifiedRunningHeadSha: isOnline ? verifiedRunningHeadSha : undefined,
    lastVerifiedAt: preview.verifiedAt,
    previewUrl: isOnline ? preview.liveUrl : undefined,
    allowedActions: isOnline
      ? ['open', 'stop']
      : capacityBlocked
        ? ['stop']
        : lifecycle === 'ready' || lifecycle === 'failed'
          ? ['start']
          : lifecycle === 'not_deployed' && requestedHeadSha
            ? ['deploy']
            : []
  };
}
