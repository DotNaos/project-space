import type {
  AvailablePullRequestDevServerSurface,
  PullRequestPrototypeSurfaceKind,
  PullRequestTestSurface,
  PullRequestTestSurfacesResult
} from '../../shared/pr-preview-test-surfaces-api';
import {
  isPrototypeScenarioKind,
  isPrototypeViewportKind,
  type PrototypeOrientation,
  type PrototypeScenarioKind,
  type PrototypeTheme,
  type PrototypeViewportKind
} from '../../shared/prototype-canvas';
import type { PrototypeReviewLocalContext } from '../../shared/prototype-review-local-api';
import {
  samePullRequestChangelogIdentity,
  type PullRequestChangelogIdentity
} from '../../shared/pr-preview-changelog-api';

export const prototypeReviewPath = '/prototype-review';

export type PrototypeReviewSurface = 'native' | 'web';

export interface PrototypeReviewRoute {
  changeId?: string;
  devTargetUrl?: string;
  headSha?: string;
  matches: boolean;
  pullRequestNumber?: number;
  repositoryFullName?: string;
  orientation: PrototypeOrientation;
  scenario?: PrototypeScenarioKind;
  surface: PrototypeReviewSurface;
  theme: PrototypeTheme;
  viewport: PrototypeViewportKind;
}

export interface PrototypeReviewTarget {
  source: 'deployed' | 'development-override' | 'live' | 'preview-build';
  surfaceKind: PullRequestPrototypeSurfaceKind;
  url: string;
}

export interface PrototypeReviewDevelopmentContext {
  connectionKind: 'local' | 'private' | 'tailscale';
  connectorId?: string;
  heartbeatAt?: string;
  leaseExpiresAt?: string;
  machineId: string;
  source: 'local-runtime' | 'verified-live';
  threadId: string;
}

function cleanRepositoryFullName(value: string | null) {
  const trimmed = value?.trim();
  return trimmed && /^[^/\s]+\/[^/\s]+$/.test(trimmed) ? trimmed : undefined;
}

function cleanPullRequestNumber(value: string | null) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function cleanChangeId(value: string | null) {
  const trimmed = value?.trim();
  return trimmed && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmed)
    ? trimmed
    : undefined;
}

function cleanHeadSha(value: string | null) {
  const trimmed = value?.trim();
  return trimmed && /^[0-9a-f]{40}$/i.test(trimmed)
    ? trimmed.toLowerCase()
    : undefined;
}

function cleanSurface(value: string | null): PrototypeReviewSurface {
  return value === 'native' ? 'native' : 'web';
}

export function parsePrototypeReviewRoute(pathname: string, search: string): PrototypeReviewRoute {
  const params = new URLSearchParams(search);
  const scenario = params.get('scenario');
  const viewport = params.get('viewport');
  return {
    changeId: cleanChangeId(params.get('change')),
    devTargetUrl: params.get('target')?.trim() || undefined,
    headSha: cleanHeadSha(params.get('head')),
    matches: pathname === prototypeReviewPath || pathname.startsWith(`${prototypeReviewPath}/`),
    pullRequestNumber: cleanPullRequestNumber(
      params.get('pullRequestNumber') ?? params.get('pr')
    ),
    repositoryFullName: cleanRepositoryFullName(
      params.get('repositoryFullName') ?? params.get('repository')
    ),
    orientation:
      params.get('orientation') === 'landscape' ? 'landscape' : 'portrait',
    scenario: isPrototypeScenarioKind(scenario) ? scenario : undefined,
    surface: cleanSurface(params.get('surface')),
    theme: params.get('theme') === 'light' ? 'light' : 'dark',
    viewport: isPrototypeViewportKind(viewport) ? viewport : 'phone'
  };
}

export function prototypeSurfaceKind(
  surface: PrototypeReviewSurface
): PullRequestPrototypeSurfaceKind {
  return surface === 'native' ? 'mobile-prototype' : 'desktop-prototype';
}

function availableSurface(
  surface: PullRequestTestSurface | undefined
): surface is Extract<PullRequestTestSurface, { state: 'available' }> {
  return surface?.state === 'available';
}

export function verifiedPrototypeTarget(
  result: PullRequestTestSurfacesResult | undefined,
  surface: PrototypeReviewSurface
): PrototypeReviewTarget | undefined {
  if (!result) return undefined;
  const surfaceKind = prototypeSurfaceKind(surface);
  const live = result.surfaces.find((candidate): candidate is AvailablePullRequestDevServerSurface =>
    candidate.kind === 'dev-server' &&
    candidate.state === 'available' &&
    candidate.servedSurface === surfaceKind
  );
  if (live) {
    return { source: 'live', surfaceKind, url: live.url };
  }
  const deployed = result.surfaces.find((candidate) => candidate.kind === surfaceKind);
  return availableSurface(deployed)
    ? { source: 'deployed', surfaceKind, url: deployed.url }
    : undefined;
}

export function verifiedPreviewBuildPrototypeTarget(input: {
  currentHref: string;
  expectedIdentity?: PullRequestChangelogIdentity;
  previewBuildIdentity?: PullRequestChangelogIdentity;
  surface: PrototypeReviewSurface;
}): PrototypeReviewTarget | undefined {
  const {
    currentHref,
    expectedIdentity,
    previewBuildIdentity,
    surface
  } = input;
  if (
    !expectedIdentity ||
    !previewBuildIdentity ||
    surface !== 'web' ||
    !samePullRequestChangelogIdentity(expectedIdentity, previewBuildIdentity)
  ) {
    return undefined;
  }
  try {
    const current = new URL(currentHref);
    if (
      current.protocol !== 'https:' ||
      current.username ||
      current.password ||
      current.port ||
      current.hostname !==
        `pr-${expectedIdentity.pullRequestNumber}.projects.os-home.net`
    ) {
      return undefined;
    }
    return {
      source: 'preview-build',
      surfaceKind: 'desktop-prototype',
      url: new URL('/prototype/desktop/', current.origin).toString()
    };
  } catch {
    return undefined;
  }
}

export function isSafeDevelopmentTarget(value: string, currentHref: string) {
  try {
    const current = new URL(currentHref);
    const target = new URL(value, current);
    return ['http:', 'https:'].includes(target.protocol) &&
      !target.username &&
      !target.password &&
      isDevelopmentHost(current.hostname) &&
      isDevelopmentHost(target.hostname);
  } catch {
    return false;
  }
}

export function developmentPrototypeTarget(
  value: string | undefined,
  currentHref: string,
  surface: PrototypeReviewSurface
): PrototypeReviewTarget | undefined {
  if (!value || !isSafeDevelopmentTarget(value, currentHref)) return undefined;
  const target = new URL(value, currentHref);
  const requestedPath = surface === 'native' ? '/prototype/mobile/' : '/prototype/desktop/';
  if (/\/prototype\/(?:desktop|mobile)\//.test(target.pathname)) {
    target.pathname = target.pathname.replace(
      /\/prototype\/(?:desktop|mobile)\//,
      requestedPath
    );
  }
  return {
    source: 'development-override',
    surfaceKind: prototypeSurfaceKind(surface),
    url: target.toString()
  };
}

export function embeddedPrototypeUrl(
  target: PrototypeReviewTarget,
  scenario: string,
  viewport: PrototypeViewportKind,
  orientation: PrototypeOrientation,
  theme: PrototypeTheme
) {
  const url = new URL(target.url);
  url.searchParams.set('embedded', '1');
  url.searchParams.set('scenario', scenario);
  url.searchParams.set('viewport', viewport);
  if (orientation === 'landscape') {
    url.searchParams.set('orientation', 'landscape');
  } else {
    url.searchParams.delete('orientation');
  }
  url.searchParams.set('theme', theme);
  url.searchParams.delete('frame');
  url.searchParams.delete('fullscreen');
  return url.toString();
}

export function isIsolatedPrototypeTarget(
  target: PrototypeReviewTarget | undefined,
  currentHref: string
) {
  if (!target) return false;
  try {
    return new URL(target.url).origin !== new URL(currentHref).origin;
  } catch {
    return false;
  }
}

export function isSafePrototypeTarget(
  target: PrototypeReviewTarget | undefined,
  currentHref: string
) {
  if (!target) return false;
  if (isIsolatedPrototypeTarget(target, currentHref)) return true;
  if (target.source !== 'preview-build') return false;
  try {
    const current = new URL(currentHref);
    const candidate = new URL(target.url);
    return (
      candidate.origin === current.origin &&
      candidate.pathname === '/prototype/desktop/' &&
      !candidate.username &&
      !candidate.password
    );
  } catch {
    return false;
  }
}

export function prototypeFrameSandbox(
  target: PrototypeReviewTarget,
  currentHref: string
) {
  return isIsolatedPrototypeTarget(target, currentHref)
    ? 'allow-same-origin allow-scripts'
    : 'allow-scripts';
}

export function feedbackMatchesTarget(
  result: PullRequestTestSurfacesResult | undefined,
  target: PrototypeReviewTarget | undefined
) {
  if (
    !result ||
    !target ||
    target.source !== 'live' ||
    result.feedback.state !== 'available' ||
    result.liveContext.state !== 'available'
  ) {
    return false;
  }
  const surface = result.surfaces.find((candidate): candidate is AvailablePullRequestDevServerSurface =>
    candidate.kind === 'dev-server' &&
    candidate.state === 'available' &&
    candidate.servedSurface === target.surfaceKind
  );
  return result.liveContext.servedSurface === target.surfaceKind &&
    surface !== undefined &&
    sameTargetUrl(surface.url, target.url);
}

export function prototypeReviewDevelopmentContext(
  result: PullRequestTestSurfacesResult | undefined,
  target: PrototypeReviewTarget | undefined,
  localContext?: PrototypeReviewLocalContext
): PrototypeReviewDevelopmentContext | undefined {
  if (
    target?.source === 'development-override' &&
    localContext?.codex.state === 'available'
  ) {
    return {
      connectionKind: prototypeConnectionKind(target.url),
      machineId: localContext.codex.machineId,
      source: 'local-runtime',
      threadId: localContext.codex.threadId
    };
  }
  if (!result || !target || !feedbackMatchesTarget(result, target)) return undefined;
  if (result.feedback.state !== 'available' || result.liveContext.state !== 'available') {
    return undefined;
  }
  const surface = result.surfaces.find((candidate): candidate is AvailablePullRequestDevServerSurface =>
    candidate.kind === 'dev-server' &&
    candidate.state === 'available' &&
    candidate.servedSurface === target.surfaceKind &&
    sameTargetUrl(candidate.url, target.url)
  );
  if (!surface) return undefined;
  return {
    connectionKind: prototypeConnectionKind(surface.url),
    connectorId: result.liveContext.connectorId,
    heartbeatAt: result.liveContext.heartbeatAt,
    leaseExpiresAt: result.liveContext.leaseExpiresAt,
    machineId: result.liveContext.machineId,
    source: 'verified-live',
    threadId: result.feedback.threadId
  };
}

export function prototypeReviewCodexContext(
  localReviewRuntime: boolean,
  result: PullRequestTestSurfacesResult | undefined,
  target: PrototypeReviewTarget | undefined,
  localContext?: PrototypeReviewLocalContext
) {
  return localReviewRuntime
    ? prototypeReviewDevelopmentContext(result, target, localContext)
    : undefined;
}

export function prototypeConnectionKind(value: string) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname.endsWith('.localhost')
    ) {
      return 'local' as const;
    }
    if (isTailscaleHost(hostname)) {
      return 'tailscale' as const;
    }
  } catch {
    // Verified live URLs are parsed before reaching this helper.
  }
  return 'private' as const;
}

function isDevelopmentHost(hostname: string) {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized.endsWith('.localhost') ||
    isTailscaleHost(normalized);
}

function isTailscaleHost(hostname: string) {
  return hostname.endsWith('.ts.net') || isTailscaleIpv4(hostname);
}

function sameTargetUrl(left: string, right: string) {
  try {
    const normalized = (value: string) => {
      const url = new URL(value);
      url.hash = '';
      return url.toString();
    };
    return normalized(left) === normalized(right);
  } catch {
    return false;
  }
}

function isTailscaleIpv4(hostname: string) {
  const octets = hostname.split('.').map(Number);
  return octets.length === 4 &&
    octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) &&
    octets[0] === 100 &&
    octets[1]! >= 64 &&
    octets[1]! <= 127;
}
