import type {
  GitHubRepositoryDetailsResult,
  PreviewHubInventoryResult,
  PreviewHubMutationResult,
  PreviewHubRecord,
  PreviewHubStartRequest,
  PreviewHubStopRequest,
  PreviewHubTouchRequest,
  PullRequestPreviewStatusResult
} from '../src/shared/project-space-api';
import { previewHubRecordFromLegacyStatus } from '../src/shared/pull-request-preview-hub-api';
import { runProjectBinary } from './local-project-cli-client';
import { getPullRequestPreviewStatus, correlatePullRequestPreviews, withUndeployedOpenPullRequests } from './pull-request-preview-status';
import { sanitizePreviewReturnTarget } from './preview-return-target';
import { projectSpaceLogger } from './observability';

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const defaultRepository = 'DotNaos/project-space';

export interface PreviewHubServiceDependencies {
  loadStatus?: typeof getPullRequestPreviewStatus;
  run?: typeof runProjectBinary;
  cwd?: string;
  now?: () => string;
  maxOnline?: number;
  auditMutation?(entry: { action: 'start' | 'stop' | 'touch'; pullRequestNumber: number; repositoryFullName: string; userId: string; outcome: string }): void;
}

export function createPreviewHubService(
  backend: { getGitHubRepositoryDetails(repositoryFullName: string): Promise<GitHubRepositoryDetailsResult> },
  dependencies: PreviewHubServiceDependencies = {}
) {
  const loadStatus = dependencies.loadStatus ?? getPullRequestPreviewStatus;
  const run = dependencies.run ?? runProjectBinary;
  const cwd = dependencies.cwd ?? process.env.PROJECT_SPACE_BACKEND_REPO_PATH ?? process.cwd();
  const configuredMaxOnline = dependencies.maxOnline ?? Number(process.env.PREVIEW_MAX_ACTIVE ?? 3);
  const maxOnline = Number.isSafeInteger(configuredMaxOnline) && configuredMaxOnline > 0
    ? Math.min(configuredMaxOnline, 3)
    : 0;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const auditMutation = dependencies.auditMutation ?? ((entry) => {
    projectSpaceLogger.info('preview.mutation.audited', {
      component: 'preview-hub',
      ...entry
    });
  });
  const mutationTimes = new Map<string, number[]>();

  function allowMutation(userId: string, action: 'start' | 'stop' | 'touch') {
    const key = `${userId}:${action}`;
    const cutoff = Date.now() - 60_000;
    const recent = (mutationTimes.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
    if (recent.length >= 30) return false;
    recent.push(Date.now());
    mutationTimes.set(key, recent);
    return true;
  }

  async function inventory(repositoryFullName = defaultRepository, userId = 'local-development-user'): Promise<PreviewHubInventoryResult> {
    if (repositoryFullName !== defaultRepository || !repositoryPattern.test(repositoryFullName) || !userId) return unavailable(repositoryFullName, 'unauthorized');
    const details = await backend.getGitHubRepositoryDetails(repositoryFullName);
    if (details.status !== 'connected') return unavailable(repositoryFullName, ['error', 'rate-limited'].includes(details.status) ? 'unavailable' : 'unauthorized');
    const result = withUndeployedOpenPullRequests(
      correlatePullRequestPreviews(await loadStatus(repositoryFullName), details),
      details
    );
    const previews = result.previews.map((preview) => previewHubRecordFromLegacyStatus(preview, now()));
    const revision = previewHubInventoryRevision(previews, result.previews);
    return {
      checkedAt: result.checkedAt,
      inventoryRevision: revision,
      maxOnline,
      onlineCount: previews.filter((preview) => preview.lifecycle === 'online').length,
      occupiedCount: previews.filter((preview) => preview.lifecycle === 'online' || preview.capacityBlocked).length,
      previews,
      repositoryFullName,
      status: 'available'
    };
  }

  async function start(request: PreviewHubStartRequest, userId = 'local-development-user'): Promise<PreviewHubMutationResult> {
    if (!allowMutation(userId, 'start')) return { code: 'rate_limited', message: 'Preview start requests are temporarily rate-limited.' };
    const current = await inventory(request.repositoryFullName, userId);
    if (current.status !== 'available') return { code: current.status === 'unauthorized' ? 'unauthorized' : 'operation_failed', message: 'Preview inventory is not currently available.' };
    const target = current.previews.find((preview) => preview.pullRequestNumber === request.pullRequestNumber);
    if (!target) return { code: 'not_found', message: 'The requested Preview is not registered.' };
    if (target.requestedHeadSha !== request.requestedHeadSha || target.currentHeadSha !== request.requestedHeadSha) return { code: 'head_changed', message: 'The pull request head changed; refresh before starting.' };
    const returnTarget = sanitizePreviewReturnTarget(request.returnTarget, request.pullRequestNumber);
    if (request.returnTarget && !returnTarget) return { code: 'invalid_return_target', message: 'The requested return path is not safe for this Preview.' };

    // A PR that has never been previewed before has no built image on the VPS yet, so it
    // must go through the "deploy" (build-from-scratch) operation instead of the cheap
    // "start" (bring an already-built image back online) operation. The trusted workflow
    // does not support the automatic-replacement flow for a fresh build, so a fresh deploy
    // simply fails fast when capacity is full instead of prompting for a replacement.
    const isUndeployed = target.lifecycle === 'not_deployed';
    if (isUndeployed && current.occupiedCount >= maxOnline) {
      return { code: 'operation_failed', message: 'All Preview capacity is currently in use. Stop a running preview before deploying a new one.' };
    }
    if (!isUndeployed && current.occupiedCount >= maxOnline && request.selectedReplacementPullRequestNumber === undefined) {
      return { code: 'capacity_requires_choice', inventoryRevision: current.inventoryRevision, online: current.previews.filter((preview) => preview.lifecycle === 'online').map((preview) => ({ pullRequestNumber: preview.pullRequestNumber, repositoryFullName: preview.repositoryFullName, requestedHeadSha: preview.requestedHeadSha, lastActivityAt: preview.lastActivityAt, lastVerifiedAt: preview.lastVerifiedAt, previewUrl: preview.previewUrl })) };
    }
    if (!isUndeployed && current.occupiedCount >= maxOnline && request.inventoryRevision !== current.inventoryRevision) return { code: 'capacity_requires_choice', inventoryRevision: current.inventoryRevision, online: current.previews.filter((preview) => preview.lifecycle === 'online').map(toCapacityCandidate) };
    const args = isUndeployed
      ? ['deploy', 'preview', '--pr', String(request.pullRequestNumber), '--format', 'json']
      : ['deploy', 'preview', 'start', '--pr', String(request.pullRequestNumber), '--format', 'json'];
    if (!isUndeployed && current.occupiedCount >= maxOnline) {
      const selected = current.previews.find((preview) =>
        preview.pullRequestNumber === request.selectedReplacementPullRequestNumber &&
        preview.repositoryFullName === (request.selectedReplacementRepositoryFullName ?? request.repositoryFullName)
      );
      if (!selected || selected.lifecycle !== 'online' || selected.requestedHeadSha !== request.selectedReplacementHeadSha) {
        return { code: 'capacity_requires_choice', inventoryRevision: current.inventoryRevision, online: current.previews.filter((preview) => preview.lifecycle === 'online').map(toCapacityCandidate) };
      }
      args.push(
        '--inventory-revision', current.inventoryRevision,
        '--replace-pr', String(selected.pullRequestNumber),
        '--replace-repository', selected.repositoryFullName,
        '--replace-head-sha', selected.requestedHeadSha
      );
    }
    const result = await run(args, cwd, { timeoutMs: 90_000 });
    if (result.exitCode !== 0) {
      auditMutation({ action: 'start', pullRequestNumber: request.pullRequestNumber, repositoryFullName: request.repositoryFullName, userId, outcome: 'failed' });
      return { code: 'operation_failed', message: safeCliFailure(result.stderr) };
    }
    auditMutation({ action: 'start', pullRequestNumber: request.pullRequestNumber, repositoryFullName: request.repositoryFullName, userId, outcome: 'accepted' });
    return { code: 'accepted', inventoryRevision: current.inventoryRevision, lifecycle: isUndeployed ? 'building' : 'starting', pullRequestNumber: request.pullRequestNumber, returnTarget };
  }

  async function stop(request: PreviewHubStopRequest, userId = 'local-development-user'): Promise<PreviewHubMutationResult> {
    if (!allowMutation(userId, 'stop')) return { code: 'rate_limited', message: 'Preview stop requests are temporarily rate-limited.' };
    const current = await inventory(request.repositoryFullName, userId);
    if (current.status !== 'available') return { code: current.status === 'unauthorized' ? 'unauthorized' : 'operation_failed', message: 'Preview inventory is not currently available.' };
    const target = current.previews.find((preview) => preview.pullRequestNumber === request.pullRequestNumber);
    if (!target || (target.lifecycle !== 'online' && !target.capacityBlocked)) return { code: 'not_found', message: 'The requested Preview is not online or capacity-blocked.' };
    if (target.requestedHeadSha !== request.requestedHeadSha || (!target.capacityBlocked && target.verifiedRunningHeadSha !== request.requestedHeadSha)) return { code: 'head_changed', message: 'The Preview head changed; refresh before stopping.' };
    const result = await run(['deploy', 'preview', 'stop', '--pr', String(request.pullRequestNumber), '--format', 'json'], cwd, { timeoutMs: 90_000 });
    if (result.exitCode !== 0) {
      auditMutation({ action: 'stop', pullRequestNumber: request.pullRequestNumber, repositoryFullName: request.repositoryFullName, userId, outcome: 'failed' });
      return { code: 'operation_failed', message: safeCliFailure(result.stderr) };
    }
    auditMutation({ action: 'stop', pullRequestNumber: request.pullRequestNumber, repositoryFullName: request.repositoryFullName, userId, outcome: 'accepted' });
    return { code: 'accepted', inventoryRevision: current.inventoryRevision, lifecycle: 'stopping', pullRequestNumber: request.pullRequestNumber };
  }

  async function touch(request: PreviewHubTouchRequest, userId = 'local-development-user'): Promise<PreviewHubMutationResult> {
    if (!allowMutation(userId, 'touch')) return { code: 'rate_limited', message: 'Preview activity updates are temporarily rate-limited.' };
    const current = await inventory(request.repositoryFullName, userId);
    if (current.status !== 'available') return { code: current.status === 'unauthorized' ? 'unauthorized' : 'operation_failed', message: 'Preview inventory is not currently available.' };
    const target = current.previews.find((preview) => preview.pullRequestNumber === request.pullRequestNumber);
    if (!target || target.lifecycle !== 'online' || target.verifiedRunningHeadSha !== request.requestedHeadSha) {
      return { code: 'head_changed', message: 'The Preview is not online at the requested exact head.' };
    }
    const result = await run(['deploy', 'preview', 'touch', '--pr', String(request.pullRequestNumber), '--format', 'json'], cwd, { timeoutMs: 30_000 });
    if (result.exitCode !== 0) {
      auditMutation({ action: 'touch', pullRequestNumber: request.pullRequestNumber, repositoryFullName: request.repositoryFullName, userId, outcome: 'failed' });
      return { code: 'operation_failed', message: safeCliFailure(result.stderr) };
    }
    auditMutation({ action: 'touch', pullRequestNumber: request.pullRequestNumber, repositoryFullName: request.repositoryFullName, userId, outcome: 'accepted' });
    return { code: 'accepted', inventoryRevision: current.inventoryRevision, lifecycle: 'online', pullRequestNumber: request.pullRequestNumber };
  }

  return { inventory, start, stop, touch };
}

function unavailable(repositoryFullName: string, status: 'unauthorized' | 'unavailable'): PreviewHubInventoryResult {
  return { checkedAt: new Date().toISOString(), inventoryRevision: 'unavailable', maxOnline: 3, onlineCount: 0, occupiedCount: 0, previews: [], repositoryFullName, status };
}

export function previewHubInventoryRevision(previews: PreviewHubRecord[], registryStatuses?: PullRequestPreviewStatusResult['previews']) {
  if (!previews.length) return '0';
  const canonical = [...previews]
    .sort((left, right) => left.repositoryFullName.localeCompare(right.repositoryFullName) || left.pullRequestNumber - right.pullRequestNumber)
    .map((preview) => {
      const registry = registryStatuses?.find((entry) => entry.pullRequestNumber === preview.pullRequestNumber && entry.repositoryFullName === preview.repositoryFullName);
      return {
        repositoryFullName: preview.repositoryFullName,
        pullRequestNumber: preview.pullRequestNumber,
        requestedSha: registry?.requestedSha ?? preview.requestedHeadSha,
        runningSha: registry?.state === 'online' && registry.runningSha ? registry.runningSha : preview.verifiedRunningHeadSha ?? null,
        state: registry ? canonicalRegistryState(registry.state) : preview.lifecycle,
        capacityBlocked: registry?.capacityBlocked ?? preview.capacityBlocked ?? false,
        updatedAt: registry?.updatedAt ?? preview.stateChangedAt
      };
    });
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function canonicalRegistryState(state: PullRequestPreviewStatusResult['previews'][number]['state']) {
  if (state === 'update-failed' || state === 'failed-initial' || state === 'cleanup-failed') return 'failed' as const;
  if (state === 'deleting' || state === 'cleanup-queued') return 'stopping' as const;
  if (state === 'deploying' || state === 'verifying' || state === 'waiting-for-lock') return 'starting' as const;
  if (state === 'queued' || state === 'validating') return 'building' as const;
  return state;
}

function toCapacityCandidate(preview: PreviewHubRecord) {
  return { pullRequestNumber: preview.pullRequestNumber, repositoryFullName: preview.repositoryFullName, requestedHeadSha: preview.requestedHeadSha, lastActivityAt: preview.lastActivityAt, lastVerifiedAt: preview.lastVerifiedAt, previewUrl: preview.previewUrl };
}

function safeCliFailure(value: string) {
  const sanitized = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/op:\/\/[^\s]+/gi, '[redacted-secret-reference]')
    .replace(/(?:bearer|basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, '[redacted-credential]')
    .replace(/(?:token|password|secret|private[_-]?key)(?:=|:)[^\s]+/gi, '[redacted-secret]')
    .trim()
    .slice(0, 512);
  return sanitized || 'Preview lifecycle operation failed.';
}
import { createHash } from 'node:crypto';
