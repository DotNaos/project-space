import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import type { ProjectSpaceAuthSession } from './local-auth-store';

export const previewIdentityHeader = 'x-project-space-preview-identity';
export const previewSignatureHeader = 'x-project-space-preview-signature';

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
  // GitHub history is a bounded read operation whose existing API uses POST
  // only because it accepts a structured revision request body.
  return method === 'POST' && pathname === '/api/github/history';
}

function signatureFor(encodedAssertion: string, secret: string) {
  return createHmac('sha256', secret).update(encodedAssertion).digest('base64url');
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
