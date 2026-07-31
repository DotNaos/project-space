import { resolve } from 'node:path';

import { runProjectBinary, type ProjectBinaryRunResult } from './local-project-cli-client';
import type {
  GitHubRepositoryDetailsResult,
  PullRequestPreviewLifecycle,
  PullRequestPreviewStatus,
  PullRequestPreviewStatusResult
} from '../src/shared/project-space-api';

const fullSha = /^[0-9a-f]{40}$/i;
const repositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

type RawPreview = Record<string, unknown>;

function publicHttpsUrl(value: unknown, pullRequestNumber: number) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      return undefined;
    }
    const expectedHost = `pr-${pullRequestNumber}.projects.os-home.net`;
    if (
      url.hostname.toLowerCase() !== expectedHost ||
      url.port ||
      (url.pathname !== '' && url.pathname !== '/')
    ) {
      return undefined;
    }
    return `https://${expectedHost}/`;
  } catch {
    return undefined;
  }
}

function prototypeHttpsUrl(value: unknown, pullRequestNumber: number) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    const expectedHost = `pr-${pullRequestNumber}.projects.os-home.net`;
    if (
      url.protocol !== 'https:' ||
      url.hostname.toLowerCase() !== expectedHost ||
      url.port ||
      url.username ||
      url.password ||
      url.pathname !== '/prototype/desktop/' ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return `https://${expectedHost}/prototype/desktop/`;
  } catch {
    return undefined;
  }
}

function pullRequestLink(value: unknown, repositoryFullName: string, pullRequestNumber: number) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      return undefined;
    }
    const expectedPath = `/${repositoryFullName}/pull/${pullRequestNumber}`;
    if (url.origin !== 'https://github.com' || url.pathname !== expectedPath) {
      return undefined;
    }
    return `https://github.com${expectedPath}`;
  } catch {
    return undefined;
  }
}

function text(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized.slice(0, maxLength)
    : undefined;
}

function sha(value: unknown) {
  return typeof value === 'string' && fullSha.test(value.trim())
    ? value.trim().toLowerCase()
    : undefined;
}

function timestamp(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

const lifecycleAliases: Record<string, PullRequestPreviewLifecycle> = {
  queued: 'queued',
  validating: 'validating',
  building: 'building',
  waitingforprlock: 'waiting-for-lock',
  waitingforlock: 'waiting-for-lock',
  blockedcapacity: 'blocked-capacity',
  deploying: 'deploying',
  verifying: 'verifying',
  ready: 'ready',
  rejected: 'rejected',
  superseded: 'superseded',
  failedinitial: 'failed-initial',
  updatefailed: 'update-failed',
  cleanupqueued: 'cleanup-queued',
  deleting: 'deleting',
  cleanupfailed: 'cleanup-failed',
  removed: 'removed',
  absent: 'removed'
};

function lifecycle(value: unknown): PullRequestPreviewLifecycle {
  const key = typeof value === 'string' ? value.toLowerCase().replace(/[^a-z]/g, '') : '';
  return lifecycleAliases[key] ?? 'unknown';
}

function positiveInteger(...values: unknown[]) {
  for (const value of values) {
    const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (Number.isSafeInteger(number) && number > 0) return number;
  }
  return undefined;
}

function previewEntries(payload: unknown) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  for (const candidate of [record.previews, record.records, record.deployments]) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function payloadRepository(payload: unknown) {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  return text(record.repositoryFullName ?? record.repository ?? record.remoteRef, 255);
}

export function sanitizePullRequestPreview(
  raw: RawPreview,
  expectedRepository: string,
  fallbackRepository?: string
): PullRequestPreviewStatus | undefined {
  const repositoryFullName = text(
    raw.repositoryFullName ?? raw.repository ?? raw.remoteRef ?? fallbackRepository,
    255
  );
  const pullRequestNumber = positiveInteger(
    raw.pullRequestNumber,
    raw.prNumber,
    raw.number,
    raw.pr
  );
  if (
    !repositoryFullName ||
    repositoryFullName.toLowerCase() !== expectedRepository.toLowerCase() ||
    !pullRequestNumber
  ) {
    return undefined;
  }

  const state = lifecycle(raw.state ?? raw.status ?? raw.lifecycle);
  const rawRequestedSha = raw.requestedSha ?? raw.headSha ?? raw.requestSha;
  const rawRunningSha = raw.runningSha ?? raw.deployedSha ?? raw.runtimeSha;
  const requestedSha = sha(rawRequestedSha);
  const runningSha = sha(rawRunningSha);
  if (
    state === 'unknown' ||
    (state !== 'removed' && !requestedSha) ||
    (rawRequestedSha !== undefined && !requestedSha) ||
    (rawRunningSha !== undefined && !runningSha)
  ) {
    return undefined;
  }

  const rawUrl = raw.liveUrl ?? raw.webUrl ?? raw.url;
  const sanitizedLiveUrl = publicHttpsUrl(rawUrl, pullRequestNumber);
  const liveUrl = requestedSha && runningSha ? sanitizedLiveUrl : undefined;
  const rawPrototypeUrl = raw.prototypeUrl;
  const prototypeMetaSha = sha(raw.prototypeMetaSha);
  const prototypeHealthy = raw.prototypeHealthy === true;
  const sanitizedPrototypeUrl = prototypeHttpsUrl(rawPrototypeUrl, pullRequestNumber);
  const prototypeUrl = requestedSha &&
    runningSha &&
    prototypeMetaSha === runningSha &&
    prototypeHealthy
    ? sanitizedPrototypeUrl
    : undefined;
  return {
    headBranch: text(raw.headBranch ?? raw.branch ?? raw.headRef, 256),
    liveUrl,
    liveUrlState: liveUrl
      ? 'available'
      : typeof rawUrl === 'string' && rawUrl.trim()
        ? 'withheld'
        : 'not-configured',
    pullRequestNumber,
    prototypeHealthy,
    prototypeMetaSha,
    prototypeUrl,
    prototypeUrlState: prototypeUrl
      ? 'available'
      : typeof rawPrototypeUrl === 'string' && rawPrototypeUrl.trim()
        ? 'withheld'
        : 'not-configured',
    repositoryFullName: expectedRepository,
    requestedSha,
    runningSha,
    state,
    updatedAt: timestamp(raw.updatedAt ?? raw.lastTransitionAt),
    verifiedAt: timestamp(raw.verifiedAt)
  };
}

export function correlatePullRequestPreviews(
  result: PullRequestPreviewStatusResult,
  details: GitHubRepositoryDetailsResult
): PullRequestPreviewStatusResult {
  return {
    ...result,
    previews: result.previews.map((preview) => {
      const pullRequest = details.pullRequests.find(
        (candidate) => candidate.number === preview.pullRequestNumber
      );
      return pullRequest ? {
        ...preview,
        currentHeadSha: sha(pullRequest.headSha),
        headBranch: pullRequest.headBranch ?? preview.headBranch,
        linkedIssueNumbers: pullRequest.linkedIssueNumbers,
        pullRequestState: pullRequest.state,
        pullRequestTitle: pullRequest.title,
        pullRequestUrl: pullRequestLink(
          pullRequest.url,
          preview.repositoryFullName,
          preview.pullRequestNumber
        )
      } : preview;
    })
  };
}

export async function getPullRequestPreviewStatus(
  repositoryFullName: string,
  pullRequestNumber?: number,
  options: {
    cwd?: string;
    run?: (args: string[], cwd: string) => Promise<ProjectBinaryRunResult>;
  } = {}
): Promise<PullRequestPreviewStatusResult> {
  const checkedAt = new Date().toISOString();
  const empty = (status: PullRequestPreviewStatusResult['status']) => ({
    checkedAt,
    previews: [],
    repositoryFullName,
    status
  });
  if (
    !repositoryName.test(repositoryFullName) ||
    (pullRequestNumber !== undefined && (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber <= 0))
  ) {
    return empty('unauthorized');
  }

  const run = options.run ?? runProjectBinary;
  const cwd = resolve(
    options.cwd ?? process.env.PROJECT_SPACE_BACKEND_REPO_PATH ?? process.cwd()
  );
  const result = await run(
    ['deploy', 'preview', 'status', '--all', '--format', 'json'],
    cwd
  );
  if (result.exitCode !== 0) return empty('unavailable');

  try {
    const payload = JSON.parse(result.stdout) as unknown;
    const fallbackRepository = payloadRepository(payload);
    const previews: PullRequestPreviewStatus[] = [];
    let invalidExpectedRecord = false;
    for (const entry of previewEntries(payload)) {
      if (!entry || typeof entry !== 'object') continue;
      const raw = entry as RawPreview;
      const rawRepository = text(
        raw.repositoryFullName ?? raw.repository ?? raw.remoteRef ?? fallbackRepository,
        255
      );
      if (rawRepository?.toLowerCase() !== repositoryFullName.toLowerCase()) continue;
      const rawPullRequestNumber = positiveInteger(
        raw.pullRequestNumber,
        raw.prNumber,
        raw.number,
        raw.pr
      );
      if (
        pullRequestNumber !== undefined &&
        rawPullRequestNumber !== undefined &&
        rawPullRequestNumber !== pullRequestNumber
      ) {
        continue;
      }
      const preview = sanitizePullRequestPreview(raw, repositoryFullName, fallbackRepository);
      if (!preview) {
        invalidExpectedRecord = true;
        continue;
      }
      if (pullRequestNumber === undefined || preview.pullRequestNumber === pullRequestNumber) {
        previews.push(preview);
      }
    }
    if (invalidExpectedRecord) return empty('unavailable');
    return { checkedAt, previews, repositoryFullName, status: 'available' };
  } catch {
    return empty('unavailable');
  }
}
