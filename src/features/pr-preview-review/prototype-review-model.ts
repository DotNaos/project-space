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

export const prototypeReviewPath = '/prototype-review';

export type PrototypeReviewSurface = 'native' | 'web';

export interface PrototypeReviewRoute {
  devTargetUrl?: string;
  matches: boolean;
  pullRequestNumber?: number;
  repositoryFullName?: string;
  orientation: PrototypeOrientation;
  scenario: PrototypeScenarioKind;
  surface: PrototypeReviewSurface;
  theme: PrototypeTheme;
  viewport: PrototypeViewportKind;
}

export interface PrototypeReviewTarget {
  source: 'deployed' | 'development-override' | 'live';
  surfaceKind: PullRequestPrototypeSurfaceKind;
  url: string;
}

function cleanRepositoryFullName(value: string | null) {
  const trimmed = value?.trim();
  return trimmed && /^[^/\s]+\/[^/\s]+$/.test(trimmed) ? trimmed : undefined;
}

function cleanPullRequestNumber(value: string | null) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function cleanSurface(value: string | null): PrototypeReviewSurface {
  return value === 'native' ? 'native' : 'web';
}

export function parsePrototypeReviewRoute(pathname: string, search: string): PrototypeReviewRoute {
  const params = new URLSearchParams(search);
  const scenario = params.get('scenario');
  const viewport = params.get('viewport');
  return {
    devTargetUrl: params.get('target')?.trim() || undefined,
    matches: pathname === prototypeReviewPath || pathname.startsWith(`${prototypeReviewPath}/`),
    pullRequestNumber: cleanPullRequestNumber(
      params.get('pullRequestNumber') ?? params.get('pr')
    ),
    repositoryFullName: cleanRepositoryFullName(
      params.get('repositoryFullName') ?? params.get('repository')
    ),
    orientation:
      params.get('orientation') === 'landscape' ? 'landscape' : 'portrait',
    scenario: isPrototypeScenarioKind(scenario) ? scenario : 'ready',
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

export function isSafeDevelopmentTarget(value: string, currentHref: string) {
  try {
    const current = new URL(currentHref);
    const target = new URL(value, current);
    const local = (hostname: string) =>
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname.endsWith('.localhost');
    return ['http:', 'https:'].includes(target.protocol) &&
      !target.username &&
      !target.password &&
      local(current.hostname) &&
      local(target.hostname);
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
  scenario: PrototypeScenarioKind,
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
  return result.liveContext.servedSurface === target.surfaceKind;
}
