import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import type { ProjectSpaceAuthSession } from './local-auth-store';

export const previewIdentityHeader = 'x-project-space-preview-identity';
export const previewSignatureHeader = 'x-project-space-preview-signature';
export const prototypeAccessCookieName = '__Host-project-space-prototype-access';
export const previewAccessCookieName = '__Host-project-space-preview-access';
const prototypeAccessLifetimeSeconds = 30;
const previewAccessLifetimeSeconds = 3_600;

export interface PreviewGatewayBinding {
  headSha: string;
  origin: string;
  pullRequestNumber: number;
  repositoryFullName: string;
}

interface PreviewIdentityAssertion extends PreviewGatewayBinding {
  audience: 'project-space-preview';
  expiresAt: number;
  issuedAt: number;
  session: ProjectSpaceAuthSession;
  version: 1;
}

interface PrototypeAccessAssertion extends PreviewGatewayBinding {
  audience: 'project-space-prototype';
  changeId: string;
  expiresAt: number;
  issuedAt: number;
  surface: 'desktop-prototype' | 'mobile-prototype';
  userId: string;
  version: 1;
}

interface PreviewAccessAssertion extends PreviewGatewayBinding {
  audience: 'project-space-preview-access';
  expiresAt: number;
  issuedAt: number;
  userId: string;
  version: 1;
}

const blockedPreviewPathPrefixes = [
  '/api/codex',
  '/api/connectors',
  '/api/dev-servers',
  '/api/git',
  '/api/machines',
  '/api/physical-machines',
  '/api/platform',
  '/api/pull-request-previews/dev-server',
  '/api/pull-request-previews/feedback',
  '/api/pull-request-previews/prototype-iteration',
  '/api/pull-request-previews/test-surfaces',
  '/api/scope-devbox',
  '/api/terminal',
  '/api/workspace-tool'
] as const;

function isPlainOrigin(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

export function derivePreviewOrigin(
  pullRequestNumber: number,
  projectDomain = 'projects.os-home.net'
) {
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber <= 0) {
    throw new Error('Preview pull request number must be a positive integer.');
  }
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(projectDomain)) {
    throw new Error('Preview project domain is invalid.');
  }
  return `https://pr-${pullRequestNumber}.${projectDomain.toLowerCase()}`;
}

export function parsePreviewGatewayBinding(
  environment: NodeJS.ProcessEnv = process.env
): PreviewGatewayBinding {
  const pullRequestNumber = Number(environment.PROJECT_SPACE_PREVIEW_PR_NUMBER ?? '');
  const repositoryFullName = environment.PROJECT_SPACE_PREVIEW_REPOSITORY?.trim() ?? '';
  const headSha = environment.PROJECT_SPACE_PREVIEW_HEAD_SHA?.trim().toLowerCase() ?? '';
  const origin = environment.PROJECT_SPACE_PUBLIC_ORIGIN?.trim() ?? '';

  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber <= 0) {
    throw new Error('PROJECT_SPACE_PREVIEW_PR_NUMBER must be a positive integer.');
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryFullName)) {
    throw new Error('PROJECT_SPACE_PREVIEW_REPOSITORY must be owner/name.');
  }
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error('PROJECT_SPACE_PREVIEW_HEAD_SHA must be a full commit SHA.');
  }
  if (!isPlainOrigin(origin)) {
    throw new Error('PROJECT_SPACE_PUBLIC_ORIGIN must be a plain HTTPS origin.');
  }
  if (origin !== derivePreviewOrigin(pullRequestNumber)) {
    throw new Error('PROJECT_SPACE_PUBLIC_ORIGIN does not match the Preview PR domain.');
  }

  return { headSha, origin, pullRequestNumber, repositoryFullName };
}

export function isBlockedPreviewPath(pathname: string) {
  return blockedPreviewPathPrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

const trustedReadOnlyGitHubPaths = new Set([
  '/api/github/catalog',
  '/api/github/issue-attachment-content',
  '/api/github/issue-comments',
  '/api/github/issue-metadata',
  '/api/github/pipeline',
  '/api/github/repository-details',
  '/api/github/repository-summary',
  '/api/github/roadmap'
]);

export function isGitHubApiPath(pathname: string) {
  return pathname === '/api/github' || pathname.startsWith('/api/github/');
}

export function isTrustedGitHubBrokerRequest(method: string | undefined, pathname: string) {
  if (method === 'GET' && (pathname === '/api/auth/session' || trustedReadOnlyGitHubPaths.has(pathname))) {
    return true;
  }
  if (method === 'GET' && /^\/api\/github\/workflow-runs\/[1-9][0-9]*$/.test(pathname)) {
    return true;
  }
  // These GitHub history reads are bounded operations whose APIs use POST only
  // because they accept structured revision request bodies.
  return method === 'POST' && (
    pathname === '/api/github/history' ||
    pathname === '/api/github/branch-comparison'
  );
}

function signatureFor(encodedAssertion: string, secret: string) {
  return createHmac('sha256', secret).update(encodedAssertion).digest('base64url');
}

function signedValue(assertion: object, secret: string) {
  if (secret.length < 32) {
    throw new Error('Preview gateway secret must contain at least 32 characters.');
  }
  const encoded = Buffer.from(JSON.stringify(assertion)).toString('base64url');
  return `${encoded}.${signatureFor(encoded, secret)}`;
}

function verifiedSignedValue(value: string, secret: string) {
  if (secret.length < 32 || value.length > 4_096) return undefined;
  const separator = value.lastIndexOf('.');
  if (separator <= 0 || separator === value.length - 1) return undefined;
  const encoded = value.slice(0, separator);
  const suppliedSignature = value.slice(separator + 1);
  const expected = Buffer.from(signatureFor(encoded, secret));
  const supplied = Buffer.from(suppliedSignature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

export function createPrototypeAccessCookie(input: {
  binding: PreviewGatewayBinding;
  changeId: string;
  now?: Date;
  secret: string;
  session: ProjectSpaceAuthSession;
  surface: PrototypeAccessAssertion['surface'];
}) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.changeId)) {
    throw new Error('Prototype Change id is invalid.');
  }
  const issuedAt = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const sessionExpiresAt = input.session.expiresAt
    ? Math.floor(Date.parse(input.session.expiresAt) / 1000)
    : Number.POSITIVE_INFINITY;
  const assertion: PrototypeAccessAssertion = {
    ...input.binding,
    audience: 'project-space-prototype',
    changeId: input.changeId,
    expiresAt: Math.min(issuedAt + prototypeAccessLifetimeSeconds, sessionExpiresAt),
    issuedAt,
    surface: input.surface,
    userId: input.session.userId,
    version: 1
  };
  return [
    `${prototypeAccessCookieName}=${signedValue(assertion, input.secret)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${prototypeAccessLifetimeSeconds}`
  ].join('; ');
}

export function createPreviewAccessCookie(input: {
  binding: PreviewGatewayBinding;
  now?: Date;
  secret: string;
  session: ProjectSpaceAuthSession;
}) {
  const issuedAt = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const sessionExpiresAt = input.session.expiresAt
    ? Math.floor(Date.parse(input.session.expiresAt) / 1000)
    : Number.POSITIVE_INFINITY;
  const assertion: PreviewAccessAssertion = {
    ...input.binding,
    audience: 'project-space-preview-access',
    expiresAt: Math.min(issuedAt + previewAccessLifetimeSeconds, sessionExpiresAt),
    issuedAt,
    userId: input.session.userId,
    version: 1
  };
  return [
    `${previewAccessCookieName}=${signedValue(assertion, input.secret)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${previewAccessLifetimeSeconds}`
  ].join('; ');
}

function readCookie(request: IncomingMessage, name: string) {
  const header = request.headers.cookie;
  if (!header || header.length > 8_192 || /[\r\n\u0000]/.test(header)) return undefined;
  const values = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  return values.length === 1 && values[0] ? values[0] : undefined;
}

export function readPrototypeAccessCookie(input: {
  binding: PreviewGatewayBinding;
  changeId?: string;
  now?: Date;
  request: IncomingMessage;
  secret: string;
  surface?: PrototypeAccessAssertion['surface'];
}) {
  const value = readCookie(input.request, prototypeAccessCookieName);
  if (!value) return null;
  const assertion = verifiedSignedValue(value, input.secret) as
    | Partial<PrototypeAccessAssertion>
    | undefined;
  if (!assertion) return null;
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const matchesBinding =
    assertion.audience === 'project-space-prototype' &&
    assertion.version === 1 &&
    assertion.repositoryFullName === input.binding.repositoryFullName &&
    assertion.pullRequestNumber === input.binding.pullRequestNumber &&
    assertion.headSha === input.binding.headSha &&
    assertion.origin === input.binding.origin &&
    (!input.changeId || assertion.changeId === input.changeId) &&
    (!input.surface || assertion.surface === input.surface);
  const timeIsValid =
    typeof assertion.issuedAt === 'number' &&
    assertion.issuedAt <= now + 5 &&
    typeof assertion.expiresAt === 'number' &&
    assertion.expiresAt >= now &&
    assertion.expiresAt <= assertion.issuedAt + prototypeAccessLifetimeSeconds;
  return matchesBinding &&
    timeIsValid &&
    typeof assertion.userId === 'string' &&
    typeof assertion.changeId === 'string' &&
    ['desktop-prototype', 'mobile-prototype'].includes(assertion.surface ?? '')
    ? {
        changeId: assertion.changeId,
        surface: assertion.surface as PrototypeAccessAssertion['surface'],
        userId: assertion.userId
      }
    : null;
}

export function readPreviewAccessCookie(input: {
  binding: PreviewGatewayBinding;
  now?: Date;
  request: IncomingMessage;
  secret: string;
}) {
  const value = readCookie(input.request, previewAccessCookieName);
  if (!value) return null;
  const assertion = verifiedSignedValue(value, input.secret) as
    | Partial<PreviewAccessAssertion>
    | undefined;
  if (!assertion) return null;
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const matchesBinding =
    assertion.audience === 'project-space-preview-access' &&
    assertion.version === 1 &&
    assertion.repositoryFullName === input.binding.repositoryFullName &&
    assertion.pullRequestNumber === input.binding.pullRequestNumber &&
    assertion.headSha === input.binding.headSha &&
    assertion.origin === input.binding.origin;
  const timeIsValid =
    typeof assertion.issuedAt === 'number' &&
    assertion.issuedAt <= now + 5 &&
    typeof assertion.expiresAt === 'number' &&
    assertion.expiresAt >= now &&
    assertion.expiresAt <= assertion.issuedAt + previewAccessLifetimeSeconds;
  return matchesBinding && timeIsValid && typeof assertion.userId === 'string'
    ? { userId: assertion.userId }
    : null;
}

export function createPreviewIdentityHeaders(input: {
  binding: PreviewGatewayBinding;
  now?: Date;
  secret: string;
  session: ProjectSpaceAuthSession;
}) {
  if (input.secret.length < 32) {
    throw new Error('Preview gateway secret must contain at least 32 characters.');
  }
  const issuedAt = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const assertion: PreviewIdentityAssertion = {
    ...input.binding,
    audience: 'project-space-preview',
    expiresAt: issuedAt + 60,
    issuedAt,
    session: input.session,
    version: 1
  };
  const encoded = Buffer.from(JSON.stringify(assertion)).toString('base64url');
  return {
    [previewIdentityHeader]: encoded,
    [previewSignatureHeader]: signatureFor(encoded, input.secret)
  };
}

function readSingleHeader(request: IncomingMessage, name: string) {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

export function readPreviewIdentityAssertion(input: {
  binding: PreviewGatewayBinding;
  now?: Date;
  request: IncomingMessage;
  secret: string;
}): ProjectSpaceAuthSession | null {
  const encoded = readSingleHeader(input.request, previewIdentityHeader);
  const suppliedSignature = readSingleHeader(input.request, previewSignatureHeader);
  if (!encoded || !suppliedSignature || input.secret.length < 32) return null;

  const expectedSignature = signatureFor(encoded, input.secret);
  const expected = Buffer.from(expectedSignature);
  const supplied = Buffer.from(suppliedSignature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;

  try {
    const assertion = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8')
    ) as Partial<PreviewIdentityAssertion>;
    const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
    const matchesBinding =
      assertion.audience === 'project-space-preview' &&
      assertion.version === 1 &&
      assertion.repositoryFullName === input.binding.repositoryFullName &&
      assertion.pullRequestNumber === input.binding.pullRequestNumber &&
      assertion.headSha === input.binding.headSha &&
      assertion.origin === input.binding.origin;
    const timeIsValid =
      typeof assertion.issuedAt === 'number' &&
      assertion.issuedAt <= now + 5 &&
      typeof assertion.expiresAt === 'number' &&
      assertion.expiresAt >= now &&
      assertion.expiresAt <= assertion.issuedAt + 60;
    const session = assertion.session;
    if (
      !matchesBinding ||
      !timeIsValid ||
      !session ||
      typeof session.userId !== 'string' ||
      typeof session.login !== 'string' ||
      session.role !== 'user'
    ) {
      return null;
    }
    return session;
  } catch {
    return null;
  }
}
