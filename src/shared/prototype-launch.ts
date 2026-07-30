import type {
  PullRequestPrototypeSurfaceKind,
  PullRequestTestSurface,
  PullRequestTestSurfacesResult
} from './pr-preview-test-surfaces-api';

export const prototypeLaunchStates = [
  'not-started',
  'starting',
  'ready',
  'stale',
  'unavailable',
  'stopped'
] as const;

export type PrototypeLaunchState = (typeof prototypeLaunchStates)[number];

export interface PrototypeLaunchIdentity {
  branchName?: string;
  headSha: string;
  issueNumber?: number;
  machineId?: string;
  projectId: string;
  pullRequestNumber: number;
  repositoryFullName: string;
  surface: PullRequestPrototypeSurfaceKind;
  threadId?: string;
  worktreeId?: string;
}

export interface PrototypeLaunchRouteIdentity
  extends Partial<Omit<PrototypeLaunchIdentity, 'surface'>> {
  surface?: PullRequestPrototypeSurfaceKind;
}

export interface PrototypeLaunchStatus {
  message: string;
  state: PrototypeLaunchState;
}

const headShaPattern = /^[0-9a-f]{7,64}$/i;

export function prototypeLaunchStatus(options: {
  error?: string;
  identity?: PrototypeLaunchIdentity;
  isLoading?: boolean;
  result?: PullRequestTestSurfacesResult;
}): PrototypeLaunchStatus {
  const { error, identity, isLoading, result } = options;
  if (!identity) {
    return {
      message: 'Link a pull request with an exact head commit first.',
      state: 'not-started'
    };
  }
  if (isLoading && !result) {
    return { message: 'Checking the exact pull request head…', state: 'starting' };
  }
  if (error) return { message: error, state: 'unavailable' };
  if (!result) {
    return {
      message: 'Prototype availability could not be verified.',
      state: 'unavailable'
    };
  }
  if (!prototypeResultMatchesIdentity(result, identity)) {
    return {
      message: 'The prototype belongs to a different repository, PR, or head commit.',
      state: 'stale'
    };
  }

  const surface = prototypeSurfaceForIdentity(result, identity);
  if (!surface) {
    return {
      message: 'No prototype surface was reported for this PR head.',
      state: 'not-started'
    };
  }
  if (surface.state === 'available') {
    return {
      message: `Verified at ${shortSha(surface.commitSha)}.`,
      state: 'ready'
    };
  }
  if (surface.reasonCode === 'live-server-stopped') {
    return { message: 'The development server is stopped.', state: 'stopped' };
  }
  if (surface.state === 'pending') {
    return { message: 'The prototype is starting for this PR head.', state: 'starting' };
  }
  if (
    surface.state === 'stale' ||
    surface.reasonCode === 'deployment-head-mismatch' ||
    surface.reasonCode === 'live-heartbeat-expired' ||
    surface.reasonCode === 'live-registration-mismatch'
  ) {
    return {
      message: 'The available prototype does not match the current PR head.',
      state: 'stale'
    };
  }
  return {
    message: 'The prototype is unavailable. Retry after the underlying issue is fixed.',
    state: 'unavailable'
  };
}

export function prototypeResultMatchesIdentity(
  result: PullRequestTestSurfacesResult,
  identity: Pick<
    PrototypeLaunchIdentity,
    'headSha' | 'pullRequestNumber' | 'repositoryFullName'
  >
) {
  return result.repositoryFullName.toLowerCase() ===
      identity.repositoryFullName.toLowerCase() &&
    result.pullRequestNumber === identity.pullRequestNumber &&
    result.headSha.toLowerCase() === identity.headSha.toLowerCase();
}

export function prototypeSurfaceForIdentity(
  result: PullRequestTestSurfacesResult,
  identity: Pick<PrototypeLaunchIdentity, 'machineId' | 'surface'>
): PullRequestTestSurface | undefined {
  const live = result.surfaces.find((candidate) =>
    candidate.kind === 'dev-server' &&
    candidate.state === 'available' &&
    candidate.servedSurface === identity.surface &&
    (!identity.machineId || candidate.machineId === identity.machineId)
  );
  const deployed = result.surfaces.find((candidate) => candidate.kind === identity.surface);
  const stoppedLive = result.surfaces.find((candidate) =>
    candidate.kind === 'dev-server' &&
    candidate.state !== 'available' &&
    candidate.reasonCode === 'live-server-stopped'
  );
  return live ??
    (deployed?.state === 'available' ? deployed : undefined) ??
    stoppedLive ??
    deployed ??
    result.surfaces.find((candidate) =>
      candidate.kind === 'dev-server' && candidate.state !== 'available'
    );
}

export function buildPrototypeReviewHref(
  identity: PrototypeLaunchIdentity,
  options?: { scenario?: string; target?: string }
) {
  const params = new URLSearchParams();
  params.set('repository', identity.repositoryFullName);
  params.set('pr', String(identity.pullRequestNumber));
  if (identity.issueNumber) params.set('issue', String(identity.issueNumber));
  params.set('project', identity.projectId);
  params.set('head', identity.headSha);
  params.set('surface', identity.surface === 'mobile-prototype' ? 'native' : 'web');
  appendOptional(params, 'branch', identity.branchName);
  appendOptional(params, 'machine', identity.machineId);
  appendOptional(params, 'thread', identity.threadId);
  appendOptional(params, 'worktree', identity.worktreeId);
  appendOptional(params, 'scenario', options?.scenario);
  appendOptional(params, 'target', options?.target);
  return `/prototype-review?${params}`;
}

export function parsePrototypeLaunchRouteIdentity(
  search: string
): PrototypeLaunchRouteIdentity {
  const params = new URLSearchParams(search);
  const surface = params.get('surface');
  return {
    branchName: cleanOptional(params.get('branch')),
    headSha: cleanHeadSha(params.get('head')),
    issueNumber: cleanPositiveInteger(params.get('issue')),
    machineId: cleanOptional(params.get('machine')),
    projectId: cleanOptional(params.get('project')),
    pullRequestNumber: cleanPositiveInteger(
      params.get('pullRequestNumber') ?? params.get('pr')
    ),
    repositoryFullName: cleanRepository(params.get('repositoryFullName') ??
      params.get('repository')),
    surface: surface === 'native' || surface === 'mobile-prototype'
      ? 'mobile-prototype'
      : surface === 'web' || surface === 'desktop-prototype'
        ? 'desktop-prototype'
        : undefined,
    threadId: cleanOptional(params.get('thread')),
    worktreeId: cleanOptional(params.get('worktree'))
  };
}

export function prototypeIdentityLinks(identity: PrototypeLaunchRouteIdentity) {
  const issue = identity.projectId && identity.issueNumber
    ? `/projects/${encodeURIComponent(identity.projectId)}/issues/${identity.issueNumber}`
    : undefined;
  const task = identity.machineId && identity.threadId
    ? `/codex/machines/${encodeURIComponent(identity.machineId)}/threads/` +
      encodeURIComponent(identity.threadId)
    : undefined;
  const worktree = identity.projectId
    ? `/projects/${encodeURIComponent(identity.projectId)}/workspaces` +
      (identity.worktreeId
        ? `?worktree=${encodeURIComponent(identity.worktreeId)}`
        : '')
    : undefined;
  const machine = identity.machineId
    ? `/machines/${encodeURIComponent(identity.machineId)}`
    : undefined;
  const pullRequest = identity.repositoryFullName && identity.pullRequestNumber
    ? `https://github.com/${identity.repositoryFullName}/pull/${identity.pullRequestNumber}`
    : undefined;
  return { issue, machine, pullRequest, task, worktree };
}

function shortSha(value: string) {
  return value.slice(0, 7);
}

function appendOptional(params: URLSearchParams, key: string, value?: string) {
  if (value?.trim()) params.set(key, value.trim());
}

function cleanOptional(value: string | null) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length <= 512 ? trimmed : undefined;
}

function cleanPositiveInteger(value: string | null) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function cleanRepository(value: string | null) {
  const trimmed = value?.trim();
  return trimmed && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)
    ? trimmed
    : undefined;
}

function cleanHeadSha(value: string | null) {
  const trimmed = value?.trim();
  return trimmed && headShaPattern.test(trimmed) ? trimmed : undefined;
}
