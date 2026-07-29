import {
  pullRequestPrototypeSurfaceKinds,
  type PullRequestPrototypeSurfaceKind,
  type PullRequestTestSurfaceKind
} from '../../src/shared/pr-preview-test-surfaces-api';

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const threadIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fullShaPattern = /^[0-9a-f]{40}$/;

export function requireRepositoryFullName(value: string) {
  const normalized = value.trim();
  if (!repositoryPattern.test(normalized)) {
    throw new Error('repositoryFullName must be owner/name.');
  }
  return normalized;
}

export function requireIdentifier(value: string, name: string) {
  const normalized = value.trim();
  if (!identifierPattern.test(normalized)) {
    throw new Error(`${name} is invalid.`);
  }
  return normalized;
}

export function requireBranchName(value: string) {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new Error('branchName is invalid.');
  }
  return normalized;
}

export function requireCommitSha(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!fullShaPattern.test(normalized)) {
    throw new Error('commitSha must be a full lowercase Git SHA.');
  }
  return normalized;
}

export function requirePullRequestNumber(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('pullRequestNumber must be a positive integer.');
  }
  return value;
}

export function requirePrototypeSurface(
  value: string
): PullRequestPrototypeSurfaceKind {
  if (!pullRequestPrototypeSurfaceKinds.includes(value as PullRequestPrototypeSurfaceKind)) {
    throw new Error('servedSurface is unsupported.');
  }
  return value as PullRequestPrototypeSurfaceKind;
}

export function optionalThreadId(value: string | undefined) {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!threadIdPattern.test(normalized)) {
    throw new Error('codexThreadId is invalid.');
  }
  return normalized;
}

function ipv4Parts(value: string) {
  const parts = value.split('.');
  if (parts.length !== 4) return undefined;
  const numbers = parts.map((part) => Number(part));
  if (
    numbers.some(
      (part, index) =>
        !Number.isInteger(part) ||
        part < 0 ||
        part > 255 ||
        String(part) !== parts[index]
    )
  ) {
    return undefined;
  }
  return numbers as [number, number, number, number];
}

export function isTailscaleIpv4(value: string) {
  const parts = ipv4Parts(value);
  return Boolean(parts && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
}

export function canonicalTailscaleUrl(
  ipv4: string,
  port: number,
  surface: PullRequestPrototypeSurfaceKind
) {
  if (!isTailscaleIpv4(ipv4)) {
    throw new Error('tailscaleIpv4 must be in the Tailscale IPv4 range.');
  }
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('tailscalePort must be a valid TCP port.');
  }
  const path = surface === 'mobile-prototype'
    ? '/prototype/mobile/'
    : '/prototype/desktop/';
  return `http://${ipv4}:${port}${path}`;
}

export function canonicalDeployedSurfaceUrl(
  value: string,
  kind: Exclude<PullRequestTestSurfaceKind, 'dev-server'>,
  pullRequestNumber: number
) {
  const url = new URL(value);
  const expectedHost = `pr-${requirePullRequestNumber(pullRequestNumber)}.projects.os-home.net`;
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== expectedHost ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('The deployed surface URL is outside the verified PR origin.');
  }
  if (kind === 'full-preview' && url.pathname !== '/') {
    throw new Error('The Full Preview URL must use the PR origin root.');
  }
  if (kind !== 'full-preview' && !url.pathname.startsWith('/prototype/')) {
    throw new Error('Prototype URLs must use the trusted prototype path.');
  }
  return url.toString();
}

export function requireTimestamp(value: string, name: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be an ISO timestamp.`);
  }
  return new Date(parsed).toISOString();
}
