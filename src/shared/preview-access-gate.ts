import { previewPullRequestNumberFromHostname } from './preview-host';

const maximumReturnTargetLength = 2_048;
const changeIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const directPrototypeChangeId = 'direct-preview';

export type PreviewSurface = 'full' | 'prototype';

export interface PreviewAccessGateTarget {
  changeId?: string;
  pullRequestNumber: number;
  returnTarget: string;
  surface: PreviewSurface;
  surfaceKind?: 'desktop-prototype' | 'mobile-prototype';
  targetUrl: string;
}

function previewOrigin(pullRequestNumber: number, candidateOrigin?: string) {
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber <= 0) return undefined;
  if (candidateOrigin) {
    try {
      const candidate = new URL(candidateOrigin);
      if (
        ['http:', 'https:'].includes(candidate.protocol) &&
        !candidate.username &&
        !candidate.password &&
        previewPullRequestNumberFromHostname(candidate.hostname) === pullRequestNumber
      ) {
        return candidate.origin;
      }
    } catch {
      return undefined;
    }
  }
  return `https://pr-${pullRequestNumber}.projects.os-home.net`;
}

function prototypeSurface(pathname: string) {
  if (pathname === '/prototype/desktop' || pathname === '/prototype/desktop/') {
    return 'desktop-prototype' as const;
  }
  if (pathname === '/prototype/mobile' || pathname === '/prototype/mobile/') {
    return 'mobile-prototype' as const;
  }
  return undefined;
}

export function previewSurfaceUrl(
  pullRequestNumber: number,
  surface: PreviewSurface,
  candidateOrigin?: string
) {
  const origin = previewOrigin(pullRequestNumber, candidateOrigin);
  if (!origin) return undefined;
  if (surface === 'full') return `${origin}/`;
  const target = new URL('/prototype/desktop/', origin);
  target.searchParams.set('change', directPrototypeChangeId);
  target.searchParams.set('scenario', 'ready');
  target.searchParams.set('viewport', 'desktop');
  return target.toString();
}

export function normalizePreviewReturnTarget(
  value: string,
  pullRequestNumber: number
) {
  const origin = previewOrigin(pullRequestNumber);
  if (
    !origin ||
    value.length > maximumReturnTargetLength ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    value.includes('#')
  ) {
    return undefined;
  }
  try {
    const target = new URL(value, origin);
    if (
      target.origin !== origin ||
      target.hash ||
      target.pathname === '/api' ||
      target.pathname.startsWith('/api/')
    ) {
      return undefined;
    }
    const surfaceKind = prototypeSurface(target.pathname);
    if (target.pathname.startsWith('/prototype/') && !surfaceKind) return undefined;
    if (surfaceKind && target.searchParams.getAll('change').length === 0) {
      target.searchParams.set('change', directPrototypeChangeId);
    }
    return `${target.pathname}${target.search}`;
  } catch {
    return undefined;
  }
}

export function previewAccessGateUrl(
  brokerOrigin: string,
  pullRequestNumber: number,
  returnTarget: string
) {
  const normalized = normalizePreviewReturnTarget(returnTarget, pullRequestNumber);
  if (!normalized) return undefined;
  const target = new URL('/preview-access', brokerOrigin);
  target.searchParams.set('pr', String(pullRequestNumber));
  target.searchParams.set('return', normalized);
  return target.toString();
}

export function parsePreviewAccessGateSearch(search: string): PreviewAccessGateTarget | undefined {
  const params = new URLSearchParams(search);
  const pullRequestValues = params.getAll('pr');
  const returnValues = params.getAll('return');
  if (
    [...params.keys()].some((key) => key !== 'pr' && key !== 'return') ||
    pullRequestValues.length !== 1 ||
    returnValues.length !== 1 ||
    !/^[1-9][0-9]{0,8}$/.test(pullRequestValues[0] ?? '')
  ) {
    return undefined;
  }
  const pullRequestNumber = Number(pullRequestValues[0]);
  const returnTarget = normalizePreviewReturnTarget(returnValues[0] ?? '', pullRequestNumber);
  const origin = previewOrigin(pullRequestNumber);
  if (!returnTarget || !origin) return undefined;
  const target = new URL(returnTarget, origin);
  const surfaceKind = prototypeSurface(target.pathname);
  if (!surfaceKind) {
    return {
      pullRequestNumber,
      returnTarget,
      surface: 'full',
      targetUrl: target.toString()
    };
  }
  const changeValues = target.searchParams.getAll('change');
  if (changeValues.length !== 1 || !changeIdPattern.test(changeValues[0] ?? '')) {
    return undefined;
  }
  return {
    changeId: changeValues[0],
    pullRequestNumber,
    returnTarget,
    surface: 'prototype',
    surfaceKind,
    targetUrl: target.toString()
  };
}
