import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage } from 'node:http';

import { createClerkClient, verifyToken } from '@clerk/backend';

import type { ProjectSpaceAuthSessionResult } from '../src/shared/project-space-api';

export interface ProjectSpaceAuthSession {
  email?: string;
  expiresAt?: string;
  login: string;
  role: 'user';
  userId: string;
}

const authContext = new AsyncLocalStorage<ProjectSpaceAuthSession | null>();

export function isProjectSpaceAuthRequired() {
  return process.env.PROJECT_SPACE_AUTH_DISABLED !== '1';
}

function getClerkSecretKey() {
  return process.env.CLERK_SECRET_KEY ?? '';
}

function readAllowedEmails() {
  return new Set(
    (process.env.PROJECT_SPACE_ALLOWED_EMAILS ?? '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  );
}

function readStringClaim(
  claims: Record<string, unknown>,
  names: string[]
): string | undefined {
  for (const name of names) {
    const value = claims[name];

    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function authorizeEmail(email?: string) {
  const allowedEmails = readAllowedEmails();

  if (allowedEmails.size === 0) {
    return true;
  }

  return Boolean(email && allowedEmails.has(email.toLowerCase()));
}

async function readUserEmail(secretKey: string, userId: string) {
  try {
    const clerkClient = createClerkClient({ secretKey });
    const user = await clerkClient.users.getUser(userId);
    return user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress;
  } catch {
    return undefined;
  }
}

export function getCurrentAuthSession() {
  return authContext.getStore() ?? null;
}

export function runWithAuthSession<T>(
  session: ProjectSpaceAuthSession | null,
  callback: () => T
) {
  return authContext.run(session, callback);
}

export function getCurrentGitHubToken() {
  return undefined;
}

export function readAuthTokenFromRequest(request: IncomingMessage) {
  const authHeader = request.headers.authorization;

  if (authHeader?.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice('bearer '.length).trim();
  }

  return null;
}

export async function readProjectSpaceAuthSession(token?: string | null) {
  if (!token || !isProjectSpaceAuthRequired()) {
    return null;
  }

  const secretKey = getClerkSecretKey();

  if (!secretKey) {
    return null;
  }

  try {
    const claims = await verifyToken(token, {
      secretKey
    });
    const userId = typeof claims.sub === 'string' ? claims.sub : '';

    if (!userId) {
      return null;
    }

    const claimRecord = claims as Record<string, unknown>;
    const email =
      readStringClaim(claimRecord, ['email', 'email_address', 'primary_email_address']) ??
      (await readUserEmail(secretKey, userId));

    if (!authorizeEmail(email)) {
      return null;
    }

    return {
      email,
      expiresAt:
        typeof claims.exp === 'number'
          ? new Date(claims.exp * 1000).toISOString()
          : undefined,
      login: email ?? userId,
      role: 'user',
      userId
    } satisfies ProjectSpaceAuthSession;
  } catch {
    return null;
  }
}

export async function readAuthSessionFromRequest(request: IncomingMessage) {
  if (!isProjectSpaceAuthRequired()) {
    return null;
  }

  return readProjectSpaceAuthSession(readAuthTokenFromRequest(request));
}

export async function readAuthSessionFromUrl(url: URL) {
  if (!isProjectSpaceAuthRequired()) {
    return null;
  }

  return readProjectSpaceAuthSession(url.searchParams.get('session'));
}

export async function getProjectSpaceAuthSessionResult(
  token?: string | null
): Promise<ProjectSpaceAuthSessionResult> {
  if (!isProjectSpaceAuthRequired()) {
    return {
      authenticated: true,
      authRequired: false
    };
  }

  if (!getClerkSecretKey()) {
    return {
      authenticated: false,
      authRequired: true,
      message: 'Set CLERK_SECRET_KEY to enable Project Space login.'
    };
  }

  const session = await readProjectSpaceAuthSession(token);

  if (!session) {
    return {
      authenticated: false,
      authRequired: true
    };
  }

  return {
    authenticated: true,
    authRequired: true,
    expiresAt: session.expiresAt,
    user: {
      email: session.email,
      id: session.userId,
      login: session.login,
      role: session.role
    }
  };
}

export function revokeProjectSpaceAuthSession() {
  // Clerk owns the browser session. The frontend signs out through Clerk.
}
