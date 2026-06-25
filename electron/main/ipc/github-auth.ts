import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

import type {
  GitHubAuthSession,
  GitHubAuthStatus,
  GitHubViewer
} from '../../../src/shared/electron-api';

const execFileAsync = promisify(execFile);
const authStoragePath = join(homedir(), '.project-space', 'github-auth.json');
const authTimeoutMs = 2 * 60 * 1000;

interface GitHubTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface GitHubUserResponse {
  avatar_url: string;
  login: string;
  name: string | null;
}

function base64Url(input: Buffer) {
  return input
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function createState() {
  return base64Url(randomBytes(24));
}

export function buildCodeChallenge(codeVerifier: string) {
  return base64Url(createHash('sha256').update(codeVerifier).digest());
}

export function buildGitHubAuthorizeUrl({
  clientId,
  codeVerifier,
  redirectUri,
  state
}: {
  clientId: string;
  codeVerifier: string;
  redirectUri: string;
  state: string;
}) {
  const authorizeUrl = new URL('https://github.com/login/oauth/authorize');

  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('scope', 'read:user repo');
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', buildCodeChallenge(codeVerifier));
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('prompt', 'select_account');

  return authorizeUrl.toString();
}

export function readGitHubAuthSession(storagePath = authStoragePath): GitHubAuthSession | null {
  if (!existsSync(storagePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(storagePath, 'utf-8')) as Partial<GitHubAuthSession>;

    if (
      typeof parsed.accessToken !== 'string' ||
      typeof parsed.viewer?.login !== 'string' ||
      typeof parsed.viewer?.avatarUrl !== 'string'
    ) {
      return null;
    }

    return {
      accessToken: parsed.accessToken,
      viewer: {
        avatarUrl: parsed.viewer.avatarUrl,
        login: parsed.viewer.login,
        name: typeof parsed.viewer.name === 'string' ? parsed.viewer.name : null
      }
    };
  } catch {
    return null;
  }
}

export function writeGitHubAuthSession(
  storagePath = authStoragePath,
  session: GitHubAuthSession
) {
  mkdirSync(dirname(storagePath), { recursive: true });
  writeFileSync(storagePath, JSON.stringify(session, null, 2), 'utf-8');
}

export function clearGitHubAuthSession(storagePath = authStoragePath) {
  if (!existsSync(storagePath)) {
    return;
  }

  rmSync(storagePath, { force: true });
}

function getGitHubClientConfig() {
  return {
    clientId: process.env.GITHUB_CLIENT_ID?.trim() ?? '',
    clientSecret: process.env.GITHUB_CLIENT_SECRET?.trim() ?? ''
  };
}

function getGitHubViewerFromResponse(payload: GitHubUserResponse): GitHubViewer {
  return {
    avatarUrl: payload.avatar_url,
    login: payload.login,
    name: payload.name
  };
}

async function exchangeCodeForToken({
  clientId,
  clientSecret,
  code,
  codeVerifier,
  redirectUri
}: {
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}) {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri
    }),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    method: 'POST'
  });
  const payload = (await response.json()) as GitHubTokenResponse;

  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description ?? 'GitHub token exchange failed.');
  }

  return payload.access_token;
}

async function fetchGitHubViewer(accessToken: string) {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    throw new Error('GitHub account lookup failed.');
  }

  return getGitHubViewerFromResponse((await response.json()) as GitHubUserResponse);
}

function buildGitHubAuthStatus(session: GitHubAuthSession | null): GitHubAuthStatus {
  const { clientId, clientSecret } = getGitHubClientConfig();

  return {
    authenticated: Boolean(session),
    configured: Boolean(clientId && clientSecret),
    viewer: session?.viewer
  };
}

export function loadGitHubAuthStatus(): GitHubAuthStatus {
  return buildGitHubAuthStatus(readGitHubAuthSession());
}

export function requireGitHubAuthSession() {
  const session = readGitHubAuthSession();

  if (!session) {
    throw new Error('Sign in with GitHub in app settings before loading or publishing ideas.');
  }

  return session;
}

export async function startGitHubAuth(): Promise<GitHubAuthStatus> {
  const { clientId, clientSecret } = getGitHubClientConfig();

  if (!clientId || !clientSecret) {
    throw new Error('GitHub OAuth is not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.');
  }

  const state = createState();
  const codeVerifier = `${createState()}${createState()}`;

  const session = await new Promise<GitHubAuthSession>((resolve, reject) => {
    let settled = false;
    const server = createServer(async (request, response) => {
      try {
        if (!request.url) {
          response.writeHead(400).end('Missing request URL.');
          rejectOnce(new Error('OAuth callback did not include a request URL.'));
          return;
        }

        const address = server.address();
        if (!address || typeof address === 'string') {
          response.writeHead(500).end('Callback server is not ready.');
          rejectOnce(new Error('OAuth callback server was not ready.'));
          return;
        }

        const currentUrl = new URL(request.url, `http://127.0.0.1:${address.port}`);

        if (currentUrl.pathname !== '/auth/github/callback') {
          response.writeHead(404).end('Route not found.');
          return;
        }

        const returnedState = currentUrl.searchParams.get('state');
        const code = currentUrl.searchParams.get('code');
        const error = currentUrl.searchParams.get('error');

        if (returnedState !== state) {
          response.writeHead(400).end('OAuth state did not match.');
          rejectOnce(new Error('OAuth state did not match.'));
          return;
        }

        if (error) {
          response.writeHead(400).end('GitHub login was cancelled.');
          rejectOnce(new Error(currentUrl.searchParams.get('error_description') ?? error));
          return;
        }

        if (!code) {
          response.writeHead(400).end('GitHub did not return a code.');
          rejectOnce(new Error('GitHub did not return an authorization code.'));
          return;
        }

        const redirectUri = `http://127.0.0.1:${address.port}/auth/github/callback`;
        const accessToken = await exchangeCodeForToken({
          clientId,
          clientSecret,
          code,
          codeVerifier,
          redirectUri
        });
        const viewer = await fetchGitHubViewer(accessToken);

        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8'
        });
        response.end(
          '<!doctype html><title>Project Space</title><body style="font-family: sans-serif; padding: 24px;">GitHub is connected. You can return to Project Space.</body>'
        );

        resolveOnce({
          accessToken,
          viewer
        });
      } catch (error) {
        response.writeHead(500).end('GitHub login failed.');
        rejectOnce(error instanceof Error ? error : new Error('GitHub login failed.'));
      }
    });

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      server.close();
      reject(new Error('GitHub login timed out.'));
    }, authTimeoutMs);

    function resolveOnce(value: GitHubAuthSession) {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      server.close();
      resolve(value);
    }

    function rejectOnce(error: Error) {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      server.close();
      reject(error);
    }

    server.on('error', (error) => {
      rejectOnce(error instanceof Error ? error : new Error('GitHub callback server failed.'));
    });

    server.listen(0, '127.0.0.1', async () => {
      try {
        const address = server.address();

        if (!address || typeof address === 'string') {
          throw new Error('OAuth callback server did not provide a local port.');
        }

        const authorizeUrl = buildGitHubAuthorizeUrl({
          clientId,
          codeVerifier,
          redirectUri: `http://127.0.0.1:${address.port}/auth/github/callback`,
          state
        });

        await execFileAsync('open', [authorizeUrl], {
          windowsHide: true
        });
      } catch (error) {
        rejectOnce(error instanceof Error ? error : new Error('Could not open GitHub login.'));
      }
    });
  });

  writeGitHubAuthSession(authStoragePath, session);

  return buildGitHubAuthStatus(session);
}

export function signOutGitHubAuth(): GitHubAuthStatus {
  clearGitHubAuthSession();

  return buildGitHubAuthStatus(null);
}
