import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  ProjectSpaceAuthDevicePollRequest,
  ProjectSpaceAuthDevicePollResult,
  ProjectSpaceAuthDeviceStartResult,
  ProjectSpaceAuthSessionResult
} from '../src/shared/project-space-api';

interface StoredAuthUser {
  createdAt: string;
  githubAccessToken: string;
  githubScope?: string;
  githubTokenType?: string;
  login: string;
  role: 'owner' | 'user';
  updatedAt: string;
}

interface StoredAuthSession {
  createdAt: string;
  expiresAt: string;
  tokenHash: string;
  userLogin: string;
}

interface AuthDatabase {
  sessions: StoredAuthSession[];
  users: StoredAuthUser[];
  version: 1;
}

export interface ProjectSpaceAuthSession {
  expiresAt: string;
  githubAccessToken: string;
  login: string;
  role: 'owner' | 'user';
  tokenHash: string;
}

const authContext = new AsyncLocalStorage<ProjectSpaceAuthSession | null>();
const projectSpaceDirectory = join(homedir(), '.project-space');
const authDatabaseFile = join(projectSpaceDirectory, 'project-space-auth.db.json');
const githubApiBaseUrl = 'https://api.github.com';
const githubDeviceCodeUrl = 'https://github.com/login/device/code';
const githubAccessTokenUrl = 'https://github.com/login/oauth/access_token';
const sessionDurationMs = 1000 * 60 * 60 * 24 * 30;
const githubOAuthClientIdMissingMessage = 'Set GITHUB_OAUTH_CLIENT_ID to enable GitHub OAuth.';

function getGitHubClientId() {
  return (
    process.env.GITHUB_OAUTH_CLIENT_ID ??
    process.env.PROJECT_SPACE_GITHUB_CLIENT_ID ??
    process.env.GITHUB_CLIENT_ID ??
    ''
  );
}

export function isProjectSpaceAuthRequired() {
  return process.env.PROJECT_SPACE_AUTH_DISABLED !== '1';
}

function readAllowedLogins() {
  return new Set(
    (process.env.PROJECT_SPACE_ALLOWED_GITHUB_LOGINS ?? '')
      .split(',')
      .map((login) => login.trim().replace(/^@/, '').toLowerCase())
      .filter(Boolean)
  );
}

function emptyDatabase(): AuthDatabase {
  return {
    sessions: [],
    users: [],
    version: 1
  };
}

function readDatabase(): AuthDatabase {
  if (!existsSync(authDatabaseFile)) {
    return emptyDatabase();
  }

  try {
    const parsed = JSON.parse(readFileSync(authDatabaseFile, 'utf-8')) as Partial<AuthDatabase>;

    return {
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      users: Array.isArray(parsed.users) ? parsed.users : [],
      version: 1
    };
  } catch {
    return emptyDatabase();
  }
}

function writeDatabase(database: AuthDatabase) {
  mkdirSync(projectSpaceDirectory, { recursive: true });
  writeFileSync(authDatabaseFile, JSON.stringify(database, null, 2), {
    mode: 0o600
  });
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function isExpired(expiresAt: string) {
  return Date.parse(expiresAt) <= Date.now();
}

function sanitizeDatabase(database: AuthDatabase) {
  return {
    ...database,
    sessions: database.sessions.filter((session) => !isExpired(session.expiresAt))
  };
}

async function requestGitHub<T>(
  path: string,
  token: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${githubApiBaseUrl}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...init.headers
    }
  });

  if (!response.ok) {
    throw new Error(`GitHub request failed with ${response.status}.`);
  }

  return (await response.json()) as T;
}

async function readGitHubLogin(token: string) {
  const user = await requestGitHub<{ login?: string }>('/user', token);

  if (!user.login) {
    throw new Error('GitHub did not return a login.');
  }

  return user.login;
}

function authorizeLogin(database: AuthDatabase, login: string) {
  const normalizedLogin = login.toLowerCase();
  const allowedLogins = readAllowedLogins();

  if (allowedLogins.size > 0) {
    return allowedLogins.has(normalizedLogin);
  }

  return (
    database.users.length === 0 ||
    database.users.some((user) => user.login.toLowerCase() === normalizedLogin)
  );
}

function upsertUser(
  database: AuthDatabase,
  login: string,
  payload: {
    accessToken: string;
    scope?: string;
    tokenType?: string;
  }
) {
  const now = new Date().toISOString();
  const existingUser = database.users.find(
    (user) => user.login.toLowerCase() === login.toLowerCase()
  );

  if (existingUser) {
    existingUser.githubAccessToken = payload.accessToken;
    existingUser.githubScope = payload.scope;
    existingUser.githubTokenType = payload.tokenType;
    existingUser.updatedAt = now;
    return existingUser;
  }

  const user: StoredAuthUser = {
    createdAt: now,
    githubAccessToken: payload.accessToken,
    githubScope: payload.scope,
    githubTokenType: payload.tokenType,
    login,
    role: database.users.length === 0 ? 'owner' : 'user',
    updatedAt: now
  };

  database.users.push(user);

  return user;
}

function createSession(database: AuthDatabase, user: StoredAuthUser) {
  const token = randomBytes(32).toString('base64url');
  const session: StoredAuthSession = {
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + sessionDurationMs).toISOString(),
    tokenHash: hashToken(token),
    userLogin: user.login
  };

  database.sessions.push(session);

  return {
    session,
    token
  };
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
  return getCurrentAuthSession()?.githubAccessToken;
}

export function readProjectSpaceAuthSession(token?: string | null) {
  if (!token) {
    return null;
  }

  const database = sanitizeDatabase(readDatabase());
  const tokenHash = hashToken(token);
  const storedSession = database.sessions.find((session) => session.tokenHash === tokenHash);

  if (!storedSession || isExpired(storedSession.expiresAt)) {
    writeDatabase(database);
    return null;
  }

  const user = database.users.find(
    (entry) => entry.login.toLowerCase() === storedSession.userLogin.toLowerCase()
  );

  if (!user) {
    return null;
  }

  return {
    expiresAt: storedSession.expiresAt,
    githubAccessToken: user.githubAccessToken,
    login: user.login,
    role: user.role,
    tokenHash
  } satisfies ProjectSpaceAuthSession;
}

export function readAuthTokenFromRequest(request: IncomingMessage) {
  const authHeader = request.headers.authorization;

  if (authHeader?.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice('bearer '.length).trim();
  }

  return null;
}

export function readAuthSessionFromRequest(request: IncomingMessage) {
  if (!isProjectSpaceAuthRequired()) {
    return null;
  }

  return readProjectSpaceAuthSession(readAuthTokenFromRequest(request));
}

export function readAuthSessionFromUrl(url: URL) {
  if (!isProjectSpaceAuthRequired()) {
    return null;
  }

  return readProjectSpaceAuthSession(url.searchParams.get('session'));
}

export function getProjectSpaceAuthSessionResult(
  token?: string | null
): ProjectSpaceAuthSessionResult {
  if (!isProjectSpaceAuthRequired()) {
    return {
      authenticated: true,
      authRequired: false
    };
  }

  const session = readProjectSpaceAuthSession(token);

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
      login: session.login,
      role: session.role
    }
  };
}

export async function startProjectSpaceAuthDeviceFlow(): Promise<ProjectSpaceAuthDeviceStartResult> {
  const clientId = getGitHubClientId();

  if (!clientId) {
    return {
      message: githubOAuthClientIdMissingMessage,
      status: 'not-configured'
    };
  }

  const response = await fetch(githubDeviceCodeUrl, {
    body: new URLSearchParams({
      client_id: clientId,
      scope: 'repo read:user'
    }),
    headers: {
      Accept: 'application/json'
    },
    method: 'POST'
  });
  const payload = (await response.json()) as {
    device_code?: string;
    error?: string;
    error_description?: string;
    expires_in?: number;
    interval?: number;
    user_code?: string;
    verification_uri?: string;
  };

  if (!response.ok || !payload.device_code) {
    return {
      message: payload.error_description ?? payload.error ?? 'Could not start GitHub login.',
      status: 'error'
    };
  }

  return {
    deviceCode: payload.device_code,
    expiresAt: new Date(Date.now() + (payload.expires_in ?? 900) * 1000).toISOString(),
    intervalSeconds: payload.interval ?? 5,
    status: 'pending',
    userCode: payload.user_code,
    verificationUri: payload.verification_uri
  };
}

export async function pollProjectSpaceAuthDeviceFlow({
  deviceCode
}: ProjectSpaceAuthDevicePollRequest): Promise<ProjectSpaceAuthDevicePollResult> {
  const clientId = getGitHubClientId();

  if (!clientId) {
    return {
      message: githubOAuthClientIdMissingMessage,
      status: 'error'
    };
  }

  const response = await fetch(githubAccessTokenUrl, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
    }),
    headers: {
      Accept: 'application/json'
    },
    method: 'POST'
  });
  const payload = (await response.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
    interval?: number;
    scope?: string;
    token_type?: string;
  };

  if (payload.error === 'authorization_pending' || payload.error === 'slow_down') {
    return {
      intervalSeconds: payload.interval,
      message: payload.error_description,
      status: 'pending'
    };
  }

  if (payload.error === 'expired_token') {
    return {
      message: payload.error_description,
      status: 'expired'
    };
  }

  if (payload.error === 'access_denied') {
    return {
      message: payload.error_description,
      status: 'denied'
    };
  }

  if (!response.ok || !payload.access_token) {
    return {
      message: payload.error_description ?? payload.error ?? 'Could not finish GitHub login.',
      status: 'error'
    };
  }

  const login = await readGitHubLogin(payload.access_token);
  const database = sanitizeDatabase(readDatabase());

  if (!authorizeLogin(database, login)) {
    writeDatabase(database);
    return {
      message: `@${login} is not allowed to use this Project Space connector.`,
      status: 'denied'
    };
  }

  const user = upsertUser(database, login, {
    accessToken: payload.access_token,
    scope: payload.scope,
    tokenType: payload.token_type
  });
  const { session, token } = createSession(database, user);

  writeDatabase(database);

  return {
    sessionToken: token,
    status: 'connected',
    user: {
      login: user.login,
      role: user.role
    },
    expiresAt: session.expiresAt
  };
}

export function revokeProjectSpaceAuthSession(token?: string | null) {
  if (!token) {
    return;
  }

  const tokenHash = hashToken(token);
  const database = readDatabase();
  database.sessions = database.sessions.filter((session) => session.tokenHash !== tokenHash);
  writeDatabase(database);
}
